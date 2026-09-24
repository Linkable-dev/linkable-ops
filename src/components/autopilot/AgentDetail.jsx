import { useCallback, useEffect, useState } from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { api } from "../../lib/api";
import { Btn } from "../ui/Button";
import { SkeletonListRows } from "../ui/Skeleton";
import { ago, whenNext } from "../../lib/relativeTime";

/**
 * One campaign's agent, opened up: the conversation that set it up, every
 * step it took, everything those steps produced, and the settings an admin
 * can change about it.
 *
 * It used to be a log and a list of runs. That answers "what happened" and
 * nothing else — not who it found, not what came back, and not what to do
 * about any of it, which meant every real question ended in a psql session.
 *
 * Six tabs, because they are six different questions asked at six different
 * moments; and one controls block, always visible, because the answer to
 * "why is it stuck" is usually a setting.
 *
 * On what the controls may do, see the contract at the top of
 * server/routes/autopilot.js: this sets what the agent is ALLOWED to do. It
 * never makes it search, email or reply — those spend money and leave the
 * building, and they belong to gRPC.
 */

const TABS = [
  ["chats", "Chats"],
  ["timeline", "Timeline"],
  ["searches", "Searches"],
  ["creators", "Creators"],
  ["emails", "Emails"],
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

const CREATOR_STAGE_COLORS = {
  applied:     { bg: "#D1FAE5", fg: "#065F46", bgDark: "#0E2E22", fgDark: "#6EE7B7" },
  emailed:     { bg: "#DBEAFE", fg: "#1E40AF", bgDark: "#0F2547", fgDark: "#93C5FD" },
  reachable:   { bg: "#F3F4F6", fg: "#4B5563", bgDark: "#1F2937", fgDark: "#9CA3AF" },
  unreachable: { bg: "#F3F4F6", fg: "#9CA3AF", bgDark: "#1F2937", fgDark: "#6B7280" },
  filtered:    { bg: "#FEE2E2", fg: "#991B1B", bgDark: "#3F1313", fgDark: "#FCA5A5" },
};

// The stage a creator row is actually in, in the same priority the funnel
// itself goes in — a creator who applied is not also just "emailed".
function creatorStage(c) {
  if (c.applied_at) return "applied";
  if (c.push_status === "pushed" || c.push_status === "invited") return "emailed";
  if (c.status === "filtered_out") return "filtered";
  if (c.reachable) return "reachable";
  return "unreachable";
}
const CREATOR_STAGE_LABEL = {
  applied: "Applied", emailed: "Emailed", reachable: "Reachable, not emailed",
  unreachable: "No email found", filtered: "Filtered out",
};

const EMAIL_TYPES = [
  ["", "All", "total"],
  ["emailsSent", "Sent", "sent"],
  ["emailsOpened", "Opened", "opened"],
  ["emailsClicked", "Clicked", "clicked"],
  ["emailsReplied", "Replied", "replied"],
];
const EMAIL_TYPE_COLORS = {
  emailsSent:             { bg: "#F3F4F6", fg: "#4B5563", bgDark: "#1F2937", fgDark: "#9CA3AF" },
  emailsOpened:           { bg: "#DBEAFE", fg: "#1E40AF", bgDark: "#0F2547", fgDark: "#93C5FD" },
  emailsClicked:          { bg: "#EDE9FE", fg: "#5B21B6", bgDark: "#2E1F4E", fgDark: "#C4B5FD" },
  emailsReplied:          { bg: "#D1FAE5", fg: "#065F46", bgDark: "#0E2E22", fgDark: "#6EE7B7" },
  linkedinInviteAccepted: { bg: "#D1FAE5", fg: "#065F46", bgDark: "#0E2E22", fgDark: "#6EE7B7" },
};
const EMAIL_TYPE_LABEL = {
  emailsSent: "Sent", emailsOpened: "Opened", emailsClicked: "Clicked",
  emailsReplied: "Replied", linkedinInviteAccepted: "LinkedIn accepted", paused: "Paused",
};

function whole(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : String(v);
}

// A face for the row: the creator's own picture when we have one (see
// withProfileImages server-side — signed, or already a fetchable URL), a
// letter on a flat colour otherwise. Never a broken-image icon: `onError`
// drops back to the letter rather than showing the browser's own glyph.
function Avatar({ src, name, size = 32, theme }) {
  const [broken, setBroken] = useState(false);
  const letter = (name || "?").replace("@", "").charAt(0).toUpperCase();
  if (src && !broken) {
    return (
      <img
        src={src}
        alt=""
        onError={() => setBroken(true)}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0, background: theme.surfaceAlt }}
      />
    );
  }
  return (
    <span style={{
      width: size, height: size, borderRadius: "50%", flexShrink: 0,
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      background: theme.accentLight, color: theme.textMid,
      fontSize: size * 0.4, fontWeight: 700,
    }}>
      {letter}
    </span>
  );
}

function StagePill({ value, label, colors, dark }) {
  const c = colors[value] || Object.values(colors)[0];
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 999,
      fontSize: 11, fontWeight: 600, whiteSpace: "nowrap",
      background: dark ? c.bgDark : c.bg, color: dark ? c.fgDark : c.fg,
    }}>
      {label}
    </span>
  );
}

// autopilot_chats is append-only, one row per model call: each row's
// `transcript` is every line said BEFORE that call, so row N's array is a
// growing prefix of row N+1's. Replaying every row's transcript in full would
// show the opening lines over and over, once per turn. This walks the rows in
// order and only emits what's NEW since the previous row, then that row's own
// reply — which reconstructs the whole thread exactly once.
function buildThread(chats) {
  const messages = [];
  let shown = 0;
  for (const row of chats) {
    const transcript = Array.isArray(row.transcript) ? row.transcript : [];
    for (const t of transcript.slice(shown)) {
      if (t?.text) messages.push({ role: t.role === "autopilot" ? "autopilot" : "brand", text: t.text });
    }
    shown = transcript.length;
    if (row.reply) {
      messages.push({
        role: "autopilot", text: row.reply, provider: row.provider,
        ready: row.ready, options: row.options, plan: row.plan,
      });
    }
  }
  return messages;
}

export default function AgentDetail({ row, defaultLimit, onManage, onAgentChanged, onAllowanceChanged, onError }) {
  const { theme, mode } = useTheme();
  const dark = mode === "dark";
  const [tab, setTab] = useState("timeline");

  // Each tab fetches once, when it is first opened: the timeline is what
  // everybody wants and the creators list is five hundred rows nobody asked
  // for until they click it.
  const [log, setLog] = useState(null);
  const [chats, setChats] = useState(null);
  const [creators, setCreators] = useState(null);
  const [creatorState, setCreatorState] = useState("");
  const [emails, setEmails] = useState(null);
  const [emailType, setEmailType] = useState("");
  const [replies, setReplies] = useState(null);

  const [busy, setBusy] = useState("");
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

  useEffect(() => {
    if (tab !== "chats" || chats) return undefined;
    let live = true;
    api
      .getAutopilotChats(row.product_id)
      .then((d) => live && setChats({ available: d.available !== false, thread: buildThread(d.chats || []) }))
      .catch((e) => live && fail(e));
    return () => {
      live = false;
    };
  }, [tab, chats, row.product_id, fail]);

  // Re-reads from the start when the state chip changes — that is the only
  // way this list is narrowed. "Load more" appends instead, onto whatever
  // chip is currently selected.
  useEffect(() => {
    if (tab !== "creators") return undefined;
    let live = true;
    setCreators((c) => (c ? { ...c, loading: true } : null));
    api
      .getAutopilotCreators(row.product_id, { limit: 25, offset: 0, state: creatorState || undefined })
      .then((d) => live && setCreators({
        rows: d.creators || [], counts: d.counts || {}, matching: d.matching ?? 0, loading: false,
      }))
      .catch((e) => live && fail(e));
    return () => {
      live = false;
    };
  }, [tab, creatorState, row.product_id, fail]);

  async function loadMoreCreators() {
    if (!creators) return;
    setCreators((c) => ({ ...c, loadingMore: true }));
    try {
      const d = await api.getAutopilotCreators(row.product_id, {
        limit: 25, offset: creators.rows.length, state: creatorState || undefined,
      });
      setCreators((c) => ({ ...c, rows: [...c.rows, ...(d.creators || [])], loadingMore: false }));
    } catch (e) {
      fail(e);
      setCreators((c) => ({ ...c, loadingMore: false }));
    }
  }

  useEffect(() => {
    if (tab !== "emails") return undefined;
    let live = true;
    setEmails((c) => (c ? { ...c, loading: true } : null));
    api
      .getAutopilotEmails(row.product_id, { limit: 25, offset: 0, type: emailType || undefined })
      .then((d) => live && setEmails({
        rows: d.emails || [], counts: d.counts || {}, matching: d.matching ?? 0, loading: false,
      }))
      .catch((e) => live && fail(e));
    return () => {
      live = false;
    };
  }, [tab, emailType, row.product_id, fail]);

  async function loadMoreEmails() {
    if (!emails) return;
    setEmails((c) => ({ ...c, loadingMore: true }));
    try {
      const d = await api.getAutopilotEmails(row.product_id, {
        limit: 25, offset: emails.rows.length, type: emailType || undefined,
      });
      setEmails((c) => ({ ...c, rows: [...c.rows, ...(d.emails || [])], loadingMore: false }));
    } catch (e) {
      fail(e);
      setEmails((c) => ({ ...c, loadingMore: false }));
    }
  }

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
  const line = { padding: "9px 0", borderBottom: `1px solid ${theme.border}`, fontSize: 13 };
  const muted = { color: theme.textMuted, fontSize: 12 };
  const chip = (on) => ({
    padding: "4px 10px", borderRadius: 999, cursor: "pointer", fontFamily: "inherit",
    fontSize: 12, fontWeight: on ? 600 : 400,
    border: `1px solid ${on ? theme.text : theme.border}`,
    background: on ? theme.accentLight : "transparent",
    color: on ? theme.text : theme.textMid,
  });

  const spent = row.search_allowance != null && row.searches_used >= row.search_allowance;
  // "none" is a campaign with no agent row yet, so there is nothing to wake
  // and nothing to re-save: the mode buttons are the only thing that applies.
  const notLaunched = row.mode === "none";
  const canWake = !notLaunched && row.mode !== "off" && ["idle", "waiting"].includes(row.status);

  return (
    <div style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "flex-start" }}>
      {/* ------------------------------------------------------- the steps */}
      <div style={{ flex: "1 1 560px", minWidth: 0 }}>
        <div style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
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

        {tab === "chats" && (
          !chats ? (
            <SkeletonListRows rows={3} lines={[["55%", 13], ["80%", 12]]} padding="6px 0" gap={10} />
          ) : !chats.available ? (
            <div style={muted}>Autopilot chat history is not available on this database.</div>
          ) : chats.thread.length === 0 ? (
            <div style={muted}>
              No Autopilot conversation recorded — this campaign was built manually, or predates
              conversation logging.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {chats.thread.map((m, i) => {
                const brand = m.role === "brand";
                return (
                  <div key={i} style={{ display: "flex", justifyContent: brand ? "flex-end" : "flex-start" }}>
                    <div style={{
                      maxWidth: "82%", padding: "8px 12px", borderRadius: 12,
                      borderBottomRightRadius: brand ? 3 : 12, borderBottomLeftRadius: brand ? 12 : 3,
                      background: brand ? theme.accentLight : theme.surfaceAlt,
                      fontSize: 13, lineHeight: 1.45,
                    }}>
                      <div>{m.text}</div>
                      {!brand && m.options?.length > 0 && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 7 }}>
                          {m.options.map((o, oi) => (
                            <span key={oi} style={{
                              fontSize: 11, padding: "2px 8px", borderRadius: 999,
                              border: `1px solid ${theme.border}`, color: theme.textMid,
                            }}>
                              {o}
                            </span>
                          ))}
                        </div>
                      )}
                      {!brand && (m.provider || m.ready) && (
                        <div style={{ ...muted, marginTop: 6, fontSize: 10.5 }}>
                          {m.provider}
                          {m.ready && (m.provider ? " · " : "") + `ready${m.plan ? ", campaign plan produced" : ""}`}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )
        )}

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
                const n = countKey ? creators?.counts?.[countKey] : null;
                return (
                  <button key={value || "all"} onClick={() => setCreatorState(value)} style={chip(creatorState === value)}>
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
              <>
                {creators.rows.map((c) => {
                  const stage = creatorStage(c);
                  return (
                    <div key={c.id} style={{ ...line, display: "flex", gap: 10, alignItems: "flex-start" }}>
                      <Avatar src={c.profile_image} name={c.instagram_username || c.full_name} theme={theme} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                          <span style={{ fontWeight: 600 }}>
                            {c.instagram_username ? `@${c.instagram_username}` : c.full_name || "unnamed"}
                          </span>
                          <span style={muted}>
                            {whole(c.followers)} followers
                            {c.engagement ? ` · ${Number(c.engagement).toFixed(1)}% ER` : ""}
                            {c.country ? ` · ${c.country}` : ""}
                          </span>
                          <span style={{ marginLeft: "auto" }}>
                            <StagePill value={stage} label={CREATOR_STAGE_LABEL[stage]} colors={CREATOR_STAGE_COLORS} dark={dark} />
                          </span>
                        </div>
                        <div style={{ ...muted, marginTop: 2 }}>
                          {stage === "applied" && `applied ${ago(c.applied_at)}`}
                          {stage === "emailed" && `emailed ${ago(c.pushed_at)}`}
                          {stage === "filtered" && (c.filter_reason || "filtered out")}
                          {c.query_label && ` · from “${c.query_label}”`}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
                  {creators.rows.length < creators.matching && (
                    <Btn size="sm" variant="outline" loading={creators.loadingMore} onClick={loadMoreCreators}>
                      Load more
                    </Btn>
                  )}
                  <span style={muted}>{creators.rows.length} of {creators.matching}</span>
                </div>
              </>
            )}
          </>
        )}

        {tab === "emails" && (
          <>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
              {EMAIL_TYPES.map(([value, text, countKey]) => {
                const n = countKey ? emails?.counts?.[countKey] : null;
                return (
                  <button key={value || "all"} onClick={() => setEmailType(value)} style={chip(emailType === value)}>
                    {text}
                    {n != null && <span style={{ color: theme.textMuted }}> {n}</span>}
                  </button>
                );
              })}
            </div>
            {!emails || emails.loading ? (
              <SkeletonListRows rows={5} lines={[["45%", 13], ["30%", 11]]} padding="6px 0" gap={10} />
            ) : emails.rows.length === 0 ? (
              <div style={muted}>No email activity recorded yet.</div>
            ) : (
              <>
                {emails.rows.map((e) => (
                  <div key={e.id} style={{ ...line, display: "flex", gap: 10, alignItems: "center" }}>
                    <Avatar src={e.profile_image} name={e.instagram_username || e.lead_email} size={28} theme={theme} />
                    <span style={{ fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {e.instagram_username ? `@${e.instagram_username}` : e.lead_email}
                    </span>
                    <StagePill
                      value={e.event_type}
                      label={EMAIL_TYPE_LABEL[e.event_type] || e.event_type}
                      colors={EMAIL_TYPE_COLORS}
                      dark={dark}
                    />
                    <span style={{ ...muted, marginLeft: "auto", whiteSpace: "nowrap" }}>{ago(e.occurred_at)}</span>
                  </div>
                ))}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
                  {emails.rows.length < emails.matching && (
                    <Btn size="sm" variant="outline" loading={emails.loadingMore} onClick={loadMoreEmails}>
                      Load more
                    </Btn>
                  )}
                  <span style={muted}>{emails.rows.length} of {emails.matching}</span>
                </div>
              </>
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
              <div key={r.id} style={{ ...line, display: "flex", gap: 10, alignItems: "flex-start" }}>
                <Avatar src={r.profile_image} name={r.instagram_username || r.lead_email} theme={theme} />
                <div style={{ flex: 1, minWidth: 0 }}>
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
              </div>
            ))
          )
        )}
      </div>

      {/* --------------------------------------------------- what it may do */}
      <div style={{ flex: "0 1 300px", minWidth: 240 }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>What it may do</div>

        {/* What it is doing, then one way to change it.
            This used to be three mode buttons that took effect on the press,
            and the press that mattered spent credits and emailed several
            hundred strangers. Reading the state and changing it are different
            jobs; only the first belongs on a panel you scroll past. */}
        <div style={{ fontSize: 13, marginBottom: 4 }}>
          {notLaunched
            ? "Never launched"
            : row.mode === "off"
              ? "Switched off — not searching, not sending"
              : row.mode === "autonomous"
                ? `Running it — ${row.runs_used} of ${row.max_runs} searches used`
                : `Finding creators only — ${row.runs_used} of ${row.max_runs} searches used`}
        </div>
        <div style={{ ...muted, marginBottom: 10 }}>
          {notLaunched
            ? "Nothing has been searched, spent or sent for this campaign."
            : `Stops at ${row.goal_applications} applications. ${row.applied} so far.`}
        </div>
        <div style={{ marginBottom: 14 }}>
          <Btn
            size="sm"
            variant={notLaunched || row.mode === "off" ? "solid" : "outline"}
            onClick={() => onManage?.()}
          >
            {notLaunched || row.mode === "off" ? "Launch Autopilot" : "Manage Autopilot"}
          </Btn>
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
