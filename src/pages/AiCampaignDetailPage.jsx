// AI Campaign detail — settings, templates (incl. A/B + AI drafts), metrics,
// lead-discovery trigger, pause/resume. Routes: /ai/campaigns/:id

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTheme } from "../contexts/ThemeContext";
import { api, friendlyDate } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Skeleton, SkeletonRow, SkeletonCard, SkeletonTableRows } from "../components/ui/Skeleton";
import { TabBar } from "../components/ui/TabBar";
import { Pagination } from "../components/ui/Pagination";
import { suggestCampaignName } from "../lib/campaign-name";

const GROUP_TINTS = {
  G1: { bg: "#E0E7FF", fg: "#3730A3" },
  G2: { bg: "#FCE7F3", fg: "#9D174D" },
  G3: { bg: "#F3F4F6", fg: "#374151" },
};
const STATUS_TINTS = {
  active:   { bg: "#D1FAE5", fg: "#065F46" },
  paused:   { bg: "#FEF3C7", fg: "#92400E" },
  archived: { bg: "#F3F4F6", fg: "#374151" },
};

// Per-row send status tints — distinct from the campaign-lifecycle STATUS_TINTS
// above. Engagement (replied > clicked > opened) overrides the raw "sent"
// status so the table reflects post-delivery state.
const SEND_STATUS_TINTS = {
  pending:   { bg: "#FEF3C7", fg: "#92400E" },
  scheduled: { bg: "#DBEAFE", fg: "#1E40AF" },
  sent:      { bg: "#D1FAE5", fg: "#065F46" },
  opened:    { bg: "#DBEAFE", fg: "#1E3A8A" },
  clicked:   { bg: "#EDE9FE", fg: "#5B21B6" },
  replied:   { bg: "#C7D2FE", fg: "#3730A3" },
  failed:    { bg: "#FEE2E2", fg: "#991B1B" },
  cancelled: { bg: "#F3F4F6", fg: "#374151" },
  bounced:   { bg: "#FED7AA", fg: "#9A3412" },
};
const SEND_STATUS_FILTERS = ["all", "pending", "scheduled", "sent", "failed", "cancelled", "bounced"];
const SEND_GROUP_FILTERS = ["all", "G1", "G2", "G3"];
const SEND_TOUCH_FILTERS = ["all", "1", "2", "3"];

function sendDisplayStatus(r) {
  if (r.replied_at) return "replied";
  if (r.clicked_at) return "clicked";
  if (r.opened_at) return "opened";
  return r.status;
}
function sendRunLabel(runSel) {
  if (runSel === "today") return "today";
  if (runSel === "all") return "all runs";
  return `run ${runSel}`;
}
function sendRatePct(rate) {
  if (rate == null || !isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

export default function AiCampaignDetailPage() {
  const { theme } = useTheme();
  const { id } = useParams();
  const navigate = useNavigate();

  const [data, setData] = useState(null);          // { campaign, templates, metrics }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const reload = useCallback(() => {
    setLoading(true); setError(null);
    api.getOutboundCampaign(id)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { reload(); }, [reload]);

  if (loading && !data) {
    return (
      <div>
        <div style={{ marginBottom: 16 }}>
          <Skeleton width={260} height={22} />
          <div style={{ height: 6 }} />
          <Skeleton width={420} height={13} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 16 }}>
          {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} height={70} />)}
        </div>
        <Card><SkeletonRow widths={["30%", "70%", "55%", "65%", "40%"]} /></Card>
      </div>
    );
  }
  if (error) {
    return <Card style={{ borderColor: "#DC2626" }}><div style={{ color: "#DC2626", fontSize: 13 }}>{error}</div></Card>;
  }
  if (!data) return null;

  const { campaign, templates, metrics } = data;

  return (
    <div>
      <div style={{ marginBottom: 16, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <Link to="/ai/campaigns" style={{ color: theme.textMuted, fontSize: 12, textDecoration: "none" }}>← All campaigns</Link>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: theme.text, margin: "4px 0 4px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {campaign.name}
            <Pill tint={STATUS_TINTS[campaign.status] || {}}>{campaign.status}</Pill>
            {campaign.auto_reply && <Pill tint={{ bg: "#E0E7FF", fg: "#3730A3" }}>auto-reply</Pill>}
            <ScheduleBadge schedule={campaign.config?.schedule} theme={theme} />
          </h1>
          <div style={{ fontSize: 12, color: theme.textMuted }}>
            Daily cap {campaign.daily_cap || 200} · Sender {campaign.sender_from} · Reply-to {campaign.reply_to}
          </div>
        </div>
        <CampaignActions campaign={campaign} onChange={reload} navigate={navigate} />
      </div>

      <CampaignTabs
        campaign={campaign}
        templates={templates}
        metrics={metrics}
        theme={theme}
        reload={reload}
      />
    </div>
  );
}

// ---------- TABS ----------

const TABS = [
  ["overview",  "Overview"],
  ["sends",     "Sends"],
  ["leads",     "Leads"],
  ["templates", "Templates"],
  ["settings",  "Settings"],
];

function CampaignTabs({ campaign, templates, metrics, theme, reload }) {
  // URL hash drives the active tab so refreshes / shared links land correctly.
  const initial = (typeof window !== "undefined" ? window.location.hash.replace(/^#/, "") : "") || "overview";
  const [tab, setTab] = useState(TABS.some(([k]) => k === initial) ? initial : "overview");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const target = `#${tab}`;
    if (window.location.hash !== target) window.history.replaceState(null, "", target);
  }, [tab]);

  return (
    <div>
      <TabBar tabs={TABS} active={tab} onSelect={setTab} />
      {tab === "overview" && (
        <OverviewTab campaign={campaign} metrics={metrics} templates={templates} theme={theme} onJump={setTab} />
      )}
      {tab === "sends" && (
        <SendsTab campaign={campaign} theme={theme} />
      )}
      {tab === "leads" && (
        <>
          <DiscoverCard campaign={campaign} theme={theme} onStarted={reload} />
          <DiscoveryRunsPanel campaign={campaign} theme={theme} />
          <LeadPoolPanel theme={theme} campaign={campaign} />
        </>
      )}
      {tab === "templates" && (
        <TemplatesCard
          campaign={campaign}
          templates={templates}
          theme={theme}
          onChange={reload}
        />
      )}
      {tab === "settings" && (
        <SettingsCard campaign={campaign} theme={theme} onSaved={reload} />
      )}
    </div>
  );
}

// Compact, click-to-jump status row above the metrics card.
function OverviewTab({ campaign, metrics, templates, theme, onJump }) {
  const [poolCounts, setPoolCounts] = useState(null);
  const [recentRun, setRecentRun] = useState(null);

  useEffect(() => {
    const tf = campaign.target_filters || {};
    const filterArgs = {
      country: (tf.countries || []).join(","),
      minRevenue: tf.min_revenue,
      maxRevenue: tf.max_revenue,
    };
    api.getOutboundLeadCounts(filterArgs).then(setPoolCounts).catch(() => {});
    api.listOutboundDiscoveryRuns(campaign.id, { limit: 1 })
      .then((r) => setRecentRun(r.rows?.[0] || null))
      .catch(() => {});
  }, [campaign.id, campaign.target_filters]);

  const sched = campaign.config?.schedule;
  const scheduleSummary = !sched || sched.cadence === "off"
    ? "Auto-send is off — campaign won't run automatically"
    : sched.cadence === "daily"
      ? `Sends once a day at ${String(sched.start_hour ?? 9).padStart(2, "0")}:00 ${sched.timezone || "UTC"}${sched.weekdays_only !== false ? " (Mon–Fri)" : ""}`
      : `Sends hourly ${String(sched.start_hour ?? 9).padStart(2, "0")}:00–${String(sched.end_hour ?? 17).padStart(2, "0")}:00 ${sched.timezone || "UTC"}${sched.weekdays_only !== false ? " (Mon–Fri)" : ""}`;

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 16 }}>
        <ClickStat label="Lead pool" value={poolCounts?.qualified ?? "—"}
          sub={poolCounts ? `${poolCounts.emailed} contacted · ${poolCounts.total - poolCounts.qualified} skipped` : "loading"}
          onClick={() => onJump("leads")} theme={theme} />
        <ClickStat label="Templates" value={templates?.length || 0}
          sub={templates?.length === 9 ? "all 9 slots filled" : `${9 - (templates?.length || 0)} slots empty`}
          onClick={() => onJump("templates")} theme={theme} />
        <ClickStat label="Auto-reply" value={campaign.auto_reply ? "On" : "Off"}
          sub={campaign.auto_reply ? "AI persona linked" : "Manual triage in AI Inbox"}
          onClick={() => onJump("settings")} theme={theme} />
        <ClickStat label="Last discovery" value={recentRun ? recentRun.status : "—"}
          sub={recentRun ? `${recentRun.sent} qualified · ${recentRun.processed} inspected` : "no runs yet"}
          onClick={() => onJump("leads")} theme={theme} />
      </div>

      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 }}>Schedule</div>
        <div style={{ fontSize: 14, color: theme.text, marginBottom: 4 }}>{scheduleSummary}</div>
        <button onClick={() => onJump("settings")} style={{ background: "transparent", border: "none", color: theme.accent, fontFamily: "inherit", fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0 }}>
          Edit schedule →
        </button>
      </Card>

      <MetricsCard metrics={metrics} theme={theme} />
    </>
  );
}

function ClickStat({ label, value, sub, onClick, theme }) {
  return (
    <button onClick={onClick} style={{
      textAlign: "left", padding: "14px 16px", borderRadius: 10,
      background: theme.surface, border: `1px solid ${theme.border}`,
      cursor: "pointer", fontFamily: "inherit",
      transition: "border-color 0.15s, transform 0.05s",
    }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = theme.accent; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = theme.border; }}>
      <div style={{ fontSize: 11, color: theme.textMuted, textTransform: "uppercase", fontWeight: 600, letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: theme.text, marginTop: 4 }}>{value}</div>
      <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 2 }}>{sub}</div>
    </button>
  );
}

function ScheduleBadge({ schedule, theme }) {
  if (!schedule || schedule.cadence === "off") {
    return <Pill tint={{ bg: "#FEE2E2", fg: "#991B1B" }} title="Auto-send is off — set a schedule in Settings">manual</Pill>;
  }
  const label = schedule.cadence === "daily" ? "daily" : "hourly";
  return <Pill tint={{ bg: "#DCFCE7", fg: "#166534" }} title={`${schedule.cadence} · ${schedule.timezone}`}>{label}</Pill>;
}

// ---------- METRICS ----------

function MetricsCard({ metrics, theme }) {
  if (!metrics) return null;
  const cells = [
    { label: "Total", value: metrics.total },
    { label: "Sent", value: metrics.sent || 0 },
    { label: "Delivered", value: `${metrics.delivered || 0} (${pct(metrics.rates?.delivered)})` },
    { label: "Opened", value: `${metrics.opened || 0} (${pct(metrics.rates?.opened)})` },
    { label: "Clicked", value: `${metrics.clicked || 0} (${pct(metrics.rates?.clicked)})` },
    { label: "Replied", value: `${metrics.replied || 0} (${pct(metrics.rates?.replied)})` },
    { label: "Bounced", value: `${metrics.bounced || 0} (${pct(metrics.rates?.bounced)})`, warn: (metrics.rates?.bounced || 0) > 0.05 },
    { label: "Complained", value: `${metrics.complained || 0} (${pct(metrics.rates?.complained)})`, warn: (metrics.rates?.complained || 0) > 0.001 },
    { label: "Cancelled", value: metrics.cancelled || 0 },
    { label: "Scheduled", value: metrics.scheduled || 0 },
  ];
  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 }}>Deliverability</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
        {cells.map((c, i) => (
          <div key={i}>
            <div style={{ fontSize: 11, color: theme.textMuted }}>{c.label}</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: c.warn ? "#DC2626" : theme.text }}>{c.value}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}
function pct(x) { return x ? `${(x * 100).toFixed(1)}%` : "0%"; }

// ---------- SENDS ----------
//
// Live view of email_sends rows for this campaign. Picks a daily run (today /
// all / specific date), filters by group + touch + status, surfaces the stop
// list, and lets the user cancel pending touches per row.

function SendsTab({ campaign, theme }) {
  const [stats, setStats] = useState(null);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [group, setGroup] = useState("all");
  const [touch, setTouch] = useState("all");
  const [status, setStatus] = useState("all");
  const [runSel, setRunSel] = useState("today");
  const [runs, setRuns] = useState([]);

  // Search input is debounced into `q` so the user can type freely without a
  // request per keystroke; the actual API call uses `q`.
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const [stopText, setStopText] = useState("");
  const [stopReason, setStopReason] = useState("replied");
  const [stopBusy, setStopBusy] = useState(false);
  const [stopResult, setStopResult] = useState(null);

  const [previewId, setPreviewId] = useState(null);

  const runParams = useMemo(() => {
    if (runSel === "all") return { scope: "all" };
    if (runSel === "today") return { scope: "today" };
    return { runDate: runSel };
  }, [runSel]);

  // Snap back to page 1 whenever any filter narrows or widens the result set —
  // staying on page 7 of an empty list would be confusing.
  useEffect(() => { setPage(1); }, [group, touch, status, runSel, q, pageSize, campaign.id]);

  // Debounce the search box → `q` so we don't spam the API.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const reload = useCallback(() => {
    setLoading(true); setError(null);
    Promise.all([
      api.getOutboundStats({ ...runParams, campaignId: campaign.id }),
      api.listOutboundSends({
        group: group === "all" ? undefined : group,
        touch: touch === "all" ? undefined : touch,
        status: status === "all" ? undefined : status,
        q: q || undefined,
        ...runParams,
        campaignId: campaign.id,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
    ])
      .then(([s, r]) => {
        setStats(s);
        setRows(r.rows || []);
        setTotal(r.total ?? r.count ?? (r.rows || []).length);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [group, touch, status, q, runParams, campaign.id, page, pageSize]);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    api.listOutboundRuns({ campaignId: campaign.id })
      .then((res) => setRuns(res.runs || []))
      .catch(() => setRuns([]));
  }, [campaign.id]);

  const stopEmails = useMemo(() => {
    return stopText.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.includes("@"));
  }, [stopText]);

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

  return (
    <>
      {error && (
        <Card style={{ borderColor: "#DC2626", marginBottom: 12 }}>
          <div style={{ color: "#DC2626", fontSize: 13 }}>{error}</div>
        </Card>
      )}

      {/* Stats — scoped to this campaign and the selected run. */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>
            Metrics · {sendRunLabel(runSel)}
          </div>
          <select
            value={runSel}
            onChange={(e) => setRunSel(e.target.value)}
            style={sendSelectStyle(theme)}
            title="Filter by daily run"
          >
            <option value="today">Today</option>
            <option value="all">All runs (aggregated)</option>
            {runs.length > 0 && <option disabled>──────────</option>}
            {runs.map((r) => (
              <option key={r.date} value={r.date}>{r.date} · {r.count} enrolled</option>
            ))}
          </select>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
          {!stats ? (
            Array.from({ length: 6 }).map((_, i) => <SendStatCardSkeleton key={i} />)
          ) : (
            <>
              <SendStatCard label="Sent" value={stats.sent ?? 0} sub={`${stats.total ?? 0} queued`} theme={theme} tint={SEND_STATUS_TINTS.sent} />
              <SendStatCard label="Delivered" value={stats.delivered ?? 0} sub={sendRatePct(stats.rates?.delivered)} theme={theme} tint={SEND_STATUS_TINTS.sent} />
              <SendStatCard label="Opened" value={stats.opened ?? 0} sub={sendRatePct(stats.rates?.opened)} theme={theme} tint={SEND_STATUS_TINTS.opened} />
              <SendStatCard label="Clicked" value={stats.clicked ?? 0} sub={sendRatePct(stats.rates?.clicked)} theme={theme} tint={SEND_STATUS_TINTS.clicked} />
              <SendStatCard label="Replied" value={stats.replied ?? 0} sub={sendRatePct(stats.rates?.replied)} theme={theme} tint={SEND_STATUS_TINTS.replied} />
              <SendStatCard label="Bounced" value={stats.bounced ?? 0} sub={sendRatePct(stats.rates?.bounced)} theme={theme} tint={SEND_STATUS_TINTS.bounced} />
            </>
          )}
        </div>
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
        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select value={stopReason} onChange={(e) => setStopReason(e.target.value)} style={sendSelectStyle(theme)}>
            <option value="replied">replied</option>
            <option value="opted_out">opted_out</option>
            <option value="bounced">bounced</option>
            <option value="manual">manual</option>
          </select>
          <Btn onClick={() => runStop(stopEmails, stopReason)} loading={stopBusy} disabled={stopEmails.length === 0}>
            {`Stop ${stopEmails.length} address${stopEmails.length === 1 ? "" : "es"}`}
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
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <select value={group} onChange={(e) => setGroup(e.target.value)} style={sendSelectStyle(theme)}>
          {SEND_GROUP_FILTERS.map((g) => <option key={g} value={g}>{g === "all" ? "Any group" : g}</option>)}
        </select>
        <select value={touch} onChange={(e) => setTouch(e.target.value)} style={sendSelectStyle(theme)}>
          {SEND_TOUCH_FILTERS.map((t) => <option key={t} value={t}>{t === "all" ? "Any touch" : `T+${t === "1" ? "0" : t === "2" ? "3" : "7"}`}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={sendSelectStyle(theme)}>
          {SEND_STATUS_FILTERS.map((s) => <option key={s} value={s}>{s === "all" ? "Any status" : s}</option>)}
        </select>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search to-email, name, subject"
          style={{
            padding: "8px 12px", borderRadius: 8, fontSize: 13, fontFamily: "inherit",
            border: `1.5px solid ${theme.border}`, background: theme.bg, color: theme.text,
            minWidth: 240, flex: "1 1 240px", maxWidth: 360,
          }}
        />
        <Btn onClick={reload} variant="secondary">Reload</Btn>
      </div>

      {/* Sends table */}
      {loading && rows.length === 0 ? (
        <Card style={{ padding: 0, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${theme.border}`, color: theme.textMuted }}>
                <th style={sendTh}>When</th><th style={sendTh}>Group</th><th style={sendTh}>Touch</th>
                <th style={sendTh}>To</th><th style={sendTh}>Subject</th><th style={sendTh}>Status</th><th style={sendTh}>Actions</th>
              </tr>
            </thead>
            <tbody>
              <SkeletonTableRows rows={6} cols={7} theme={theme} />
            </tbody>
          </table>
        </Card>
      ) : rows.length === 0 ? (
        <Card><div style={{ color: theme.textMuted, fontSize: 13 }}>No sends match these filters.</div></Card>
      ) : (
        <Card style={{ padding: 0, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${theme.border}`, color: theme.textMuted }}>
                <th style={sendTh}>When</th>
                <th style={sendTh}>Group</th>
                <th style={sendTh}>Touch</th>
                <th style={sendTh}>To</th>
                <th style={sendTh}>Subject</th>
                <th style={sendTh}>Status</th>
                <th style={sendTh}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderBottom: `1px solid ${theme.border}` }}>
                  <td style={{ ...sendTd, color: theme.textMuted, whiteSpace: "nowrap" }}>
                    {friendlyDate(
                      r.status === "sent" ? r.sent_at
                        : r.status === "cancelled" ? (r.cancelled_at || r.scheduled_at)
                        : r.scheduled_at
                    )}
                  </td>
                  <td style={sendTd}><Pill tint={GROUP_TINTS[r.brand_group] || {}}>{r.brand_group || "—"}</Pill></td>
                  <td style={sendTd}>T+{r.touch_number === 1 ? "0" : r.touch_number === 2 ? "3" : r.touch_number === 3 ? "7" : "?"}</td>
                  <td style={sendTd}>
                    <div style={{ color: theme.text }}>{r.to_name || "—"}</div>
                    <div style={{ color: theme.textMuted, fontSize: 11 }}>{r.to_email}</div>
                  </td>
                  <td style={{ ...sendTd, color: theme.text, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.subject}
                  </td>
                  <td style={sendTd}>
                    {(() => {
                      const ds = sendDisplayStatus(r);
                      return <Pill tint={SEND_STATUS_TINTS[ds] || {}}>{ds}</Pill>;
                    })()}
                    {r.cancel_reason && (
                      <div style={{ fontSize: 10, color: theme.textMuted, marginTop: 2 }}>{r.cancel_reason}</div>
                    )}
                  </td>
                  <td style={sendTd}>
                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      <button
                        onClick={() => setPreviewId(r.id)}
                        style={iconBtn(theme)}
                        title="Preview email"
                        aria-label="Preview email"
                      >
                        <EyeIcon />
                      </button>
                      {(r.status === "pending" || r.status === "scheduled") && (
                        <button
                          onClick={() => runStop([r.to_email], "replied")}
                          disabled={stopBusy}
                          style={miniBtn(theme)}
                          title="Cancel this row + all other pending touches for this address"
                        >
                          Stop
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {total > 0 && (
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      )}

      {previewId && (
        <EmailPreviewModal
          sendId={previewId}
          campaign={campaign}
          theme={theme}
          onClose={() => setPreviewId(null)}
        />
      )}
    </>
  );
}

// Lazy-loads the full email body via /outbound/sends/:id and shows headers,
// rendered subject + body, status pill, and the engagement timeline.
function EmailPreviewModal({ sendId, campaign, theme, onClose }) {
  const [send, setSend] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setSend(null); setError(null);
    api.getOutboundSend(sendId)
      .then((d) => { if (!cancelled) setSend(d); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [sendId]);

  // Esc closes. Click outside the panel closes too.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const events = send ? buildSendTimeline(send) : [];
  const ds = send ? sendDisplayStatus(send) : null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000,
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "48px 16px", overflowY: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 720, background: theme.surface, color: theme.text,
          borderRadius: 12, border: `1px solid ${theme.border}`, boxShadow: theme.shadow,
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${theme.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Email preview</div>
          <button onClick={onClose} style={{ ...miniBtn(theme), padding: "4px 8px" }} title="Close (Esc)">✕</button>
        </div>

        {error && (
          <div style={{ padding: 16, color: "#DC2626", fontSize: 13 }}>{error}</div>
        )}

        {!send && !error && (
          <div style={{ padding: 16 }}>
            <SkeletonRow widths={["30%", "50%", "70%", "60%", "80%"]} />
          </div>
        )}

        {send && (
          <div style={{ padding: 18 }}>
            {/* Status row */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
              <Pill tint={SEND_STATUS_TINTS[ds] || {}}>{ds}</Pill>
              <Pill tint={GROUP_TINTS[send.brand_group] || {}}>{send.brand_group || "—"}</Pill>
              <span style={{ fontSize: 12, color: theme.textMuted }}>
                T+{send.touch_number === 1 ? "0" : send.touch_number === 2 ? "3" : send.touch_number === 3 ? "7" : "?"}
                {send.template_key ? ` · ${send.template_key}` : ""}
              </span>
              {send.cancel_reason && (
                <span style={{ fontSize: 11, color: theme.textMuted }}>· {send.cancel_reason}</span>
              )}
            </div>

            {/* Headers */}
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", marginBottom: 16, fontSize: 12 }}>
              <div style={{ color: theme.textMuted }}>From</div>
              <div style={{ color: theme.text }}>{campaign.sender_from}</div>
              <div style={{ color: theme.textMuted }}>Reply-to</div>
              <div style={{ color: theme.text }}>{campaign.reply_to}</div>
              <div style={{ color: theme.textMuted }}>To</div>
              <div style={{ color: theme.text }}>
                {send.to_name ? `${send.to_name} · ` : ""}{send.to_email}
              </div>
            </div>

            {/* Subject */}
            <div style={{ fontSize: 16, fontWeight: 600, color: theme.text, marginBottom: 12, lineHeight: 1.35 }}>
              {send.subject || "—"}
            </div>

            {/* Body */}
            <div
              style={{
                padding: 14, borderRadius: 8, background: theme.bg,
                border: `1px solid ${theme.border}`,
                fontSize: 13, lineHeight: 1.55, color: theme.text,
                whiteSpace: "pre-wrap", fontFamily: "inherit",
                marginBottom: 16,
              }}
            >
              {send.body || <span style={{ color: theme.textMuted, fontStyle: "italic" }}>Body not yet rendered (still pending).</span>}
            </div>

            {/* Timeline */}
            {events.length > 0 && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 }}>Timeline</div>
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 14px", fontSize: 12 }}>
                  {events.map((e, i) => (
                    <Fragment key={i}>
                      <div style={{ color: theme.textMuted, whiteSpace: "nowrap" }}>{friendlyDate(e.at)}</div>
                      <div style={{ color: theme.text }}>{e.label}</div>
                    </Fragment>
                  ))}
                </div>
              </div>
            )}

            {send.error && (
              <div style={{ marginTop: 12, padding: 10, borderRadius: 6, background: "#FEE2E2", color: "#991B1B", fontSize: 12 }}>
                {send.error}
              </div>
            )}

            {send.resend_id && (
              <div style={{ marginTop: 14, fontSize: 11, color: theme.textMuted }}>
                Resend ID: {send.resend_id}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function buildSendTimeline(s) {
  const evts = [
    { at: s.scheduled_at, label: "Scheduled" },
    { at: s.sent_at, label: "Sent" },
    { at: s.delivered_at, label: "Delivered" },
    { at: s.opened_at, label: "Opened" },
    { at: s.clicked_at, label: "Clicked" },
    { at: s.replied_at, label: "Replied" },
    { at: s.bounced_at, label: "Bounced" },
    { at: s.complained_at, label: "Complained" },
    { at: s.cancelled_at, label: s.cancel_reason ? `Cancelled (${s.cancel_reason})` : "Cancelled" },
  ];
  return evts.filter((e) => !!e.at).sort((a, b) => new Date(a.at) - new Date(b.at));
}

function EyeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  );
}

function iconBtn(theme) {
  return {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: 26, height: 26, padding: 0,
    border: `1px solid ${theme.border}`, borderRadius: 4,
    background: theme.bg, color: theme.text, cursor: "pointer",
  };
}

function SendStatCard({ label, value, sub, theme, tint = {} }) {
  return (
    <Card style={{ padding: "12px 14px", marginBottom: 0 }}>
      <div style={{ fontSize: 11, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: tint.fg || theme.text, marginTop: 2 }}>{value}</div>
      {sub != null && (
        <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 2 }}>{sub}</div>
      )}
    </Card>
  );
}

// Mirrors SendStatCard's layout exactly so loading → loaded doesn't reflow.
function SendStatCardSkeleton() {
  return (
    <Card style={{ padding: "12px 14px", marginBottom: 0 }}>
      <Skeleton width="60%" height={11} />
      <div style={{ height: 2 }} />
      <Skeleton width="40%" height={22} />
      <div style={{ height: 2 }} />
      <Skeleton width="30%" height={11} />
    </Card>
  );
}

const sendTh = { padding: "8px 12px", textAlign: "left", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 };
const sendTd = { padding: "8px 12px", verticalAlign: "top" };
function sendSelectStyle(theme) {
  return {
    padding: "8px 12px", borderRadius: 8, fontSize: 13, fontFamily: "inherit",
    border: `1.5px solid ${theme.border}`, background: theme.bg, color: theme.text,
    minWidth: 140,
  };
}

// ---------- SETTINGS ----------

function SettingsCard({ campaign, theme, onSaved }) {
  const sched = campaign.config?.schedule || {};
  const [form, setForm] = useState({
    name: campaign.name,
    daily_cap: campaign.daily_cap,
    sender_from: campaign.sender_from,
    reply_to: campaign.reply_to,
    auto_reply: campaign.auto_reply,
    brief: campaign.brief || "",
    countries: (campaign.target_filters?.countries || []).join(","),
    categories: campaign.target_filters?.categories || [],
    min_revenue: campaign.target_filters?.min_revenue || "",
    max_revenue: campaign.target_filters?.max_revenue || "",
    schedule_cadence: sched.cadence || "off",
    schedule_timezone: sched.timezone || (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC"),
    schedule_start_hour: Number.isFinite(sched.start_hour) ? sched.start_hour : 9,
    schedule_end_hour: Number.isFinite(sched.end_hour) ? sched.end_hour : 17,
    schedule_weekdays_only: sched.weekdays_only !== false,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [catSearch, setCatSearch] = useState("");
  const [catResults, setCatResults] = useState([]);
  const [catFocused, setCatFocused] = useState(false);
  const [catErr, setCatErr] = useState(null);
  const [catLoading, setCatLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCatLoading(true);
    const t = setTimeout(() => {
      api.getStoreLeadsCategories({ q: catSearch })
        .then((res) => { if (!cancelled) { setCatResults(res.categories || []); setCatErr(null); } })
        .catch((e) => { if (!cancelled) setCatErr(e.message); })
        .finally(() => { if (!cancelled) setCatLoading(false); });
    }, 150);
    return () => { cancelled = true; clearTimeout(t); };
  }, [catSearch]);

  function set(k) { return (e) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value })); }

  function toggleCategory(id) {
    setForm((f) => ({
      ...f,
      categories: f.categories.includes(id)
        ? f.categories.filter((c) => c !== id)
        : [...f.categories, id],
    }));
  }

  async function save() {
    setBusy(true); setErr(null);
    try {
      const target_filters = {
        countries: form.countries.split(",").map((s) => s.trim()).filter(Boolean),
        categories: form.categories,
        min_revenue: Number(form.min_revenue) || undefined,
        max_revenue: Number(form.max_revenue) || undefined,
      };
      const schedule = {
        cadence: form.schedule_cadence,
        timezone: form.schedule_timezone,
        start_hour: Number(form.schedule_start_hour) || 9,
        end_hour: Number(form.schedule_end_hour) || 17,
        weekdays_only: !!form.schedule_weekdays_only,
      };
      await api.updateOutboundCampaign(campaign.id, {
        name: form.name,
        daily_cap: Number(form.daily_cap) || 200,
        sender_from: form.sender_from,
        reply_to: form.reply_to,
        auto_reply: !!form.auto_reply,
        brief: form.brief || null,
        target_filters,
        config: { ...(campaign.config || {}), schedule },
      });
      onSaved();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 12 }}>Settings</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Name" theme={theme}><Input value={form.name} onChange={set("name")} /></Field>
        <Field label="Daily cap" theme={theme}><Input type="number" value={form.daily_cap} onChange={set("daily_cap")} /></Field>
        <Field label="Sender (from)" theme={theme}><Input value={form.sender_from} onChange={set("sender_from")} /></Field>
        <Field label="Reply-to" theme={theme}><Input value={form.reply_to} onChange={set("reply_to")} /></Field>
        <Field label="Countries (comma)" theme={theme}><Input value={form.countries} onChange={set("countries")} /></Field>
        <Field label="Min revenue $/mo" theme={theme}><Input type="number" value={form.min_revenue} onChange={set("min_revenue")} /></Field>
        <Field label="Max revenue $/mo" theme={theme}><Input type="number" value={form.max_revenue} onChange={set("max_revenue")} /></Field>
        <Field label="Categories" theme={theme} colSpan={2}>
          {form.categories.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              {form.categories.map((c) => (
                <span key={c} style={{
                  display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12,
                  padding: "4px 8px 4px 10px", borderRadius: 999,
                  border: `1.5px solid ${theme.accent}`,
                  background: theme.accent + "15", color: theme.text,
                }}>
                  {c}
                  <button onClick={() => toggleCategory(c)} title="Remove" style={{
                    border: "none", background: "transparent", cursor: "pointer",
                    color: theme.textMuted, padding: 0, fontSize: 14, lineHeight: 1,
                  }}>×</button>
                </span>
              ))}
            </div>
          )}
          <div style={{ position: "relative" }}>
            <Input
              value={catSearch}
              onChange={(e) => setCatSearch(e.target.value)}
              onFocus={() => setCatFocused(true)}
              onBlur={() => setTimeout(() => setCatFocused(false), 150)}
              placeholder="Search StoreLeads categories — e.g. skincare, footwear, supplements"
            />
            {catFocused && (
              <div style={{
                position: "absolute", top: "100%", left: 0, right: 0, zIndex: 10, marginTop: 4,
                maxHeight: 280, overflowY: "auto", borderRadius: 8,
                border: `1px solid ${theme.border}`, background: theme.surface, boxShadow: theme.shadow,
              }}>
                {catErr ? (
                  <div style={{ padding: "10px 12px", fontSize: 12, color: "#DC2626" }}>
                    Couldn't load categories: {catErr}. (If you just deployed, the server may not be ready yet.)
                  </div>
                ) : catLoading && catResults.length === 0 ? (
                  <div style={{ padding: "10px 12px", fontSize: 12, color: theme.textMuted }}>Searching…</div>
                ) : catResults.filter((r) => !form.categories.includes(r.path)).length === 0 ? (
                  <div style={{ padding: "10px 12px", fontSize: 12, color: theme.textMuted }}>
                    {catSearch
                      ? `No StoreLeads categories match "${catSearch}". Try fewer or broader words.`
                      : "Start typing to search categories."}
                  </div>
                ) : (
                  catResults.filter((r) => !form.categories.includes(r.path)).slice(0, 50).map((r) => (
                    <button key={r.path}
                      onMouseDown={(e) => { e.preventDefault(); toggleCategory(r.path); }}
                      style={{
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                        width: "100%", padding: "8px 12px", border: "none",
                        background: "transparent", cursor: "pointer", textAlign: "left",
                        fontFamily: "inherit", fontSize: 13, color: theme.text,
                        borderBottom: `1px solid ${theme.border}`,
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = theme.surfaceAlt}
                      onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                      <span>{r.path}</span>
                      <span style={{ fontSize: 11, color: theme.textMuted }}>{r.count} brands</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 6 }}>
            Leave empty to use the default beauty + wellness preset.
          </div>
        </Field>
        <Field label="Brief (used for AI drafts)" theme={theme} colSpan={2}>
          <textarea
            value={form.brief} onChange={set("brief")}
            rows={3}
            style={{
              width: "100%", padding: "8px 12px", borderRadius: 8, fontFamily: "inherit", fontSize: 13,
              border: `1.5px solid ${theme.border}`, background: theme.bg, color: theme.text, resize: "vertical",
            }}
          />
        </Field>
        <Field label="Send schedule" theme={theme} colSpan={2}>
          <ScheduleEditor form={form} setForm={setForm} theme={theme} />
        </Field>
        <Field label="Reply mode" theme={theme} colSpan={2}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: theme.text }}>
            <input type="checkbox" checked={!!form.auto_reply} onChange={set("auto_reply")} />
            Auto-reply with AI
          </label>
          <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 6, paddingLeft: 24 }}>
            {form.auto_reply
              ? (campaign.ai_campaign_id
                  ? <>Replies to this campaign's emails will be answered by the linked AI persona. <Link to={`/ai/test-lab?campaign=${campaign.ai_campaign_id}`} style={{ color: theme.accent, fontWeight: 600 }}>Tune persona →</Link></>
                  : "When you save, an AI persona will be created automatically using the brief above. You can tune it later from this page.")
              : "Off — replies land in Inbox for manual handling."}
          </div>
        </Field>
      </div>
      {err && <div style={{ color: "#DC2626", fontSize: 12, marginTop: 8 }}>{err}</div>}
      <div style={{ marginTop: 12 }}><Btn onClick={save} loading={busy}>Save settings</Btn></div>
    </Card>
  );
}

// ---------- SCHEDULE EDITOR ----------

const COMMON_TIMEZONES = [
  "Europe/London", "Europe/Berlin", "Europe/Paris", "Europe/Madrid", "Europe/Rome",
  "Europe/Amsterdam", "Europe/Stockholm", "Europe/Athens",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Toronto",
  "Asia/Singapore", "Asia/Tokyo", "Asia/Hong_Kong", "Asia/Dubai", "Asia/Kolkata",
  "Australia/Sydney", "Pacific/Auckland", "UTC",
];

function ScheduleEditor({ form, setForm, theme }) {
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const guess = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : null;
  const tzOptions = guess && !COMMON_TIMEZONES.includes(guess) ? [guess, ...COMMON_TIMEZONES] : COMMON_TIMEZONES;

  // Live "next fire" preview so users can sanity-check what they picked.
  const preview = (() => {
    if (form.schedule_cadence === "off") return "Auto-send is off. The campaign won't run until you turn it on.";
    const tz = form.schedule_timezone;
    const start = `${String(form.schedule_start_hour).padStart(2, "0")}:00`;
    const end = `${String(form.schedule_end_hour).padStart(2, "0")}:00`;
    const days = form.schedule_weekdays_only ? "Mon-Fri" : "every day";
    if (form.schedule_cadence === "daily") return `Sends once a day at ${start} ${tz}, ${days}, up to ${form.daily_cap || 200} emails.`;
    return `Sends hourly between ${start}–${end} ${tz}, ${days}, ~${Math.ceil((form.daily_cap || 200) / Math.max(1, form.schedule_end_hour - form.schedule_start_hour + 1))} per hour (cap ${form.daily_cap || 200}/day).`;
  })();

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <label style={{ fontSize: 12, color: theme.textMid }}>
          Cadence
          <select value={form.schedule_cadence} onChange={(e) => set("schedule_cadence", e.target.value)}
            style={selStyle(theme)}>
            <option value="off">Off — manual only</option>
            <option value="daily">Once a day</option>
            <option value="hourly_business">Hourly during business hours</option>
          </select>
        </label>
        <label style={{ fontSize: 12, color: theme.textMid }}>
          Timezone
          <select value={form.schedule_timezone} onChange={(e) => set("schedule_timezone", e.target.value)}
            disabled={form.schedule_cadence === "off"} style={selStyle(theme)}>
            {tzOptions.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12, color: theme.textMid }}>
          {form.schedule_cadence === "hourly_business" ? "Window start (hour)" : "Send at (hour)"}
          <select value={form.schedule_start_hour} onChange={(e) => set("schedule_start_hour", Number(e.target.value))}
            disabled={form.schedule_cadence === "off"} style={selStyle(theme)}>
            {hours.map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
          </select>
        </label>
        {form.schedule_cadence === "hourly_business" && (
          <label style={{ fontSize: 12, color: theme.textMid }}>
            Window end (hour, inclusive)
            <select value={form.schedule_end_hour} onChange={(e) => set("schedule_end_hour", Number(e.target.value))}
              style={selStyle(theme)}>
              {hours.map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
            </select>
          </label>
        )}
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: theme.text, marginTop: 10 }}>
        <input type="checkbox" checked={!!form.schedule_weekdays_only}
          onChange={(e) => set("schedule_weekdays_only", e.target.checked)}
          disabled={form.schedule_cadence === "off"} />
        Weekdays only (Mon-Fri)
      </label>
      <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 8, padding: "8px 10px", background: theme.surfaceAlt, borderRadius: 6 }}>
        {preview}
      </div>
    </div>
  );
}

function selStyle(theme) {
  return {
    display: "block", width: "100%", marginTop: 4, padding: "8px 10px",
    border: `1.5px solid ${theme.border}`, borderRadius: 8, fontSize: 13,
    background: theme.bg, color: theme.text, fontFamily: "inherit",
  };
}

// ---------- ACTIONS ----------

function CampaignActions({ campaign, onChange, navigate }) {
  const [busy, setBusy] = useState(false);

  async function pause() { setBusy(true); try { await api.pauseOutboundCampaign(campaign.id); onChange(); } finally { setBusy(false); } }
  async function resume() { setBusy(true); try { await api.resumeOutboundCampaign(campaign.id); onChange(); } finally { setBusy(false); } }
  async function archive() {
    if (!window.confirm(`Archive "${campaign.name}"? Already-scheduled touches will still go out unless you also pause.`)) return;
    setBusy(true);
    try { await api.archiveOutboundCampaign(campaign.id); navigate("/ai/campaigns"); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ display: "flex", gap: 8 }}>
      {campaign.status === "active" && <Btn onClick={pause} loading={busy} variant="secondary">Pause</Btn>}
      {campaign.status === "paused" && <Btn onClick={resume} loading={busy}>Resume</Btn>}
      {campaign.status !== "archived" && <Btn onClick={archive} loading={busy} variant="secondary" style={{ color: "#DC2626" }}>Archive</Btn>}
    </div>
  );
}

// ---------- DISCOVER ----------

function DiscoverCard({ campaign, theme, onStarted }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [limit, setLimit] = useState(100);

  async function run() {
    setBusy(true); setErr(null); setResult(null);
    try {
      const out = await api.discoverForOutboundCampaign(campaign.id, { limit: Number(limit) || 100 });
      setResult(out);
      if (onStarted) onStarted();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 }}>Lead discovery</div>
      <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 8 }}>
        Queues a discovery run for this campaign's filters. A worker (cron / scheduled agent) pulls fresh prospects from StoreLeads, enriches via Apollo + Hunter, and adds them to the pool. Watch progress in the panel below.
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Input type="number" value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 120 }} />
        <Btn onClick={run} loading={busy}>Run discovery</Btn>
        {result?.run_id && (
          <span style={{ fontSize: 12, color: "#065F46" }}>
            ✓ queued (target {result.target}) — picked up by the next worker run
          </span>
        )}
      </div>
      {err && <div style={{ color: "#DC2626", fontSize: 12, marginTop: 8 }}>{err}</div>}
    </Card>
  );
}

// ---------- DISCOVERY RUNS PANEL ----------

const RUN_STATUS_TINTS = {
  pending:  { bg: "#FEF3C7", fg: "#92400E" },
  running:  { bg: "#DBEAFE", fg: "#1E40AF" },
  complete: { bg: "#D1FAE5", fg: "#065F46" },
  failed:   { bg: "#FEE2E2", fg: "#991B1B" },
  stopped:  { bg: "#F3F4F6", fg: "#374151" },
};

function DiscoveryRunsPanel({ campaign, theme }) {
  const [runs, setRuns] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState(null);

  const reload = useCallback(async () => {
    try {
      const res = await api.listOutboundDiscoveryRuns(campaign.id, { limit: 10 });
      setRuns(res.rows || []);
      setErr(null);
    } catch (e) { setErr(e.message); }
    finally { setLoaded(true); }
  }, [campaign.id]);

  useEffect(() => { reload(); }, [reload]);

  // Poll every 5s while any run is still 'running' so progress counts feel live.
  const anyRunning = runs.some((r) => r.status === "running" || r.status === "pending");
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [anyRunning, reload]);

  async function stop(runId) {
    try { await api.stopOutboundDiscoveryRun(runId); reload(); }
    catch (e) { setErr(e.message); }
  }

  if (!loaded) {
    return (
      <Card style={{ marginBottom: 16 }}>
        <SkeletonRow widths={["35%", "70%", "55%"]} />
      </Card>
    );
  }
  if (runs.length === 0) {
    return null; // no clutter when there's nothing to show
  }

  return (
    <Card style={{ marginBottom: 16, padding: 0 }}>
      <div style={{ padding: "16px 20px 8px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.4 }}>
            Recent discovery runs {anyRunning && <span style={{ color: theme.accent, marginLeft: 6 }}>· live</span>}
          </div>
          <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 4 }}>
            Counts below are <strong>at-run-time</strong> snapshots. Some leads may be re-classified later (e.g. shared mailboxes demoted, brands re-checked). For the current truth, see <em>Lead pool</em> below.
          </div>
        </div>
        <button onClick={reload} style={{ padding: "4px 10px", fontSize: 11, fontFamily: "inherit", fontWeight: 600, border: `1px solid ${theme.border}`, borderRadius: 4, background: theme.bg, color: theme.text, cursor: "pointer" }}>
          Refresh
        </button>
      </div>
      {err && <div style={{ color: "#DC2626", fontSize: 12, padding: "0 20px 8px" }}>{err}</div>}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${theme.border}`, color: theme.textMuted }}>
            <th style={runTh}>Status</th>
            <th style={runTh}>Progress</th>
            <th style={runTh} title="Brands counted as qualified at the moment this run completed. The current pool may differ — see Lead pool below.">Qualified (at run)</th>
            <th style={runTh}>Skipped</th>
            <th style={runTh}>Failed</th>
            <th style={runTh}>Started</th>
            <th style={runTh}>Finished</th>
            <th style={runTh}>Action</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            // Target is qualified leads, not brands inspected — the loop exits
            // at sent === total. Showing processed / total made progress
            // overshoot 100% whenever any brands got skipped/failed.
            const target = r.total || 1;
            const pct = Math.min(100, Math.round((r.sent / target) * 100));
            return (
              <tr key={r.id} style={{ borderBottom: `1px solid ${theme.border}` }}>
                <td style={runTd}>
                  <Pill tint={RUN_STATUS_TINTS[r.status] || {}}>{r.status}</Pill>
                  {r.error && <div style={{ fontSize: 10, color: "#DC2626", marginTop: 2, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.error}>{r.error}</div>}
                </td>
                <td style={runTd}>
                  <div style={{ color: theme.text }}>{r.sent} / {r.total || "?"}</div>
                  <div style={{ fontSize: 10, color: theme.textMuted, marginTop: 1 }}>{r.processed} inspected</div>
                  <div style={{ width: 120, height: 4, background: theme.surfaceAlt, borderRadius: 2, marginTop: 4, overflow: "hidden" }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: r.status === "failed" ? "#DC2626" : theme.accent }} />
                  </div>
                </td>
                <td style={{ ...runTd, color: "#065F46", fontWeight: 600 }}>{r.sent}</td>
                <td style={{ ...runTd, color: theme.textMuted }}>{r.skipped}</td>
                <td style={{ ...runTd, color: r.failed ? "#991B1B" : theme.textMuted }}>{r.failed}</td>
                <td style={{ ...runTd, color: theme.textMuted, whiteSpace: "nowrap" }}>{shortDate(r.started_at || r.created_at)}</td>
                <td style={{ ...runTd, color: theme.textMuted, whiteSpace: "nowrap" }}>{r.completed_at ? shortDate(r.completed_at) : "—"}</td>
                <td style={runTd}>
                  {r.status === "running" ? (
                    <button onClick={() => stop(r.id)} style={{ padding: "4px 10px", fontSize: 11, fontFamily: "inherit", fontWeight: 600, border: `1px solid ${theme.border}`, borderRadius: 4, background: theme.bg, color: theme.text, cursor: "pointer" }}>Stop</button>
                  ) : (
                    <span style={{ color: theme.textMuted, fontSize: 11 }}>—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

const runTh = { padding: "8px 16px", textAlign: "left", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 };
const runTd = { padding: "8px 16px", verticalAlign: "top" };

// ---------- LEAD POOL PANEL ----------
//
// Brands the discovery worker has surfaced. The pool is team-wide, but on a
// campaign detail page we filter to leads matching THIS campaign's targeting
// (country / revenue band) by default — there's a toggle to view the whole
// team pool when needed.

function LeadPoolPanel({ theme, campaign }) {
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState(null);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [onlyQualified, setOnlyQualified] = useState(true);
  const [scopeToCampaign, setScopeToCampaign] = useState(true);

  // Filters derived from the campaign's target_filters when scoped.
  const tf = campaign?.target_filters || {};
  const hasTargeting = (tf.countries?.length || tf.min_revenue || tf.max_revenue);
  const filterArgs = scopeToCampaign && hasTargeting ? {
    country: (tf.countries || []).join(","),
    minRevenue: tf.min_revenue,
    maxRevenue: tf.max_revenue,
  } : {};

  const load = useCallback(() => {
    api.listOutboundLeads({
      q: q || undefined,
      qualified: onlyQualified ? undefined : "false",
      limit: pageSize,
      offset: (page - 1) * pageSize,
      ...filterArgs,
    })
      .then((res) => { setRows(res.rows || []); setTotal(res.total || 0); })
      .catch(() => {});
    api.getOutboundLeadCounts(filterArgs).then(setCounts).catch(() => {});
  }, [q, page, onlyQualified, scopeToCampaign, JSON.stringify(filterArgs)]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => { setPage(1); }, [q, onlyQualified, scopeToCampaign, pageSize]);

  return (
    <Card style={{ marginBottom: 16, padding: 0 }}>
      <div style={{ padding: "16px 20px 8px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.4 }}>
            Lead pool {counts && (
              <span style={{ marginLeft: 8, color: theme.textMuted, fontSize: 11, textTransform: "none", fontWeight: 400, letterSpacing: 0 }}>
                {counts.qualified} with email · {counts.total - counts.qualified} skipped · {counts.emailed} contacted
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 4 }}>
            {scopeToCampaign && hasTargeting
              ? <>Filtered to this campaign's targeting{tf.countries?.length ? ` · ${tf.countries.join(", ")}` : ""}{tf.min_revenue || tf.max_revenue ? ` · ${tf.min_revenue ? "$" + (tf.min_revenue / 1000).toFixed(0) + "k" : ""}-${tf.max_revenue ? "$" + (tf.max_revenue / 1000).toFixed(0) + "k" : ""}/mo` : ""}.</>
              : "Whole team pool — leads from all campaigns' discovery runs."}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {hasTargeting && (
            <label style={{ fontSize: 11, color: theme.textMuted, display: "inline-flex", alignItems: "center", gap: 4 }}>
              <input type="checkbox" checked={scopeToCampaign} onChange={(e) => setScopeToCampaign(e.target.checked)} style={{ margin: 0 }} />
              this campaign only
            </label>
          )}
          <label style={{ fontSize: 11, color: theme.textMuted, display: "inline-flex", alignItems: "center", gap: 4 }}>
            <input type="checkbox" checked={onlyQualified} onChange={(e) => setOnlyQualified(e.target.checked)} style={{ margin: 0 }} />
            with email only
          </label>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search domain or contact"
            style={{ padding: "6px 10px", borderRadius: 6, fontSize: 12, fontFamily: "inherit",
              border: `1px solid ${theme.border}`, background: theme.bg, color: theme.text, minWidth: 200 }}
          />
        </div>
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: "20px", color: theme.textMuted, fontSize: 13 }}>
          {q ? "No leads match this search." : "No leads in the pool yet — run discovery first."}
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${theme.border}`, color: theme.textMuted }}>
              <th style={runTh}>Domain</th>
              <th style={runTh}>Contact</th>
              <th style={runTh}>Email</th>
              <th style={runTh}>Country</th>
              <th style={runTh}>Categories</th>
              <th style={runTh}>Status</th>
              <th style={runTh}>Added</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const skipReason = r.raw_data?._disqualify_reason;
              const fullName = [r.contact_first_name, r.contact_last_name].filter(Boolean).join(" ");
              return (
                <tr key={r.id} style={{ borderBottom: `1px solid ${theme.border}` }}>
                  <td style={runTd}>
                    <a href={`https://${r.domain}`} target="_blank" rel="noreferrer" style={{ color: theme.text, fontWeight: 500, textDecoration: "none" }}>{r.domain}</a>
                  </td>
                  <td style={runTd}>
                    <div style={{ color: theme.text }}>{fullName || "—"}</div>
                    {r.contact_position && <div style={{ fontSize: 11, color: theme.textMuted }}>{r.contact_position}</div>}
                  </td>
                  <td style={{ ...runTd, color: r.email ? theme.text : theme.textMuted }}>{r.email || "—"}</td>
                  <td style={{ ...runTd, color: theme.textMuted }}>{r.country_code || "—"}</td>
                  <td style={{ ...runTd, color: theme.textMuted, fontSize: 11, maxWidth: 180 }}>
                    {(r.categories || []).slice(0, 2).map((c) => c.split("/").pop()).join(", ") || "—"}
                  </td>
                  <td style={runTd}>
                    {r.emailed
                      ? <Pill tint={{ bg: "#D1FAE5", fg: "#065F46" }}>contacted</Pill>
                      : skipReason
                        ? <Pill tint={{ bg: "#FEE2E2", fg: "#991B1B" }} title={skipReason}>skipped</Pill>
                        : <Pill tint={{ bg: "#DBEAFE", fg: "#1E40AF" }}>queued</Pill>}
                  </td>
                  <td style={{ ...runTd, color: theme.textMuted, whiteSpace: "nowrap" }}>{shortDate(r.imported_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {total > 0 && (
        <div style={{ padding: "0 20px" }}>
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </div>
      )}
    </Card>
  );
}

function shortDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const opts = sameDay ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
  return d.toLocaleString(undefined, opts);
}

// ---------- TEMPLATES ----------

const SLOTS = [
  ["G1", 1], ["G1", 2], ["G1", 3],
  ["G2", 1], ["G2", 2], ["G2", 3],
  ["G3", 1], ["G3", 2], ["G3", 3],
];

const GROUP_LABELS = {
  G1: "G1 · Creator-active",
  G2: "G2 · Summer-seasonal",
  G3: "G3 · Cold catch-all",
};

function TemplatesCard({ campaign, templates, theme, onChange }) {
  const [generating, setGenerating] = useState(false);
  const [genErr, setGenErr] = useState(null);
  const [refinementPrompt, setRefinementPrompt] = useState("");
  const [activeGroup, setActiveGroup] = useState("G1");

  async function generate() {
    setGenerating(true); setGenErr(null);
    try {
      // Steering rewrite scoped to the active group only.
      await api.generateOutboundDrafts(campaign.id, {
        refinement_prompt: refinementPrompt.trim() || undefined,
        groups: [activeGroup],
      });
      onChange();
    } catch (e) { setGenErr(e.message); }
    finally { setGenerating(false); }
  }

  const grouped = useMemo(() => {
    const m = {};
    for (const slot of SLOTS) m[`${slot[0]}-T${slot[1]}`] = [];
    for (const t of templates || []) {
      const k = t.template_key || `${t.brand_group}-T${t.touch_number}`;
      (m[k] ||= []).push(t);
    }
    return m;
  }, [templates]);

  // Per-group counts feed the tab badges.
  const countsByGroup = useMemo(() => {
    const c = { G1: 0, G2: 0, G3: 0 };
    for (const t of templates || []) {
      if (c[t.brand_group] != null) c[t.brand_group]++;
    }
    return c;
  }, [templates]);

  const visibleSlots = SLOTS.filter(([g]) => g === activeGroup);

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.4 }}>Templates ({templates?.length || 0})</div>
        <Btn onClick={generate} loading={generating}>Rewrite {activeGroup} with AI</Btn>
      </div>

      <TabBar
        tabs={["G1", "G2", "G3"].map((g) => [g, `${GROUP_LABELS[g]} (${countsByGroup[g]})`])}
        active={activeGroup}
        onSelect={setActiveGroup}
      />

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: theme.textMuted, marginBottom: 4 }}>
          Steering prompt (optional) — applied to every {activeGroup} slot's rewrite
        </div>
        <textarea
          value={refinementPrompt}
          onChange={(e) => setRefinementPrompt(e.target.value)}
          placeholder='e.g. "lead with the ROI math, drop the calendly link, keep tone confrontational, reference Black Friday case study"'
          rows={2}
          style={{
            width: "100%", padding: "8px 12px", borderRadius: 8, fontFamily: "inherit", fontSize: 13,
            border: `1.5px solid ${theme.border}`, background: theme.bg, color: theme.text, resize: "vertical",
          }}
        />
      </div>
      {genErr && <div style={{ color: "#DC2626", fontSize: 12, marginBottom: 8 }}>{genErr}</div>}

      <div style={{ display: "grid", gap: 12 }}>
        {visibleSlots.map(([g, t]) => {
          const key = `${g}-T${t}`;
          const list = grouped[key] || [];
          return (
            <SlotBlock key={key} group={g} touch={t} templates={list} theme={theme} onChange={onChange} />
          );
        })}
      </div>
    </Card>
  );
}

function SlotBlock({ group, touch, templates, theme, onChange }) {
  return (
    <div style={{ border: `1px solid ${theme.border}`, borderRadius: 8, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Pill tint={GROUP_TINTS[group] || {}}>{group}</Pill>
        <span style={{ fontSize: 13, fontWeight: 500, color: theme.text }}>T+{touch === 1 ? "0" : touch === 2 ? "3" : "7"}</span>
        <span style={{ fontSize: 11, color: theme.textMuted }}>({templates.length} variant{templates.length === 1 ? "" : "s"})</span>
      </div>
      {templates.length === 0 ? (
        <div style={{ fontSize: 12, color: theme.textMuted }}>No templates — generate AI drafts or seed defaults.</div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {templates.map((t) => (
            <TemplateRow key={t.id} template={t} theme={theme} onChange={onChange} />
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateRow({ template, theme, onChange }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: template.name || "",
    subject_template: template.subject_template,
    body_template: template.body_template,
    weight: template.weight,
    is_active: template.is_active,
    is_draft: template.is_draft,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function save() {
    setBusy(true); setErr(null);
    try {
      await api.updateOutboundTemplate(template.id, {
        name: form.name,
        subject_template: form.subject_template,
        body_template: form.body_template,
        weight: Number(form.weight) || 0,
        is_active: !!form.is_active,
        is_draft: !!form.is_draft,
      });
      setEditing(false);
      onChange();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function deactivate() {
    if (!window.confirm("Deactivate this template? It won't be sent again until you toggle is_active back on.")) return;
    setBusy(true);
    try { await api.deleteOutboundTemplate(template.id); onChange(); }
    finally { setBusy(false); }
  }

  if (!editing) {
    return (
      <div style={{ padding: 8, background: theme.surfaceAlt, borderRadius: 6, fontSize: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <strong style={{ color: theme.text }}>{template.name || template.template_key}</strong>
            {template.is_draft && <Pill tint={{ bg: "#FEF3C7", fg: "#92400E" }}>draft</Pill>}
            {!template.is_active && <Pill tint={{ bg: "#FEE2E2", fg: "#991B1B" }}>inactive</Pill>}
            {template.generated_by_ai && <Pill tint={{ bg: "#E0E7FF", fg: "#3730A3" }}>AI</Pill>}
            <span style={{ color: theme.textMuted }}>weight: {template.weight}</span>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <button onClick={() => setEditing(true)} style={miniBtn(theme)}>Edit</button>
            <button onClick={deactivate} disabled={busy} style={{ ...miniBtn(theme), color: "#DC2626" }}>Deactivate</button>
          </div>
        </div>
        <div style={{ marginTop: 6, color: theme.text, fontWeight: 500 }}>{template.subject_template}</div>
        <pre style={{ margin: "4px 0 0", fontSize: 11, color: theme.textMuted, whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{template.body_template}</pre>
      </div>
    );
  }

  return (
    <div style={{ padding: 12, background: theme.surfaceAlt, borderRadius: 6 }}>
      <div style={{ display: "grid", gap: 8 }}>
        <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="name" />
        <Input value={form.subject_template} onChange={(e) => setForm({ ...form, subject_template: e.target.value })} placeholder="subject" />
        <textarea
          value={form.body_template} onChange={(e) => setForm({ ...form, body_template: e.target.value })}
          rows={8}
          style={{
            width: "100%", padding: "8px 12px", borderRadius: 8, fontFamily: "inherit", fontSize: 13,
            border: `1.5px solid ${theme.border}`, background: theme.bg, color: theme.text, resize: "vertical",
          }}
        />
        <div style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 12, color: theme.text }}>
          <label>weight <Input type="number" value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value })} style={{ width: 80, marginLeft: 6 }} /></label>
          <label><input type="checkbox" checked={!!form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} /> active</label>
          <label><input type="checkbox" checked={!!form.is_draft} onChange={(e) => setForm({ ...form, is_draft: e.target.checked })} /> draft</label>
        </div>
        {err && <div style={{ color: "#DC2626", fontSize: 12 }}>{err}</div>}
        <div style={{ display: "flex", gap: 6 }}>
          <Btn onClick={save} loading={busy}>Save</Btn>
          <Btn onClick={() => setEditing(false)} variant="secondary">Cancel</Btn>
        </div>
      </div>
    </div>
  );
}

// ---------- SHARED ----------

function Field({ label, theme, colSpan, children }) {
  return (
    <div style={{ gridColumn: colSpan ? `span ${colSpan}` : undefined }}>
      <div style={{ fontSize: 11, color: theme.textMuted, textTransform: "uppercase", fontWeight: 600, letterSpacing: 0.4, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
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

function miniBtn(theme) {
  return {
    padding: "4px 10px", fontSize: 11, fontFamily: "inherit", fontWeight: 600,
    border: `1px solid ${theme.border}`, borderRadius: 4, background: theme.bg,
    color: theme.text, cursor: "pointer",
  };
}
