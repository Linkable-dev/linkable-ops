// AI Outbound — live dashboard for the daily-200 sequencer.
// Shows today's email_sends rows, lets you filter by group/touch/status,
// and stop pending touches for any address (paste list or per-row button).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api, friendlyDate } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";

const STATUS_TINTS = {
  pending:   { bg: "#FEF3C7", fg: "#92400E" },
  scheduled: { bg: "#DBEAFE", fg: "#1E40AF" },
  sent:      { bg: "#D1FAE5", fg: "#065F46" },
  failed:    { bg: "#FEE2E2", fg: "#991B1B" },
  cancelled: { bg: "#F3F4F6", fg: "#374151" },
  bounced:   { bg: "#FED7AA", fg: "#9A3412" },
};

const GROUP_TINTS = {
  G1: { bg: "#E0E7FF", fg: "#3730A3" },   // creator-active
  G2: { bg: "#FCE7F3", fg: "#9D174D" },   // summer
  G3: { bg: "#F3F4F6", fg: "#374151" },   // cold
};

const STATUS_FILTERS = ["all", "pending", "scheduled", "sent", "failed", "cancelled", "bounced"];
const GROUP_FILTERS = ["all", "G1", "G2", "G3"];
const TOUCH_FILTERS = ["all", "1", "2", "3"];
const SCOPE_FILTERS = ["today", "all"];

export default function AiOutboundPage() {
  const { theme } = useTheme();

  const [stats, setStats] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [group, setGroup] = useState("all");
  const [touch, setTouch] = useState("all");
  const [status, setStatus] = useState("all");
  const [scope, setScope] = useState("today");

  const [stopText, setStopText] = useState("");
  const [stopReason, setStopReason] = useState("replied");
  const [stopBusy, setStopBusy] = useState(false);
  const [stopResult, setStopResult] = useState(null);

  const reload = useCallback(() => {
    setLoading(true); setError(null);
    Promise.all([
      api.getOutboundStats(),
      api.listOutboundSends({
        group: group === "all" ? undefined : group,
        touch: touch === "all" ? undefined : touch,
        status: status === "all" ? undefined : status,
        scope,
        limit: 500,
      }),
    ])
      .then(([s, r]) => { setStats(s); setRows(r.rows || []); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [group, touch, status, scope]);

  useEffect(() => { reload(); }, [reload]);

  async function runStop(emails, reason) {
    if (emails.length === 0) return;
    setStopBusy(true); setStopResult(null);
    try {
      const out = await api.stopOutbound({ emails, reason });
      const cancelled = (out.results || []).reduce((sum, r) => sum + (r.cancelled || 0), 0);
      setStopResult({ ok: true, addresses: emails.length, cancelled });
      setStopText("");
      reload();
    } catch (e) {
      setStopResult({ ok: false, error: e.message });
    } finally {
      setStopBusy(false);
    }
  }

  const stopEmails = useMemo(() => {
    return stopText.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.includes("@"));
  }, [stopText]);

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: theme.text, margin: 0 }}>AI Outbound</h1>
        <p style={{ fontSize: 13, color: theme.textMuted, margin: "4px 0 0" }}>
          Daily-200 sequencer: 3-touch sequences (T+0 / T+3 / T+7) across G1 creator-active, G2 summer-seasonal, G3 cold catch-all. Reply / opt-out cancellations land here.
        </p>
      </div>

      {error && (
        <Card style={{ borderColor: "#DC2626", marginBottom: 12 }}>
          <div style={{ color: "#DC2626", fontSize: 13 }}>{error}</div>
        </Card>
      )}

      {/* Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 16 }}>
        <StatCard label="Today total" value={stats?.total ?? "—"} theme={theme} />
        <StatCard label="Sent" value={stats?.byStatus?.sent ?? 0} theme={theme} tint={STATUS_TINTS.sent} />
        <StatCard label="Scheduled" value={stats?.byStatus?.scheduled ?? 0} theme={theme} tint={STATUS_TINTS.scheduled} />
        <StatCard label="Cancelled" value={stats?.byStatus?.cancelled ?? 0} theme={theme} tint={STATUS_TINTS.cancelled} />
        <StatCard label="Failed" value={stats?.byStatus?.failed ?? 0} theme={theme} tint={STATUS_TINTS.failed} />
        <StatCard label="G2 (summer)" value={stats?.byGroup?.G2 ?? 0} theme={theme} tint={GROUP_TINTS.G2} />
        <StatCard label="G1 (creator)" value={stats?.byGroup?.G1 ?? 0} theme={theme} tint={GROUP_TINTS.G1} />
        <StatCard label="G3 (cold)" value={stats?.byGroup?.G3 ?? 0} theme={theme} tint={GROUP_TINTS.G3} />
      </div>

      {/* Stop list */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: theme.text }}>Stop list</div>
        <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 8 }}>
          Paste replied / opt-out addresses (any separators). Suppresses globally + cancels every pending touch.
        </div>
        <textarea
          value={stopText}
          onChange={(e) => setStopText(e.target.value)}
          placeholder="sarah@glowserum.com&#10;mike@kombuchaco.com"
          rows={3}
          style={{
            width: "100%", padding: "8px 12px", borderRadius: 8, fontFamily: "inherit", fontSize: 13,
            border: `1.5px solid ${theme.border}`, background: theme.bg, color: theme.text,
            resize: "vertical",
          }}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
          <select value={stopReason} onChange={(e) => setStopReason(e.target.value)} style={selectStyle(theme)}>
            <option value="replied">replied</option>
            <option value="opted_out">opted_out</option>
            <option value="bounced">bounced</option>
            <option value="manual">manual</option>
          </select>
          <Btn onClick={() => runStop(stopEmails, stopReason)} disabled={stopBusy || stopEmails.length === 0}>
            {stopBusy ? "Stopping…" : `Stop ${stopEmails.length} address${stopEmails.length === 1 ? "" : "es"}`}
          </Btn>
          {stopResult?.ok && (
            <span style={{ fontSize: 12, color: "#065F46" }}>
              ✓ {stopResult.addresses} suppressed · {stopResult.cancelled} touches cancelled
            </span>
          )}
          {stopResult && !stopResult.ok && (
            <span style={{ fontSize: 12, color: "#DC2626" }}>{stopResult.error}</span>
          )}
        </div>
      </Card>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <select value={scope} onChange={(e) => setScope(e.target.value)} style={selectStyle(theme)}>
          {SCOPE_FILTERS.map((s) => <option key={s} value={s}>{s === "today" ? "Today" : "All time"}</option>)}
        </select>
        <select value={group} onChange={(e) => setGroup(e.target.value)} style={selectStyle(theme)}>
          {GROUP_FILTERS.map((g) => <option key={g} value={g}>{g === "all" ? "Any group" : g}</option>)}
        </select>
        <select value={touch} onChange={(e) => setTouch(e.target.value)} style={selectStyle(theme)}>
          {TOUCH_FILTERS.map((t) => <option key={t} value={t}>{t === "all" ? "Any touch" : `T+${t === "1" ? "0" : t === "2" ? "3" : "7"}`}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={selectStyle(theme)}>
          {STATUS_FILTERS.map((s) => <option key={s} value={s}>{s === "all" ? "Any status" : s}</option>)}
        </select>
        <Btn onClick={reload} variant="secondary">Reload</Btn>
      </div>

      {/* Sends table */}
      {loading && rows.length === 0 ? (
        <Card><div style={{ color: theme.textMuted }}>Loading…</div></Card>
      ) : rows.length === 0 ? (
        <Card><div style={{ color: theme.textMuted, fontSize: 13 }}>No sends match these filters.</div></Card>
      ) : (
        <Card style={{ padding: 0, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${theme.border}`, color: theme.textMuted }}>
                <Th>When</Th>
                <Th>Group</Th>
                <Th>Touch</Th>
                <Th>To</Th>
                <Th>Subject</Th>
                <Th>Status</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderBottom: `1px solid ${theme.border}` }}>
                  <Td style={{ color: theme.textMuted, whiteSpace: "nowrap" }}>
                    {friendlyDate(r.sent_at || r.scheduled_at)}
                  </Td>
                  <Td><Pill tint={GROUP_TINTS[r.brand_group] || {}}>{r.brand_group || "—"}</Pill></Td>
                  <Td>T+{r.touch_number === 1 ? "0" : r.touch_number === 2 ? "3" : r.touch_number === 3 ? "7" : "?"}</Td>
                  <Td>
                    <div style={{ color: theme.text }}>{r.to_name || "—"}</div>
                    <div style={{ color: theme.textMuted, fontSize: 11 }}>{r.to_email}</div>
                  </Td>
                  <Td style={{ color: theme.text, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.subject}
                  </Td>
                  <Td>
                    <Pill tint={STATUS_TINTS[r.status] || {}}>{r.status}</Pill>
                    {r.cancel_reason && (
                      <div style={{ fontSize: 10, color: theme.textMuted, marginTop: 2 }}>{r.cancel_reason}</div>
                    )}
                  </Td>
                  <Td>
                    {(r.status === "pending" || r.status === "scheduled") ? (
                      <button
                        onClick={() => runStop([r.to_email], "replied")}
                        disabled={stopBusy}
                        style={miniBtn(theme)}
                        title="Cancel this row + all other pending touches for this address"
                      >
                        Stop
                      </button>
                    ) : (
                      <span style={{ color: theme.textMuted, fontSize: 11 }}>—</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function StatCard({ label, value, theme, tint = {} }) {
  return (
    <Card style={{ padding: "12px 14px" }}>
      <div style={{ fontSize: 11, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: tint.fg || theme.text, marginTop: 2 }}>{value}</div>
    </Card>
  );
}

function Pill({ tint = {}, children }) {
  return (
    <span style={{
      display: "inline-block",
      background: tint.bg || "#F3F4F6", color: tint.fg || "#374151",
      fontSize: 10, fontWeight: 700, padding: "2px 6px",
      borderRadius: 4, textTransform: "uppercase", letterSpacing: 0.4,
    }}>{children}</span>
  );
}

function Th({ children }) {
  return <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>{children}</th>;
}
function Td({ children, style = {} }) {
  return <td style={{ padding: "8px 12px", verticalAlign: "top", ...style }}>{children}</td>;
}
function selectStyle(theme) {
  return {
    padding: "8px 12px", borderRadius: 8, fontSize: 13, fontFamily: "inherit",
    border: `1.5px solid ${theme.border}`, background: theme.bg, color: theme.text,
    minWidth: 140,
  };
}
function miniBtn(theme) {
  return {
    padding: "4px 10px", fontSize: 11, fontFamily: "inherit", fontWeight: 600,
    border: `1px solid ${theme.border}`, borderRadius: 4, background: theme.bg,
    color: theme.text, cursor: "pointer",
  };
}
