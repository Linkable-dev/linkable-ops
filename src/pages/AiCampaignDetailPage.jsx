// AI Campaign detail — settings, templates (incl. A/B + AI drafts), metrics,
// lead-discovery trigger, pause/resume. Routes: /ai/campaigns/:id

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTheme } from "../contexts/ThemeContext";
import { api } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Skeleton, SkeletonRow, SkeletonCard } from "../components/ui/Skeleton";
import { TabBar } from "../components/ui/TabBar";

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
      <div style={{ marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <Link to="/ai/campaigns" style={{ color: theme.textMuted, fontSize: 12, textDecoration: "none" }}>← All campaigns</Link>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: theme.text, margin: "4px 0 0", display: "flex", alignItems: "center", gap: 12 }}>
            {campaign.name}
            <Pill tint={STATUS_TINTS[campaign.status] || {}}>{campaign.status}</Pill>
            {campaign.auto_reply && <Pill tint={{ bg: "#E0E7FF", fg: "#3730A3" }}>auto-reply</Pill>}
          </h1>
        </div>
        <CampaignActions campaign={campaign} onChange={reload} navigate={navigate} />
      </div>

      <MetricsCard metrics={metrics} theme={theme} />
      <SettingsCard campaign={campaign} theme={theme} onSaved={reload} />
      <DiscoverCard campaign={campaign} theme={theme} onStarted={reload} />
      <DiscoveryRunsPanel campaign={campaign} theme={theme} />
      <LeadPoolPanel theme={theme} />
      <TemplatesCard
        campaign={campaign}
        templates={templates}
        theme={theme}
        onChange={reload}
      />
    </div>
  );
}

// ---------- METRICS ----------

function MetricsCard({ metrics, theme }) {
  if (!metrics) return null;
  const cells = [
    { label: "Total in flight", value: metrics.total },
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
                  ? "Replies to this campaign's emails will be answered by the linked AI persona."
                  : "When you save, an AI persona will be created automatically using the brief above. Tweak it later in AI Test Lab.")
              : "Off — replies land in AI Inbox for manual handling."}
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
// Team-wide pool of brands that any discovery run has surfaced. This isn't
// per-campaign — every campaign shares the same pool, the daily-200 sender
// just picks brands matching its own filters at send time.

function LeadPoolPanel({ theme }) {
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState(null);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [onlyQualified, setOnlyQualified] = useState(true);
  const pageSize = 10;

  const load = useCallback(() => {
    api.listOutboundLeads({
      q: q || undefined,
      qualified: onlyQualified ? undefined : "false",
      limit: pageSize,
      offset: (page - 1) * pageSize,
    })
      .then((res) => { setRows(res.rows || []); setTotal(res.total || 0); })
      .catch(() => {});
    api.getOutboundLeadCounts().then(setCounts).catch(() => {});
  }, [q, page, onlyQualified]);

  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => { setPage(1); }, [q, onlyQualified]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

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
            Live state — this is the source of truth, not the run-time counters above.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
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
      {total > pageSize && (
        <div style={{ padding: "10px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: theme.textMuted }}>
          <span>Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}</span>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
              style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${theme.border}`, background: theme.bg, color: theme.text, fontSize: 12, cursor: page <= 1 ? "not-allowed" : "pointer", opacity: page <= 1 ? 0.5 : 1 }}>Prev</button>
            <span style={{ padding: "4px 8px" }}>{page} / {totalPages}</span>
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
              style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${theme.border}`, background: theme.bg, color: theme.text, fontSize: 12, cursor: page >= totalPages ? "not-allowed" : "pointer", opacity: page >= totalPages ? 0.5 : 1 }}>Next</button>
          </div>
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
