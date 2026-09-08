import { useEffect, useMemo, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { useDbTarget } from "../contexts/DbTargetContext";
import { api, friendlyDate } from "../lib/api";
import { Card } from "../components/ui/Card";
import { SkeletonListRows } from "../components/ui/Skeleton";
import { AlertRow } from "../components/alerts/AlertRow";
import { readSnoozes, writeSnoozes, isSnoozed } from "../lib/alerts";

const KINDS = [["all", "All"], ["shipping", "Shipping"], ["applications", "Applications"], ["trials", "Trials"], ["billing", "Billing"], ["sales", "Sales"], ["deletion", "Deletion"]];

export default function AlertsPage() {
  const { theme } = useTheme();
  const { target } = useDbTarget();
  // Results are keyed by DB target, so switching target shows a fresh load
  // without resetting state synchronously inside the effect.
  const [results, setResults] = useState({});
  const [kind, setKind] = useState("all");
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [snoozes, setSnoozes] = useState(readSnoozes);
  const entry = results[target];
  const data = entry?.data || null;
  const error = entry?.error || null;
  const loading = !entry;

  useEffect(() => {
    let alive = true;
    api.getAlerts()
      .then((d) => alive && setResults((r) => ({ ...r, [target]: { data: d } })))
      .catch((e) => alive && setResults((r) => ({ ...r, [target]: { error: e.message } })));
    return () => { alive = false; };
  }, [target]);

  const alerts = useMemo(() => data?.alerts || [], [data]);
  const counts = useMemo(() => {
    const c = { all: 0 };
    for (const a of alerts) { if (isSnoozed(a.key, snoozes)) continue; c.all++; c[a.kind] = (c[a.kind] || 0) + 1; }
    return c;
  }, [alerts, snoozes]);
  const visible = alerts.filter((a) => (kind === "all" || a.kind === kind) && (showSnoozed || !isSnoozed(a.key, snoozes)));
  const snoozedCount = alerts.filter((a) => isSnoozed(a.key, snoozes)).length;

  const snooze = (key, days) => {
    const next = { ...snoozes };
    if (days === 0) delete next[key]; else next[key] = Date.now() + days * 86_400_000;
    setSnoozes(next); writeSnoozes(next);
  };

  return (
    <div style={{ maxWidth: 1100 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: theme.text, margin: 0 }}>Alerts</h1>
          <p style={{ fontSize: 13, color: theme.textMuted, margin: "4px 0 0" }}>
            Brands that need a nudge: samples not shipped, applications left waiting, trials about to end, payments failing.
          </p>
        </div>
        {data && <div style={{ fontSize: 12, color: theme.textMuted }}>checked {friendlyDate(data.generatedAt)}</div>}
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        {KINDS.map(([k, label]) => (
          <button key={k} onClick={() => setKind(k)} style={{
            height: 32, padding: "0 12px", borderRadius: 999, fontSize: 12, fontWeight: 500, cursor: "pointer",
            border: `1px solid ${kind === k ? theme.text : theme.border}`,
            background: kind === k ? theme.text : theme.surface, color: kind === k ? theme.surface : theme.textMid,
          }}>{label}{counts[k] ? ` (${counts[k]})` : ""}</button>
        ))}
        {snoozedCount > 0 && (
          <button onClick={() => setShowSnoozed((v) => !v)} style={{ marginLeft: "auto", background: "none", border: "none", color: theme.textMid, fontSize: 12, cursor: "pointer", textDecoration: "underline", fontFamily: "inherit" }}>
            {showSnoozed ? "Hide" : "Show"} {snoozedCount} snoozed
          </button>
        )}
      </div>

      <Card style={{ padding: 0, overflow: "hidden" }}>
        {error && <div style={{ padding: 16, color: theme.danger, fontSize: 13 }}>Failed to load alerts: {error}</div>}
        {!error && loading && <SkeletonListRows rows={6} lines={[["40%", 14], ["75%", 12]]} meta={{ width: 120, lines: [[80, 11]] }} action={{ width: 70, height: 28 }} lastDivider />}
        {!error && !loading && visible.length === 0 && (
          <div style={{ padding: 32, textAlign: "center", color: theme.textMuted, fontSize: 13 }}>
            {alerts.length === 0 ? "Nothing needs attention right now." : "No alerts in this view."}
          </div>
        )}
        {!error && !loading && visible.map((a, i) => (
          <AlertRow key={a.key} alert={a} theme={theme} isLast={i === visible.length - 1} snoozed={isSnoozed(a.key, snoozes)} onSnooze={snooze} />
        ))}
      </Card>
    </div>
  );
}
