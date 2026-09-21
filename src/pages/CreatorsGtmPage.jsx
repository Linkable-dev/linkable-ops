import { useCallback, useEffect, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Select } from "../components/ui/Select";
import { Skeleton, SkeletonTableRows } from "../components/ui/Skeleton";
import { Pagination } from "../components/ui/Pagination";
import {
  ColumnFilter,
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
 * Same contract as Brands: hold and hide stop the invite going out, they do not
 * tidy the list.
 */

const TIERS = [
  { value: "", label: "All tiers" },
  { value: "A", label: "Tier A" },
  { value: "B", label: "Tier B" },
  { value: "C", label: "Tier C" },
];

const DECISIONS = [
  { value: "", label: "All decisions" },
  { value: "pending", label: "Undecided" },
  { value: "send", label: "Invite" },
  { value: "hold", label: "Hold" },
  { value: "hide", label: "Hidden" },
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
const COLUMNS = [
  { key: "tier", label: "Tier", width: 90, sort: "asc",
    filter: { type: "select", options: ["A", "B", "C", "reject"] } },
  { key: "handle", label: "Creator", width: 240, sort: "asc", fill: true,
    filter: { type: "text", placeholder: "Handle or name…" } },
  { key: "followers", label: "Followers", width: 120, sort: "desc", right: true,
    filter: { type: "number" } },
  { key: "brands_posted_about", label: "Brands", width: 110, sort: "desc", right: true,
    filter: { type: "number" } },
  { key: "contact_email", label: "Email", width: 230, sort: "asc",
    filter: { type: "text", placeholder: "Email…" } },
  { key: "niche", label: "Niche", width: 130, sort: "asc",
    filter: { type: "text", placeholder: "Niche…" } },
  { key: "source", label: "Found via", width: 140, sort: "asc",
    filter: { type: "select", options: ["brand_mentions", "influencers_club"] } },
  { key: "decision", label: "Decision", width: 220 },
];
const FIXED_KEYS = [];
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
  const [decision, setDecision] = useState("");
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(null);

  const [sort, setSort] = useState({ sortBy: "", sortDir: "desc" });
  const [colFilters, setColFilters] = useState({});

  const { widths, sized, startResize, resetWidth } =
    useColumnWidths("prospector-creators", DEFAULT_WIDTHS, FIXED_KEYS);
  const { orderedColumns, dragHandleProps, dropTargetProps, dragOverKey } =
    useColumnOrder("prospector-creators", COLUMNS, FIXED_KEYS);

  const handleSort = useCallback((colKey, defaultDir) => {
    setSort((cur) => nextSort(cur, colKey, defaultDir));
    setPage(0);
  }, []);
  const setColFilter = useCallback((key, value) => {
    setColFilters((cur) => (cur[key] === value ? cur : { ...cur, [key]: value }));
    setPage(0);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    try {
      const [rows, s] = await Promise.all([
        api.getProspectingCreators({
          tier, decision, q, filters: colFilters,
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
  }, [tier, decision, q, page, sort.sortBy, sort.sortDir, colFilters]);

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

  const tiles = [
    { label: "Reachable", value: stats?.contactable ?? 0, hint: "email, not held" },
    { label: "Posts about 2+", value: stats?.multiBrand ?? 0, hint: "doing it as a habit" },
    { label: "Invited", value: stats?.invited ?? 0, hint: "already contacted" },
  ];

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, color: theme.text }}>Creators</h1>
        <p style={{ margin: "6px 0 0", color: theme.textMuted, fontSize: 13, maxWidth: 700 }}>
          Found by the brand pipeline: they posted about a brand we were looking at, which
          means they already do this. Hold and hide stop the invite being sent.
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

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        {tiles.map((t) => (
          <Card key={t.label}>
            <div style={{ padding: 14 }}>
              <div style={{ color: theme.textMuted, fontSize: 12 }}>{t.label}</div>
              {loading && !stats
                ? <Skeleton style={{ height: 26, width: 48, marginTop: 6 }} />
                : <div style={{ fontSize: 24, color: theme.text, fontWeight: 600 }}>{t.value}</div>}
              <div style={{ color: theme.textMuted, fontSize: 11, marginTop: 2 }}>{t.hint}</div>
            </div>
          </Card>
        ))}
      </div>

      <Card>
        <div style={{ display: "flex", gap: 10, padding: 12, flexWrap: "wrap",
                      alignItems: "center", borderBottom: `1px solid ${theme.border}` }}>
          <div style={{ width: 150 }}>
            <Select value={tier} onChange={(v) => { setTier(v); setPage(0); }}
                    options={withCounts(TIERS, stats?.byTier)} ariaLabel="Tier" size="sm" />
          </div>
          <div style={{ width: 150 }}>
            <Select value={decision} onChange={(v) => { setDecision(v); setPage(0); }}
                    options={DECISIONS} ariaLabel="Decision" size="sm" />
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
                      grip={<DragHandle colKey={col.key} dragHandleProps={dragHandleProps} theme={theme} />}
                      trailing={col.filter && (
                        <ColumnFilter
                          theme={theme}
                          label={col.label}
                          type={col.filter.type}
                          options={col.filter.options}
                          placeholder={col.filter.placeholder}
                          value={colFilters[col.key] || ""}
                          onCommit={(v) => setColFilter(col.key, v)}
                        />
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
                        overflow: "hidden", textOverflow: "ellipsis",
                        whiteSpace: col.key === "handle" ? "normal" : "nowrap",
                      }}>
                        {creatorCell(col, { c, theme, saving, decide })}
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
function creatorCell(col, { c, theme, saving, decide }) {
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
    case "niche":
      return c.niche || <span style={{ color: theme.textMuted }}>—</span>;
    case "source":
      return <span style={{ color: theme.textMuted, fontSize: 12 }}>
        {(c.source || "").replace("_", " ") || "—"}
      </span>;
    case "decision":
      return (
        <>
          {/* A creator who cannot be invited says so rather than offering a
              button that does nothing. */}
          {c.blocked && (
            <div style={{ color: theme.textMuted, fontSize: 11, marginBottom: 4 }} title={c.blocked}>
              {c.blocked.length > 40 ? c.blocked.slice(0, 40) + "…" : c.blocked}
            </div>
          )}
          <div style={{ display: "flex", gap: 4, opacity: c.blocked ? 0.45 : 1 }}>
            {[["send", "invite", theme.success],
              ["hold", "hold", theme.warning],
              ["hide", "hide", theme.textMuted]].map(([value, label, colour]) => {
              const chosen = c.decision === value;
              return (
                <Btn key={value} size="sm"
                     variant={chosen ? "solid" : "secondary"}
                     color={chosen ? colour : undefined}
                     style={{ padding: "4px 12px", fontSize: 12,
                              opacity: chosen || !c.decision || c.decision === "pending" ? 1 : 0.5 }}
                     disabled={saving === c.handle}
                     title={chosen ? `${label} - click to undo` : `Mark ${label}`}
                     onClick={() => decide(c.handle, chosen ? "pending" : value)}>
                  {label}
                </Btn>
              );
            })}
          </div>
        </>
      );
    default:
      return c[col.key] ?? null;
  }
}
