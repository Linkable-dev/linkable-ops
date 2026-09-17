import { Fragment, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTheme } from "../contexts/ThemeContext";
import { api } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Select } from "../components/ui/Select";
import { Skeleton, SkeletonListRows, SkeletonTableRows } from "../components/ui/Skeleton";

/**
 * GTM outreach, as agents.
 *
 * What this replaces: a list of campaigns with filters, nine templates and a
 * daily cap, which a person drove every morning and which had no opinion about
 * whether it had already done its job. Everything about when to stop lived in
 * somebody's head.
 *
 * An agent has a goal and a budget, runs on its own clock, and stops itself —
 * and an admin can start it, hold it, widen it, or run one pass by hand and
 * watch what happens. The sending underneath is unchanged: an agent points at
 * one of those campaigns and decides whether it runs today, not how it sends.
 */

const STATE_COLORS = {
  working: { bg: "#DBEAFE", fg: "#1E40AF", bgDark: "#0F2547", fgDark: "#93C5FD" },
  waiting: { bg: "#FEF3C7", fg: "#92400E", bgDark: "#3B2A0E", fgDark: "#FCD34D" },
  idle: { bg: "#F3F4F6", fg: "#4B5563", bgDark: "#1F2937", fgDark: "#9CA3AF" },
  done: { bg: "#D1FAE5", fg: "#065F46", bgDark: "#0E2E22", fgDark: "#6EE7B7" },
  paused: { bg: "#F3F4F6", fg: "#4B5563", bgDark: "#1F2937", fgDark: "#9CA3AF" },
  failed: { bg: "#FEE2E2", fg: "#991B1B", bgDark: "#3F1313", fgDark: "#FCA5A5" },
  off: { bg: "#F3F4F6", fg: "#4B5563", bgDark: "#1F2937", fgDark: "#9CA3AF" },
  autonomous: { bg: "#EDE9FE", fg: "#5B21B6", bgDark: "#2A1B47", fgDark: "#C4B5FD" },
  assisted: { bg: "#E0E7FF", fg: "#3730A3", bgDark: "#1E1B47", fgDark: "#A5B4FC" },
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
  return `${Math.floor(hours / 24)}d ago`;
}

function when(raw) {
  if (!raw) return "—";
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return "—";
  const mins = Math.round((at.getTime() - Date.now()) / 60000);
  if (mins <= 0) return "due now";
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
}

// One input style, so the form reads as one control rather than six.
function field(theme) {
  return {
    display: "block",
    width: "100%",
    marginTop: 4,
    padding: "7px 9px",
    borderRadius: 8,
    border: `1px solid ${theme.border}`,
    background: theme.surface,
    color: theme.text,
    fontSize: 13,
  };
}

export default function GtmAgentsPage() {
  const { theme, mode } = useTheme();
  const dark = mode === "dark";

  const [agents, setAgents] = useState([]);
  const [available, setAvailable] = useState(true);
  // Why it is unavailable, in the server's words. There is more than one
  // reason and they need different people to fix them: a migration nobody has
  // applied, or a key that row-level security is hiding every row from.
  const [unavailableReason, setUnavailableReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState({ events: [], metrics: null, replies: [], loading: false });
  const [busy, setBusy] = useState("");
  const [runLog, setRunLog] = useState(null);
  // Creating one: an agent is a goal and a budget put in front of a campaign
  // that already exists, so the form is four numbers and a picker.
  const [campaigns, setCampaigns] = useState([]);
  const [draft, setDraft] = useState({
    name: "",
    email_campaign_id: "",
    audience_type: "brand",
    goal_replies: 20,
    max_prospects: 500,
    daily_cap: 40,
  });

  const load = useCallback(
    () =>
      api
        .getOutboundAgents()
        .then((d) => {
          setAgents(d.agents || []);
          setAvailable(d.available !== false);
          setUnavailableReason(d.reason || "");
          setError("");
        })
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    let live = true;
    api
      .getOutboundAgents()
      .then((d) => {
        if (!live) return;
        setAgents(d.agents || []);
        setAvailable(d.available !== false);
        setUnavailableReason(d.reason || "");
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  // The campaigns an agent can be put in front of. Loaded once; an agent
  // without one has nothing to send from, so the form refuses to submit.
  useEffect(() => {
    let live = true;
    api
      .listOutboundCampaigns({ limit: 100 })
      .then((d) => live && setCampaigns(d.campaigns || d.data || []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  async function adopt() {
    setBusy("adopt");
    try {
      const d = await api.adoptOutboundCampaigns();
      setRunLog({ summary: `Adopted ${d.adopted} campaign${d.adopted === 1 ? "" : "s"}`, log: [] });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  async function create() {
    if (!draft.name.trim() || !draft.email_campaign_id) return;
    setBusy("new");
    try {
      await api.createOutboundAgent(draft);
      setDraft({ ...draft, name: "", email_campaign_id: "" });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  function openAgent(id) {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    setDetail({ events: [], metrics: null, replies: [], loading: true });
    api
      .getOutboundAgent(id)
      .then((d) =>
        setDetail({
          events: d.events || [],
          metrics: d.metrics || null,
          replies: d.replies || [],
          loading: false,
        }),
      )
      .catch(() => setDetail({ events: [], metrics: null, replies: [], loading: false }));
  }

  async function setMode(id, next) {
    setBusy(id);
    try {
      await api.updateOutboundAgent(id, { mode: next });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  // One pass, now. `dry` prepares without sending — the way to look before
  // leaping, and the reason an admin can run this at all.
  async function runNow(id, dry) {
    setBusy(id);
    setRunLog(null);
    try {
      const d = await api.runOutboundAgent(id, { dry });
      setRunLog({ id, summary: d.result?.summary || d.result?.action, log: d.log || [] });
      await load();
      if (openId === id) openAgent(id), openAgent(id);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  const pill = (value) => {
    const c = STATE_COLORS[value] || STATE_COLORS.idle;
    return (
      <span
        style={{
          display: "inline-block",
          padding: "2px 8px",
          borderRadius: 999,
          fontSize: 12,
          fontWeight: 600,
          whiteSpace: "nowrap",
          background: dark ? c.bgDark : c.bg,
          color: dark ? c.fgDark : c.fg,
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
  const td = { padding: "10px", fontSize: 13, borderBottom: `1px solid ${theme.border}` };
  const num = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
  const button = {
    padding: "4px 10px",
    borderRadius: 8,
    border: `1px solid ${theme.border}`,
    background: theme.surface,
    color: theme.text,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>Outbound</h1>
      <p style={{ color: theme.textMuted, fontSize: 13, margin: "0 0 20px", maxWidth: 720 }}>
        Each agent has a goal, a budget and its own clock: it enrols, sends, follows up and stops
        when it has what it was asked for. Start one and leave it, or run a single pass and watch.
        The campaign behind it still owns the templates and the sender.
      </p>

      {!available && !loading && (
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Nothing to show yet</div>
          <div style={{ color: theme.textMuted, fontSize: 13 }}>
            {unavailableReason || (
              <>
                The agent tables are not in this database yet — apply{" "}
                <code>supabase/migrations/018_outbound_agents.sql</code> and reload. Nothing else
                is affected in the meantime.
              </>
            )}
          </div>
        </Card>
      )}

      {error && (
        <Card>
          <div style={{ color: "#B91C1C", fontSize: 13 }}>{error}</div>
        </Card>
      )}

      {runLog && (
        <Card>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>{runLog.summary}</div>
          <pre
            style={{
              margin: 0,
              maxHeight: 220,
              overflow: "auto",
              fontSize: 11,
              lineHeight: 1.5,
              color: theme.textMuted,
              whiteSpace: "pre-wrap",
            }}
          >
            {runLog.log.join("\n") || "Nothing to report."}
          </pre>
        </Card>
      )}

      {available && (
        <Card>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>New agent</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label style={{ flex: "1 1 180px", fontSize: 12, color: theme.textMuted }}>
              Name
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="UK skincare brands"
                style={field(theme)}
              />
            </label>
            <label style={{ flex: "1 1 220px", fontSize: 12, color: theme.textMuted }}>
              Sends from
              <Select
                value={draft.email_campaign_id}
                onChange={(id) => {
                  const c = campaigns.find((x) => x.id === id);
                  setDraft({
                    ...draft,
                    email_campaign_id: id,
                    audience_type: c?.audience_type || draft.audience_type,
                  });
                }}
                ariaLabel="Sends from"
                placeholder="Pick a campaign…"
                options={campaigns.map((c) => ({
                  value: c.id,
                  label: c.name,
                  hint: `${c.audience_type || "brand"}${c.status ? ` · ${c.status}` : ""}`,
                }))}
                searchPlaceholder="Campaign name…"
              />
            </label>
            <label style={{ width: 110, fontSize: 12, color: theme.textMuted }}>
              Goal (replies)
              <input
                type="number"
                min="1"
                value={draft.goal_replies}
                onChange={(e) => setDraft({ ...draft, goal_replies: e.target.value })}
                style={field(theme)}
              />
            </label>
            <label style={{ width: 120, fontSize: 12, color: theme.textMuted }}>
              Budget (people)
              <input
                type="number"
                min="1"
                value={draft.max_prospects}
                onChange={(e) => setDraft({ ...draft, max_prospects: e.target.value })}
                style={field(theme)}
              />
            </label>
            <label style={{ width: 100, fontSize: 12, color: theme.textMuted }}>
              Per day
              <input
                type="number"
                min="1"
                value={draft.daily_cap}
                onChange={(e) => setDraft({ ...draft, daily_cap: e.target.value })}
                style={field(theme)}
              />
            </label>
            <button
              style={{ ...button, padding: "8px 14px" }}
              disabled={busy === "new" || !draft.name.trim() || !draft.email_campaign_id}
              onClick={create}
            >
              Create, switched off
            </button>
            {/* The campaigns that predate agents. Safe to press twice: one
                agent per campaign is a unique index, and adoption skips what
                already has one. */}
            <button
              style={{ ...button, padding: "8px 14px" }}
              disabled={busy === "adopt"}
              onClick={adopt}
              title="Give every live campaign an agent of its own, switched off"
            >
              {busy === "adopt" ? "Adopting…" : "Adopt existing campaigns"}
            </button>
          </div>
          <div style={{ color: theme.textMuted, fontSize: 12, marginTop: 8 }}>
            It starts off. Press Start when you want it running, or Dry run to watch one pass
            without sending anything.
          </div>
        </Card>
      )}

      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 28 }} />
                <th style={th}>Agent</th>
                <th style={th}>Audience</th>
                <th style={th}>Mode</th>
                <th style={th}>State</th>
                <th style={{ ...th, textAlign: "right" }}>Contacted</th>
                <th style={{ ...th, textAlign: "right" }}>Replied</th>
                <th style={{ ...th, textAlign: "right" }}>Per day</th>
                <th style={th}>Last did</th>
                <th style={th}>Next</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {loading && <SkeletonTableRows rows={4} cols={11} />}

              {!loading && agents.length === 0 && (
                <tr>
                  <td style={{ ...td, color: theme.textMuted }} colSpan={11}>
                    No agents yet. One points at an existing campaign and decides when it runs.
                  </td>
                </tr>
              )}

              {!loading &&
                agents.map((a) => (
                  <Fragment key={a.id}>
                    <tr>
                      <td
                        style={{ ...td, color: theme.textMuted, cursor: "pointer" }}
                        onClick={() => openAgent(a.id)}
                      >
                        {openId === a.id ? "▾" : "▸"}
                      </td>
                      <td style={{ ...td, fontWeight: 600, cursor: "pointer" }} onClick={() => openAgent(a.id)}>
                        {a.name}
                        <div style={{ color: theme.textMuted, fontWeight: 400, fontSize: 12 }}>
                          {a.email_campaigns?.id ? (
                            <Link
                              to={`/ai/campaigns/${a.email_campaigns.id}`}
                              onClick={(e) => e.stopPropagation()}
                              style={{ color: theme.textMuted }}
                              title="Templates, senders and slots"
                            >
                              {a.email_campaigns.name}
                            </Link>
                          ) : (
                            "no campaign"
                          )}
                        </div>
                      </td>
                      <td style={{ ...td, color: theme.textMuted }}>{a.audience_type}</td>
                      <td style={td}>{pill(a.mode)}</td>
                      <td style={td}>
                        {pill(a.status)}
                        {a.stopped_reason && (
                          <div style={{ color: theme.textMuted, fontSize: 11, marginTop: 3 }}>
                            {a.stopped_reason}
                          </div>
                        )}
                      </td>
                      <td style={num}>
                        {a.contacted}
                        <span style={{ color: theme.textMuted }}>/{a.max_prospects}</span>
                      </td>
                      {/* The number it exists to produce, against the goal that
                          stops it. */}
                      <td style={{ ...num, fontWeight: 600 }}>
                        {a.replied}
                        <span style={{ color: theme.textMuted, fontWeight: 400 }}>
                          /{a.goal_replies}
                        </span>
                      </td>
                      <td style={num}>{a.daily_cap}</td>
                      <td style={{ ...td, color: theme.textMuted, whiteSpace: "nowrap" }}>
                        {ago(a.last_acted_at)}
                      </td>
                      <td style={{ ...td, color: theme.textMuted, whiteSpace: "nowrap" }}>
                        {a.mode === "off" || ["done", "failed"].includes(a.status)
                          ? "—"
                          : when(a.next_action_at)}
                      </td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                          {a.mode === "off" ? (
                            <button
                              style={button}
                              disabled={busy === a.id}
                              onClick={() => setMode(a.id, "autonomous")}
                            >
                              Start
                            </button>
                          ) : (
                            <button
                              style={button}
                              disabled={busy === a.id}
                              onClick={() => setMode(a.id, "off")}
                            >
                              Stop
                            </button>
                          )}
                          <button
                            style={button}
                            disabled={busy === a.id || a.mode === "off"}
                            onClick={() => runNow(a.id, true)}
                            title="One pass, sending nothing"
                          >
                            Dry run
                          </button>
                          <button
                            style={button}
                            disabled={busy === a.id || a.mode === "off"}
                            onClick={() => runNow(a.id, false)}
                          >
                            Run now
                          </button>
                        </div>
                      </td>
                    </tr>

                    {openId === a.id && (
                      <tr>
                        <td style={{ ...td, background: theme.bg }} colSpan={11}>
                          {/* The six metric tiles and the log beneath them,
                              in outline, so the row keeps its height while it
                              fills. */}
                          {detail.loading && (
                            <div>
                              <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 16 }}>
                                {[0, 1, 2, 3, 4, 5].map((i) => (
                                  <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                    <Skeleton width={58} height={11} />
                                    <Skeleton width={i === 2 || i === 3 ? 62 : 34} height={15} />
                                  </div>
                                ))}
                              </div>
                              <SkeletonListRows
                                rows={3}
                                lines={[["60%", 13]]}
                                meta={{ width: 76, lines: [[60, 12]] }}
                                padding="6px 0"
                                gap={10}
                              />
                            </div>
                          )}
                          {!detail.loading && (
                            <div style={{ display: "flex", gap: 28, flexWrap: "wrap", marginBottom: 14 }}>
                              {/* How it is landing. The numbers the campaign
                                  page kept to itself, next to what produced
                                  them. */}
                              {detail.metrics && (
                                <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
                                  {[
                                    ["Sent", detail.metrics.sent],
                                    ["Delivered", detail.metrics.delivered],
                                    ["Opened", `${detail.metrics.opened} (${detail.metrics.open_rate}%)`],
                                    ["Replied", `${detail.metrics.replied} (${detail.metrics.reply_rate}%)`],
                                    ["Bounced", detail.metrics.bounced],
                                    ["Queued", detail.metrics.pending],
                                  ].map(([label, value]) => (
                                    <div key={label}>
                                      <div style={{ fontSize: 11, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.4 }}>
                                        {label}
                                      </div>
                                      <div style={{ fontSize: 15, fontWeight: 700 }}>{value}</div>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {detail.replies.length > 0 && (
                                <div style={{ minWidth: 220 }}>
                                  <div style={{ fontSize: 11, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>
                                    Who replied
                                  </div>
                                  {detail.replies.map((r, i) => (
                                    <div key={i} style={{ fontSize: 12 }}>
                                      {r.email}
                                      <span style={{ color: theme.textMuted }}> · {ago(r.at)}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}

                          {!detail.loading && detail.events.length === 0 && (
                            <div style={{ color: theme.textMuted, fontSize: 13 }}>
                              Nothing yet — it has not run.
                            </div>
                          )}
                          {!detail.loading &&
                            detail.events.map((e, i) => (
                              <div
                                key={i}
                                style={{
                                  display: "flex",
                                  gap: 10,
                                  padding: "6px 0",
                                  borderBottom:
                                    i < detail.events.length - 1 ? `1px solid ${theme.border}` : "none",
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
                                  {ago(e.created_at)}
                                </span>
                                <span style={{ fontSize: 13 }}>
                                  {e.summary || e.action}
                                  {e.detail && (
                                    <span style={{ color: theme.textMuted }}> — {e.detail}</span>
                                  )}
                                </span>
                              </div>
                            ))}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
