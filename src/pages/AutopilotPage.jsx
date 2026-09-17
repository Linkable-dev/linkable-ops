import { Fragment, useEffect, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { SkeletonTableRows } from "../components/ui/Skeleton";

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

function ago(raw) {
  if (!raw) return "—";
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return "—";
  const mins = Math.floor((Date.now() - at.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

function whenNext(raw) {
  if (!raw) return "—";
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return "—";
  const mins = Math.round((at.getTime() - Date.now()) / 60000);
  if (mins <= 0) return "due now";
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

export default function AutopilotPage() {
  const { theme, mode } = useTheme();
  const dark = mode === "dark";

  const [rows, setRows] = useState([]);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState({ events: [], runs: [], loading: false });
  // The monthly search limit, per brand and in general. Kept next to the rows
  // rather than on a settings page of its own: the moment anybody wants to
  // change it is the moment they are looking at an agent it has stopped.
  const [limitDraft, setLimitDraft] = useState({});
  const [savingLimit, setSavingLimit] = useState("");
  const [defaultLimit, setDefaultLimit] = useState(null);
  const [defaultDraft, setDefaultDraft] = useState("");

  // Loads once. `loading` starts true, so the effect has nothing to set on the
  // way in — only on the way out.
  useEffect(() => {
    let live = true;
    api
      .getAutopilotCampaigns({ limit: 100 })
      .then((d) => {
        if (!live) return;
        setRows(d.campaigns || []);
        setAvailable(d.available !== false);
        setError("");
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

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

  // Writing a limit is not the same as driving an agent: it sets the number
  // every guard then runs against. The agent picks it up on its next tick,
  // which is why a brand parked "until the 1st" comes back within the hour.
  async function saveLimit(row) {
    const raw = limitDraft[row.brand_user_id];
    const searches = Math.floor(Number(raw));
    if (!Number.isFinite(searches) || searches < 0) return;
    setSavingLimit(row.brand_user_id);
    setError("");
    try {
      await api.setAutopilotAllowance(row.brand_user_id, { monthly_searches: searches });
      setRows((all) =>
        all.map((r) =>
          r.brand_user_id === row.brand_user_id
            ? { ...r, search_allowance: searches, allowance_is_override: true }
            : r,
        ),
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingLimit("");
    }
  }

  async function revertToDefaultLimit(row) {
    setSavingLimit(row.brand_user_id);
    setError("");
    try {
      await api.clearAutopilotAllowance(row.brand_user_id);
      setRows((all) =>
        all.map((r) =>
          r.brand_user_id === row.brand_user_id
            ? { ...r, search_allowance: defaultLimit, allowance_is_override: false }
            : r,
        ),
      );
      setLimitDraft((d) => ({ ...d, [row.brand_user_id]: String(defaultLimit ?? "") }));
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingLimit("");
    }
  }

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

  function toggle(productId) {
    if (openId === productId) {
      setOpenId(null);
      return;
    }
    setOpenId(productId);
    setDetail({ events: [], runs: [], loading: true });
    api
      .getAutopilotEvents(productId)
      .then((d) => setDetail({ events: d.events || [], runs: d.runs || [], loading: false }))
      .catch(() => setDetail({ events: [], runs: [], loading: false }));
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
      {/* "Recruiting", to match the nav — Autopilot is named in the line
          underneath, because that is what the agent is called everywhere it
          actually runs. */}
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>Recruiting</h1>
      <p style={{ color: theme.textMuted, fontSize: 13, margin: "0 0 20px" }}>
        Autopilot runs in the backend and brands never see it. This is where it is watched: what
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

      {available && (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ ...th, width: 28 }} />
                  <th style={th}>Campaign</th>
                  <th style={th}>Brand</th>
                  <th style={th}>Mode</th>
                  <th style={th}>State</th>
                  <th style={{ ...th, textAlign: "right" }}>Found</th>
                  <th style={{ ...th, textAlign: "right" }}>Contactable</th>
                  <th style={{ ...th, textAlign: "right" }}>Emailed</th>
                  <th style={{ ...th, textAlign: "right" }}>Replied</th>
                  <th style={{ ...th, textAlign: "right" }}>Applied</th>
                  <th style={{ ...th, textAlign: "right" }}>Searches</th>
                  <th style={th}>Last did</th>
                  <th style={th}>Next</th>
                </tr>
              </thead>
              <tbody>
                {loading && <SkeletonTableRows rows={6} cols={13} />}

                {!loading && rows.length === 0 && (
                  <tr>
                    <td style={{ ...td, color: theme.textMuted }} colSpan={13}>
                      No campaign has an agent yet. One is created when a campaign launches — an
                      already-live campaign was never enrolled.
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
                            {detail.loading && (
                              <div style={{ color: theme.textMuted, fontSize: 13 }}>Loading…</div>
                            )}

                            {!detail.loading && (
                              <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
                                <div style={{ flex: "1 1 420px", minWidth: 0 }}>
                                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
                                    What it did
                                  </div>
                                  {detail.events.length === 0 && (
                                    <div style={{ color: theme.textMuted, fontSize: 13 }}>
                                      Nothing yet.
                                    </div>
                                  )}
                                  {detail.events.map((e, i) => (
                                    <div
                                      key={i}
                                      style={{
                                        display: "flex",
                                        gap: 10,
                                        padding: "6px 0",
                                        borderBottom:
                                          i < detail.events.length - 1
                                            ? `1px solid ${theme.border}`
                                            : "none",
                                      }}
                                    >
                                      <span
                                        style={{
                                          color: theme.textMuted,
                                          fontSize: 12,
                                          minWidth: 76,
                                          whiteSpace: "nowrap",
                                        }}
                                      >
                                        {ago(e.created)}
                                      </span>
                                      <span style={{ fontSize: 13 }}>
                                        {e.summary || e.action}
                                        {e.detail && (
                                          <span style={{ color: theme.textMuted }}>
                                            {" "}
                                            — {e.detail}
                                          </span>
                                        )}
                                      </span>
                                    </div>
                                  ))}
                                </div>

                                <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
                                    The brand's month
                                  </div>
                                  <div style={{ fontSize: 13, marginBottom: 6 }}>
                                    {r.searches_used} of {r.search_allowance ?? "—"} searches used
                                    {r.search_allowance != null &&
                                      r.searches_used >= r.search_allowance && (
                                      <div style={{ color: "#B45309", fontSize: 12, marginTop: 2 }}>
                                        Spent. Its agent waits for the 1st unless this is raised.
                                      </div>
                                    )}
                                  </div>
                                  <div style={{ color: theme.textMuted, fontSize: 12, marginBottom: 8 }}>
                                    Counted across every campaign this brand runs, not this one.
                                    {r.allowance_is_override
                                      ? " This brand has a limit of its own."
                                      : ` Default for every brand${defaultLimit != null ? ` (${defaultLimit})` : ""}.`}
                                  </div>
                                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                    <input
                                      type="number"
                                      min="0"
                                      value={
                                        limitDraft[r.brand_user_id] ??
                                        String(r.search_allowance ?? "")
                                      }
                                      onChange={(e) =>
                                        setLimitDraft((d) => ({
                                          ...d,
                                          [r.brand_user_id]: e.target.value,
                                        }))
                                      }
                                      onClick={(e) => e.stopPropagation()}
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
                                      loading={savingLimit === r.brand_user_id}
                                      onClick={() => saveLimit(r)}
                                    >
                                      Set limit
                                    </Btn>
                                    {r.allowance_is_override && (
                                      <Btn
                                        size="sm"
                                        variant="outline"
                                        disabled={savingLimit === r.brand_user_id}
                                        onClick={() => revertToDefaultLimit(r)}
                                      >
                                        Use default
                                      </Btn>
                                    )}
                                  </div>
                                </div>

                                <div style={{ flex: "1 1 340px", minWidth: 0 }}>
                                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
                                    Searches
                                  </div>
                                  {detail.runs.length === 0 && (
                                    <div style={{ color: theme.textMuted, fontSize: 13 }}>
                                      None yet.
                                    </div>
                                  )}
                                  {detail.runs.map((run) => (
                                    <div
                                      key={run.id}
                                      style={{
                                        padding: "6px 0",
                                        borderBottom: `1px solid ${theme.border}`,
                                        fontSize: 13,
                                      }}
                                    >
                                      <div
                                        style={{ display: "flex", gap: 8, alignItems: "baseline" }}
                                      >
                                        <span style={{ fontWeight: 600 }}>{run.status}</span>
                                        <span style={{ color: theme.textMuted, fontSize: 12 }}>
                                          {ago(run.created)}
                                        </span>
                                      </div>
                                      <div style={{ color: theme.textMuted, fontSize: 12 }}>
                                        {/* Enriched well under discovered on a run that is
                                            still going is what a stall looks like — a deploy
                                            takes the executor with it. */}
                                        {run.discovered_count} found · {run.enriched_count} checked
                                        · {run.contactable} contactable ·{" "}
                                        {Number(run.credits_spent || 0).toFixed(1)} credits
                                      </div>
                                      {run.error && (
                                        <div style={{ color: "#B91C1C", fontSize: 12 }}>
                                          {run.error}
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
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
    </div>
  );
}
