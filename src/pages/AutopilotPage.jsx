import { Fragment, useEffect, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { SkeletonTableRows } from "../components/ui/Skeleton";
import { ColumnFilter, describeFilter, SortLabel, nextSort } from "../components/table/tableTools";
import AgentDetail from "../components/autopilot/AgentDetail";
import { ago, whenNext } from "../lib/relativeTime";

/**
 * Autopilot — the recruiting machine, watched from here.
 *
 * The brand app used to show this funnel and it was taken off deliberately: a
 * brand buys relevant applicants, not a view of the machine. The machine still
 * has to be watched — a search that stalled, an agent sitting at "waiting" for
 * a week, a campaign that has emailed four hundred creators and produced one
 * application — and this is the page that does it.
 *
 * Read-only on purpose. Starting, stopping and re-planning go through the main
 * app's own console, which enforces the search budget and the send guards; a
 * button here would write straight to the database and walk past both.
 */

// The states an agent can be in, in the words the machine uses, with the
// colour a person needs: working is fine, failed is not, waiting is usually
// fine and occasionally means stuck.
const STATUS_COLORS = {
  working: { bg: "#DBEAFE", fg: "#1E40AF", bgDark: "#0F2547", fgDark: "#93C5FD" },
  waiting: { bg: "#FEF3C7", fg: "#92400E", bgDark: "#3B2A0E", fgDark: "#FCD34D" },
  idle:    { bg: "#F3F4F6", fg: "#4B5563", bgDark: "#1F2937", fgDark: "#9CA3AF" },
  done:    { bg: "#D1FAE5", fg: "#065F46", bgDark: "#0E2E22", fgDark: "#6EE7B7" },
  paused:  { bg: "#F3F4F6", fg: "#4B5563", bgDark: "#1F2937", fgDark: "#9CA3AF" },
  failed:  { bg: "#FEE2E2", fg: "#991B1B", bgDark: "#3F1313", fgDark: "#FCA5A5" },
  off:     { bg: "#F3F4F6", fg: "#4B5563", bgDark: "#1F2937", fgDark: "#9CA3AF" },
};

// The header, declared once so it cannot drift from the endpoint. `key` must
// exist in AGENT_SORTS / AGENT_FILTERS in routes/autopilot.js — both sorting
// and filtering are server-side, so the count under the table and the empty
// state stay true, and a sort covers every agent rather than the hundred that
// happen to be loaded.
//
// defaultDir is the direction a first click takes: "asc" reads right for
// names, "desc" for counts and dates — biggest and most recent first is what
// somebody clicking a number column is asking for.
const COLUMNS = [
  { key: "campaign_name", label: "Campaign", sort: "asc", filter: true },
  { key: "brand_name", label: "Brand", sort: "asc", filter: true },
  { key: "mode", label: "Mode", sort: "asc", filter: true },
  { key: "status", label: "State", sort: "asc", filter: true },
  { key: "found", label: "Found", sort: "desc", right: true },
  { key: "contactable", label: "Contactable", sort: "desc", right: true },
  { key: "emailed", label: "Emailed", sort: "desc", right: true },
  { key: "replied", label: "Replied", sort: "desc", right: true },
  { key: "applied", label: "Applied", sort: "desc", right: true },
  { key: "runs_used", label: "Searches", sort: "desc", right: true },
  { key: "last_event_at", label: "Last did", sort: "desc" },
  { key: "next_action_at", label: "Next", sort: "asc" },
];

// The four that can also be narrowed, with the controls each one needs.
const FILTERS = [
  { key: "campaign_name", label: "Campaign", type: "text", placeholder: "Campaign name…" },
  { key: "brand_name", label: "Brand", type: "text", placeholder: "Brand…" },
  {
    key: "mode",
    label: "Mode",
    type: "select",
    options: [
      { value: "autonomous", label: "Autonomous" },
      { value: "assisted", label: "Assisted" },
      { value: "off", label: "Off" },
    ],
  },
  {
    key: "status",
    label: "State",
    type: "select",
    options: [
      // First, because it is the reason anybody filters this page at all:
      // an agent that is switched on and going nowhere.
      { value: "stuck", label: "Stuck or parked" },
      { value: "working", label: "Working" },
      { value: "waiting", label: "Waiting" },
      { value: "idle", label: "Idle" },
      { value: "done", label: "Done" },
      { value: "paused", label: "Paused" },
      { value: "failed", label: "Failed" },
    ],
  },
];

export default function AutopilotPage() {
  const { theme, mode } = useTheme();
  const dark = mode === "dark";

  const [rows, setRows] = useState([]);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState(null);
  const [filters, setFilters] = useState({});
  const [sort, setSort] = useState({ sortBy: "", sortDir: "" });
  const [total, setTotal] = useState(null);
  const [totalAll, setTotalAll] = useState(null);
  // The monthly search limit, per brand and in general. Kept next to the rows
  // rather than on a settings page of its own: the moment anybody wants to
  // change it is the moment they are looking at an agent it has stopped.
  const [savingLimit, setSavingLimit] = useState("");
  const [defaultLimit, setDefaultLimit] = useState(null);
  const [defaultDraft, setDefaultDraft] = useState("");

  // Re-reads whenever a filter changes. The popover commits after a pause, so
  // there is nothing to debounce here — every change that arrives is one the
  // operator finished making.
  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .getAutopilotCampaigns({ limit: 100, filters, ...sort })
      .then((d) => {
        if (!live) return;
        setRows(d.campaigns || []);
        setTotal(d.total ?? null);
        setTotalAll(d.total_all ?? null);
        setAvailable(d.available !== false);
        setError("");
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [filters, sort]);

  // The default row, read once so the page can say what a brand with no row of
  // its own actually gets.
  useEffect(() => {
    let live = true;
    api
      .getAutopilotAllowances()
      .then((d) => {
        if (!live) return;
        const fallback = (d.allowances || []).find((a) => a.scope === "default");
        if (fallback) {
          setDefaultLimit(fallback.monthly_searches);
          setDefaultDraft(String(fallback.monthly_searches));
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  async function saveDefault() {
    const searches = Math.floor(Number(defaultDraft));
    if (!Number.isFinite(searches) || searches < 0) return;
    setSavingLimit("default");
    setError("");
    try {
      await api.setAutopilotAllowance("default", { monthly_searches: searches });
      setDefaultLimit(searches);
      // Every brand without a row of its own just changed too.
      setRows((all) =>
        all.map((r) => (r.allowance_is_override ? r : { ...r, search_allowance: searches })),
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingLimit("");
    }
  }

  // One filter at a time, and an empty value removes the key rather than
  // sitting in the object as "": the chip row and the endpoint both read
  // "is this key here" as "is this narrowed".
  function setFilter(key, value) {
    setFilters((f) => {
      const next = { ...f };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
    // A row opened under the old list is about a campaign that may not be in
    // the new one.
    setOpenId(null);
  }

  const activeFilters = FILTERS.filter((f) => filters[f.key]);
  const byFilterKey = Object.fromEntries(FILTERS.map((f) => [f.key, f]));

  // Click the active column to flip it, another to switch to it.
  const handleSort = (key, defaultDir) => setSort((s2) => nextSort(s2, key, defaultDir));

  const toggle = (productId) => setOpenId((open) => (open === productId ? null : productId));

  // The row and the panel are one thing: a mode changed in the panel has to
  // show in the row behind it, or the table is describing the agent as it was
  // before the click.
  function patchAgent(productId, agent) {
    if (!agent) return;
    setRows((all) =>
      all.map((r) =>
        r.product_id === productId
          ? {
              ...r,
              mode: agent.mode ?? r.mode,
              status: agent.status ?? r.status,
              goal_applications: agent.goal_applications ?? r.goal_applications,
              max_runs: agent.max_runs ?? r.max_runs,
              next_action_at: agent.next_action_at ?? r.next_action_at,
              stopped_reason: agent.mode === "off" ? r.stopped_reason : "",
            }
          : r,
      ),
    );
  }

  // An allowance belongs to the brand, so every one of its campaigns on this
  // page changes at once.
  function patchAllowance(brandUserId, searches, isOverride) {
    setRows((all) =>
      all.map((r) =>
        r.brand_user_id === brandUserId
          ? { ...r, search_allowance: searches, allowance_is_override: isOverride }
          : r,
      ),
    );
  }

  const pill = (value, palette) => {
    const c = palette[value] || palette.idle;
    return (
      <span
        style={{
          display: "inline-block",
          padding: "2px 8px",
          borderRadius: 999,
          fontSize: 12,
          fontWeight: 600,
          background: dark ? c.bgDark : c.bg,
          color: dark ? c.fgDark : c.fg,
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </span>
    );
  };

  const th = {
    textAlign: "left",
    padding: "8px 10px",
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    color: theme.textMuted,
    borderBottom: `1px solid ${theme.border}`,
    whiteSpace: "nowrap",
  };
  const td = {
    padding: "10px",
    fontSize: 13,
    borderBottom: `1px solid ${theme.border}`,
    verticalAlign: "middle",
  };
  const num = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>Autopilot</h1>
      <p style={{ color: theme.textMuted, fontSize: 13, margin: "0 0 20px" }}>
        Recruiting runs in the backend and brands never see it. This is where it is watched: what
        each campaign's agent is doing, what it found, and what came back.
      </p>

      {!available && !loading && (
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Not on this database</div>
          <div style={{ color: theme.textMuted, fontSize: 13 }}>
            Sourcing has never been deployed here, so none of its tables exist. Switch the database
            target to dev, where the machine actually runs.
          </div>
        </Card>
      )}

      {error && (
        <Card>
          <div style={{ color: "#B91C1C", fontSize: 13 }}>{error}</div>
        </Card>
      )}

      {/* The limit itself, on the page where its effects are visible. It used
          to be a constant in Go: a brand that had used its month was parked
          until the 1st and the only lever was a deploy. */}
      {available && defaultLimit != null && (
        <Card>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 320px", minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Searches a brand gets each month</div>
              <div style={{ color: theme.textMuted, fontSize: 12, marginTop: 2 }}>
                Every brand, unless one has a limit of its own — set that on the brand's row below.
                Each search spends provider credits, which is the whole reason for a limit. Agents
                read it on their next tick, so raising one un-parks it within the hour.
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="number"
                min="0"
                value={defaultDraft}
                onChange={(e) => setDefaultDraft(e.target.value)}
                style={{
                  width: 72,
                  padding: "6px 8px",
                  borderRadius: 6,
                  border: `1px solid ${theme.border}`,
                  background: theme.surface,
                  color: theme.text,
                  fontSize: 13,
                  fontFamily: "inherit",
                }}
              />
              <Btn
                size="sm"
                loading={savingLimit === "default"}
                disabled={String(defaultLimit) === String(defaultDraft)}
                onClick={saveDefault}
              >
                Save
              </Btn>
            </div>
          </div>
        </Card>
      )}

      {/* What is currently being hidden, and the way back. A filter set in a
          header cell is invisible from anywhere else on the page, and the
          funnel icon alone does not say WHAT it is narrowed to. */}
      {available && activeFilters.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            margin: "0 0 12px",
            fontSize: 12,
            color: theme.textMuted,
          }}
        >
          {activeFilters.map((f) => (
            <span
              key={f.key}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "3px 6px 3px 10px",
                borderRadius: 999,
                background: theme.surfaceAlt,
                border: `1px solid ${theme.border}`,
                color: theme.text,
              }}
            >
              {f.label} {describeFilter(f.type, filters[f.key], f.options)}
              <button
                onClick={() => setFilter(f.key, "")}
                aria-label={`Remove the ${f.label} filter`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 16,
                  height: 16,
                  border: "none",
                  borderRadius: "50%",
                  background: "transparent",
                  color: theme.textMuted,
                  cursor: "pointer",
                  fontSize: 13,
                  lineHeight: 1,
                  padding: 0,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = theme.text)}
                onMouseLeave={(e) => (e.currentTarget.style.color = theme.textMuted)}
              >
                ✕
              </button>
            </span>
          ))}
          {activeFilters.length > 1 && (
            <button
              onClick={() => setFilters({})}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                font: "inherit",
                color: theme.textMid,
                cursor: "pointer",
                textDecoration: "underline",
              }}
            >
              Clear all
            </button>
          )}
        </div>
      )}

      {available && (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ ...th, width: 28 }} />
                  {/* Sort label and funnel both live in the header cell, the
                      way they do on every other table here — a toolbar above
                      the table would be a second place to look for the same
                      two things. */}
                  {COLUMNS.map((col) => {
                    const f = byFilterKey[col.key];
                    return (
                      <th key={col.key} style={col.right ? { ...th, textAlign: "right" } : th}>
                        <span style={{ display: "inline-flex", alignItems: "center" }}>
                          <SortLabel
                            theme={theme}
                            label={col.label}
                            colKey={col.key}
                            sortBy={sort.sortBy}
                            sortDir={sort.sortDir}
                            defaultDir={col.sort}
                            onSort={handleSort}
                          />
                          {f && (
                            <ColumnFilter
                              theme={theme}
                              label={f.label}
                              type={f.type}
                              options={f.options}
                              placeholder={f.placeholder}
                              value={filters[f.key] || ""}
                              onCommit={(v) => setFilter(f.key, v)}
                            />
                          )}
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {loading && <SkeletonTableRows rows={6} cols={13} />}

                {!loading && rows.length === 0 && (
                  <tr>
                    <td style={{ ...td, color: theme.textMuted }} colSpan={13}>
                      {activeFilters.length ? (
                        <>
                          No agent matches these filters.{" "}
                          <button
                            onClick={() => setFilters({})}
                            style={{
                              background: "none",
                              border: "none",
                              padding: 0,
                              font: "inherit",
                              color: theme.text,
                              cursor: "pointer",
                              textDecoration: "underline",
                            }}
                          >
                            Clear them
                          </button>
                          .
                        </>
                      ) : (
                        <>
                          No campaign has an agent yet. One is created when a campaign launches —
                          an already-live campaign was never enrolled.
                        </>
                      )}
                    </td>
                  </tr>
                )}

                {!loading &&
                  rows.map((r) => (
                    <Fragment key={r.agent_id}>
                      <tr
                        onClick={() => toggle(r.product_id)}
                        style={{ cursor: "pointer" }}
                      >
                        <td style={{ ...td, color: theme.textMuted }}>
                          {openId === r.product_id ? "▾" : "▸"}
                        </td>
                        <td style={{ ...td, fontWeight: 600 }}>
                          {r.campaign_name || "Untitled"}
                          {r.run_in_flight && (
                            <span style={{ color: theme.textMuted, fontWeight: 400 }}>
                              {" "}
                              · searching
                            </span>
                          )}
                        </td>
                        <td style={{ ...td, color: theme.textMuted }}>{r.brand_name || "—"}</td>
                        <td style={td}>{pill(r.mode, STATUS_COLORS)}</td>
                        <td style={td}>
                          {pill(r.status, STATUS_COLORS)}
                          {r.stopped_reason && (
                            <div style={{ color: theme.textMuted, fontSize: 11, marginTop: 3 }}>
                              {r.stopped_reason}
                            </div>
                          )}
                        </td>
                        <td style={num}>{r.found}</td>
                        <td style={num}>{r.contactable}</td>
                        <td style={num}>
                          {r.emailed}
                          {!r.has_sequence && r.found > 0 && (
                            <div style={{ color: theme.textMuted, fontSize: 11 }}>no sequence</div>
                          )}
                        </td>
                        <td style={num}>{r.replied}</td>
                        {/* The number the whole machine exists to produce, next
                            to the goal it was given. */}
                        <td style={{ ...num, fontWeight: 600 }}>
                          {r.applied}
                          <span style={{ color: theme.textMuted, fontWeight: 400 }}>
                            /{r.goal_applications}
                          </span>
                        </td>
                        <td style={num}>
                          {r.runs_used}/{r.max_runs}
                          {/* The agent's own budget above; the brand's month
                              below. An agent parked on the second while the
                              first is untouched is the state that read as a
                              stall — "searches: none yet" and "this month's
                              searches are all used" are both true, about
                              different things. */}
                          {r.search_allowance != null && (
                            <div
                              style={{
                                fontSize: 11,
                                fontWeight: 400,
                                color:
                                  r.searches_used >= r.search_allowance
                                    ? "#B45309"
                                    : theme.textMuted,
                              }}
                            >
                              brand {r.searches_used}/{r.search_allowance}
                            </div>
                          )}
                        </td>
                        <td style={{ ...td, color: theme.textMuted, whiteSpace: "nowrap" }}>
                          {ago(r.last_event_at)}
                        </td>
                        <td style={{ ...td, color: theme.textMuted, whiteSpace: "nowrap" }}>
                          {r.mode === "off" || ["done", "failed"].includes(r.status)
                            ? "—"
                            : whenNext(r.next_action_at)}
                        </td>
                      </tr>

                      {openId === r.product_id && (
                        <tr>
                          <td style={{ ...td, background: theme.bg }} colSpan={13}>
                            <AgentDetail
                              row={r}
                              defaultLimit={defaultLimit}
                              onAgentChanged={patchAgent}
                              onAllowanceChanged={patchAllowance}
                              onError={setError}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* The count belongs under the table because the filters are real: with
          one set, "12" on its own would be the answer to a question nobody
          asked. */}
      {available && !loading && rows.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: theme.textMuted, textAlign: "right" }}>
          {activeFilters.length
            ? `${total ?? rows.length} of ${totalAll ?? rows.length} agents match`
            : `${totalAll ?? rows.length} ${totalAll === 1 ? "agent" : "agents"}`}
        </div>
      )}
    </div>
  );
}
