import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";

/**
 * Instagram DMs to brands: the page drafts, a person sends.
 *
 * Instagram does not let software open a conversation - its API only answers
 * accounts that wrote first - so the send stays human. Everything around it
 * does not have to: the brand is found, what it asked for is read, and the
 * message is written before anybody needs it.
 *
 * Laid out as a queue, not a feed. A compact list on the left, one brand open
 * on the right, and "Mark sent" moves to the next one. The first version gave
 * every brand a full-width card with its own text box, which made fifty brands
 * fifty screens of scrolling.
 *
 * One brand, one channel. A brand already handed to the email sequence is not
 * offered here, and marking one sent keeps it out of the email sequence.
 */

const VIEWS = [
  { value: "todo", label: "To send", count: "todo" },
  { value: "sent", label: "Sent", count: "sent" },
  { value: "skipped", label: "Skipped", count: "skipped" },
];

const LANGUAGE_LABEL = { en: "English", it: "Italiano" };
const dmLink = (handle) => `https://ig.me/m/${encodeURIComponent(handle)}`;
const nameOf = (lead) => lead.brand_name || lead.ig_full_name || lead.handle;
const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

// Wide enough for the list beside the message; below this they stack.
function useWide(min = 1100) {
  const [wide, setWide] = useState(() => window.innerWidth >= min);
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= min);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [min]);
  return wide;
}

export default function InstagramDmPage() {
  const { theme } = useTheme();
  const wide = useWide();
  const [view, setView] = useState("todo");
  const [data, setData] = useState(null);
  // Counts, settings and countries outlive a tab switch; the list does not.
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState(null);
  const [notice, setNotice] = useState(null);
  const [selected, setSelected] = useState(null);
  const [drafting, setDrafting] = useState(null); // { done, failed } while writing
  const [savingSetting, setSavingSetting] = useState(false);
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);

  // Only the newest request may write. Switching tabs used to paint the "To
  // send" list under "Sent" - with Undo buttons on brands nobody had sent to -
  // until the slower answer arrived.
  const requestRef = useRef(0);

  const load = useCallback(async (quiet = false) => {
    const request = ++requestRef.current;
    if (!quiet) setLoading(true);
    try {
      const out = await api.getInstagramDms({ view, limit: 100 });
      if (request !== requestRef.current) return;
      setData(out);
      setMeta({ counts: out.counts, settings: out.settings, countries: out.countries || {} });
      setProblem(null);
    } catch (err) {
      if (request === requestRef.current) setProblem(err?.message || "could not load the queue");
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [view]);

  useEffect(() => { setSelected(null); setData(null); load(); }, [load]);

  const leads = useMemo(() => data?.leads || [], [data]);
  const counts = meta?.counts || {};
  const current = leads.find((l) => l.handle === selected) || leads[0] || null;

  // Merge one changed lead into the list, or drop it when it has left this view.
  const leadsRef = useRef([]);
  useEffect(() => { leadsRef.current = leads; }, [leads]);

  const settle = useCallback((updated, stillHere) => {
    if (!stillHere) {
      // Move to the next brand, so marking sent is also "next".
      const list = leadsRef.current;
      const index = list.findIndex((l) => l.handle === updated.handle);
      const next = index >= 0 ? list[index + 1] || list[index - 1] : null;
      setSelected(next ? next.handle : null);
    }
    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        leads: stillHere
          ? prev.leads.map((l) => (l.handle === updated.handle ? { ...l, ...updated } : l))
          : prev.leads.filter((l) => l.handle !== updated.handle),
      };
    });
    load(true);
  }, [load]);

  // Messages are written without anybody asking: a brand in the queue with no
  // message is a brand nobody can send to. Ten at a time (one serverless call),
  // until the list on screen is covered.
  const draftMissing = useCallback(async () => {
    let done = 0;
    let failed = 0;
    setDrafting({ done, failed });
    try {
      for (let round = 0; round < 10 && viewRef.current === "todo"; round++) {
        const out = await api.draftInstagramDms({});
        done += out.drafted?.length || 0;
        failed += out.failed?.length || 0;
        for (const d of out.drafted || []) settle(d, true);
        setDrafting({ done, failed });
        if (!out.drafted?.length) {
          if (out.failed?.length) {
            setNotice({ tone: "danger",
                        text: `Could not write a message for @${out.failed[0].handle}: ${out.failed[0].error}` });
          }
          break;
        }
      }
    } catch (err) {
      setNotice({ tone: "danger", text: err?.message || "could not write messages" });
    } finally {
      setDrafting(null);
    }
  }, [settle]);

  const missing = view === "todo" ? leads.filter((l) => !l.dm_text).length : 0;
  const startedFor = useRef(null);
  useEffect(() => {
    // Once per shape of the queue, and only when something is missing, so a
    // brand whose message keeps failing does not loop.
    if (!data || view !== "todo" || !missing || drafting) return;
    const key = `${counts.todo}:${counts.nonShopify}:${JSON.stringify(meta?.settings)}`;
    if (startedFor.current === key) return;
    startedFor.current = key;
    draftMissing();
  }, [data, view, missing, drafting, counts.todo, counts.nonShopify, meta?.settings, draftMissing]);

  // Admin choices for the whole team: which brands are in the queue at all.
  async function saveSetting(key, value) {
    setSavingSetting(true);
    try {
      await api.setProspectingSetting(key, value);
      await load(true);
    } catch (err) {
      setNotice({ tone: "danger", text: err?.message || "could not save the setting" });
    } finally {
      setSavingSetting(false);
    }
  }

  // j / k or the arrow keys move through the list, outside the text box.
  useEffect(() => {
    const onKey = (e) => {
      if (["TEXTAREA", "INPUT"].includes(document.activeElement?.tagName)) return;
      if (!["ArrowDown", "ArrowUp", "j", "k"].includes(e.key) || !leads.length) return;
      e.preventDefault();
      const index = Math.max(0, leads.findIndex((l) => l.handle === current?.handle));
      const step = e.key === "ArrowDown" || e.key === "j" ? 1 : -1;
      setSelected(leads[Math.min(leads.length - 1, Math.max(0, index + step))].handle);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [leads, current]);

  const includeNonShopify = meta?.settings?.dm_include_non_shopify === true;
  const chosenCountries = meta?.settings?.dm_countries || [];

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 22, color: theme.text }}>Instagram DMs</h1>
        <span style={{ color: theme.textMuted, fontSize: 13 }}>
          Copy the message, send it in the conversation that opens, mark it sent.
          Brands marked sent stay out of the email sequence.
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
            {v.label}{meta ? ` ${counts[v.count] ?? 0}` : ""}
          </Btn>
        ))}
        {meta ? (
          <>
            <Stat theme={theme} label="sent today" value={counts.sentToday} />
            <Stat theme={theme} label="replied" value={counts.replied} />
          </>
        ) : (
          <Skeleton style={{ height: 14, width: 150, marginLeft: 6 }} />
        )}
        <div style={{ flex: 1 }} />
        {drafting && (
          <span style={{ fontSize: 12, color: theme.textMid }}>
            Writing messages… {drafting.done} done{drafting.failed ? `, ${drafting.failed} failed` : ""}
          </span>
        )}
        {meta && (
          <CountryPicker theme={theme} available={meta.countries} chosen={chosenCountries}
                         disabled={savingSetting} onChange={(codes) => saveSetting("dm_countries", codes)} />
        )}
        {meta && (
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12,
                          color: theme.textMid, cursor: savingSetting ? "wait" : "pointer" }}
                 title="Brands whose store is not on Shopify are never emailed. This decides whether they are offered here, for everyone.">
            <input type="checkbox" checked={includeNonShopify} disabled={savingSetting}
                   onChange={(e) => saveSetting("dm_include_non_shopify", e.target.checked)} style={{ margin: 0 }} />
            Include brands not on Shopify{counts.nonShopify ? ` (${counts.nonShopify})` : ""}
          </label>
        )}
      </div>

      {notice && (
        <div style={{ fontSize: 13, color: notice.tone === "danger" ? theme.danger : theme.textMid }}>
          {notice.text}
        </div>
      )}

      {loading && !data ? (
        <LoadingShape view={view} wide={wide} theme={theme} />
      ) : !leads.length ? (
        <Card style={{ padding: 16, marginBottom: 0 }}>
          <div style={{ color: theme.textMuted, fontSize: 13 }}>{emptyText(view)}</div>
        </Card>
      ) : view === "todo" ? (
        <div style={{
          display: "grid", gap: 12, alignItems: "start",
          gridTemplateColumns: wide ? "minmax(300px, 380px) minmax(0, 1fr)" : "minmax(0, 1fr)",
        }}>
          <QueueList leads={leads} current={current} onSelect={setSelected} theme={theme}
                     drafting={Boolean(drafting)} maxHeight={wide ? "calc(100vh - 210px)" : 320} />
          {current && (
            <DmPanel key={current.handle} lead={current} maxChars={data?.maxChars || 520}
                     drafting={Boolean(drafting) && !current.dm_text}
                     onSettled={settle} onNotice={setNotice} sticky={wide} />
          )}
        </div>
      ) : (
        <Card style={{ padding: 0, marginBottom: 0 }}>
          {leads.map((lead, i) => (
            <SentRow key={lead.handle} lead={lead} last={i === leads.length - 1}
                     onSettled={settle} onNotice={setNotice} />
          ))}
        </Card>
      )}

      {data && data.total > leads.length && (
        <div style={{ fontSize: 12, color: theme.textMuted }}>
          Showing the first {leads.length} of {data.total}. They move up as these are sent.
        </div>
      )}
    </div>
  );
}

// The page's own shape while it loads, so nothing jumps when it arrives.
function LoadingShape({ view, wide, theme }) {
  const rows = Array.from({ length: 8 });
  const listRow = (i) => (
    <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 12px",
                          borderTop: i ? `1px solid ${theme.border}` : "none" }}>
      <Skeleton style={{ width: 7, height: 7, borderRadius: 99 }} />
      <div style={{ flex: 1 }}>
        <Skeleton style={{ display: "block", height: 12, width: "55%" }} />
        <Skeleton style={{ display: "block", height: 10, width: "35%", marginTop: 6 }} />
      </div>
      <Skeleton style={{ height: 16, width: 34, borderRadius: 99 }} />
    </div>
  );
  if (view !== "todo") {
    return <Card style={{ padding: 0, marginBottom: 0 }}>{rows.slice(0, 5).map((_, i) => listRow(i))}</Card>;
  }
  return (
    <div style={{ display: "grid", gap: 12, alignItems: "start",
                  gridTemplateColumns: wide ? "minmax(300px, 380px) minmax(0, 1fr)" : "minmax(0, 1fr)" }}>
      <Card style={{ padding: 0, marginBottom: 0 }}>{rows.map((_, i) => listRow(i))}</Card>
      <Card style={{ padding: 18, marginBottom: 0 }}>
        <Skeleton style={{ display: "block", height: 16, width: "30%" }} />
        <Skeleton style={{ display: "block", height: 11, width: "45%", marginTop: 8 }} />
        <Skeleton style={{ height: 44, marginTop: 16 }} />
        <Skeleton style={{ height: 220, marginTop: 12, borderRadius: 10 }} />
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <Skeleton style={{ height: 30, width: 150, borderRadius: 99 }} />
          <Skeleton style={{ height: 30, width: 130, borderRadius: 99 }} />
        </div>
      </Card>
    </div>
  );
}

const COUNTRY_NAMES = (() => {
  try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; }
})();
const countryName = (code) => (code === "UNKNOWN" ? "Unknown country"
  : (COUNTRY_NAMES?.of(code) || code));

// Which countries' brands are in the queue, for everyone. Nothing chosen means
// every country; the counts include the countries left out, so it is clear
// what a change will add or remove before making it.
function CountryPicker({ theme, available, chosen, disabled, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const codes = Object.keys(available || {})
    .sort((a, b) => (available[b] - available[a]) || a.localeCompare(b));
  // A chosen country with nobody waiting still shows, so it can be unticked.
  for (const c of chosen) if (!codes.includes(c)) codes.push(c);
  const all = !chosen.length;
  const isOn = (c) => all || chosen.includes(c);

  function toggle(code) {
    const current = all ? codes : chosen;
    const next = current.includes(code) ? current.filter((c) => c !== code) : [...current, code];
    // Every country ticked is the same as no filter, and is stored as one.
    onChange(codes.every((c) => next.includes(c)) ? [] : next);
  }

  const label = all ? "All countries"
    : chosen.length <= 3 ? chosen.map((c) => (c === "UNKNOWN" ? "Unknown" : c)).join(", ")
    : `${chosen.length} countries`;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <Btn size="sm" variant="secondary" onClick={() => setOpen((v) => !v)} disabled={disabled}
           aria-expanded={open} title="Which countries' brands are in the queue, for everyone">
        {label} ▾
      </Btn>
      {open && (
        <div style={{
          position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 20, width: 260,
          background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 12,
          boxShadow: theme.shadowMd, padding: 8, maxHeight: 360, overflowY: "auto",
        }}>
          <button type="button" onClick={() => onChange([])} disabled={disabled || all}
                  style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 8px",
                           border: "none", background: "transparent", fontFamily: "inherit",
                           fontSize: 12, color: all ? theme.textMuted : theme.text,
                           cursor: all ? "default" : "pointer" }}>
            All countries
          </button>
          {codes.map((code) => (
            <label key={code} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
                                       fontSize: 12.5, color: theme.text, cursor: "pointer" }}>
              <input type="checkbox" checked={isOn(code)} disabled={disabled}
                     onChange={() => toggle(code)} style={{ margin: 0 }} />
              <span style={{ flex: 1 }}>{countryName(code)}</span>
              <span style={{ color: theme.textMuted, fontVariantNumeric: "tabular-nums" }}>
                {available?.[code] ?? 0}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ theme, label, value }) {
  return (
    <span style={{ fontSize: 12, color: theme.textMuted, marginLeft: 6 }}>
      <strong style={{ color: theme.text, fontWeight: 600 }}>{value ?? 0}</strong> {label}
    </span>
  );
}

function emptyText(view) {
  if (view === "sent") return "Nothing sent yet.";
  if (view === "skipped") return "Nothing skipped.";
  return "No brands waiting. New ones arrive every morning from the Instagram searches.";
}

function Tag({ children, tone, title }) {
  const { theme } = useTheme();
  const color = tone ? theme[tone] : theme.textMid;
  return (
    <span title={title} style={{
      fontSize: 10.5, padding: "1px 7px", borderRadius: 999, whiteSpace: "nowrap", lineHeight: "16px",
      border: `1px solid ${tone ? color : theme.border}`, color,
    }}>
      {children}
    </span>
  );
}

function QueueList({ leads, current, onSelect, theme, drafting, maxHeight }) {
  const activeRef = useRef(null);
  useEffect(() => { activeRef.current?.scrollIntoView({ block: "nearest" }); }, [current?.handle]);

  return (
    <Card style={{ padding: 0, marginBottom: 0, overflow: "hidden" }}>
      <div style={{ maxHeight, overflowY: "auto" }}>
        {leads.map((lead, i) => {
          const active = lead.handle === current?.handle;
          const ready = Boolean(lead.dm_text);
          return (
            <button
              key={lead.handle}
              ref={active ? activeRef : null}
              type="button"
              onClick={() => onSelect(lead.handle)}
              aria-current={active ? "true" : undefined}
              style={{
                display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left",
                padding: "9px 12px", border: "none", font: "inherit", cursor: "pointer",
                borderTop: i ? `1px solid ${theme.border}` : "none",
                background: active ? theme.accentLight : "transparent",
                boxShadow: active ? `inset 3px 0 0 ${theme.accent}` : "none",
              }}
            >
              <span
                title={ready ? "Message ready" : drafting ? "Writing…" : "No message yet"}
                style={{
                  width: 7, height: 7, borderRadius: 99, flexShrink: 0,
                  background: ready ? theme.success : theme.border,
                }}
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: theme.text,
                               overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {nameOf(lead)}
                </span>
                <span style={{ display: "block", fontSize: 11.5, color: theme.textMuted,
                               overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  @{lead.handle}
                  {lead.country ? ` · ${lead.country}` : ""}
                  {lead.ig_followers ? ` · ${compact(lead.ig_followers)}` : ""}
                </span>
              </span>
              <span style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                {lead.intent_signal === "open_call" && <Tag tone="success" title="Posted asking for creators">Call</Tag>}
                {lead.status === "not_shopify" && <Tag tone="warning" title="Store is not on Shopify">No Shopify</Tag>}
                {lead.email_queued && <Tag tone="warning" title="Goes to the email sequence on the next run">Email</Tag>}
              </span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function DmPanel({ lead, maxChars, drafting, onSettled, onNotice, sticky }) {
  const { theme } = useTheme();
  const [text, setText] = useState(lead.dm_text || "");
  const [busy, setBusy] = useState(null);
  const [copied, setCopied] = useState(false);
  const [showPost, setShowPost] = useState(false);

  // A redraft replaces the text; typing in the box does not come back here.
  useEffect(() => { setText(lead.dm_text || ""); }, [lead.dm_text]);

  const name = nameOf(lead);
  const language = lead.dm_language || lead.default_language || "en";
  const other = language === "it" ? "en" : "it";
  const dirty = text.trim() !== (lead.dm_text || "").trim();
  const caption = (lead.intent_caption || "").trim();

  async function run(label, fn) {
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      onNotice({ tone: "danger", text: `@${lead.handle}: ${err?.message || "failed"}` });
    } finally {
      setBusy(null);
    }
  }

  const save = () => run("save", async () => {
    if (!dirty) return;
    onSettled(await api.updateInstagramDm(lead.handle, "edit", text), true);
  });

  const draft = (lang) => run(lang ? `draft-${lang}` : "draft", async () => {
    const out = await api.draftInstagramDms({ handles: [lead.handle], language: lang });
    if (out.failed?.length) throw new Error(out.failed[0].error);
    if (out.drafted?.[0]) onSettled(out.drafted[0], true);
  });

  // Copy first, then open: the conversation opens in another tab and the
  // message is already on the clipboard when it does.
  const copyAndOpen = () => run("copy", async () => {
    if (dirty) onSettled(await api.updateInstagramDm(lead.handle, "edit", text), true);
    await navigator.clipboard.writeText(text.trim());
    setCopied(true);
    window.open(dmLink(lead.handle), "_blank", "noopener");
  });

  const mark = (action) => run(action, async () => {
    if (action === "sent" && dirty) await api.updateInstagramDm(lead.handle, "edit", text);
    onSettled(await api.updateInstagramDm(lead.handle, action), false);
  });

  return (
    <Card style={{ padding: 18, marginBottom: 0, ...(sticky ? { position: "sticky", top: 12 } : {}) }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: theme.text }}>{name}</div>
          <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 2 }}>
            @{lead.handle}
            {lead.country ? ` · ${lead.country}` : ""}
            {lead.ig_category && lead.ig_category !== "None" ? ` · ${lead.ig_category}` : ""}
            {lead.ig_followers ? ` · ${lead.ig_followers.toLocaleString()} followers` : ""}
            {lead.domain ? ` · ${lead.domain}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {lead.intent_signal === "open_call" && <Tag tone="success">Asked for creators</Tag>}
          {lead.status === "not_shopify" && <Tag tone="warning">Not on Shopify</Tag>}
          {lead.tier && <Tag>Tier {lead.tier}</Tag>}
          <Btn size="sm" variant="secondary"
               href={lead.instagram_url || `https://www.instagram.com/${lead.handle}/`} target="_blank">
            Profile
          </Btn>
          {lead.intent_post_url && (
            <Btn size="sm" variant="secondary" href={lead.intent_post_url} target="_blank">Their post</Btn>
          )}
        </div>
      </div>

      {caption && (
        <button
          type="button"
          onClick={() => setShowPost((v) => !v)}
          title={showPost ? "Show less" : "Show the whole post"}
          style={{
            display: "block", width: "100%", textAlign: "left", marginTop: 12, padding: "6px 10px",
            border: "none", borderLeft: `3px solid ${theme.border}`, background: "transparent",
            fontFamily: "inherit", color: theme.textMid, fontSize: 12.5, lineHeight: 1.45, cursor: "pointer",
            whiteSpace: "pre-wrap",
            ...(showPost ? {} : {
              display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden",
            }),
          }}
        >
          {caption}
        </button>
      )}

      {lead.email_queued && (
        <div style={{ marginTop: 10, fontSize: 12, color: theme.warning }}>
          Goes to the email sequence on the next run unless it is DMed first.
        </div>
      )}

      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setCopied(false); }}
        onBlur={save}
        rows={Math.min(18, Math.max(8, text.split("\n").length + 2))}
        placeholder={drafting || busy?.startsWith("draft") ? "Writing the message…" : "No message yet."}
        aria-label={`Message to ${name}`}
        style={{
          width: "100%", marginTop: 12, padding: "10px 12px", borderRadius: 10,
          fontFamily: "inherit", fontSize: 13, lineHeight: 1.5,
          border: `1.5px solid ${theme.border}`, background: theme.bg, color: theme.text,
          resize: "vertical", boxSizing: "border-box",
        }}
      />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: theme.textMuted, marginTop: 4 }}>
        <span>{lead.dm_text ? `In ${LANGUAGE_LABEL[language] || language}` : ""}</span>
        <span style={{ color: text.length > maxChars + 60 ? theme.warning : theme.textMuted }}>
          {text.length} characters
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
        <Btn size="sm" onClick={copyAndOpen} loading={busy === "copy"} disabled={!text.trim() || Boolean(busy)}>
          {copied ? "Copied, open again" : "Copy and open DM"}
        </Btn>
        <Btn size="sm" variant="outline" onClick={() => mark("sent")} loading={busy === "sent"}
             disabled={!text.trim() || Boolean(busy)}>
          Mark sent, next
        </Btn>
        <div style={{ flex: 1 }} />
        <Btn size="sm" variant="secondary" onClick={() => draft()} loading={busy === "draft"} disabled={Boolean(busy)}>
          {lead.dm_text ? "Rewrite" : "Write message"}
        </Btn>
        <Btn size="sm" variant="secondary" onClick={() => draft(other)} loading={busy === `draft-${other}`}
             disabled={Boolean(busy)}>
          In {LANGUAGE_LABEL[other]}
        </Btn>
        <Btn size="sm" variant="secondary" onClick={() => mark("skip")} loading={busy === "skip"} disabled={Boolean(busy)}>
          Skip
        </Btn>
      </div>
    </Card>
  );
}

function SentRow({ lead, last, onSettled, onNotice }) {
  const { theme } = useTheme();
  const [busy, setBusy] = useState(null);

  const act = async (action) => {
    setBusy(action);
    try {
      onSettled(await api.updateInstagramDm(lead.handle, action), action === "replied");
    } catch (err) {
      onNotice({ tone: "danger", text: `@${lead.handle}: ${err?.message || "failed"}` });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{
      display: "flex", gap: 12, alignItems: "center", padding: "10px 16px", flexWrap: "wrap",
      borderBottom: last ? "none" : `1px solid ${theme.border}`,
    }}>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>{nameOf(lead)}</div>
        <div style={{ fontSize: 12, color: theme.textMuted }}>
          @{lead.handle}
          {lead.dm_sent_at ? ` · sent ${new Date(lead.dm_sent_at).toLocaleString()}` : ""}
          {lead.dm_sent_by ? ` by ${lead.dm_sent_by}` : ""}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end" }}>
        {lead.dm_state === "replied" && <Tag tone="success">Replied</Tag>}
        {lead.dm_state === "sent" && (
          <Btn size="sm" variant="secondary" onClick={() => act("replied")} loading={busy === "replied"}
               disabled={Boolean(busy)}>
            They replied
          </Btn>
        )}
        <Btn size="sm" variant="secondary" href={dmLink(lead.handle)} target="_blank">Open DM</Btn>
        <Btn size="sm" variant="secondary" onClick={() => act("reopen")} loading={busy === "reopen"}
             disabled={Boolean(busy)}>
          {lead.dm_state === "skipped" ? "Restore" : "Undo"}
        </Btn>
      </div>
    </div>
  );
}
