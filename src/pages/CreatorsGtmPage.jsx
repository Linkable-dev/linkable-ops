import { useCallback, useEffect, useState } from "react";
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
 * Creator GTM: people worth inviting onto Linkable.
 *
 * Every creator here was found by the brand pipeline, not by a separate search.
 * They turned up because they posted about a brand we were looking at, which is
 * the one fact that makes a creator worth approaching — they already do this,
 * for brands of roughly the size Linkable serves. The brand side was collecting
 * them as evidence and throwing them away as people.
 *
 * Which is why the column that matters is "Brands": someone seen posting about
 * three different brands is doing it as a habit, where one could be a customer
 * who liked something.
 *
 * Same contract as Brands, and the same shape on screen so neither page has to
 * be learned twice: one Invite toggle per row, four tiles that are also the
 * filter, and no per-column popovers.
 *
 * A creator is invited if and only if the decision is `send`. Pending, hold and
 * hide are one instruction to the sender - not this one - so the row asks one
 * question rather than three. Across all 49 creators the old three-button
 * control had produced exactly nothing: every row still reads `pending`.
 */

const TIERS = [
  { value: "", label: "All tiers" },
  { value: "A", label: "Tier A" },
  { value: "B", label: "Tier B" },
  { value: "C", label: "Tier C" },
];

// The funnel, and the only way to slice this table. Each is a tile you click.
//
// `blocked` is the one that was nowhere: a creator who is not qualified, or
// whose bio gave up no email, cannot be invited however often somebody clicks
// invite. The server already knew - it sends a `blocked` reason per row - but
// there was no way to ask how many there were.
const VIEWS = [
  { value: "review", label: "To review", hint: "nobody has said invite" },
  { value: "queued", label: "Queued to invite", hint: "goes on the next tick" },
  { value: "invited", label: "Invited", hint: "handed to Lemlist" },
  { value: "blocked", label: "Cannot invite", hint: "no email, or not qualified" },
];

const PAGE_SIZE = 50;

// A count belongs on the thing it counts, where it also says whether an option
// is worth clicking before you click it.
function withCounts(options, counts) {
  if (!counts) return options;
  return options.map((o) => {
    const n = o.value ? counts[o.value] : null;
    return n ? { ...o, label: `${o.label} (${n})` } : o;
  });
}

// Same shape as the Brands table: one place that says what each column is,
// read by both the header and the body so they cannot drift apart.
//
// No per-column filter popovers - the tiles and the toolbar already reach
// everything they reached, from one place instead of two. "Found via" is gone
// with them: it reads brand_mentions on all 49 rows, because that is the only
// finder that has run.
const COLUMNS = [
  { key: "tier", label: "Tier", width: 80, sort: "asc" },
  { key: "handle", label: "Creator", width: 260, sort: "asc", fill: true },
  { key: "followers", label: "Followers", width: 120, sort: "desc", right: true },
  { key: "brands_posted_about", label: "Brands", width: 110, sort: "desc", right: true },
  { key: "contact_email", label: "Email", width: 240, sort: "asc" },
  { key: "state", label: "State", width: 150, sort: "desc" },
  { key: "actions", label: "Actions", width: 180, resizable: false },
];
const FIXED_KEYS = ["actions"];
const DEFAULT_WIDTHS = fitWidths(COLUMNS);

export default function CreatorsGtmPage() {
  const { theme } = useTheme();
  const [creators, setCreators] = useState([]);
  const [stats, setStats] = useState(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState(null);
  const [page, setPage] = useState(0);
  const [tier, setTier] = useState("");
  const [view, setView] = useState("");
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(null);

  const [sort, setSort] = useState({ sortBy: "", sortDir: "desc" });
  const [menu, setMenu] = useState(null);

  const { widths, sized, startResize, resetWidth } =
    useColumnWidths("prospector-creators", DEFAULT_WIDTHS, FIXED_KEYS);
  const { orderedColumns, dragHandleProps, dropTargetProps, dragOverKey } =
    useColumnOrder("prospector-creators", COLUMNS, FIXED_KEYS);

  const handleSort = useCallback((colKey, defaultDir) => {
    setSort((cur) => nextSort(cur, colKey, defaultDir));
    setPage(0);
  }, []);
  // Clicking the tile you are on clears it, so one control both narrows the
  // table and gives the whole list back.
  const chooseView = useCallback((next) => {
    setView((cur) => (cur === next ? "" : next));
    setPage(0);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    try {
      const [rows, s] = await Promise.all([
        api.getProspectingCreators({
          tier, view, q,
          sortBy: sort.sortBy, sortDir: sort.sortDir,
          limit: PAGE_SIZE, offset: page * PAGE_SIZE,
        }),
        api.getProspectingCreatorStats(),
      ]);
      setCreators(rows.creators || []);
      setTotal(rows.total || 0);
      setStats(s);
    } catch (err) {
      setProblem(err?.hint || err?.message || "could not load creators");
      setCreators([]);
    } finally {
      setLoading(false);
    }
  }, [tier, view, q, page, sort.sortBy, sort.sortDir]);

  useEffect(() => { load(); }, [load]);

  async function decide(handle, next) {
    setSaving(handle);
    try {
      const updated = await api.setProspectingCreatorDecision(handle, next);
      setCreators((rows) => rows.map((r) => (r.handle === handle ? { ...r, ...updated } : r)));
      api.getProspectingCreatorStats().then(setStats).catch(() => {});
    } finally {
      setSaving(null);
    }
  }

  // Three, not five. Tier A and Tier B were both already a column in the table
  // and an option in the tier filter, so the page said the same thing three
  // times before showing a single creator; those counts are on the filter now.
  const totalWidth = orderedColumns.reduce(
    (sum, c) => sum + (c.fill && !sized.has(c.key) ? 160 : (widths[c.key] || c.width)), 0);


  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, color: theme.text }}>Creators</h1>
        <p style={{ margin: "6px 0 0", color: theme.textMuted, fontSize: 13, maxWidth: 700 }}>
          Found by the brand pipeline: they posted about a brand we were looking at, which
          means they already do this. A creator is invited only if marked Invite.
        </p>
      </div>


      {problem && (
        <Card>
          <div style={{ padding: 16, color: theme.textMuted, fontSize: 13 }}>
            <strong style={{ color: theme.text }}>Not set up yet.</strong> {problem}
          </div>
        </Card>
      )}

      {/* Above the counts, because finding creators is the job and the counts
          describe what finding them produced. */}
      <FindCreators theme={theme} onAdded={load} />

      <ViewTiles stats={stats} loading={loading && !stats} theme={theme}
                 view={view} onChoose={chooseView} />

      <Card>
        <div style={{ display: "flex", gap: 10, padding: 12, flexWrap: "wrap",
                      alignItems: "center", borderBottom: `1px solid ${theme.border}` }}>
          <div style={{ width: 150 }}>
            <Select value={tier} onChange={(v) => { setTier(v); setPage(0); }}
                    options={withCounts(TIERS, stats?.byTier)} ariaLabel="Tier" size="sm" />
          </div>
          <input
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(0); }}
            placeholder="Search"
            aria-label="Search creators"
            style={{ width: 200, padding: "6px 10px", borderRadius: 8,
                     border: `1px solid ${theme.border}`, background: theme.inputBg,
                     color: theme.text, fontSize: 13 }}
          />
          <div style={{ flex: 1 }} />
          <span style={{ color: theme.textMuted, fontSize: 12 }}>
            {total} creator{total === 1 ? "" : "s"}
          </span>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{
            width: "100%", minWidth: totalWidth, borderCollapse: "collapse",
            fontSize: 13, tableLayout: "fixed",
          }}>
            <colgroup>
              {orderedColumns.map((col) => (
                <col key={col.key} style={col.fill && !sized.has(col.key)
                  ? { minWidth: 160 }
                  : { width: widths[col.key] || col.width }} />
              ))}
            </colgroup>
            <thead>
              <tr style={{ color: theme.textMuted, borderBottom: `1px solid ${theme.border}` }}>
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
                <SkeletonTableRows
                  rows={Math.min(Math.max(creators.length, 4), PAGE_SIZE)}
                  cols={orderedColumns.length}
                />
              ) : creators.length === 0 ? (
                <tr>
                  <td colSpan={orderedColumns.length}
                      style={{ padding: 24, color: theme.textMuted, textAlign: "center" }}>
                    {problem ? "—" : "No creators match these filters."}
                  </td>
                </tr>
              ) : creators.map((c) => {
                const held = c.decision === "hold" || c.decision === "hide";
                return (
                  <tr key={c.handle} style={{ borderBottom: `1px solid ${theme.border}`,
                                              opacity: held ? 0.55 : 1 }}>
                    {orderedColumns.map((col) => (
                      <td key={col.key} style={{
                        padding: "6px 10px", color: theme.text,
                        textAlign: col.right ? "right" : "left",
                        // Everything clips so a long email cannot print over the
                        // next column - except Actions, whose menu must escape.
                        overflow: col.key === "actions" ? "visible" : "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: col.key === "handle" ? "normal" : "nowrap",
                      }}>
                        {creatorCell(col, { c, theme, saving, decide,
                                            menuOpen: menu === c.handle, onMenu: setMenu })}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <Pagination page={page + 1} pageSize={PAGE_SIZE} total={total}
                    onPageChange={(n) => setPage(Math.max(0, n - 1))} />
      </Card>
    </div>
  );
}


/**
 * Describe the creators you want; a model writes the search; you read it before
 * it spends anything.
 *
 * Two steps on purpose. Planning is free and is the half most worth a human
 * eye - which words are in a creator's own bio is exactly where judgement still
 * beats the model. Running bills 0.01 credits per creator the provider returns,
 * which is cheap enough to do often and not cheap enough to do by accident.
 *
 * The plan is shown as the filters that will actually be sent, including the
 * parts the model does not get to choose: creators not businesses, no private
 * accounts, nothing dormant for a year, and an engagement ceiling, because
 * sustained 25% engagement on 20k followers is a bought audience and the
 * results are sorted by engagement.
 */
function FindCreators({ theme, onAdded }) {
  const [prompt, setPrompt] = useState("");
  const [plan, setPlan] = useState(null);
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [limit, setLimit] = useState(25);

  async function makePlan() {
    setBusy("plan"); setError(null); setResults(null);
    try {
      setPlan(await api.planCreatorSearch(prompt));
    } catch (err) {
      setError(err?.hint || err?.message || "could not plan the search");
    } finally {
      setBusy(null);
    }
  }

  async function run() {
    setBusy("run"); setError(null);
    try {
      setResults(await api.runCreatorSearch(plan.query, limit));
    } catch (err) {
      setError(err?.hint || err?.message || "the search failed");
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    setBusy("add"); setError(null);
    try {
      const fresh = results.creators.filter((c) => !c.known);
      await api.addFoundCreators(fresh, prompt);
      setResults(null); setPlan(null); setPrompt("");
      onAdded?.();
    } catch (err) {
      setError(err?.hint || err?.message || "could not add them");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        <div>
          <div style={{ color: theme.text, fontSize: 14, fontWeight: 600 }}>Find more creators</div>
          <div style={{ color: theme.textMuted, fontSize: 12, marginTop: 2 }}>
            Describe who you want. Nothing is spent until you run the search.
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && prompt.trim()) makePlan(); }}
            placeholder="UK skincare creators who already do UGC, 10-50k followers"
            aria-label="Describe the creators you want"
            style={{
              flex: 1, minWidth: 280, padding: "8px 12px", borderRadius: 8,
              border: `1px solid ${theme.border}`, background: theme.inputBg,
              color: theme.text, fontSize: 13,
            }}
          />
          <Btn onClick={makePlan} disabled={!prompt.trim() || busy === "plan"} loading={busy === "plan"}>
            Plan the search
          </Btn>
        </div>

        {error && <div style={{ color: "#dc2626", fontSize: 12 }}>{error}</div>}

        {plan && !results && (
          <div style={{ border: `1px solid ${theme.border}`, borderRadius: 8, padding: 12 }}>
            <div style={{ color: theme.text, fontSize: 13 }}>{plan.query.rationale}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "8px 0" }}>
              {Object.entries(plan.filters).map(([k, v]) => (
                <span key={k} style={{
                  fontSize: 11, color: theme.textMuted, background: theme.surfaceAlt,
                  border: `1px solid ${theme.border}`, borderRadius: 6, padding: "2px 8px",
                }}>
                  {k}: {typeof v === "object" ? JSON.stringify(v) : String(v)}
                </span>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ color: theme.textMuted, fontSize: 12 }}>Return at most</span>
              <input type="number" min={1} max={100} value={limit}
                     onChange={(e) => setLimit(Number(e.target.value))}
                     aria-label="How many creators"
                     style={{ width: 70, padding: "6px 8px", borderRadius: 8,
                              border: `1px solid ${theme.border}`, background: theme.inputBg,
                              color: theme.text, fontSize: 13 }} />
              <span style={{ color: theme.textMuted, fontSize: 12 }}>
                ≈ {(limit * (plan.creditsPerCreator || 0.01)).toFixed(2)} credits
              </span>
              <Btn onClick={run} disabled={!plan.configured || busy === "run"} loading={busy === "run"}>
                Run the search
              </Btn>
              {!plan.configured && (
                <span style={{ color: theme.textMuted, fontSize: 12 }}>
                  Provider key not set on this server.
                </span>
              )}
            </div>
          </div>
        )}

        {results && (
          <div style={{ border: `1px solid ${theme.border}`, borderRadius: 8 }}>
            <div style={{ padding: "10px 12px", borderBottom: `1px solid ${theme.border}`,
                          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ color: theme.text, fontSize: 13 }}>
                {results.creators.length} found, {results.newCount} new
              </span>
              <span style={{ color: theme.textMuted, fontSize: 12 }}>
                {results.creditsSpent} credits spent
              </span>
              <div style={{ flex: 1 }} />
              <Btn onClick={add} disabled={!results.newCount || busy === "add"} loading={busy === "add"}>
                Add {results.newCount} to creators
              </Btn>
            </div>
            {/* A dropped location is a much wider search than the one asked
                for, so it is said out loud rather than swallowed. */}
            {results.droppedLocations?.length > 0 && (
              <div style={{ padding: "8px 12px", color: "#b45309", fontSize: 12 }}>
                The provider does not know {results.droppedLocations.join(", ")}, so that part
                of the location filter was not applied.
              </div>
            )}
            <div style={{ maxHeight: 280, overflowY: "auto" }}>
              {results.creators.map((c) => (
                <div key={c.handle} style={{
                  display: "flex", gap: 10, alignItems: "center",
                  padding: "6px 12px", borderTop: `1px solid ${theme.border}`,
                  opacity: c.known ? 0.5 : 1, fontSize: 13,
                }}>
                  <span style={{ color: theme.text, minWidth: 200 }}>@{c.handle}</span>
                  <span style={{ color: theme.textMuted, fontVariantNumeric: "tabular-nums" }}>
                    {(c.followers ?? 0).toLocaleString()}
                  </span>
                  <span style={{ color: theme.textMuted }}>
                    {c.engagement != null ? `${Number(c.engagement).toFixed(1)}%` : ""}
                  </span>
                  <div style={{ flex: 1 }} />
                  {c.known && <span style={{ color: theme.textMuted, fontSize: 11 }}>already here</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}


/**
 * One creator's cells, keyed on the column rather than written in a fixed
 * order, so reordering the header reorders the body with it.
 */
function creatorCell(col, { c, theme, saving, decide, menuOpen, onMenu }) {
  switch (col.key) {
    case "tier":
      return c.tier || "—";
    case "handle":
      return (
        <>
          <a href={c.instagram_url} target="_blank" rel="noreferrer"
             style={{ color: theme.text, textDecoration: "none" }}>
            @{c.handle}
          </a>
          <div style={{ color: theme.textMuted, fontSize: 11 }}>
            {c.full_name || c.niche || ""}
          </div>
        </>
      );
    case "followers":
      return <span style={{ fontVariantNumeric: "tabular-nums" }}>
        {(c.followers || 0).toLocaleString()}
      </span>;
    case "brands_posted_about":
      return (
        <>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{c.brands_posted_about}</span>
          {c.example_brand && (
            <div style={{ color: theme.textMuted, fontSize: 11 }}>e.g. @{c.example_brand}</div>
          )}
        </>
      );
    case "contact_email":
      return (
        <span title={c.contact_email || ""}
              style={{ color: c.contact_email ? theme.text : theme.textMuted }}>
          {c.contact_email || "none found"}
        </span>
      );
    case "state":
      return <StateCell c={c} theme={theme} />;
    case "actions":
      // Header left, content grouped right and tight: the house rule for an
      // Actions column everywhere in ops.
      return (
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 6 }}>
          <InviteToggle c={c} theme={theme} saving={saving === c.handle} decide={decide} />
          <RowMenu c={c} theme={theme} saving={saving === c.handle}
                   open={menuOpen} onOpenChange={onMenu} decide={decide} />
        </div>
      );
    default:
      return c[col.key] ?? null;
  }
}

/**
 * How far this creator has got, in one word - and, when they cannot go any
 * further, why.
 *
 * The reason was already computed on the server and already sent down as
 * `blocked`; it was rendered above three buttons in a 40-character truncation
 * nobody would read. It is the state now, because for a blocked creator it is
 * the only thing about them worth knowing.
 */
function StateCell({ c, theme }) {
  if (c.reply_state && c.reply_state !== "sent") {
    return <span style={{ color: theme.success }}>{c.reply_state.replace("_", " ")}</span>;
  }
  if (c.pushed_at) return <span style={{ color: theme.text }}>invited</span>;
  if (c.blocked) {
    return (
      <span title={c.blocked} style={{ color: theme.warning }}>
        {c.blocked.length > 22 ? c.blocked.slice(0, 22) + "…" : c.blocked}
      </span>
    );
  }
  if (c.decision === "hide") return <span style={{ color: theme.textMuted }}>hidden</span>;
  if (c.decision === "send") {
    // Which of the two sequences they would get. The cold one is the weaker,
    // and it should never be a surprise that it is about to go.
    return (
      <>
        <div style={{ color: theme.text }}>queued</div>
        <div style={{ color: theme.textMuted, fontSize: 11 }}>{c.invite} email</div>
      </>
    );
  }
  return <span style={{ color: theme.textMuted }}>—</span>;
}

/**
 * The one bit that matters, as one button. A creator is handed to Lemlist if
 * and only if the decision is `send`, so the other three values were three
 * ways of writing the same instruction.
 */
function InviteToggle({ c, theme, saving, decide }) {
  const on = c.decision === "send";
  return (
    <Btn
      size="sm"
      variant={on ? "solid" : "secondary"}
      color={on ? theme.success : undefined}
      disabled={saving || (!on && Boolean(c.blocked))}
      title={c.blocked && !on ? c.blocked
            : on ? "Marked invite - click to stop it going"
            : `Invite this creator (${c.invite} email)`}
      style={{ padding: "4px 14px", fontSize: 12 }}
      onClick={() => decide(c.handle, on ? "pending" : "send")}
    >
      {on ? "Inviting" : "Invite"}
    </Btn>
  );
}

/**
 * Putting a creator away, behind an overflow because it is rare - and a rare
 * action sitting permanently beside a common one is most of what makes a table
 * look busy.
 */
function RowMenu({ c, theme, saving, open, onOpenChange, decide }) {
  const hidden = c.decision === "hide";
  return (
    <div style={{ position: "relative" }}>
      <Btn variant="secondary" size="sm" disabled={saving}
           aria-label={`More actions for @${c.handle}`} aria-expanded={open}
           onClick={() => onOpenChange(open ? null : c.handle)}>
        ···
      </Btn>
      {open && (
        <div role="menu" style={{
          position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 20,
          background: theme.cardBg, border: `1px solid ${theme.border}`,
          borderRadius: 8, boxShadow: "0 6px 20px rgba(0,0,0,0.18)", minWidth: 160, padding: 4,
        }}>
          <button type="button" role="menuitem"
            onClick={() => { onOpenChange(null); decide(c.handle, hidden ? "pending" : "hide"); }}
            style={{
              display: "block", width: "100%", textAlign: "left", padding: "7px 10px",
              background: "transparent", border: "none", cursor: "pointer",
              color: theme.text, fontSize: 13, borderRadius: 6, font: "inherit",
            }}>
            {hidden ? "Unhide" : "Hide this creator"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Four numbers, each one the filter for itself.
 *
 * They were three that only described the table - you read "Invited 0", then
 * found "Invited" again in a select below to actually see it. A count you
 * cannot click is a fact you have to act on somewhere else.
 */
function ViewTiles({ stats, loading, theme, view, onChoose }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
      {VIEWS.map((t) => {
        const active = view === t.value;
        return (
          <Card key={t.value}>
            <button type="button" onClick={() => onChoose(t.value)} aria-pressed={active}
              style={{
                display: "block", width: "100%", textAlign: "left", padding: 14,
                background: active ? theme.accentLight : "transparent",
                border: "none", borderRadius: "inherit", cursor: "pointer", font: "inherit",
                boxShadow: active ? `inset 0 0 0 1px ${theme.accent}` : "none",
              }}>
              <div style={{ color: active ? theme.accent : theme.textMuted, fontSize: 12 }}>
                {t.label}
              </div>
              {loading
                ? <Skeleton style={{ height: 26, width: 48, marginTop: 6 }} />
                : <div style={{ fontSize: 24, color: theme.text, fontWeight: 600 }}>
                    {stats?.byView?.[t.value] ?? 0}
                  </div>}
              <div style={{ color: theme.textMuted, fontSize: 11, marginTop: 2 }}>{t.hint}</div>
            </button>
          </Card>
        );
      })}
    </div>
  );
}
