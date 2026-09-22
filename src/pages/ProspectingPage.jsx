import { Fragment, useCallback, useEffect, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Select } from "../components/ui/Select";
import { Skeleton, SkeletonTableRows } from "../components/ui/Skeleton";
import { Pagination } from "../components/ui/Pagination";
import {
  DragHandle,
  HeaderCell,
  ResizeHandle,
  SortLabel,
  fitWidths,
  headerCellStyle,
  nextSort,
  useColumnOrder,
  useColumnWidths,
} from "../components/table/tableTools";

/**
 * Outbound prospecting: Shopify brands that look like candidates to install
 * Linkable.
 *
 * The signal behind every row is one pair of facts. A brand with creators
 * posting about it and no affiliate app installed is running influencer
 * marketing it cannot attribute — which is the entire pitch, and which no store
 * database sells, because it only exists by crossing Instagram activity with
 * storefront technographics.
 *
 * What this page is for is the decision, not the browsing — and there is only
 * one decision, because `ops_require_decision` is on in the pipeline and a
 * lead is emailed if and only if it is marked send. Pending, hold and hide all
 * mean the same thing to the sender: not this one.
 *
 * So the row carries one Send toggle and nothing else. It used to carry three
 * buttons — send, hold and hide — which is eighty-one controls on a screen of
 * twenty-seven leads to express a single bit, and the page had to spend a line
 * of its own subtitle explaining that two of the three did the same thing.
 * Across the whole table those two were worth one row: 25 send, 1 pending,
 * 1 hold, 0 hide.
 *
 * Hide survives in the overflow, because putting a lead away is a real thing
 * to want and it is not the same as deciding about it. Hold is no longer
 * offered; rows still holding it read as undecided, which is what it meant.
 *
 * The pipeline itself runs outside this app and is not startable from here.
 * That is deliberate for now rather than missing: it spends money per run, and
 * a button that quietly bills is worse than no button.
 */

const TIERS = [
  { value: "", label: "All tiers" },
  { value: "A", label: "Tier A" },
  { value: "B", label: "Tier B" },
  { value: "C", label: "Tier C" },
];

// The funnel, in order, and the only way to slice this table. Each one is a
// tile you click rather than an option you find in a select — a count you
// cannot act on and a filter you cannot see the size of were the same three
// facts printed twice.
//
// `blocked` is the one that was nowhere on the page: a lead the pipeline has
// not routed cannot be emailed whatever its decision says, and six leads marked
// send were sitting in it.
const VIEWS = [
  { value: "review", label: "To review", hint: "nobody has said send" },
  { value: "queued", label: "Queued to send", hint: "goes on the next tick" },
  { value: "sent", label: "Sent", hint: "handed to Lemlist" },
  { value: "blocked", label: "Needs review", hint: "cannot send yet" },
];

const PAGE_SIZE = 50;

// The columns, and everything true about each one in a single place: how wide,
// which way a first sort click goes, and what kind of filter its popover
// offers. The header and the body both read this, so a column cannot appear in
// one and not the other.
//
// `select` is the leading checkbox and `actions` the trailing Details button:
// both fixed, neither reorderable, because a table whose checkbox has wandered
// into the middle is a table nobody can use.
// No per-column filter popovers. Every column that had one was already
// reachable from the toolbar above it or the tiles above that, so the page
// carried two filtering systems that did the same job and disagreed about
// where you would look for it. Sorting, dragging and resizing stay.
//
// "Affiliate app" is gone with them. It is the defining fact of a tier — Tier A
// means there is no affiliate app — so on a table that is mostly Tier A it was
// a column of the word "none".
const COLUMNS = [
  { key: "tier", label: "Tier", width: 80, sort: "asc" },
  { key: "brand_name", label: "Brand", width: 260, sort: "asc", fill: true },
  { key: "distinct_creators_90d", label: "Creators", width: 110, sort: "desc", right: true },
  { key: "contact_email", label: "Email", width: 240, sort: "asc" },
  { key: "state", label: "State", width: 130, sort: "desc" },
  { key: "actions", label: "Actions", width: 190, resizable: false },
];
const FIXED_KEYS = ["actions"];
const DEFAULT_WIDTHS = fitWidths(COLUMNS);
const SELECT_COL_WIDTH = 36;

// "Tier A (11)" rather than a tile saying 11 somewhere else on the page. A
// count is most useful attached to the thing it counts, where it also tells you
// whether a filter is worth clicking before you click it.
function withCounts(options, counts) {
  if (!counts) return options;
  return options.map((o) => {
    const n = o.value ? counts[o.value] : null;
    return n ? { ...o, label: `${o.label} (${n})` } : o;
  });
}

export default function ProspectingPage() {
  const { theme } = useTheme();
  const [leads, setLeads] = useState([]);
  const [stats, setStats] = useState(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState(null);
  const [page, setPage] = useState(0);
  const [tier, setTier] = useState("");
  const [view, setView] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [saving, setSaving] = useState(null);
  const [sort, setSort] = useState({ sortBy: "", sortDir: "desc" });
  const [menu, setMenu] = useState(null);

  const { widths, sized, startResize, resetWidth } =
    useColumnWidths("prospector-leads", DEFAULT_WIDTHS, FIXED_KEYS);
  const { orderedColumns, dragHandleProps, dropTargetProps, dragOverKey } =
    useColumnOrder("prospector-leads", COLUMNS, FIXED_KEYS);

  const handleSort = useCallback((colKey, defaultDir) => {
    setSort((cur) => nextSort(cur, colKey, defaultDir));
    setPage(0);
  }, []);

  // Clicking the tile you are already on clears it, so the same control both
  // narrows the table and gives you the whole list back.
  const chooseView = useCallback((next) => {
    setView((cur) => (cur === next ? "" : next));
    setPage(0);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    try {
      const [rows, s] = await Promise.all([
        api.getProspectingLeads({
          tier, view, q,
          sortBy: sort.sortBy, sortDir: sort.sortDir,
          limit: PAGE_SIZE, offset: page * PAGE_SIZE,
        }),
        api.getProspectingStats(),
      ]);
      setLeads(rows.leads || []);
      setTotal(rows.total || 0);
      setStats(s);
    } catch (err) {
      // The table ships with the pipeline, not with this app, so "not set up
      // yet" is a normal state and should read as one.
      setProblem(err?.hint || err?.message || "could not load leads");
      setLeads([]);
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, [tier, view, q, page, sort.sortBy, sort.sortDir]);

  useEffect(() => { load(); }, [load]);

  async function decide(handle, next, note) {
    setSaving(handle);
    try {
      const updated = await api.setProspectingDecision(handle, next, note);
      setLeads((rows) => rows.map((r) => (r.handle === handle ? { ...r, ...updated } : r)));
      api.getProspectingStats().then(setStats).catch(() => {});
    } finally {
      setSaving(null);
    }
  }

  async function decideMany(next) {
    const handles = [...selected];
    if (!handles.length) return;
    setSaving("bulk");
    try {
      await api.setProspectingDecisions(handles, next, null);
      setSelected(new Set());
      await load();
    } finally {
      setSaving(null);
    }
  }

  function toggle(handle) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(handle) ? next.delete(handle) : next.add(handle);
      return next;
    });
  }

  const allShown = leads.length > 0 && leads.every((l) => selected.has(l.handle));
  // Never narrower than the sum of its columns, so a table dragged wide
  // scrolls rather than squeezing every column back.
  const totalWidth = SELECT_COL_WIDTH + orderedColumns.reduce(
    (sum, c) => sum + (c.fill && !sized.has(c.key) ? 160 : (widths[c.key] || c.width)), 0);

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, color: theme.text }}>Brands</h1>
        <p style={{ margin: "6px 0 0", color: theme.textMuted, fontSize: 13, maxWidth: 680 }}>
          Shopify brands with creators posting about them. Tier A have no affiliate app,
          so they cannot attribute any of it. A lead is emailed only if it is marked
          Send.
        </p>
      </div>

      {problem && (
        <Card>
          <div style={{ padding: 16, color: theme.textMuted, fontSize: 13 }}>
            <strong style={{ color: theme.text }}>Not set up yet.</strong> {problem}
          </div>
        </Card>
      )}

      <Campaigns theme={theme} />

      <ViewTiles stats={stats} loading={loading && !stats} theme={theme}
                 view={view} onChoose={chooseView} />

      <Card>
        {/* Filters sized to their contents, like everywhere else in ops: a
            full-width select reads as a form, and this is a toolbar. */}
        <div style={{
          display: "flex", gap: 10, padding: 12, flexWrap: "wrap", alignItems: "center",
          borderBottom: `1px solid ${theme.border}`,
        }}>
          <div style={{ width: 150 }}>
            <Select value={tier} onChange={(v) => { setTier(v); setPage(0); }}
                    options={withCounts(TIERS, stats?.byTier)} ariaLabel="Tier" size="sm" />
          </div>
          <input
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(0); }}
            placeholder="Search"
            aria-label="Search leads"
            style={{
              width: 200, padding: "6px 10px", borderRadius: 8,
              border: `1px solid ${theme.border}`, background: theme.inputBg,
              color: theme.text, fontSize: 13,
            }}
          />
          <div style={{ flex: 1 }} />
          <span style={{ color: theme.textMuted, fontSize: 12 }}>
            {total} lead{total === 1 ? "" : "s"}
          </span>
          {selected.size > 0 && (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ color: theme.textMuted, fontSize: 12 }}>{selected.size} selected</span>
              <Btn onClick={() => decideMany("send")} disabled={saving === "bulk"}>Send</Btn>
              <Btn variant="secondary" onClick={() => decideMany("hide")} disabled={saving === "bulk"}>Hide</Btn>
            </div>
          )}
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{
            width: "100%", minWidth: totalWidth, borderCollapse: "collapse",
            fontSize: 13, tableLayout: "fixed",
          }}>
            {/* Fixed layout plus a colgroup: without it the browser sizes
                columns from their content and every drag is argued with. */}
            <colgroup>
              <col style={{ width: SELECT_COL_WIDTH }} />
              {orderedColumns.map((col) => (
                <col key={col.key} style={col.fill && !sized.has(col.key)
                  ? { minWidth: 160 }
                  : { width: widths[col.key] || col.width }} />
              ))}
            </colgroup>
            <thead>
              <tr style={{ borderBottom: `1px solid ${theme.border}`, color: theme.textMuted }}>
                <th style={{ padding: "8px 10px" }}>
                  <input
                    type="checkbox"
                    checked={allShown}
                    aria-label="Select every lead on this page"
                    onChange={() =>
                      setSelected(allShown ? new Set() : new Set(leads.map((l) => l.handle)))
                    }
                  />
                </th>
                {orderedColumns.map((col) => (
                  <th
                    key={col.key}
                    style={{
                      padding: "8px 10px", fontWeight: 500,
                      textAlign: col.right ? "right" : "left",
                      ...headerCellStyle,
                      background: dragOverKey === col.key ? theme.accentLight : undefined,
                    }}
                    {...dropTargetProps(col.key)}
                  >
                    <HeaderCell
                      align={col.right ? "right" : "left"}
                      grip={!FIXED_KEYS.includes(col.key) && (
                        <DragHandle colKey={col.key} dragHandleProps={dragHandleProps} theme={theme} />
                      )}
                    >
                      {col.sort ? (
                        <SortLabel
                          theme={theme}
                          label={col.label}
                          colKey={col.key}
                          sortBy={sort.sortBy}
                          sortDir={sort.sortDir}
                          defaultDir={col.sort}
                          onSort={handleSort}
                        />
                      ) : col.label}
                    </HeaderCell>
                    {col.resizable !== false && (
                      <ResizeHandle colKey={col.key} startResize={startResize}
                                    resetWidth={resetWidth} theme={theme} />
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                // Same shape and size as the table it stands in for.
                <SkeletonTableRows
                  rows={Math.min(Math.max(leads.length, 4), PAGE_SIZE)}
                  cols={orderedColumns.length + 1}
                />
              ) : leads.length === 0 ? (
                <tr>
                  <td colSpan={orderedColumns.length + 1}
                      style={{ padding: 24, color: theme.textMuted, textAlign: "center" }}>
                    {problem ? "—" : "No leads match these filters."}
                  </td>
                </tr>
              ) : (
                leads.map((lead) => (
                  <Fragment key={lead.handle}>
                    <LeadRow
                      lead={lead}
                      columns={orderedColumns}
                      theme={theme}
                      selected={selected.has(lead.handle)}
                      onToggle={() => toggle(lead.handle)}
                      onOpen={() => setOpen(open === lead.handle ? null : lead.handle)}
                      onDecide={decide}
                      saving={saving === lead.handle}
                      expanded={open === lead.handle}
                      menuOpen={menu === lead.handle}
                      onMenu={setMenu}
                    />
                    {open === lead.handle && (
                      <LeadDetail lead={lead} theme={theme} span={orderedColumns.length + 1} />
                    )}
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>

        <Pagination
          page={page + 1}
          pageSize={PAGE_SIZE}
          total={total}
          onPageChange={(n) => setPage(Math.max(0, n - 1))}
        />
      </Card>

      <p style={{ color: theme.textMuted, fontSize: 12, margin: 0 }}>
        Leads are produced by the linkable-prospector pipeline, which runs outside this app
        and syncs here. It is not startable from this page on purpose: every run spends money,
        and a button that quietly bills is worse than no button.
      </p>
    </div>
  );
}

/**
 * Campaigns: a goal, a budget, and the opinion to stop.
 *
 * Two state columns, not one. The campaign reports `state`; a person sets
 * `desired_state`. The runner lives elsewhere and on its own clock, so if this
 * page wrote `state` directly, a pass finishing a second later would overwrite
 * the instruction it was meant to be following.
 *
 * Which is also why Start reads as "asked to start" until the runner agrees.
 * Anything else would be this page claiming something it cannot know.
 */
function Campaigns({ theme }) {
  const [campaigns, setCampaigns] = useState([]);
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);

  const load = useCallback(async () => {
    try {
      const { campaigns: rows } = await api.getProspectingCampaigns();
      setCampaigns(rows || []);
      setProblem(null);
    } catch (err) {
      setProblem(err?.hint || err?.message || "could not load campaigns");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function setState(name, desired) {
    setBusy(name);
    try {
      await api.setProspectingCampaignState(name, desired);
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (problem) return null;

  return (
    <Card>
      <NewCampaign theme={theme} onCreated={load} />
      {!campaigns.length && (
        <div style={{ padding: 16, color: theme.textMuted, fontSize: 13 }}>
          No campaigns yet. A campaign is a goal and a budget: it runs until it has the
          leads it was asked for or has spent what it was given.
        </div>
      )}
      {/* One line each, not a table.
          Three lines per campaign - the state, "asked to start", and the
          sentence explaining why it stopped - made two campaigns taller than
          the leads they produced, and it was the first thing on the page.
          The explanation is still there, on hover, where it costs nothing to
          have until you want it. */}
      {campaigns.map((c) => {
        const asked = c.desired_state === "running";
        const actually = c.state === "running";
        const why = [
          asked && !actually ? "asked to start" : null,
          c.stopped_reason,
          c.last_error,
        ].filter(Boolean).join(" · ");
        return (
          <div key={c.name} style={{
            display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
            padding: "10px 14px", borderTop: `1px solid ${theme.border}`, fontSize: 13,
          }}>
            <span style={{ color: theme.text, fontWeight: 500 }}>{c.name}</span>
            <span
              title={why || undefined}
              style={{
                color: actually ? theme.success : theme.textMuted,
                borderBottom: why ? `1px dotted ${theme.border}` : "none",
                cursor: why ? "help" : "default",
              }}
            >
              {c.state}{asked && !actually ? " (starting)" : ""}
            </span>
            <span style={{ color: theme.textMuted, fontSize: 12 }}>
              tier {c.goal_tiers} · {c.source}
            </span>
            <div style={{ flex: 1 }} />
            <span style={{ color: theme.text, fontVariantNumeric: "tabular-nums" }}>
              {c.leads_found}/{c.goal_leads}
            </span>
            <span style={{ color: theme.textMuted, fontVariantNumeric: "tabular-nums" }}>
              ${Number(c.spent_usd || 0).toFixed(2)} of ${Number(c.budget_usd).toFixed(2)}
            </span>
            <span style={{ color: theme.textMuted, fontSize: 12 }}>
              {c.passes} pass{c.passes === 1 ? "" : "es"}
            </span>
            <Btn
              size="sm"
              variant={asked ? "secondary" : "solid"}
              disabled={busy === c.name}
              onClick={() => setState(c.name, asked ? "off" : "running")}
            >
              {asked ? "Hold" : "Start"}
            </Btn>
          </div>
        );
      })}
    </Card>
  );
}

/**
 * Naming a campaign is choosing what to spend and when to stop, so the form
 * asks for exactly that and nothing else. Source, hashtags and countries have
 * sensible defaults; a goal and a budget do not, because they are the decision.
 *
 * It is created switched off. A campaign that starts the moment it is named
 * spends before anyone has read back what they typed.
 */
function NewCampaign({ theme, onCreated }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({
    name: "", goal_leads: 20, goal_tiers: "A", budget_usd: 5,
    source: "creator_calls", hashtags: "", countries: "",
  });

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const field = {
    padding: "6px 10px", borderRadius: 8, border: `1px solid ${theme.border}`,
    background: theme.inputBg, color: theme.text, fontSize: 13,
  };

  async function create() {
    setBusy(true); setError(null);
    try {
      await api.createProspectingCampaign({
        ...form,
        goal_leads: Number(form.goal_leads),
        budget_usd: Number(form.budget_usd),
        hashtags: form.hashtags || null,
        countries: form.countries || null,
      });
      setForm((f) => ({ ...f, name: "", hashtags: "" }));
      setOpen(false);
      await onCreated();
    } catch (err) {
      setError(err?.error || err?.message || "could not create it");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div style={{ padding: "12px 14px", borderBottom: `1px solid ${theme.border}`,
                    display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ color: theme.textMuted, fontSize: 12 }}>
          Campaigns — each has a goal and a budget, and stops itself when it has one or
          has spent the other.
        </span>
        <Btn onClick={() => setOpen(true)}>New campaign</Btn>
      </div>
    );
  }

  return (
    <div style={{ padding: 14, borderBottom: `1px solid ${theme.border}`,
                  display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
      <Labelled label="Name" theme={theme} width={190}>
        <input value={form.name} onChange={set("name")} placeholder="UK skincare"
               style={{ ...field, width: "100%" }} />
      </Labelled>
      <Labelled label="Leads wanted" theme={theme} width={110}>
        <input type="number" min="1" value={form.goal_leads} onChange={set("goal_leads")}
               style={{ ...field, width: "100%" }} />
      </Labelled>
      <Labelled label="Tiers" theme={theme} width={90}>
        <input value={form.goal_tiers} onChange={set("goal_tiers")} placeholder="A"
               style={{ ...field, width: "100%" }} />
      </Labelled>
      <Labelled label="Budget ($)" theme={theme} width={100}>
        <input type="number" min="0.5" step="0.5" value={form.budget_usd} onChange={set("budget_usd")}
               style={{ ...field, width: "100%" }} />
      </Labelled>
      <Labelled label="Hashtags" theme={theme} width={220}>
        <input value={form.hashtags} onChange={set("hashtags")}
               placeholder="ugccreatorwanted, creatorswanted"
               style={{ ...field, width: "100%" }} />
      </Labelled>
      <Btn onClick={create} disabled={busy || !form.name.trim()}>Create</Btn>
      <Btn variant="secondary" onClick={() => { setOpen(false); setError(null); }}>Cancel</Btn>
      <div style={{ width: "100%", color: theme.textMuted, fontSize: 11 }}>
        {error
          ? <span style={{ color: theme.danger }}>{error}</span>
          : "Created switched off. Press Start when you want it running."}
      </div>
    </div>
  );
}

function Labelled({ label, width, theme, children }) {
  return (
    <div style={{ width }}>
      <div style={{ color: theme.textMuted, fontSize: 11, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

/**
 * Four numbers, and each one is the filter for itself.
 *
 * They were three tiles that only described the table: you read "Undecided 1",
 * then went to a select in the toolbar below and found "Undecided" a second
 * time to actually see it. A count you cannot click is a fact you have to act
 * on somewhere else.
 *
 * The fourth is new. "Needs review" is the leads the pipeline has not routed,
 * which cannot be emailed whatever their decision says — six of them were
 * marked send and going nowhere, and the page gave no hint they existed.
 */
function ViewTiles({ stats, loading, theme, view, onChoose }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
      {VIEWS.map((t) => {
        const active = view === t.value;
        return (
          <Card key={t.value}>
            <button
              type="button"
              onClick={() => onChoose(t.value)}
              aria-pressed={active}
              style={{
                display: "block", width: "100%", textAlign: "left", padding: 14,
                background: active ? theme.accentLight : "transparent",
                border: "none", borderRadius: "inherit", cursor: "pointer", font: "inherit",
                // The selected tile is the only thing telling you why the table
                // below is short, so it has to survive a glance.
                boxShadow: active ? `inset 0 0 0 1px ${theme.accent}` : "none",
              }}
            >
              <div style={{ color: active ? theme.accent : theme.textMuted, fontSize: 12 }}>
                {t.label}
              </div>
              {loading ? (
                <Skeleton style={{ height: 26, width: 48, marginTop: 6 }} />
              ) : (
                <div style={{ fontSize: 24, color: theme.text, fontWeight: 600 }}>
                  {stats?.byView?.[t.value] ?? 0}
                </div>
              )}
              <div style={{ color: theme.textMuted, fontSize: 11, marginTop: 2 }}>{t.hint}</div>
            </button>
          </Card>
        );
      })}
    </div>
  );
}

/**
 * One lead, rendered in whatever order the header is currently in.
 *
 * The cells used to be a fixed sequence of <td>s, which is fine until columns
 * can be reordered - then the header says one thing and the body another. A
 * single renderer keyed on the column means they cannot disagree.
 */
function leadCell(col, { lead, theme, saving, onDecide, onOpen, expanded, menuOpen, onMenu }) {
  switch (col.key) {
    case "tier":
      return <TierBadge tier={lead.tier} theme={theme} />;
    case "brand_name":
      return (
        <>
          <div style={{ color: theme.text, overflow: "hidden", textOverflow: "ellipsis" }}>
            {lead.brand_name || lead.handle}
          </div>
          <a
            href={lead.domain ? `https://${lead.domain}` : lead.instagram_url}
            target="_blank" rel="noreferrer"
            style={{ color: theme.textMuted, fontSize: 12, textDecoration: "none" }}
          >
            {lead.domain || `@${lead.handle}`}
          </a>
        </>
      );
    case "distinct_creators_90d":
      return (
        <>
          <div style={{ color: theme.text, fontVariantNumeric: "tabular-nums" }}>
            {lead.distinct_creators_90d ?? 0}
          </div>
          <div style={{ color: theme.textMuted, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
            {(lead.creator_activity_score ?? 0).toFixed(2)}
          </div>
        </>
      );
    case "contact_email":
      return (
        <span title={lead.contact_email || ""}
              style={{ color: lead.contact_email ? theme.text : theme.textMuted }}>
          {lead.contact_email || "none found"}
        </span>
      );
    case "state":
      return <StateCell lead={lead} theme={theme} />;
    case "actions":
      // Header left, content grouped right and tight: the house rule for an
      // Actions column everywhere in ops.
      return (
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 6 }}>
          <SendToggle lead={lead} theme={theme} saving={saving} onDecide={onDecide} />
          <Btn variant="secondary" size="sm" onClick={onOpen}>
            {expanded ? "Less" : "Details"}
          </Btn>
          <RowMenu lead={lead} theme={theme} saving={saving}
                   open={menuOpen} onOpenChange={onMenu} onDecide={onDecide} />
        </div>
      );
    default:
      return lead[col.key] ?? null;
  }
}

/**
 * How far this lead has actually got, in one word.
 *
 * There were two columns for this — "Reply", which was blank until Lemlist
 * said something, and "Decision", which was three buttons. Neither answered
 * the question you actually arrive with, which is whether this brand has been
 * emailed yet, because that lives in a third column the table never showed
 * (`status`, and a lead that is not `routed` never goes).
 *
 * Read in the order things happen, so the first true one wins.
 */
function StateCell({ lead, theme }) {
  const [label, colour] =
    lead.reply_state && lead.reply_state !== "sent"
      ? [lead.reply_state.replace("_", " "), theme.success]
    : lead.pushed_at ? ["sent", theme.text]
    : lead.decision === "hide" ? ["hidden", theme.textMuted]
    : lead.status !== "routed" ? ["needs review", theme.warning]
    : lead.decision === "send" ? ["queued", theme.text]
    : ["—", theme.textMuted];
  return (
    <>
      <span style={{ color: colour }}>{label}</span>
      {/* Why it is held. The pipeline writes a sentence on every needs_review
          lead - "GB lead with entity_type=unknown: individual subscriber under
          PECR until confirmed otherwise" - and it was stored, synced, and shown
          nowhere. A state you cannot act on is a state you argue with. */}
      {lead.status !== "routed" && !lead.pushed_at && lead.review_reason && (
        <div title={lead.review_reason}
             style={{ color: theme.textMuted, fontSize: 11, whiteSpace: "normal", lineHeight: 1.3 }}>
          {lead.review_reason.split(":")[0]}
        </div>
      )}
    </>
  );
}

function LeadRow({ lead, columns, theme, selected, onToggle, onOpen, onDecide, saving, expanded,
                   menuOpen, onMenu }) {
  const held = lead.decision === "hold" || lead.decision === "hide";
  return (
    <tr
      style={{
        borderBottom: `1px solid ${theme.border}`,
        opacity: held ? 0.55 : 1,
        background: selected ? theme.hoverBg : "transparent",
      }}
    >
      <td style={{ padding: "6px 10px" }}>
        <input type="checkbox" checked={selected} onChange={onToggle}
               aria-label={`Select ${lead.brand_name || lead.handle}`} />
      </td>
      {columns.map((col) => (
        <td
          key={col.key}
          style={{
            padding: "6px 10px", color: theme.text,
            textAlign: col.right ? "right" : "left",
            // Clipped, so a long email cannot print itself over the next
            // column when somebody drags this one narrow.
            // Every column clips, so a long email cannot print itself over the
            // next one — except Actions, which has a menu that must escape.
            overflow: col.key === "actions" ? "visible" : "hidden",
            whiteSpace: col.key === "brand_name" ? "normal" : "nowrap",
            textOverflow: "ellipsis",
          }}
        >
          {leadCell(col, { lead, theme, saving, onDecide, onOpen, expanded, menuOpen, onMenu })}
        </td>
      ))}
    </tr>
  );
}

/**
 * The one bit that matters, as one button.
 *
 * `ops_require_decision` is on in the pipeline, so a lead is handed to Lemlist
 * if and only if its decision is `send`. Pending, hold and hide are all the
 * same instruction — don't — and giving three of them a button each meant the
 * table asked a three-way question about something with two answers.
 *
 * Clicking a sending row turns it back off, which is why it stays a button
 * rather than becoming a tick.
 */
function SendToggle({ lead, theme, saving, onDecide }) {
  const on = lead.decision === "send";
  return (
    <Btn
      size="sm"
      variant={on ? "solid" : "secondary"}
      color={on ? theme.success : undefined}
      disabled={saving}
      title={on ? "Marked send - click to stop it going" : "Mark this lead to be emailed"}
      style={{ padding: "4px 14px", fontSize: 12 }}
      onClick={() => onDecide(lead.handle, on ? "pending" : "send")}
    >
      {on ? "Sending" : "Send"}
    </Btn>
  );
}

/**
 * Putting a lead away, which is not the same as deciding about it.
 *
 * Behind an overflow because it is rare — nought rows out of twenty-seven use
 * it — and a rare action sitting permanently beside a common one is most of
 * what makes a table look busy.
 */
function RowMenu({ lead, theme, saving, open, onOpenChange, onDecide }) {
  const hidden = lead.decision === "hide";
  return (
    <div style={{ position: "relative" }}>
      <Btn variant="secondary" size="sm" disabled={saving}
           aria-label={`More actions for ${lead.brand_name || lead.handle}`}
           aria-expanded={open}
           onClick={() => onOpenChange(open ? null : lead.handle)}>
        ···
      </Btn>
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 20,
            background: theme.cardBg, border: `1px solid ${theme.border}`,
            borderRadius: 8, boxShadow: "0 6px 20px rgba(0,0,0,0.18)", minWidth: 150,
            padding: 4,
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => { onOpenChange(null); onDecide(lead.handle, hidden ? "pending" : "hide"); }}
            style={{
              display: "block", width: "100%", textAlign: "left", padding: "7px 10px",
              background: "transparent", border: "none", cursor: "pointer",
              color: theme.text, fontSize: 13, borderRadius: 6, font: "inherit",
            }}
          >
            {hidden ? "Unhide" : "Hide this lead"}
          </button>
        </div>
      )}
    </div>
  );
}

function TierBadge({ tier, theme }) {
  const colours = { A: theme.success, B: theme.warning, C: theme.textMuted };
  return (
    <span
      style={{
        display: "inline-block", minWidth: 20, textAlign: "center",
        padding: "2px 8px", borderRadius: 6, fontSize: 12, fontWeight: 600,
        color: colours[tier] || theme.textMuted,
        border: `1px solid ${colours[tier] || theme.border}`,
      }}
    >
      {tier || "—"}
    </span>
  );
}

/**
 * Everything known about one lead.
 *
 * Laid out in two parts rather than as one grid of facts. An auto-fitting grid
 * put a two-line sentence about why a lead is Tier A beside a one-word country
 * and a number, each column as wide as the widest thing in it, so nothing
 * lined up and the eye had no left edge to follow. The sentences are sentences
 * now, full width and at the top; the short facts are a proper aligned list
 * underneath, label and value in fixed columns.
 */
function LeadDetail({ lead, theme, span = 9 }) {
  // The long ones read as prose and get their own line.
  const prose = [
    ["Why this tier", lead.tier_reason],
    ["Creators seen posting about them", lead.top_creators],
    ["Note", lead.ops_note],
  ].filter(([, v]) => v);

  // The short ones line up.
  const facts = [
    ["Products", lead.product_count],
    ["Affiliate app", lead.affiliate_app && lead.affiliate_app !== "none" ? lead.affiliate_app : "none"],
    ["Entity", lead.entity_type
      ? `${lead.entity_type.replace(/_/g, " ")}${lead.entity_verified ? " · verified" : " · unverified"}`
      : null],
    ["Founder", lead.founder_name],
    ["Country", lead.country],
    ["Found via", lead.source],
    ["Pipeline status", lead.status],
  ].filter(([, v]) => v !== null && v !== undefined && v !== "");

  return (
    <tr>
      <td colSpan={span} style={{ background: theme.hoverBg, padding: "16px 20px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1100 }}>

          {prose.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {prose.map(([label, value]) => (
                <div key={label}>
                  <div style={{ color: theme.textMuted, fontSize: 11, marginBottom: 2 }}>{label}</div>
                  <div style={{ color: theme.text, fontSize: 13, lineHeight: 1.5 }}>{String(value)}</div>
                </div>
              ))}
            </div>
          )}

          {lead.intent_post_url && (
            <div>
              <div style={{ color: theme.textMuted, fontSize: 11, marginBottom: 2 }}>Open call</div>
              <a href={lead.intent_post_url} target="_blank" rel="noreferrer"
                 style={{ color: theme.accent, fontSize: 13 }}>{lead.intent_post_url}</a>
            </div>
          )}

          {/* A fixed label column, so every value starts at the same place. */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
                        columnGap: 32, rowGap: 6 }}>
            {facts.map(([label, value]) => (
              <div key={label} style={{ display: "flex", gap: 12, fontSize: 13, lineHeight: 1.6 }}>
                <span style={{ color: theme.textMuted, minWidth: 110, flexShrink: 0 }}>{label}</span>
                <span style={{ color: theme.text }}>{String(value)}</span>
              </div>
            ))}
          </div>

          <CreatorList text={lead.creator_list} theme={theme} />

          <SentEmails handle={lead.handle} pushed={Boolean(lead.pushed_at)} theme={theme} />
        </div>
      </td>
    </tr>
  );
}

/**
 * The emails themselves: what went, what is still to come, and what each one
 * actually said.
 *
 * Reconstructed rather than stored. Lemlist keeps only the first line of a
 * message on an activity, but it keeps the template and this lead's variables,
 * and putting one through the other is exactly what it did when it sent. A
 * copy saved by us at push time would eventually disagree with the recipient's
 * inbox, quietly, the first time anybody edited the sequence.
 *
 * It earned itself immediately: the first render showed the last email in the
 * sequence opening with "there," rather than "Hi there," - a greeting lost
 * when some broken fallback syntax came out, and one nobody would have seen
 * for seven days.
 */
function SentEmails({ handle, pushed, theme }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      setData(await api.getSentEmails(handle, "brand"));
    } catch (err) {
      setError(err?.hint || err?.message || "could not read the emails");
    } finally {
      setLoading(false);
    }
  }, [handle]);

  if (!pushed) {
    return (
      <div style={{ marginTop: 12, color: theme.textMuted, fontSize: 12 }}>
        Nothing sent. Mark this lead <strong>send</strong> and the next tick hands it to Lemlist.
      </div>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      {!data && !loading && (
        <Btn variant="secondary" size="sm" onClick={load}>Show the emails</Btn>
      )}
      {loading && <Skeleton style={{ height: 60 }} />}
      {error && <div style={{ color: "#dc2626", fontSize: 12 }}>{error}</div>}
      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ color: theme.textMuted, fontSize: 12 }}>
            {data.campaignName}{data.from ? ` · from ${data.from}` : ""} · to {data.email}
          </div>
          {data.note && <div style={{ color: theme.textMuted, fontSize: 12 }}>{data.note}</div>}
          {(data.steps || []).map((step) => (
            <div key={step.index} style={{
              border: `1px solid ${theme.border}`, borderRadius: 8,
              background: theme.surface, opacity: step.sentAt ? 1 : 0.6,
            }}>
              <div style={{
                padding: "6px 10px", borderBottom: `1px solid ${theme.border}`,
                display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12,
              }}>
                <span style={{ color: theme.text }}>Step {step.index}</span>
                <span style={{ color: theme.textMuted }}>
                  {step.sentAt
                    ? `sent ${new Date(step.sentAt).toLocaleString()}`
                    : `due day ${step.delayDays}`}
                </span>
                {step.events.filter((e) => e.type !== "emailsSent").map((e, i) => (
                  <span key={i} style={{ color: theme.success }}>
                    {e.type.replace("emails", "").toLowerCase()}
                  </span>
                ))}
              </div>
              {step.subject && (
                <div style={{ padding: "6px 10px", color: theme.text, fontSize: 13, fontWeight: 500 }}>
                  {step.subject}
                </div>
              )}
              <div style={{
                padding: "0 10px 10px", whiteSpace: "pre-wrap",
                color: theme.textMuted, fontSize: 13,
              }}>{step.body}</div>
            </div>
          ))}
          {/* {{signature}} is resolved by Lemlist from the sending mailbox, so
              it is the one thing here that cannot be shown: we do not have it. */}
          <div style={{ color: theme.textMuted, fontSize: 11 }}>
            Reconstructed from the sequence and this lead's variables. Any
            {" "}<code>{"{{signature}}"}</code> above is filled in by Lemlist from the
            sending mailbox, so it is the one part we cannot show.
          </div>
        </div>
      )}
    </div>
  );
}


/**
 * The list the first email offers to send.
 *
 * "I've got the full list - every handle, every post. Want me to send it over?"
 * is the ask that gets a reply, and it only works if the answer exists the
 * moment somebody says yes. This is that answer, one click from the lead, so
 * replying is a paste rather than a job.
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
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <span style={{ color: theme.textMuted, fontSize: 11 }}>
          The list we offered them ({lines.length})
        </span>
        <Btn variant="secondary" size="sm" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Btn>
      </div>
      <div style={{
        maxHeight: 160, overflowY: "auto", whiteSpace: "pre-wrap",
        background: theme.surface, border: `1px solid ${theme.border}`,
        borderRadius: 8, padding: 10, color: theme.text, fontSize: 12,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      }}>{text}</div>
    </div>
  );
}
