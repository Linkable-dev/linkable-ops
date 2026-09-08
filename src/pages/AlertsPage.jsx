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
import { SEVERITY, readSnoozes, writeSnoozes, isSnoozed } from "../lib/alerts";

const KINDS = [["all", "All"], ["shipping", "Shipping"], ["applications", "Applications"], ["trials", "Trials"], ["billing", "Billing"], ["sales", "Sales"], ["deletion", "Deletion"]];
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
  // Results are keyed by DB target, so switching target shows a fresh load
  // without resetting state synchronously inside the effect.
  const [results, setResults] = useState({});
  const [kind, setKind] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [query, setQuery] = useState("");
  const [view, setView] = useState(() => { try { return localStorage.getItem("lk-alerts-view") || "brand"; } catch { return "brand"; } });
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [snoozes, setSnoozes] = useState(readSnoozes);
  const entry = results[target];
  const data = entry?.data || null;
  const error = entry?.error || null;
  const loading = !entry;

  const load = () => {
    api.getAlerts()
      .then((d) => setResults((r) => ({ ...r, [target]: { data: d } })))
      .catch((e) => setResults((r) => ({ ...r, [target]: { error: e.message } })));
  };
  useEffect(() => {
    let alive = true;
    api.getAlerts()
      .then((d) => alive && setResults((r) => ({ ...r, [target]: { data: d } })))
      .catch((e) => alive && setResults((r) => ({ ...r, [target]: { error: e.message } })));
    return () => { alive = false; };
  }, [target]);

  const alerts = useMemo(() => data?.alerts || [], [data]);
  const live = useMemo(() => alerts.filter((a) => !isSnoozed(a.key, snoozes)), [alerts, snoozes]);
  const snoozedCount = alerts.length - live.length;

  const summary = useMemo(() => {
    const s = { danger: 0, warn: 0, info: 0, brands: new Set() };
    for (const a of live) { s[a.severity] = (s[a.severity] || 0) + 1; if (a.brand?.user_id) s.brands.add(a.brand.user_id); }
    return { ...s, brands: s.brands.size };
  }, [live]);
  const kindCounts = useMemo(() => {
    const c = { all: live.length };
    for (const a of live) c[a.kind] = (c[a.kind] || 0) + 1;
    return c;
  }, [live]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (showSnoozed ? alerts : live).filter((a) =>
      (kind === "all" || a.kind === kind) &&
      (severity === "all" || a.severity === severity) &&
      (!q || [a.title, a.detail, a.brand?.store_name, a.brand?.email, a.campaign?.title].some((s) => String(s || "").toLowerCase().includes(q))),
    );
  }, [alerts, live, showSnoozed, kind, severity, query]);

  // Group by brand, most urgent brand first, then the longest-waiting.
  const groups = useMemo(() => {
    const m = new Map();
    for (const a of visible) {
      const id = a.brand?.user_id || "none";
      if (!m.has(id)) m.set(id, { id, brand: a.brand, alerts: [] });
      m.get(id).alerts.push(a);
    }
    const arr = [...m.values()];
    for (const g of arr) g.alerts.sort((x, y) => SEV_ORDER[x.severity] - SEV_ORDER[y.severity] || new Date(x.since || 0) - new Date(y.since || 0));
    arr.sort((x, y) => SEV_ORDER[x.alerts[0].severity] - SEV_ORDER[y.alerts[0].severity] || y.alerts.length - x.alerts.length);
    return arr;
  }, [visible]);

  const snooze = (keys, days) => {
    const next = { ...snoozes };
    for (const key of [].concat(keys)) { if (days === 0) delete next[key]; else next[key] = Date.now() + days * 86_400_000; }
    setSnoozes(next); writeSnoozes(next);
  };

  const chip = (active, onClick, label, extra) => (
    <button key={label} onClick={onClick} style={{
      height: 30, padding: "0 12px", borderRadius: 999, fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
      border: `1px solid ${active ? theme.text : theme.border}`, background: active ? theme.text : theme.surface, color: active ? theme.surface : theme.textMid,
      display: "inline-flex", alignItems: "center", gap: 6, ...extra,
    }}>{label}</button>
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: theme.text, margin: 0 }}>Alerts</h1>
          <p style={{ fontSize: 13, color: theme.textMuted, margin: "4px 0 0" }}>
            One card per brand, most urgent first. Open the brand to impersonate or grant a trial, or snooze what you have already chased.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {data && <span style={{ fontSize: 12, color: theme.textMuted }}>checked {friendlyDate(data.generatedAt)}</span>}
          <Btn size="sm" variant="outline" onClick={load} disabled={loading}>Refresh</Btn>
        </div>
      </div>

      {/* Summary tiles double as severity filters */}
      {loading ? <SkeletonStatGrid count={4} minWidth={170} variant="kpi" style={{ marginBottom: 16 }} /> : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 16 }}>
          {[["danger", summary.danger], ["warn", summary.warn], ["info", summary.info]].map(([sev, n]) => {
            const s = SEVERITY[sev];
            const active = severity === sev;
            return (
              <button key={sev} onClick={() => setSeverity(active ? "all" : sev)} style={{
                textAlign: "left", padding: "14px 16px", borderRadius: 12, cursor: "pointer", fontFamily: "inherit",
                background: theme.surface, border: `1px solid ${active ? s.color : theme.border}`, boxShadow: active ? `0 0 0 3px ${s.bg}` : "none",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textMuted }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: s.color }} />{s.label}
                </div>
                <div style={{ fontSize: 24, fontWeight: 700, color: n ? s.color : theme.textMuted, marginTop: 6 }}>{n}</div>
                <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 2 }}>{sev === "danger" ? "blocking a sale or a payment" : sev === "warn" ? "will hurt if left another week" : "worth knowing, no rush"}</div>
              </button>
            );
          })}
          <div style={{ padding: "14px 16px", borderRadius: 12, background: theme.surface, border: `1px solid ${theme.border}` }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textMuted }}>Brands to contact</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: theme.text, marginTop: 6 }}>{summary.brands}</div>
            <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 2 }}>{live.length} open alert{live.length === 1 ? "" : "s"}{snoozedCount ? ` · ${snoozedCount} snoozed` : ""}</div>
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
        {snoozedCount > 0 && (
          <button onClick={() => setShowSnoozed((v) => !v)} style={{ background: "none", border: "none", color: theme.textMid, fontSize: 12, cursor: "pointer", textDecoration: "underline", fontFamily: "inherit" }}>
            {showSnoozed ? "Hide snoozed" : `Show ${snoozedCount} snoozed`}
          </button>
        )}
      </div>

      {error && <Card><div style={{ color: theme.danger, fontSize: 13 }}>Failed to load alerts: {error}</div></Card>}
      {!error && loading && (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", borderBottom: `1px solid ${theme.border}`, display: "flex", gap: 12, alignItems: "center" }}><Skeleton width={36} height={36} radius={8} /><Skeleton width={180} height={14} /><Skeleton width={60} height={18} radius={999} /></div>
          <SkeletonListRows rows={3} padding="10px 16px" lines={[["50%", 13]]} meta={{ width: 100, lines: [[80, 11]] }} action={{ width: 60, height: 22 }} />
        </Card>
      )}
      {!error && !loading && visible.length === 0 && (
        <Card><div style={{ padding: 16, textAlign: "center", color: theme.textMuted, fontSize: 13 }}>{live.length === 0 && !showSnoozed ? "Nothing needs attention right now." : "No alerts match these filters."}</div></Card>
      )}

      {!error && !loading && view === "brand" && groups.map((g) => (
        <BrandGroup key={g.id} group={g} theme={theme} snoozes={snoozes} onSnooze={snooze} onOpen={() => g.brand?.user_id && openBrand(g.brand.user_id)} />
      ))}

      {!error && !loading && view === "list" && visible.length > 0 && (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          {[...visible].sort((x, y) => SEV_ORDER[x.severity] - SEV_ORDER[y.severity] || new Date(x.since || 0) - new Date(y.since || 0)).map((a, i, arr) => (
            <AlertLine key={a.key} alert={a} theme={theme} showBrand isLast={i === arr.length - 1} snoozed={isSnoozed(a.key, snoozes)} onSnooze={snooze} />
          ))}
        </Card>
      )}
    </div>
  );
}

function BrandGroup({ group: g, theme, snoozes, onSnooze, onOpen }) {
  const top = g.alerts[0];
  const sev = SEVERITY[top.severity];
  const counts = g.alerts.reduce((a, x) => ({ ...a, [x.severity]: (a[x.severity] || 0) + 1 }), {});
  const name = g.brand?.store_name || g.brand?.email || "Unknown brand";
  const initials = name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  const allSnoozed = g.alerts.every((a) => isSnoozed(a.key, snoozes));
  return (
    <Card style={{ padding: 0, overflow: "hidden", marginBottom: 12, borderLeft: `3px solid ${sev.color}` }}>
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
          </div>
          {g.brand?.email && <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.brand.email}</div>}
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          {g.brand?.email && <Btn size="sm" variant="outline" onClick={() => navigator.clipboard?.writeText(g.brand.email)} title="Copy the brand email to write the nudge">Copy email</Btn>}
          <Btn size="sm" variant="outline" onClick={onOpen}>Brand 360</Btn>
          <Btn size="sm" variant="secondary" onClick={() => onSnooze(g.alerts.map((a) => a.key), allSnoozed ? 0 : 7)} title={allSnoozed ? "Show these again" : "Hide this brand's alerts for 7 days on this browser"}>{allSnoozed ? "Unsnooze" : "Snooze 7d"}</Btn>
        </div>
      </div>
      {g.alerts.map((a, i) => (
        <AlertLine key={a.key} alert={a} theme={theme} isLast={i === g.alerts.length - 1} snoozed={isSnoozed(a.key, snoozes)} onSnooze={onSnooze} />
      ))}
    </Card>
  );
}

function AlertLine({ alert: a, theme, isLast, snoozed, onSnooze, showBrand = false }) {
  const sev = SEVERITY[a.severity] || SEVERITY.info;
  const when = age(a.since);
  const stale = when && when.days > 30;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: isLast ? "none" : `1px solid ${theme.border}`, opacity: snoozed ? 0.5 : 1 }}>
      <span title={sev.label} style={{ width: 8, height: 8, borderRadius: "50%", background: sev.color, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>{a.title}</span>
          {showBrand && a.brand && <BrandLink userId={a.brand.user_id} style={{ fontSize: 13, color: theme.textMid }}>{a.brand.store_name || a.brand.email}</BrandLink>}
          {a.campaign && <span style={{ fontSize: 12, color: theme.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 360 }} title={a.campaign.title}>{a.campaign.title}</span>}
        </div>
        <div style={{ fontSize: 12, color: theme.textMid, marginTop: 2, lineHeight: 1.45 }}>{a.detail}</div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0, minWidth: 150 }}>
        {when && <div style={{ fontSize: 12, fontWeight: 600, color: stale ? sev.color : theme.textMid }} title={friendlyDate(a.since)}>{when.text}</div>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 3 }}>
          {a.campaign && <Link to={`/ops/campaigns?search=${encodeURIComponent(a.campaign.title)}`} style={{ fontSize: 12, color: theme.textMid }}>Campaign</Link>}
          {!a.campaign && a.href && <Link to={a.href} style={{ fontSize: 12, color: theme.textMid }}>Open</Link>}
          {onSnooze && (snoozed
            ? <button onClick={() => onSnooze(a.key, 0)} style={linkBtn(theme)}>Unsnooze</button>
            : <button onClick={() => onSnooze(a.key, 7)} style={linkBtn(theme)} title="Hide for 7 days on this browser">Snooze</button>)}
        </div>
      </div>
    </div>
  );
}
const linkBtn = (theme) => ({ background: "none", border: "none", padding: 0, color: theme.textMuted, fontSize: 12, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" });
