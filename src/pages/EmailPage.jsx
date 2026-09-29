import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTheme } from "../contexts/ThemeContext";
import { api } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { ListPager, MultiPicker, SortPicker, Tag } from "../components/gtm/QueueParts";
import { countedOptions, useRowsThatFit, useWide } from "../components/gtm/queueHooks";
import ProspectingRepliesPage from "./ProspectingRepliesPage";

/**
 * Email to brands: the pipeline writes, Lemlist sends, a person decides.
 *
 * The one decision is Send. `ops_require_decision` is on in the pipeline, so a
 * lead is handed to Lemlist if and only if it is marked send here; pending and
 * hold mean the same thing to the sender: not this one.
 *
 * Laid out like the Instagram tab, as a queue: a compact list on the left, one
 * brand open on the right. It used to be a table whose rows held a Send button
 * and hid everything worth deciding on behind Details - why the brand is a
 * lead, who posted about it, and above all the email it would get. The panel
 * shows all three, so Send is decided on the email rather than on a name.
 *
 * Several at once still works: tick rows in the list and Send them together,
 * for the days a whole page of Tier A is obviously right.
 *
 * One brand, one channel. A brand DMed on Instagram is not emailed, and the
 * list says so.
 */

// The funnel in order; the keys are VIEWS in server/routes/prospecting.js.
// Results is the replies, read back from Lemlist.
const VIEWS = [
  { value: "review", label: "To review" },
  { value: "queued", label: "Queued" },
  { value: "sent", label: "Sent" },
  { value: "blocked", label: "Needs review" },
  { value: "results", label: "Results" },
];
const VIEW_KEYS = VIEWS.map((v) => v.value);

// How a lead was found; the keys are PATHS in server/lib/instagram-dm-queue.js.
const PATH_LABELS = {
  linkable: "Linkable creators post about them",
  gifted: "Gifted posts",
  programme: "Creator programme page",
  stores: "Shopify store list",
  calls: "Asked for creators",
  tags: "Tagged by creators",
  OTHER: "Found another way",
};
const pathName = (code) => PATH_LABELS[code] || code;

// Default order is the server's: tier, then the strongest creator signal.
const SORTS = [
  { value: "", label: "Best first" },
  { value: "distinct_creators_90d:desc", label: "Most creators" },
  { value: "first_seen_at:desc", label: "Newest" },
  { value: "brand_name:asc", label: "Brand A-Z" },
];

const ROW_PX = 52;
const nameOf = (lead) => lead.brand_name || lead.handle;
const CHECKBOX = { display: "block", margin: 0, width: 15, height: 15, cursor: "pointer", flexShrink: 0 };

const remembered = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; }
};

export default function EmailPage() {
  const { theme } = useTheme();
  const wide = useWide();
  const [params, setParams] = useSearchParams();
  const view = VIEW_KEYS.includes(params.get("view")) ? params.get("view") : "review";
  const setView = (next) => setParams(next === "review" ? {} : { view: next }, { replace: true });

  const [data, setData] = useState(null);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState(null);
  const [notice, setNotice] = useState(null);
  const [selected, setSelected] = useState(null);
  const [ticked, setTicked] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  // One person's working filters, remembered in this browser.
  const [tiers, setTiers] = useState(() => remembered("email-tiers", []));
  const [paths, setPaths] = useState(() => remembered("email-paths", []));
  const [sort, setSort] = useState(() => remembered("email-sort", ""));
  // The box updates at once; the query waits for typing to pause.
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQ(qInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [qInput]);
  useEffect(() => {
    try {
      localStorage.setItem("email-tiers", JSON.stringify(tiers));
      localStorage.setItem("email-paths", JSON.stringify(paths));
      localStorage.setItem("email-sort", JSON.stringify(sort));
    } catch { /* private window */ }
  }, [tiers, paths, sort]);

  // Paged by the server, one window-full at a time, like the Instagram queue.
  const [page, setPage] = useState(0);
  const listTop = useRef(null);
  const fitted = useRowsThatFit(listTop, ROW_PX, Boolean(stats), `${view}:${wide}`);
  const pageSize = wide ? fitted : 8;
  useEffect(() => { setPage(0); }, [view, tiers, paths, sort, q, pageSize]);
  useEffect(() => { setTicked(new Set()); }, [view, tiers, paths, sort, q, page]);

  // Only the newest request may write, so a slow answer for the last tab
  // cannot paint over the one now showing.
  const requestRef = useRef(0);
  const refreshStats = useCallback(() => {
    api.getProspectingStats().then(setStats).catch(() => {});
  }, []);

  const load = useCallback(async (quiet = false) => {
    if (view === "results") { setLoading(false); refreshStats(); return; }
    const request = ++requestRef.current;
    if (!quiet) setLoading(true);
    try {
      const [sortBy, sortDir] = sort ? sort.split(":") : ["", ""];
      const [rows, s] = await Promise.all([
        api.getProspectingLeads({
          view, tier: tiers.join(","), paths: paths.join(","), q, sortBy, sortDir,
          limit: pageSize, offset: page * pageSize,
        }),
        api.getProspectingStats(),
      ]);
      if (request !== requestRef.current) return;
      setData(rows);
      setStats(s);
      setProblem(null);
    } catch (err) {
      // The table ships with the pipeline, not with this app, so "not set up
      // yet" is a normal state and should read as one.
      if (request === requestRef.current) setProblem(err?.hint || err?.message || "could not load leads");
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [view, tiers, paths, sort, q, page, pageSize, refreshStats]);

  useEffect(() => { setSelected(null); setData(null); load(); }, [load]);

  const leads = useMemo(() => data?.leads || [], [data]);
  const current = leads.find((l) => l.handle === selected) || leads[0] || null;
  const leadsRef = useRef([]);
  useEffect(() => { leadsRef.current = leads; }, [leads]);

  // Merge a changed lead in, or drop it when it has left this view and open
  // the next one, so deciding is also "next".
  const settle = useCallback((updated, stillHere) => {
    if (!stillHere) {
      const list = leadsRef.current;
      const index = list.findIndex((l) => l.handle === updated.handle);
      const next = index >= 0 ? list[index + 1] || list[index - 1] : null;
      setSelected(next ? next.handle : null);
    }
    setData((prev) => prev && {
      ...prev,
      total: stillHere ? prev.total : Math.max(0, prev.total - 1),
      leads: stillHere
        ? prev.leads.map((l) => (l.handle === updated.handle ? { ...l, ...updated } : l))
        : prev.leads.filter((l) => l.handle !== updated.handle),
    });
    refreshStats();
  }, [refreshStats]);

  const decide = useCallback(async (lead, decision) => {
    // Whether the decision keeps the lead in the view it was made from.
    const stays = view === "blocked" ? decision !== "hide"
      : view === "review" ? !["send", "hide"].includes(decision)
      : view === "queued" ? decision === "send"
      : true;
    try {
      const updated = await api.setProspectingDecision(lead.handle, decision, null);
      settle({ ...lead, ...updated }, stays);
    } catch (err) {
      setNotice({ tone: "danger", text: `${nameOf(lead)}: ${err?.message || "could not save"}` });
    }
  }, [settle, view]);

  async function decideTicked(decision) {
    const handles = [...ticked];
    if (!handles.length) return;
    setBulkBusy(true);
    try {
      await api.setProspectingDecisions(handles, decision, null);
      setNotice({ tone: "info", text: decision === "send"
        ? `${handles.length} queued. The next tick hands them to Lemlist.`
        : `${handles.length} will never be emailed.` });
      setTicked(new Set());
      await load(true);
    } catch (err) {
      setNotice({ tone: "danger", text: err?.message || "could not save" });
    } finally {
      setBulkBusy(false);
    }
  }

  // The open brand's main button, for the keyboard.
  const panelActions = useRef({});
  // Outside a text box: j / k or the arrows move, s marks the open brand Send.
  useEffect(() => {
    const onKey = (e) => {
      if (["TEXTAREA", "INPUT", "SELECT"].includes(document.activeElement?.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "s" && panelActions.current.send) { e.preventDefault(); panelActions.current.send(); return; }
      if (!["ArrowDown", "ArrowUp", "j", "k"].includes(e.key) || !leads.length) return;
      e.preventDefault();
      const index = Math.max(0, leads.findIndex((l) => l.handle === current?.handle));
      const step = e.key === "ArrowDown" || e.key === "j" ? 1 : -1;
      setSelected(leads[Math.min(leads.length - 1, Math.max(0, index + step))].handle);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [leads, current]);

  const byView = stats?.byView || {};
  const tickable = view !== "sent";
  const pager = data && <ListPager theme={theme} page={page} pageSize={pageSize} total={data.total}
                                   onPage={setPage} />;

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 22, color: theme.text }}>Email</h1>
        <span style={{ color: theme.textMuted, fontSize: 13 }}>
          Read the email, mark it Send, and the next tick hands it to Lemlist. Nothing is
          emailed unless it is marked Send.
        </span>
      </div>

      {problem && (
        <Card style={{ padding: 16, marginBottom: 0 }}>
          <div style={{ color: theme.textMuted, fontSize: 13 }}>
            <strong style={{ color: theme.text }}>Not set up yet.</strong> {problem}
          </div>
        </Card>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {VIEWS.map((v) => (
          <Btn key={v.value} size="sm" variant={view === v.value ? "solid" : "secondary"}
               onClick={() => { if (v.value !== view) { setView(v.value); setNotice(null); } }}>
            {v.label}{stats && v.value !== "results" ? ` ${byView[v.value] ?? 0}` : ""}
          </Btn>
        ))}
        <div style={{ flex: 1 }} />
        {view !== "results" && (
          <>
            <input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder="Search"
              aria-label="Search brands"
              style={{
                width: 180, padding: "6px 12px", borderRadius: 999, fontFamily: "inherit",
                border: `1px solid ${theme.border}`, background: theme.surface, color: theme.text, fontSize: 12,
              }}
            />
            <MultiPicker theme={theme} allLabel="All tiers" noun="tiers" title="Only show these tiers (just for you)"
                         options={countedOptions(stats?.byTier, tiers, (c) => `Tier ${c}`)
                           .filter((o) => ["A", "B", "C"].includes(o.code))}
                         chosen={tiers} onChange={setTiers} short={(o) => o.label} />
            <MultiPicker theme={theme} allLabel="Found any way" noun="paths"
                         title="Only show brands found this way (just for you)"
                         options={countedOptions(stats?.byPath, paths, pathName)}
                         chosen={paths} onChange={setPaths} short={(o) => o.label} />
            <SortPicker theme={theme} value={sort} onChange={setSort} options={SORTS} />
          </>
        )}
      </div>

      {notice && (
        <div style={{ fontSize: 13, color: notice.tone === "danger" ? theme.danger : theme.textMid }}>
          {notice.text}
        </div>
      )}

      <div ref={listTop} />
      {view === "results" ? (
        <ProspectingRepliesPage kind="brand" embedded />
      ) : loading && !data ? (
        <LoadingShape wide={wide} theme={theme} />
      ) : !leads.length ? (
        <Card style={{ padding: 16, marginBottom: 0 }}>
          <div style={{ color: theme.textMuted, fontSize: 13 }}>
            {q || tiers.length || paths.length ? "No brands match these filters." : EMPTY[view]}
          </div>
        </Card>
      ) : (
        <div style={{
          display: "grid", gap: 12, alignItems: "start",
          gridTemplateColumns: wide ? "minmax(300px, 380px) minmax(0, 1fr)" : "minmax(0, 1fr)",
        }}>
          <EmailList leads={leads} current={current} onSelect={setSelected} theme={theme}
                     view={view} tickable={tickable} ticked={ticked} onTick={setTicked}
                     bulkBusy={bulkBusy} onBulk={decideTicked} footer={pager} />
          {current && (
            <EmailPanel key={`${view}:${current.handle}`} lead={current} view={view} theme={theme}
                        onDecide={decide} actionsRef={panelActions} sticky={wide} />
          )}
        </div>
      )}
    </div>
  );
}

const EMPTY = {
  review: "Nothing to review. New brands arrive as the campaigns on Sources find them.",
  queued: "Nothing queued. Brands marked Send wait here until the next tick hands them to Lemlist.",
  sent: "Nothing sent yet.",
  blocked: "Nothing held. A brand the pipeline cannot clear for email lands here, with the reason.",
};

function LoadingShape({ wide, theme }) {
  const row = (i) => (
    <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 12px",
                          borderTop: i ? `1px solid ${theme.border}` : "none" }}>
      <Skeleton style={{ width: 15, height: 15, borderRadius: 4 }} />
      <div style={{ flex: 1 }}>
        <Skeleton style={{ display: "block", height: 12, width: "55%" }} />
        <Skeleton style={{ display: "block", height: 10, width: "35%", marginTop: 6 }} />
      </div>
      <Skeleton style={{ height: 16, width: 22, borderRadius: 6 }} />
    </div>
  );
  return (
    <div style={{ display: "grid", gap: 12, alignItems: "start",
                  gridTemplateColumns: wide ? "minmax(300px, 380px) minmax(0, 1fr)" : "minmax(0, 1fr)" }}>
      <Card style={{ padding: 0, marginBottom: 0 }}>{Array.from({ length: 8 }).map((_, i) => row(i))}</Card>
      <Card style={{ padding: 18, marginBottom: 0 }}>
        <Skeleton style={{ display: "block", height: 16, width: "30%" }} />
        <Skeleton style={{ display: "block", height: 11, width: "45%", marginTop: 8 }} />
        <Skeleton style={{ height: 44, marginTop: 16 }} />
        <Skeleton style={{ height: 220, marginTop: 12, borderRadius: 10 }} />
      </Card>
    </div>
  );
}

// "replied", "opened": what came back, for a brand already sent to.
function replyLabel(lead) {
  return lead.reply_state && lead.reply_state !== "sent" ? lead.reply_state.replace("_", " ") : null;
}

function EmailList({ leads, current, onSelect, theme, view, tickable, ticked, onTick, bulkBusy, onBulk, footer }) {
  const activeRef = useRef(null);
  useEffect(() => { activeRef.current?.scrollIntoView({ block: "nearest" }); }, [current?.handle]);
  const allTicked = leads.length > 0 && leads.every((l) => ticked.has(l.handle));
  const toggle = (handle) => onTick((prev) => {
    const next = new Set(prev);
    if (next.has(handle)) next.delete(handle); else next.add(handle);
    return next;
  });

  return (
    <Card style={{ padding: 0, marginBottom: 0, overflow: "hidden" }}>
      {tickable && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", minHeight: 30,
                      borderBottom: `1px solid ${theme.border}`, fontSize: 12, color: theme.textMuted }}>
          <input type="checkbox" style={CHECKBOX} checked={allTicked} aria-label="Select every brand on this page"
                 onChange={() => onTick(allTicked ? new Set() : new Set(leads.map((l) => l.handle)))} />
          {ticked.size ? (
            <>
              <span>{ticked.size} selected</span>
              <div style={{ flex: 1 }} />
              {view !== "queued" && (
                <Btn size="sm" onClick={() => onBulk("send")} loading={bulkBusy} disabled={bulkBusy}>
                  Send {ticked.size}
                </Btn>
              )}
              {view === "queued" && (
                <Btn size="sm" variant="secondary" onClick={() => onBulk("pending")} disabled={bulkBusy}>
                  Unqueue {ticked.size}
                </Btn>
              )}
              <Btn size="sm" variant="secondary" onClick={() => onBulk("hide")} disabled={bulkBusy}
                   title="Never email these brands: they go on the suppression list">
                Never email
              </Btn>
            </>
          ) : <span>Select several to decide them together</span>}
        </div>
      )}
      {leads.map((lead, i) => {
        const active = lead.handle === current?.handle;
        const reply = replyLabel(lead);
        return (
          <div key={lead.handle} ref={active ? activeRef : null} style={{
            display: "flex", alignItems: "center", gap: 10, paddingLeft: tickable ? 12 : 0,
            borderTop: i ? `1px solid ${theme.border}` : "none",
            background: active ? theme.accentLight : "transparent",
            boxShadow: active ? `inset 3px 0 0 ${theme.accent}` : "none",
          }}>
            {tickable && (
              <input type="checkbox" style={CHECKBOX} checked={ticked.has(lead.handle)}
                     onChange={() => toggle(lead.handle)} aria-label={`Select ${nameOf(lead)}`} />
            )}
            <button
              type="button"
              onClick={() => onSelect(lead.handle)}
              aria-current={active ? "true" : undefined}
              style={{
                display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0, textAlign: "left",
                padding: tickable ? "9px 12px 9px 0" : "9px 12px", border: "none", font: "inherit",
                cursor: "pointer", background: "transparent",
              }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: theme.text,
                               overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {nameOf(lead)}
                </span>
                <span style={{ display: "block", fontSize: 11.5, color: theme.textMuted,
                               overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {lead.domain || `@${lead.handle}`}
                  {lead.country ? ` · ${lead.country}` : ""}
                  {` · ${creatorsPhrase(lead.distinct_creators_90d)}`}
                </span>
              </span>
              <span style={{ display: "flex", gap: 4, flexShrink: 0, alignItems: "center" }}>
                {reply && <Tag tone="success">{reply}</Tag>}
                {lead.dm_sent_at && <Tag tone="warning" title="Sent a DM on Instagram, so it is not emailed">DMed</Tag>}
                {view === "review" && lead.decision === "hold" && <Tag title="Held by an older version of this page">Held</Tag>}
                {view === "blocked" && lead.decision === "send" && <Tag tone="success" title="Goes once the pipeline clears it">Send</Tag>}
                <TierBadge tier={lead.tier} theme={theme} />
              </span>
            </button>
          </div>
        );
      })}
      {footer}
    </Card>
  );
}

const creatorsPhrase = (n) => (!n ? "no creators seen" : n === 1 ? "1 creator" : `${n} creators`);

/**
 * One brand: why it is a lead, the email it would get, and the decision.
 *
 * The email is the reason the panel exists. Before a Send it is the campaign's
 * sequence rendered with the variables the pipeline would push, which is what
 * Lemlist itself does; after, it is what went, step by step.
 */
function EmailPanel({ lead, view, theme, onDecide, actionsRef, sticky }) {
  const [busy, setBusy] = useState(null);
  const sent = Boolean(lead.pushed_at);
  const queued = lead.decision === "send";
  const blocked = view === "blocked";

  const act = async (decision) => {
    setBusy(decision);
    try { await onDecide(lead, decision); } finally { setBusy(null); }
  };

  useEffect(() => {
    if (!actionsRef) return undefined;
    actionsRef.current = { send: !sent && !queued && !busy ? () => act("send") : null };
    return () => { actionsRef.current = {}; };
  });

  const facts = [
    ["Email", lead.contact_email || "none found"],
    ["Founder", lead.founder_name],
    ["Country", lead.country],
    ["Products", lead.product_count],
    ["Affiliate app", lead.affiliate_app && lead.affiliate_app !== "none" ? lead.affiliate_app : "none"],
    ["Entity", lead.entity_type
      ? `${lead.entity_type.replace(/_/g, " ")}${lead.entity_verified ? " · verified" : " · unverified"}`
      : null],
    ["Found via", lead.source],
  ].filter(([, v]) => v !== null && v !== undefined && v !== "");

  return (
    <Card style={{ padding: 18, marginBottom: 0, ...(sticky ? { position: "sticky", top: 12 } : {}) }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: theme.text }}>{nameOf(lead)}</div>
          <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 2 }}>
            {lead.contact_email || "no email found"}
            {lead.domain ? ` · ${lead.domain}` : ""}
            {` · ${creatorsPhrase(lead.distinct_creators_90d)} in 90 days`}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {lead.tier && <Tag>Tier {lead.tier}</Tag>}
          {lead.intent_signal === "open_call" && <Tag tone="success">Asked for creators</Tag>}
          {lead.domain && <Btn size="sm" variant="secondary" href={`https://${lead.domain}`} target="_blank">Store</Btn>}
          <Btn size="sm" variant="secondary" href={lead.instagram_url || `https://www.instagram.com/${lead.handle}/`}
               target="_blank">Instagram</Btn>
          {lead.intent_post_url && (
            <Btn size="sm" variant="secondary" href={lead.intent_post_url} target="_blank">Their post</Btn>
          )}
        </div>
      </div>

      {blocked && lead.review_reason && (
        <div title={lead.review_reason} style={{ marginTop: 12, fontSize: 12.5, color: theme.warning }}>
          Cannot be emailed yet: {holdReason(lead.review_reason)}.
          {lead.decision === "send" ? " Marked Send, so it goes once the pipeline clears it." : ""}
        </div>
      )}
      {lead.dm_sent_at && !sent && (
        <div style={{ marginTop: 12, fontSize: 12.5, color: theme.warning }}>
          Sent a DM on Instagram, so the pipeline will not email it.
        </div>
      )}

      {(lead.tier_reason || lead.top_creators) && (
        <div style={{ marginTop: 12, padding: "6px 10px", borderLeft: `3px solid ${theme.border}`,
                      fontSize: 12.5, lineHeight: 1.5, color: theme.textMid }}>
          {lead.tier_reason && <div>{lead.tier_reason}</div>}
          {lead.top_creators && <div style={{ marginTop: lead.tier_reason ? 4 : 0 }}>Posting about them: {lead.top_creators}</div>}
        </div>
      )}

      <EmailSteps handle={lead.handle} sent={sent} theme={theme} />

      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap", alignItems: "center" }}>
        {sent ? (
          <span style={{ fontSize: 12.5, color: theme.textMid }}>
            Handed to Lemlist {new Date(lead.pushed_at).toLocaleDateString()}
            {replyLabel(lead) ? ` · ${replyLabel(lead)}` : ""}
          </span>
        ) : queued ? (
          <>
            <Tag tone="success" title="Goes to Lemlist on the next tick">✓ Queued</Tag>
            <Btn size="sm" variant="secondary" onClick={() => act("pending")} loading={busy === "pending"}
                 disabled={Boolean(busy)}>
              Unqueue
            </Btn>
          </>
        ) : (
          <Btn size="sm" onClick={() => act("send")} loading={busy === "send"}
               disabled={Boolean(busy) || !lead.contact_email}
               title={lead.contact_email ? "Hand this brand to Lemlist on the next tick" : "No email address to send to"}>
            {blocked ? "Send once cleared" : "Send, next"}
          </Btn>
        )}
        <div style={{ flex: 1 }} />
        {!sent && (
          <Btn size="sm" variant="secondary" onClick={() => act("hide")} loading={busy === "hide"}
               disabled={Boolean(busy)} title="Never email this brand: it goes on the suppression list">
            Never email
          </Btn>
        )}
      </div>
      {!sent && (
        <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 8 }}>
          keys: s send, j/k move
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                    columnGap: 24, rowGap: 4, marginTop: 16, paddingTop: 12, borderTop: `1px solid ${theme.border}` }}>
        {facts.map(([label, value]) => (
          <div key={label} style={{ display: "flex", gap: 12, fontSize: 12.5, lineHeight: 1.6, minWidth: 0 }}>
            <span style={{ color: theme.textMuted, minWidth: 90, flexShrink: 0 }}>{label}</span>
            <span style={{ color: theme.text, overflow: "hidden", textOverflow: "ellipsis" }}>{String(value)}</span>
          </div>
        ))}
      </div>

      <CreatorList text={lead.creator_list} theme={theme} />
    </Card>
  );
}

/**
 * The emails: what this brand would get, or what it got.
 *
 * Reconstructed rather than stored. Lemlist keeps the template and this
 * lead's variables, and putting one through the other is exactly what it did
 * (or will do) when it sends. The first step is open; the follow-ups fold,
 * because the first one is what the decision rests on.
 */
function EmailSteps({ handle, sent, theme }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [allSteps, setAllSteps] = useState(false);

  // The panel is keyed on the brand, so this mounts fresh for each one.
  useEffect(() => {
    let live = true;
    (sent ? api.getSentEmails(handle, "brand") : api.getEmailPreview(handle))
      .then((out) => { if (live) setData(out); })
      .catch((err) => { if (live) setError(err?.hint || err?.message || "could not read the email"); });
    return () => { live = false; };
  }, [handle, sent]);

  if (error) return <div style={{ marginTop: 12, color: theme.danger, fontSize: 12 }}>{error}</div>;
  if (!data) return <Skeleton style={{ display: "block", height: 160, marginTop: 12, borderRadius: 10 }} />;

  const steps = data.steps || [];
  if (!steps.length) {
    return (
      <div style={{ marginTop: 12, fontSize: 12.5, color: theme.textMuted }}>
        {data.note || (sent ? "Nothing to show." : "No preview yet: the pipeline has not published what this brand would be sent.")}
      </div>
    );
  }
  const shown = allSteps ? steps : steps.slice(0, 1);

  return (
    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ color: theme.textMuted, fontSize: 12 }}>
        {sent ? "Sent" : "Would send"}
        {data.campaignName ? ` · ${data.campaignName}` : ""}
        {data.from ? ` · from ${data.from}` : ""}
        {data.email ? ` · to ${data.email}` : ""}
      </div>
      {data.note && <div style={{ color: theme.textMuted, fontSize: 12 }}>{data.note}</div>}
      {shown.map((step) => (
        <div key={step.index} style={{
          border: `1px solid ${theme.border}`, borderRadius: 10, background: theme.bg,
          // Greyed only when nothing says it went: Lemlist sometimes files a
          // reply against a step without a matching sent activity.
          opacity: sent && !step.sentAt && !step.events.length ? 0.6 : 1,
        }}>
          <div style={{ padding: "6px 12px", borderBottom: `1px solid ${theme.border}`, display: "flex",
                        gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
            <span style={{ color: theme.text }}>Step {step.index}</span>
            <span style={{ color: theme.textMuted }}>
              {step.sentAt ? `sent ${new Date(step.sentAt).toLocaleString()}`
                : step.delayDays ? `day ${step.delayDays}` : "first email"}
            </span>
            {step.events.filter((e) => e.type !== "emailsSent").map((e, i) => (
              <span key={i} style={{ color: theme.success }}>{e.type.replace("emails", "").toLowerCase()}</span>
            ))}
          </div>
          {step.subject && (
            <div style={{ padding: "8px 12px 0", color: theme.text, fontSize: 13, fontWeight: 600 }}>{step.subject}</div>
          )}
          <div style={{ padding: "6px 12px 10px", whiteSpace: "pre-wrap", color: theme.textMid,
                        fontSize: 13, lineHeight: 1.5 }}>{plainText(step.body)}</div>
        </div>
      ))}
      {steps.length > 1 && (
        <div>
          <Btn size="sm" variant="secondary" onClick={() => setAllSteps((v) => !v)}>
            {allSteps ? "Only the first email" : `Show the ${steps.length - 1} follow-up${steps.length > 2 ? "s" : ""}`}
          </Btn>
        </div>
      )}
      {/* {{signature}} is filled in by Lemlist from the sending mailbox, so it
          is the one part that cannot be shown. */}
      <div style={{ color: theme.textMuted, fontSize: 11 }}>
        Rendered from the Lemlist sequence and this brand&apos;s variables; any{" "}
        <code>{"{{signature}}"}</code> is added by Lemlist from the sending mailbox.
      </div>
    </div>
  );
}

// Lemlist keeps a step as HTML - a <p> per line and <p><br></p> for a blank
// one - so it is read back as the text a recipient sees. Parsed, not
// inserted: DOMParser runs no scripts and the result is only ever text.
function plainText(html) {
  const raw = String(html || "");
  // Plain-text steps keep their line breaks; in HTML a bare newline is a space.
  if (!/<(p|br|div)[\s>/]/i.test(raw)) return raw.trim();
  const text = raw.replace(/\s*\n\s*/g, " ")
    .replace(/<p[^>]*>\s*<br\s*\/?>\s*<\/p>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n");
  const parsed = new DOMParser().parseFromString(text, "text/html").body.textContent || "";
  return parsed.replace(/\n{3,}/g, "\n\n").trim();
}

// The pipeline writes its reasons for itself: "GB lead with
// entity_type=unknown: individual subscriber under PECR until confirmed
// otherwise" is exact and means nothing to somebody looking at a queue. The
// full sentence stays in the tooltip; the line says what it means.
function holdReason(raw) {
  const text = String(raw || "");
  if (/entity_type=unknown/i.test(text)) return "no company record found";
  if (/no contact email/i.test(text)) return "no email on the storefront";
  if (/suppress/i.test(text)) return "on the suppression list";
  return text.split(":")[0];
}

function TierBadge({ tier, theme }) {
  const colours = { A: theme.success, B: theme.warning, C: theme.textMuted };
  return (
    <span style={{
      display: "inline-block", minWidth: 20, textAlign: "center", lineHeight: "16px",
      padding: "0 6px", borderRadius: 6, fontSize: 11, fontWeight: 600,
      color: colours[tier] || theme.textMuted, border: `1px solid ${colours[tier] || theme.border}`,
    }}>
      {tier || "—"}
    </span>
  );
}

/**
 * The list the first email offers to send: "I've got the full list - every
 * handle, every post. Want me to send it over?" only works if the answer
 * exists the moment somebody says yes, so replying is a paste, not a job.
 */
function CreatorList({ text, theme }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  const lines = text.split("\n").filter(Boolean);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <span style={{ color: theme.textMuted, fontSize: 11 }}>The list the email offers them ({lines.length})</span>
        <Btn variant="secondary" size="sm" onClick={copy}>{copied ? "Copied" : "Copy"}</Btn>
      </div>
      <div style={{
        maxHeight: 140, overflowY: "auto", whiteSpace: "pre-wrap",
        background: theme.bg, border: `1px solid ${theme.border}`,
        borderRadius: 8, padding: 10, color: theme.text, fontSize: 12,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      }}>{text}</div>
    </div>
  );
}
