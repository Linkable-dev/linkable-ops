// Unified inbox: manual-triage replies + AI conversation threads in one queue.
//
// Manual rows come from email_sends.replied_at (campaigns with auto_reply=false).
// AI rows come from ai_conversations (campaigns with auto_reply=true). Both are
// merged server-side by latest activity so an operator works one list instead
// of jumping between two UIs.
//
// Backend: /api/outbound/inbox (listOutboundInbox / getOutboundInboxManual /
// handleOutboundInboxManual / optOutOutboundInboxManual). AI thread detail
// still goes through the existing /api/conversations/threads/:id endpoint.

import { useCallback, useEffect, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api, friendlyDate } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { SkeletonRow } from "../components/ui/Skeleton";

const MODE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "manual", label: "Manual" },
  { value: "ai", label: "AI" },
];
const STATUS_OPTIONS = [
  { value: "unhandled", label: "Needs reply" },
  { value: "handled", label: "Handled" },
  { value: "all", label: "All" },
];

export default function AiInboxPage() {
  const { theme } = useTheme();

  const [mode, setMode] = useState("all");
  const [status, setStatus] = useState("unhandled");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [selected, setSelected] = useState(null);   // row object from list
  const [detail, setDetail] = useState(null);       // detail payload (shape depends on mode)
  const [detailLoading, setDetailLoading] = useState(false);
  const [busyAction, setBusyAction] = useState(null);

  const loadList = useCallback(() => {
    setLoading(true);
    setError(null);
    api.listOutboundInbox({ mode, status, q: search || undefined, limit: 100 })
      .then((res) => setRows(res.rows || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [mode, status, search]);

  useEffect(() => { loadList(); }, [loadList]);

  // Load detail whenever selection changes.
  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    setDetailLoading(true);
    const p = selected.mode === "manual"
      ? api.getOutboundInboxManual(selected.send_id)
      : api.getAiThread(selected.conversation_id);
    p.then(setDetail)
     .catch((e) => setError(e.message))
     .finally(() => setDetailLoading(false));
  }, [selected]);

  // After any action that changes a row's state, refetch both list + detail.
  const refreshAfterAction = useCallback(async () => {
    await loadList();
    if (selected?.mode === "manual") {
      const d = await api.getOutboundInboxManual(selected.send_id).catch(() => null);
      setDetail(d);
    }
  }, [loadList, selected]);

  async function onMarkHandled() {
    if (!selected || selected.mode !== "manual") return;
    setBusyAction("handle");
    try {
      await api.handleOutboundInboxManual(selected.send_id);
      await refreshAfterAction();
    } catch (e) { setError(e.message); }
    finally { setBusyAction(null); }
  }

  async function onUnhandle() {
    if (!selected || selected.mode !== "manual") return;
    setBusyAction("unhandle");
    try {
      await api.unhandleOutboundInboxManual(selected.send_id);
      await refreshAfterAction();
    } catch (e) { setError(e.message); }
    finally { setBusyAction(null); }
  }

  async function onOptOut() {
    if (!selected || selected.mode !== "manual") return;
    if (!confirm(`Opt out ${selected.to_email}? This adds them to suppressions and cancels remaining touches.`)) return;
    setBusyAction("opt-out");
    try {
      await api.optOutOutboundInboxManual(selected.send_id, { note: "ui inbox opt-out" });
      await refreshAfterAction();
    } catch (e) { setError(e.message); }
    finally { setBusyAction(null); }
  }

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: theme.text, margin: 0 }}>Inbox</h1>
        <p style={{ fontSize: 13, color: theme.textMuted, margin: "4px 0 0" }}>
          Replies that need attention — manual-triage and AI-managed threads in one queue.
        </p>
      </div>

      <FilterBar
        theme={theme}
        mode={mode} setMode={setMode}
        status={status} setStatus={setStatus}
        search={search} setSearch={setSearch}
      />

      {error && (
        <Card style={{ borderColor: "#DC2626", marginBottom: 12 }}>
          <div style={{ color: "#DC2626", fontSize: 13 }}>{error}</div>
        </Card>
      )}

      <div style={{
        display: "grid",
        gridTemplateColumns: selected ? "minmax(0, 360px) minmax(0, 1fr)" : "1fr",
        gap: 16, alignItems: "start",
      }}>
        <InboxList
          theme={theme}
          rows={rows}
          loading={loading}
          selectedId={selected?.id || null}
          onSelect={setSelected}
          status={status}
        />
        {selected && (
          <DetailPane
            theme={theme}
            selected={selected}
            detail={detail}
            loading={detailLoading}
            busyAction={busyAction}
            onClose={() => setSelected(null)}
            onMarkHandled={onMarkHandled}
            onUnhandle={onUnhandle}
            onOptOut={onOptOut}
          />
        )}
      </div>
    </div>
  );
}

// ----------------------------- Filter bar ------------------------------------

function FilterBar({ theme, mode, setMode, status, setStatus, search, setSearch }) {
  return (
    <div style={{
      display: "flex", gap: 12, marginBottom: 12, alignItems: "center", flexWrap: "wrap",
    }}>
      <PillGroup theme={theme} value={mode} setValue={setMode} options={MODE_OPTIONS} />
      <PillGroup theme={theme} value={status} setValue={setStatus} options={STATUS_OPTIONS} />
      <div style={{ flex: 1, minWidth: 200 }}>
        <Input
          placeholder="Search email, name, or subject…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
    </div>
  );
}

function PillGroup({ theme, value, setValue, options }) {
  return (
    <div style={{
      display: "inline-flex", gap: 2, padding: 2, borderRadius: 8,
      background: theme.surfaceAlt, border: `1px solid ${theme.border}`,
    }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => setValue(o.value)}
            style={{
              padding: "6px 12px", border: "none", borderRadius: 6,
              background: active ? theme.bg : "transparent",
              color: active ? theme.text : theme.textMuted,
              fontSize: 12, fontWeight: active ? 600 : 500,
              cursor: "pointer", fontFamily: "inherit",
              boxShadow: active ? `0 0 0 1px ${theme.border}` : "none",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ----------------------------- List ------------------------------------------

function InboxList({ theme, rows, loading, selectedId, onSelect, status }) {
  if (loading) {
    return (
      <Card style={{ padding: 0 }}>
        <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          {Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} />)}
        </div>
      </Card>
    );
  }
  if (rows.length === 0) {
    return (
      <Card>
        <div style={{ color: theme.textMuted, fontSize: 13, padding: 12 }}>
          {status === "unhandled"
            ? "No replies need attention. ✨"
            : status === "handled"
              ? "No handled replies yet."
              : "No replies in this view."
          }
        </div>
      </Card>
    );
  }
  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ maxHeight: 700, overflowY: "auto" }}>
        {rows.map((r) => (
          <InboxRow
            key={r.id}
            theme={theme}
            row={r}
            selected={r.id === selectedId}
            onClick={() => onSelect(r)}
          />
        ))}
      </div>
    </Card>
  );
}

function InboxRow({ theme, row, selected, onClick }) {
  const modeColor = row.mode === "manual" ? "#F59E0B" : "#3B82F6";
  return (
    <div
      onClick={onClick}
      style={{
        padding: "12px 14px", cursor: "pointer", borderBottom: `1px solid ${theme.border}`,
        background: selected ? theme.surfaceAlt : "transparent",
        display: "flex", flexDirection: "column", gap: 4,
        borderLeft: `3px solid ${selected ? modeColor : "transparent"}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
          {row.unhandled && (
            <span style={{
              width: 8, height: 8, borderRadius: "50%",
              background: modeColor, flexShrink: 0,
            }} />
          )}
          <span style={{
            fontSize: 9, fontWeight: 700, textTransform: "uppercase",
            letterSpacing: 0.4, padding: "1px 5px", borderRadius: 3,
            background: `${modeColor}22`, color: modeColor, flexShrink: 0,
          }}>
            {row.mode}
          </span>
          <span style={{
            color: theme.text, fontSize: 13, fontWeight: 500,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0,
          }}>
            {row.to_name || row.to_email}
          </span>
        </div>
        <span style={{ fontSize: 11, color: theme.textMuted, flexShrink: 0 }}>
          {friendlyDate(row.last_activity_at)}
        </span>
      </div>
      <div style={{
        fontSize: 12, color: theme.textMid,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {row.subject || "(no subject)"}
      </div>
      <div style={{
        fontSize: 11, color: theme.textMuted, display: "flex", gap: 8,
      }}>
        <span>{row.campaign_name || "(no campaign)"}</span>
        {row.audience_type && <span>· {row.audience_type}</span>}
        {row.mode === "ai" && row.ai_status && <span>· {row.ai_status}</span>}
        {row.mode === "manual" && row.handled_at && (
          <span>· handled {friendlyDate(row.handled_at)}</span>
        )}
      </div>
    </div>
  );
}

// ----------------------------- Detail pane ----------------------------------

function DetailPane({ theme, selected, detail, loading, busyAction, onClose, onMarkHandled, onUnhandle, onOptOut }) {
  if (loading || !detail) {
    return (
      <Card>
        <div style={{ color: theme.textMuted, fontSize: 13 }}>Loading…</div>
      </Card>
    );
  }
  if (selected.mode === "manual") {
    return (
      <ManualReplyDetail
        theme={theme}
        detail={detail}
        busyAction={busyAction}
        onClose={onClose}
        onMarkHandled={onMarkHandled}
        onUnhandle={onUnhandle}
        onOptOut={onOptOut}
      />
    );
  }
  return <AiThreadDetail theme={theme} thread={detail} onClose={onClose} />;
}

function ManualReplyDetail({ theme, detail, busyAction, onClose, onMarkHandled, onUnhandle, onOptOut }) {
  const { send, reply, suppression } = detail;
  const isHandled = !!send.handled_at;
  const isSuppressed = !!suppression;

  return (
    <Card style={{ padding: 0 }}>
      <div style={{
        padding: "12px 16px", borderBottom: `1px solid ${theme.border}`,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, color: theme.text, fontSize: 14 }}>
            {send.to_name || send.to_email}
          </div>
          <div style={{ fontSize: 12, color: theme.textMuted }}>
            {send.to_email} · {send.campaign_name || "(no campaign)"} · touch {send.touch_number || "?"}
          </div>
        </div>
        <button onClick={onClose} style={{
          background: "transparent", border: "none", color: theme.textMuted,
          fontSize: 18, cursor: "pointer",
        }}>×</button>
      </div>

      {/* Suppression banner */}
      {isSuppressed && (
        <div style={{
          padding: "8px 16px", fontSize: 12,
          background: "#FEF3C7", color: "#92400E",
          borderBottom: `1px solid ${theme.border}`,
        }}>
          <b>Already suppressed</b> — reason: {suppression.reason}
          {suppression.detail ? ` (${suppression.detail})` : ""}
        </div>
      )}

      {/* Handled banner */}
      {isHandled && (
        <div style={{
          padding: "8px 16px", fontSize: 12,
          background: theme.surfaceAlt, color: theme.textMid,
          borderBottom: `1px solid ${theme.border}`,
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <span>
            Handled by <b>{send.handled_by_email || "?"}</b> on {friendlyDate(send.handled_at)}
          </span>
          <Btn size="sm" variant="outline" loading={busyAction === "unhandle"} onClick={onUnhandle}>
            Undo
          </Btn>
        </div>
      )}

      <div style={{ padding: 16, maxHeight: 540, overflowY: "auto", background: theme.bg }}>
        {/* Reply */}
        {reply ? (
          <div style={{ marginBottom: 16 }}>
            <div style={{
              fontSize: 11, fontWeight: 600, textTransform: "uppercase",
              letterSpacing: 0.4, color: theme.textMid, marginBottom: 6,
            }}>
              Reply · {friendlyDate(reply.received_at)}
            </div>
            <div style={{
              background: theme.surface, border: `1px solid ${theme.border}`,
              borderRadius: 10, padding: "12px 14px",
              whiteSpace: "pre-wrap", fontSize: 13, color: theme.text, lineHeight: 1.55,
            }}>
              {reply.body}
            </div>
            <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 4 }}>
              From {reply.from_name ? `${reply.from_name} <${reply.from_email}>` : reply.from_email}
            </div>
          </div>
        ) : (
          <div style={{
            padding: 12, marginBottom: 16,
            background: theme.surfaceAlt, border: `1px dashed ${theme.border}`,
            borderRadius: 8, fontSize: 12, color: theme.textMuted,
          }}>
            Reply text couldn't be recovered from raw events. The send was stamped
            replied_at at {friendlyDate(send.replied_at)} but no matching webhook
            payload landed within the ±10-minute window.
          </div>
        )}

        {/* Original send (collapsed by default in spirit — shown muted) */}
        <details style={{ marginTop: 16 }}>
          <summary style={{
            cursor: "pointer", fontSize: 11, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: 0.4, color: theme.textMid,
          }}>
            Original send · {friendlyDate(send.sent_at)} · {send.sender_domain || "—"}
          </summary>
          <div style={{
            marginTop: 8, background: theme.surfaceAlt, border: `1px solid ${theme.border}`,
            borderRadius: 8, padding: "10px 12px",
          }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: theme.text, marginBottom: 6 }}>
              {send.subject}
            </div>
            <div style={{
              fontSize: 12, color: theme.textMid, whiteSpace: "pre-wrap", lineHeight: 1.55,
            }}>
              {send.body}
            </div>
          </div>
        </details>
      </div>

      {/* Actions footer */}
      {!isHandled && (
        <div style={{
          padding: "10px 16px", borderTop: `1px solid ${theme.border}`,
          background: theme.surfaceAlt, display: "flex", gap: 8, justifyContent: "flex-end",
        }}>
          {!isSuppressed && (
            <Btn size="sm" variant="outline" loading={busyAction === "opt-out"} onClick={onOptOut}>
              Opt out
            </Btn>
          )}
          <Btn size="sm" loading={busyAction === "handle"} onClick={onMarkHandled}>
            Mark handled
          </Btn>
        </div>
      )}
    </Card>
  );
}

// ----------------------------- AI thread (carried over) ----------------------

function AiThreadDetail({ theme, thread, onClose }) {
  if (!thread) {
    return <Card><div style={{ color: theme.textMuted }}>Loading thread…</div></Card>;
  }
  const messages = thread.messages || [];
  return (
    <Card style={{ padding: 0 }}>
      <div style={{
        padding: "12px 16px", borderBottom: `1px solid ${theme.border}`,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <div>
          <div style={{ fontWeight: 600, color: theme.text, fontSize: 14 }}>
            {thread.prospect_name || thread.prospect_email}
          </div>
          <div style={{ fontSize: 12, color: theme.textMuted }}>
            {thread.prospect_email} · {thread.prospect_company || "—"} · {thread.status}
          </div>
        </div>
        <button onClick={onClose} style={{
          background: "transparent", border: "none", color: theme.textMuted,
          fontSize: 18, cursor: "pointer",
        }}>×</button>
      </div>
      <div style={{ padding: 16, maxHeight: 540, overflowY: "auto", background: theme.bg }}>
        {messages.length === 0 ? (
          <div style={{ color: theme.textMuted, fontSize: 13 }}>No messages yet.</div>
        ) : messages.map((m) => (
          <MessageBubble key={m.id} m={m} theme={theme} />
        ))}
      </div>
      {thread.ai_notes && (
        <div style={{
          borderTop: `1px solid ${theme.border}`, padding: 12, background: theme.surfaceAlt,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: theme.textMid,
            textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 4,
          }}>
            AI notes
          </div>
          <pre style={{ margin: 0, fontSize: 11, color: theme.textMid, whiteSpace: "pre-wrap" }}>
            {thread.ai_notes}
          </pre>
        </div>
      )}
    </Card>
  );
}

function MessageBubble({ m, theme }) {
  const isOut = m.direction === "out";
  const bg = isOut ? theme.accent : theme.surface;
  const fg = isOut ? (theme.mode === "dark" ? "#0A0A0A" : "#fff") : theme.text;
  const sentLabel = m.sent_at
    ? `sent ${friendlyDate(m.sent_at)}`
    : m.scheduled_for
      ? `scheduled ${friendlyDate(m.scheduled_for)}`
      : m.error ? `error: ${m.error}` : "draft";
  return (
    <div style={{ display: "flex", justifyContent: isOut ? "flex-end" : "flex-start", marginBottom: 12 }}>
      <div style={{ maxWidth: "78%" }}>
        {m.subject && (
          <div style={{ fontSize: 10, color: theme.textMuted, marginBottom: 3, fontWeight: 600 }}>
            {m.subject}
          </div>
        )}
        <div style={{
          background: bg, color: fg, padding: "10px 14px", borderRadius: 12,
          fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap",
          border: isOut ? "none" : `1px solid ${theme.border}`,
        }}>
          {m.body}
        </div>
        <div style={{ fontSize: 10, color: theme.textMuted, marginTop: 4, textAlign: isOut ? "right" : "left" }}>
          {sentLabel}
        </div>
      </div>
    </div>
  );
}
