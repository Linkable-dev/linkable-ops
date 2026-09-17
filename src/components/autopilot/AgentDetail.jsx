import { useCallback, useEffect, useState } from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { api } from "../../lib/api";
import { Btn } from "../ui/Button";
import { SkeletonListRows } from "../ui/Skeleton";
import { ago, whenNext } from "../../lib/relativeTime";

/**
 * One campaign's agent, opened up: every step it took, everything those steps
 * produced, and the settings an admin can change about it.
 *
 * It used to be a log and a list of runs. That answers "what happened" and
 * nothing else — not who it found, not what came back, and not what to do
 * about any of it, which meant every real question ended in a psql session.
 *
 * Four tabs, because they are four different questions asked at four
 * different moments; and one controls block, always visible, because the
 * answer to "why is it stuck" is usually a setting.
 *
 * On what the controls may do, see the contract at the top of
 * server/routes/autopilot.js: this sets what the agent is ALLOWED to do. It
 * never makes it search, email or reply — those spend money and leave the
 * building, and they belong to gRPC.
 */

const TABS = [
  ["timeline", "Timeline"],
  ["searches", "Searches"],
  ["creators", "Creators"],
  ["replies", "Replies"],
];

// The states a creator can end in, as the endpoint understands them. "All" has
// no value, which is also how a filter is cleared everywhere else here.
const CREATOR_STATES = [
  ["", "All", "total"],
  ["applied", "Applied", "applied"],
  ["emailed", "Emailed", "emailed"],
  ["reachable", "Reachable", "reachable"],
  ["unreachable", "No email", null],
  ["filtered", "Filtered out", "filtered"],
];

const MODES = [
  ["autonomous", "Autonomous"],
  ["assisted", "Assisted"],
  ["off", "Off"],
];

function whole(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : String(v);
}

export default function AgentDetail({ row, defaultLimit, onAgentChanged, onAllowanceChanged, onError }) {
  const { theme } = useTheme();
  const [tab, setTab] = useState("timeline");

  // Each tab fetches once, when it is first opened: the timeline is what
  // everybody wants and the creators list is five hundred rows nobody asked
  // for until they click it.
  const [log, setLog] = useState(null);
  const [creators, setCreators] = useState(null);
  const [creatorState, setCreatorState] = useState("");
  const [replies, setReplies] = useState(null);

  const [busy, setBusy] = useState("");
  const [goal, setGoal] = useState(String(row.goal_applications ?? ""));
  const [budget, setBudget] = useState(String(row.max_runs ?? ""));
  const [limit, setLimit] = useState(String(row.search_allowance ?? ""));

  const fail = useCallback((e) => onError?.(e.message || String(e)), [onError]);

  useEffect(() => {
    let live = true;
    api
      .getAutopilotEvents(row.product_id)
      .then((d) => live && setLog({ events: d.events || [], runs: d.runs || [] }))
      .catch((e) => live && fail(e));
    return () => {
      live = false;
    };
  }, [row.product_id, fail]);

  // Re-reads when the state chip changes, which is the only way this list is
  // narrowed — the counts beside the chips come back with it.
  useEffect(() => {
    if (tab !== "creators") return undefined;
    let live = true;
    setCreators((c) => (c ? { ...c, loading: true } : null));
    api
      .getAutopilotCreators(row.product_id, { limit: 25, state: creatorState || undefined })
      .then((d) => live && setCreators({ rows: d.creators || [], counts: d.counts || {}, loading: false }))
      .catch((e) => live && fail(e));
    return () => {
      live = false;
    };
  }, [tab, creatorState, row.product_id, fail]);

  useEffect(() => {
    if (tab !== "replies" || replies) return undefined;
    let live = true;
    api
      .getAutopilotReplies(row.product_id)
      .then((d) => live && setReplies(d.replies || []))
      .catch((e) => live && fail(e));
    return () => {
      live = false;
    };
  }, [tab, replies, row.product_id, fail]);

  async function saveAgent(mode) {
    setBusy("agent");
    try {
      const d = await api.setAutopilotAgent(row.product_id, {
        mode,
        goal_applications: Number(goal),
        max_runs: Number(budget),
      });
      onAgentChanged?.(row.product_id, d.agent);
      // The change is a line in the agent's own log, so the timeline it is
      // sitting next to has to be re-read or it is a page describing a state
      // nothing on it explains.
      const fresh = await api.getAutopilotEvents(row.product_id);
      setLog({ events: fresh.events || [], runs: fresh.runs || [] });
    } catch (e) {
      fail(e);
    } finally {
      setBusy("");
    }
  }

  async function wake() {
    setBusy("wake");
    try {
      const d = await api.wakeAutopilotAgent(row.product_id);
      onAgentChanged?.(row.product_id, d.agent);
      const fresh = await api.getAutopilotEvents(row.product_id);
      setLog({ events: fresh.events || [], runs: fresh.runs || [] });
    } catch (e) {
      fail(e);
    } finally {
      setBusy("");
    }
  }

  async function saveLimit() {
    const searches = Math.floor(Number(limit));
    if (!Number.isFinite(searches) || searches < 0) return;
    setBusy("limit");
    try {
      await api.setAutopilotAllowance(row.brand_user_id, { monthly_searches: searches });
      onAllowanceChanged?.(row.brand_user_id, searches, true);
    } catch (e) {
      fail(e);
    } finally {
      setBusy("");
    }
  }

  async function revertLimit() {
    setBusy("limit");
    try {
      await api.clearAutopilotAllowance(row.brand_user_id);
      onAllowanceChanged?.(row.brand_user_id, defaultLimit, false);
      setLimit(String(defaultLimit ?? ""));
    } catch (e) {
      fail(e);
    } finally {
      setBusy("");
    }
  }

  const label = { fontSize: 11, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.4 };
  const input = {
    width: 64, padding: "6px 8px", borderRadius: 6, border: `1px solid ${theme.border}`,
    background: theme.surface, color: theme.text, fontSize: 13, fontFamily: "inherit",
  };
  const line = { padding: "7px 0", borderBottom: `1px solid ${theme.border}`, fontSize: 13 };
  const muted = { color: theme.textMuted, fontSize: 12 };

  const spent = row.search_allowance != null && row.searches_used >= row.search_allowance;
  const canWake = row.mode !== "off" && ["idle", "waiting"].includes(row.status);

  return (
    <div style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "flex-start" }}>
      {/* ------------------------------------------------------- the steps */}
      <div style={{ flex: "1 1 520px", minWidth: 0 }}>
        <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
          {TABS.map(([key, text]) => {
            const on = tab === key;
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                style={{
                  padding: "5px 10px", borderRadius: 7, border: "none", cursor: "pointer",
                  fontFamily: "inherit", fontSize: 12, fontWeight: on ? 600 : 500,
                  background: on ? theme.accentLight : "transparent",
                  color: on ? theme.text : theme.textMuted,
                }}
              >
                {text}
              </button>
            );
          })}
        </div>

        {tab === "timeline" && (
          !log ? (
            <SkeletonListRows rows={4} lines={[["70%", 13]]} meta={{ width: 76, lines: [[60, 12]] }} padding="6px 0" gap={10} />
          ) : log.events.length === 0 ? (
            <div style={muted}>It has not done anything yet.</div>
          ) : (
            log.events.map((e, i) => (
              <div key={i} style={{ ...line, display: "flex", gap: 10 }}>
                <span style={{ ...muted, minWidth: 76, whiteSpace: "nowrap" }}>{ago(e.created)}</span>
                <span>
                  {e.summary || e.action}
                  {e.detail && <span style={{ color: theme.textMuted }}> — {e.detail}</span>}
                </span>
              </div>
            ))
          )
        )}

        {tab === "searches" && (
          !log ? (
            <SkeletonListRows rows={3} lines={[["40%", 13], ["75%", 12]]} padding="6px 0" gap={10} />
          ) : log.runs.length === 0 ? (
            <div style={muted}>No search has been run for this campaign.</div>
          ) : (
            log.runs.map((run) => (
              <div key={run.id} style={line}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 600 }}>{run.status}</span>
                  <span style={muted}>{ago(run.created)}</span>
                  <span style={muted}>
                    {whole(run.discovered_count)} found · {whole(run.enriched_count)} checked ·{" "}
                    {whole(run.contactable)} reachable · {Number(run.credits_spent || 0).toFixed(2)} credits
                  </span>
                </div>
                {run.error && (
                  <div style={{ color: "#B91C1C", fontSize: 12, marginTop: 3 }}>{run.error}</div>
                )}
                {/* The model's own searches. This is the step everything after
                    it depends on, and it was the one thing the page never
                    showed. */}
                {Array.isArray(run.plan?.queries) && run.plan.queries.length > 0 && (
                  <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 5 }}>
                    {run.plan.queries.map((q, i) => (
                      <div key={i} style={{ fontSize: 12 }}>
                        <span style={{ fontWeight: 600 }}>{q.label || `Search ${i + 1}`}</span>
                        {q.countries?.length > 0 && (
                          <span style={muted}> · {q.countries.slice(0, 6).join(", ")}</span>
                        )}
                        {q.ai_search && (
                          <div style={{ color: theme.textMid, marginTop: 1 }}>{q.ai_search}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {run.plan_rationale && (
                  <div style={{ ...muted, marginTop: 5 }}>{run.plan_rationale}</div>
                )}
              </div>
            ))
          )
        )}

        {tab === "creators" && (
          <>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
              {CREATOR_STATES.map(([value, text, countKey]) => {
                const on = creatorState === value;
                const n = countKey ? creators?.counts?.[countKey] : null;
                return (
                  <button
                    key={value || "all"}
                    onClick={() => setCreatorState(value)}
                    style={{
                      padding: "4px 10px", borderRadius: 999, cursor: "pointer", fontFamily: "inherit",
                      fontSize: 12, fontWeight: on ? 600 : 400,
                      border: `1px solid ${on ? theme.text : theme.border}`,
                      background: on ? theme.accentLight : "transparent",
                      color: on ? theme.text : theme.textMid,
                    }}
                  >
                    {text}
                    {n != null && <span style={{ color: theme.textMuted }}> {n}</span>}
                  </button>
                );
              })}
            </div>
            {!creators || creators.loading ? (
              <SkeletonListRows rows={5} lines={[["45%", 13], ["60%", 11]]} padding="6px 0" gap={10} />
            ) : creators.rows.length === 0 ? (
              <div style={muted}>No creator in this state.</div>
            ) : (
              creators.rows.map((c) => (
                <div key={c.id} style={{ ...line, display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 600 }}>
                    {c.instagram_username ? `@${c.instagram_username}` : c.full_name || "unnamed"}
                  </span>
                  <span style={muted}>
                    {whole(c.followers)} followers
                    {c.engagement ? ` · ${Number(c.engagement).toFixed(1)}% ER` : ""}
                    {c.country ? ` · ${c.country}` : ""}
                  </span>
                  <span style={{ ...muted, marginLeft: "auto", textAlign: "right" }}>
                    {c.applied_at
                      ? `applied ${ago(c.applied_at)}`
                      : c.push_status === "pushed" || c.push_status === "invited"
                        ? `emailed ${ago(c.pushed_at)}`
                        : c.status === "filtered_out"
                          ? c.filter_reason || "filtered out"
                          : c.reachable
                            ? "reachable, not emailed"
                            : "no email found"}
                  </span>
                  {c.query_label && (
                    <div style={{ ...muted, flexBasis: "100%" }}>from “{c.query_label}”</div>
                  )}
                </div>
              ))
            )}
          </>
        )}

        {tab === "replies" && (
          !replies ? (
            <SkeletonListRows rows={3} lines={[["35%", 13], ["80%", 12]]} padding="6px 0" gap={10} />
          ) : replies.length === 0 ? (
            <div style={muted}>Nobody has written back yet.</div>
          ) : (
            replies.map((r) => (
              <div key={r.id} style={line}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 600 }}>
                    {r.instagram_username ? `@${r.instagram_username}` : r.lead_email}
                  </span>
                  <span style={muted}>{ago(r.received_at || r.created)}</span>
                  {r.intent && <span style={muted}>· {r.intent}</span>}
                  {r.needs_human && (
                    <span style={{ fontSize: 11, fontWeight: 600, color: "#B45309" }}>
                      needs a human{r.escalation_reason ? ` — ${r.escalation_reason}` : ""}
                    </span>
                  )}
                  <span style={{ ...muted, marginLeft: "auto" }}>
                    {r.sent_at ? `answered ${ago(r.sent_at)}` : r.status || "unanswered"}
                  </span>
                </div>
                {r.body && <div style={{ fontSize: 12, marginTop: 4 }}>{r.body}</div>}
                {r.draft && !r.sent_at && (
                  <div style={{ ...muted, marginTop: 4 }}>Draft reply: {r.draft}</div>
                )}
                {r.error && <div style={{ color: "#B91C1C", fontSize: 12, marginTop: 3 }}>{r.error}</div>}
              </div>
            ))
          )
        )}
      </div>

      {/* --------------------------------------------------- what it may do */}
      <div style={{ flex: "0 1 300px", minWidth: 240 }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>What it may do</div>

        <div style={{ ...label, marginBottom: 5 }}>Mode</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          {MODES.map(([value, text]) => (
            <Btn
              key={value}
              size="sm"
              variant={row.mode === value ? "solid" : "outline"}
              loading={busy === "agent" && row.mode !== value}
              onClick={() => saveAgent(value)}
            >
              {text}
            </Btn>
          ))}
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 6 }}>
          <div>
            <div style={{ ...label, marginBottom: 4 }}>Goal</div>
            <input style={input} type="number" min="1" max="500" value={goal}
              onChange={(e) => setGoal(e.target.value)} />
          </div>
          <div>
            <div style={{ ...label, marginBottom: 4 }}>Searches</div>
            <input style={input} type="number" min="1" max="10" value={budget}
              onChange={(e) => setBudget(e.target.value)} />
          </div>
          <Btn size="sm" variant="outline" loading={busy === "agent"} onClick={() => saveAgent(row.mode)}>
            Save
          </Btn>
        </div>
        <div style={{ ...muted, marginBottom: 14 }}>
          Applications to stop at, and searches it may spend getting there. Widening either wakes a
          finished agent rather than leaving it stopped.
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
          <Btn size="sm" variant="outline" disabled={!canWake} loading={busy === "wake"} onClick={wake}>
            Check now
          </Btn>
          <span style={muted}>
            {canWake ? `otherwise ${whenNext(row.next_action_at)}` : "only while it is on and waiting"}
          </span>
        </div>

        {/* The brand's month, which is the limit that stops an agent without
            touching its own budget — and the one that reads as a stall. */}
        <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 12 }}>
          <div style={{ ...label, marginBottom: 5 }}>The brand's month</div>
          <div style={{ fontSize: 13, marginBottom: 4 }}>
            {row.searches_used} of {row.search_allowance ?? "—"} searches used
          </div>
          {spent && (
            <div style={{ color: "#B45309", fontSize: 12, marginBottom: 6 }}>
              Spent. It waits for the 1st unless this is raised.
            </div>
          )}
          <div style={{ ...muted, marginBottom: 8 }}>
            Counted across every campaign this brand runs, not this one.
            {row.allowance_is_override
              ? " This brand has a limit of its own."
              : ` Default for every brand${defaultLimit != null ? ` (${defaultLimit})` : ""}.`}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input style={input} type="number" min="0" value={limit}
              onChange={(e) => setLimit(e.target.value)} />
            <Btn size="sm" loading={busy === "limit"} onClick={saveLimit}>
              Set limit
            </Btn>
            {row.allowance_is_override && (
              <Btn size="sm" variant="outline" disabled={busy === "limit"} onClick={revertLimit}>
                Use default
              </Btn>
            )}
          </div>
        </div>

        <div style={{ ...muted, marginTop: 14, lineHeight: 1.5 }}>
          Searching, emailing and replying are not done from here — they spend credits and leave
          the building, so they stay with the agent and its guards. Everything above is what it is
          allowed to do when it next looks.
        </div>
      </div>
    </div>
  );
}
