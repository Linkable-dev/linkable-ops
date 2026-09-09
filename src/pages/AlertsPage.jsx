import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTheme } from "../contexts/ThemeContext";
import { useDbTarget } from "../contexts/DbTargetContext";
import { useBrandDrawer } from "../contexts/BrandDrawerContext";
import { api, friendlyDate } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Skeleton, SkeletonStatGrid, SkeletonListRows } from "../components/ui/Skeleton";
import { BrandLink } from "../components/brand/BrandLink";
import { SEVERITY, notifyAlertsChanged } from "../lib/alerts";
import NudgeModal from "../components/alerts/NudgeModal";
import AutoNudgeSettings from "../components/alerts/AutoNudgeSettings";

const KINDS = [["all", "Everything"], ["shipping", "Samples"], ["applications", "Applications"], ["trials", "Trials"], ["billing", "Billing"], ["sales", "Sales"], ["deliverability", "Sending"], ["deletion", "Deletion"]];
const SEV_ORDER = { danger: 0, warn: 1, info: 2 };

// "waiting 34 days" for past dates, "in 3 days" for deadlines.
function age(iso) {
  if (!iso) return null;
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days >= 0) return { text: days === 0 ? "since today" : `waiting ${days} day${days === 1 ? "" : "s"}`, days };
  const d = -days;
  return { text: d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`, days };
}

export default function AlertsPage() {
  const { theme } = useTheme();
  const { target } = useDbTarget();
  const { openBrand } = useBrandDrawer();
  // Results are keyed by target + scope so a reload never resets state inside an effect.
  const [results, setResults] = useState({});
  const [kind, setKind] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [query, setQuery] = useState("");
  const [view, setView] = useState(() => { try { return localStorage.getItem("lk-alerts-view") || "brand"; } catch { return "brand"; } });
  const [showDismissed, setShowDismissed] = useState(false);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [nudgeAlert, setNudgeAlert] = useState(null); // alert whose nudge dialog is open
  const [nudgeSent, setNudgeSent] = useState(null);   // { to } after a send
  const [showAuto, setShowAuto] = useState(false);    // automatic-chase settings
  const scope = showDismissed ? "all" : "open";
  const cacheKey = `${target}:${scope}`;
  const entry = results[cacheKey];
  const data = entry?.data || null;
  const error = entry?.error || null;
  const loading = !entry;

  const fetchAlerts = (key = cacheKey, all = showDismissed) => api.getAlerts({ all })
    .then((d) => setResults((r) => ({ ...r, [key]: { data: d } })))
    .catch((e) => setResults((r) => ({ ...r, [key]: { error: e.message } })));
  useEffect(() => {
    let alive = true;
    api.getAlerts({ all: scope === "all" })
      .then((d) => alive && setResults((r) => ({ ...r, [cacheKey]: { data: d } })))
      .catch((e) => alive && setResults((r) => ({ ...r, [cacheKey]: { error: e.message } })));
    return () => { alive = false; };
  }, [cacheKey, scope]);

  const alerts = useMemo(() => data?.alerts || [], [data]);
  const open = useMemo(() => alerts.filter((a) => !a.dismissed), [alerts]);

  const summary = useMemo(() => {
    const s = { danger: 0, warn: 0, info: 0, brands: new Set() };
    for (const a of open) { s[a.severity] = (s[a.severity] || 0) + 1; if (a.brand?.user_id) s.brands.add(a.brand.user_id); }
    return { ...s, brands: s.brands.size };
  }, [open]);
  const kindCounts = useMemo(() => {
    const c = { all: open.length };
    for (const a of open) c[a.kind] = (c[a.kind] || 0) + 1;
    return c;
  }, [open]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return alerts.filter((a) =>
      (kind === "all" || a.kind === kind) &&
      (severity === "all" || a.severity === severity) &&
      (!q || [a.title, a.detail, a.brand?.store_name, a.brand?.email, a.campaign?.title].some((s) => String(s || "").toLowerCase().includes(q))),
    );
  }, [alerts, kind, severity, query]);

  // Group by brand, most urgent brand first.
  const groups = useMemo(() => {
    const m = new Map();
    for (const a of visible) {
      const id = a.brand?.user_id || "none";
      if (!m.has(id)) m.set(id, { id, brand: a.brand, alerts: [] });
      m.get(id).alerts.push(a);
    }
    const arr = [...m.values()];
    const rank = (a) => (a.dismissed ? 9 : SEV_ORDER[a.severity]);
    for (const g of arr) g.alerts.sort((x, y) => rank(x) - rank(y) || new Date(x.since || 0) - new Date(y.since || 0));
    arr.sort((x, y) => rank(x.alerts[0]) - rank(y.alerts[0]) || y.alerts.length - x.alerts.length);
    return arr;
  }, [visible]);

  // Done / Snooze / Restore are shared with every admin (stored server-side).
  const act = async (items, mode) => {
    const list = [].concat(items);
    setBusy(list.map((a) => a.key).join("|")); setActionError(null);
    try {
      if (mode === "restore") await api.restoreAlerts(list.map((a) => a.key));
      else await api.dismissAlerts(list.map((a) => ({ key: a.key, fingerprint: a.fingerprint })), mode, 7);
      await Promise.all([fetchAlerts(`${target}:open`, false), showDismissed ? fetchAlerts(`${target}:all`, true) : null]);
      notifyAlertsChanged();
    } catch (e) { setActionError(e.message); }
    finally { setBusy(null); }
  };
  const isBusy = (a) => !!busy && busy.split("|").includes(a.key);

  // A sent nudge changes the alert list (the send marks it done by default),
  // so reload the same way a dismissal does.
  const onNudged = async (to) => {
    setNudgeAlert(null);
    setNudgeSent({ to });
    await Promise.all([fetchAlerts(`${target}:open`, false), showDismissed ? fetchAlerts(`${target}:all`, true) : null]);
    notifyAlertsChanged();
  };

  useEffect(() => {
    if (!nudgeSent) return;
    const t = setTimeout(() => setNudgeSent(null), 6000);
    return () => clearTimeout(t);
  }, [nudgeSent]);

  const chip = (active, onClick, label) => (
    <button key={label} onClick={onClick} style={{
      height: 30, padding: "0 12px", borderRadius: 999, fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
      border: `1px solid ${active ? theme.text : theme.border}`, background: active ? theme.text : theme.surface, color: active ? theme.surface : theme.textMid,
    }}>{label}</button>
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: theme.text, margin: 0 }}>Alerts</h1>
          <p style={{ fontSize: 13, color: theme.textMuted, margin: "4px 0 0", maxWidth: 760 }}>
            Things a brand has left hanging. <b>Send nudge</b> writes the chase email from the alert and sends it once you have read it; <b>Done</b> hides the alert until the situation changes and <b>Snooze</b> hides it for a week. Nudges and dismissals are shared with the whole team.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {data && <span style={{ fontSize: 12, color: theme.textMuted }}>checked {friendlyDate(data.generatedAt)}</span>}
          <Btn size="sm" variant={showAuto ? "solid" : "outline"} onClick={() => setShowAuto((v) => !v)} title="Choose which alert kinds chase brands on their own">Automatic</Btn>
          <Btn size="sm" variant="outline" onClick={() => fetchAlerts()} disabled={loading}>Refresh</Btn>
        </div>
      </div>

      {loading ? <SkeletonStatGrid count={4} minWidth={170} variant="kpi" style={{ marginBottom: 16 }} /> : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 16 }}>
          {[["danger", summary.danger], ["warn", summary.warn], ["info", summary.info]].map(([sev, n]) => {
            const s = SEVERITY[sev];
            const active = severity === sev;
            return (
              <button key={sev} onClick={() => setSeverity(active ? "all" : sev)} title={active ? "Show every severity" : `Show only ${s.label}`} style={{
                textAlign: "left", padding: "14px 16px", borderRadius: 12, cursor: "pointer", fontFamily: "inherit",
                background: theme.surface, border: `1px solid ${active ? s.color : theme.border}`, boxShadow: active ? `0 0 0 3px ${s.bg}` : "none",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textMuted }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: s.color }} />{s.label}
                </div>
                <div style={{ fontSize: 24, fontWeight: 700, color: n ? s.color : theme.textMuted, marginTop: 6 }}>{n}</div>
                <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 2 }}>{sev === "danger" ? "a creator or a payment is stuck" : sev === "warn" ? "will hurt if left another week" : "worth knowing, no rush"}</div>
              </button>
            );
          })}
          <div style={{ padding: "14px 16px", borderRadius: 12, background: theme.surface, border: `1px solid ${theme.border}` }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textMuted }}>Brands to contact</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: theme.text, marginTop: 6 }}>{summary.brands}</div>
            <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 2 }}>{open.length} open · {data?.dismissedCount || 0} done or snoozed</div>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        {KINDS.map(([k, label]) => chip(kind === k, () => setKind(k), kindCounts[k] ? `${label} (${kindCounts[k]})` : label))}
        <input
          value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by brand or campaign…"
          style={{ marginLeft: "auto", height: 30, padding: "0 12px", borderRadius: 999, border: `1px solid ${theme.border}`, background: theme.surface, color: theme.text, fontSize: 12, fontFamily: "inherit", outline: "none", minWidth: 200 }}
        />
        <div style={{ display: "flex", gap: 2, padding: 2, borderRadius: 999, background: theme.surfaceAlt }}>
          {[["brand", "By brand"], ["list", "List"]].map(([v, l]) => (
            <button key={v} onClick={() => { setView(v); try { localStorage.setItem("lk-alerts-view", v); } catch { /* ignore */ } }} style={{
              height: 26, padding: "0 10px", borderRadius: 999, fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", border: "none",
              background: view === v ? theme.surface : "transparent", color: view === v ? theme.text : theme.textMuted, boxShadow: view === v ? theme.shadow : "none",
            }}>{l}</button>
          ))}
        </div>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: theme.textMid, cursor: "pointer" }}>
          <input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} /> show done &amp; snoozed
        </label>
      </div>

      {showAuto && <AutoNudgeSettings onClose={() => setShowAuto(false)} />}

      {nudgeSent && (
        <Card style={{ borderColor: "#86EFAC", marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: theme.text }}>Nudge sent to <b>{nudgeSent.to}</b>. Replies go to the shared inbox.</div>
        </Card>
      )}
      {actionError && <Card style={{ borderColor: "#FCA5A5" }}><div style={{ color: theme.danger, fontSize: 13 }}>{actionError}</div></Card>}
      {error && <Card><div style={{ color: theme.danger, fontSize: 13 }}>Failed to load alerts: {error}</div></Card>}
      {!error && loading && (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", borderBottom: `1px solid ${theme.border}`, display: "flex", gap: 12, alignItems: "center" }}><Skeleton width={36} height={36} radius={8} /><Skeleton width={180} height={14} /><Skeleton width={60} height={18} radius={999} /></div>
          <SkeletonListRows rows={3} padding="10px 16px" lines={[["45%", 13], ["70%", 11]]} meta={{ width: 100, lines: [[80, 11]] }} action={{ width: 120, height: 26 }} />
        </Card>
      )}
      {!error && !loading && visible.length === 0 && (
        <Card><div style={{ padding: 16, textAlign: "center", color: theme.textMuted, fontSize: 13 }}>{open.length === 0 && !showDismissed ? "All clear. Nothing is waiting on a brand right now." : "No alerts match these filters."}</div></Card>
      )}

      {!error && !loading && view === "brand" && groups.map((g) => (
        <BrandGroup key={g.id} group={g} theme={theme} isBusy={isBusy} onAct={act} onNudge={setNudgeAlert} onOpen={() => g.brand?.user_id && openBrand(g.brand.user_id)} />
      ))}

      {nudgeAlert && (
        <NudgeModal alerts={nudgeAlert} onClose={() => setNudgeAlert(null)} onSent={onNudged} />
      )}

      {!error && !loading && view === "list" && visible.length > 0 && (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          {[...visible].sort((x, y) => (x.dismissed ? 9 : SEV_ORDER[x.severity]) - (y.dismissed ? 9 : SEV_ORDER[y.severity]) || new Date(x.since || 0) - new Date(y.since || 0)).map((a, i, arr) => (
            <AlertLine key={a.key} alert={a} theme={theme} showBrand isLast={i === arr.length - 1} busy={isBusy(a)} onAct={act} onNudge={setNudgeAlert} />
          ))}
        </Card>
      )}
    </div>
  );
}

function BrandGroup({ group: g, theme, isBusy, onAct, onNudge, onOpen }) {
  // Clearing a whole brand hides work from every admin, so it takes two clicks.
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    if (!confirmClear) return;
    const t = setTimeout(() => setConfirmClear(false), 4000);
    return () => clearTimeout(t);
  }, [confirmClear]);
  const openAlerts = g.alerts.filter((a) => !a.dismissed);
  const top = openAlerts[0] || g.alerts[0];
  const sev = SEVERITY[top.severity];
  const counts = openAlerts.reduce((a, x) => ({ ...a, [x.severity]: (a[x.severity] || 0) + 1 }), {});
  const name = g.brand?.store_name || g.brand?.email || "Unknown brand";
  const initials = name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  const groupBusy = openAlerts.some(isBusy);
  return (
    <Card style={{ padding: 0, overflow: "hidden", marginBottom: 12, borderLeft: `3px solid ${openAlerts.length ? sev.color : theme.border}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: `1px solid ${theme.border}`, background: theme.surface }}>
        <button onClick={onOpen} title="Open brand 360" style={{ width: 36, height: 36, borderRadius: 8, border: "none", background: theme.surfaceAlt, color: theme.text, fontWeight: 700, fontSize: 12, cursor: "pointer", flexShrink: 0 }}>{initials}</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <BrandLink userId={g.brand?.user_id} style={{ fontSize: 14, fontWeight: 700, color: theme.text, textDecoration: "none" }}>{name}</BrandLink>
            {["danger", "warn", "info"].filter((s) => counts[s]).map((s) => (
              <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999, background: SEVERITY[s].bg, color: SEVERITY[s].color }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: SEVERITY[s].color }} />{counts[s]} {SEVERITY[s].label.toLowerCase()}
              </span>
            ))}
            {openAlerts.length === 0 && <span style={{ fontSize: 11, color: theme.textMuted }}>all handled</span>}
          </div>
          {g.brand?.email && <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.brand.email}</div>}
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          {g.brand?.email && openAlerts.length > 0 && (
            <Btn size="sm" variant="outline" onClick={() => onNudge(openAlerts)}
              title={`Write one email covering all ${openAlerts.length} open alerts for this brand`}>
              Nudge all {openAlerts.length}
            </Btn>
          )}
          {g.brand?.email && <Btn size="sm" variant="secondary" onClick={() => navigator.clipboard?.writeText(g.brand.email)} title="Copy the brand email">Copy email</Btn>}
          <Btn size="sm" variant="outline" onClick={onOpen}>Brand 360</Btn>
          {openAlerts.length > 0 && (
            confirmClear
              ? <Btn size="sm" color="#B45309" onClick={() => { setConfirmClear(false); onAct(openAlerts, "done"); }} loading={groupBusy}>Mark all {openAlerts.length} done?</Btn>
              : <Btn size="sm" variant="outline" onClick={() => setConfirmClear(true)} loading={groupBusy} title="Mark every open alert for this brand as done">Done, chased</Btn>
          )}
        </div>
      </div>
      {g.alerts.map((a, i) => (
        <AlertLine key={a.key} alert={a} theme={theme} isLast={i === g.alerts.length - 1} busy={isBusy(a)} onAct={onAct} onNudge={onNudge} />
      ))}
    </Card>
  );
}

function AlertLine({ alert: a, theme, isLast, busy, onAct, onNudge, showBrand = false }) {
  const sev = SEVERITY[a.severity] || SEVERITY.info;
  const when = age(a.since);
  const stale = when && when.days > 30;
  const d = a.dismissed;
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 16px", borderBottom: isLast ? "none" : `1px solid ${theme.border}`, opacity: d ? 0.55 : 1 }}>
      <span title={sev.label} style={{ width: 8, height: 8, borderRadius: "50%", background: sev.color, flexShrink: 0, marginTop: 6 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>{a.title}</span>
          {showBrand && a.brand && <BrandLink userId={a.brand.user_id} style={{ fontSize: 13, color: theme.textMid }}>{a.brand.store_name || a.brand.email}</BrandLink>}
          {a.campaign && (
            <Link to={`/ops/campaigns?search=${encodeURIComponent(a.campaign.title)}`} title="Open in Campaign Operations" style={{ fontSize: 12, color: theme.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 360, textDecoration: "underline dotted", textUnderlineOffset: 3 }}>{a.campaign.title}</Link>
          )}
          {when && <span style={{ fontSize: 12, fontWeight: 600, color: stale ? sev.color : theme.textMid }} title={friendlyDate(a.since)}>· {when.text}</span>}
        </div>
        <div style={{ fontSize: 12, color: theme.textMid, marginTop: 3, lineHeight: 1.45 }}>{a.detail}</div>
        {a.action && !d && <div style={{ fontSize: 12, color: theme.text, marginTop: 3, lineHeight: 1.45 }}><span style={{ fontWeight: 600 }}>What to do:</span> {a.action}</div>}
        {a.nudge && <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 3 }}>Nudged {friendlyDate(a.nudge.at)}{a.nudge.by ? ` by ${a.nudge.by}` : ""}</div>}
        {d && <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 3 }}>{d.mode === "snoozed" ? `Snoozed until ${friendlyDate(d.until)}` : `Marked done ${friendlyDate(d.at)}`}{d.by ? ` by ${d.by}` : ""}</div>}
      </div>
      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
        {d ? (
          <Btn size="sm" variant="outline" onClick={() => onAct(a, "restore")} loading={busy}>Reopen</Btn>
        ) : (
          <>
            {a.brand?.email && onNudge && (
              <Btn size="sm" variant="outline" onClick={() => onNudge(a)} disabled={busy}
                title={a.nudge ? `Already nudged ${friendlyDate(a.nudge.at)} — write another` : "Write and send the chase email to this brand"}>
                {a.nudge ? "Nudge again" : "Send nudge"}
              </Btn>
            )}
            <Btn size="sm" variant="outline" onClick={() => onAct(a, "snooze")} loading={busy} title="Hide for 7 days for everyone">Snooze 7d</Btn>
            <Btn size="sm" onClick={() => onAct(a, "done")} loading={busy} title="Hide until the situation changes">Done</Btn>
          </>
        )}
      </div>
    </div>
  );
}
