// Switches: whole features of the main app, off or on.
//
// Each row is a feature the app reads from its own database every twenty
// seconds, so a switch here takes effect by itself, with no deploy, on the
// database picked in the header (dev or production). Off never deletes what
// brands and creators saved; on carries on from there.

import { useEffect, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { useDbTarget } from "../contexts/DbTargetContext";
import { api, friendlyDate } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Toggle } from "../components/ui/Toggle";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { SkeletonListRows } from "../components/ui/Skeleton";

export default function SwitchesPage() {
  const { theme } = useTheme();
  const { target } = useDbTarget();
  const { ask, dialog } = useConfirm();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState("");
  const where = target === "dev" ? "dev" : "production";

  useEffect(() => {
    let alive = true;
    setData(null);
    setError("");
    api.getSwitches()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [target]);

  async function flip(s, enabled) {
    const ok = await ask({
      title: `Turn ${s.label} ${enabled ? "on" : "off"} on ${where}?`,
      body: enabled
        ? "It comes back for everyone within half a minute, from where it stopped."
        : `${s.about} It takes effect within half a minute, and you can turn it back on here.`,
      confirmLabel: enabled ? "Turn on" : "Turn off",
      danger: !enabled,
    });
    if (!ok) return;
    setSaving(s.key);
    setError("");
    try {
      const row = await api.setSwitch(s.key, enabled);
      setData((d) => ({ ...d, switches: d.switches.map((x) => (x.key === row.key ? row : x)) }));
    } catch (e) {
      setError(`We couldn't change that: ${e.message}`);
    } finally {
      setSaving("");
    }
  }

  const rows = data?.switches || [];

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: theme.text, margin: 0 }}>Switches</h1>
        <p style={{ fontSize: 13, color: theme.textMuted, margin: "4px 0 0", maxWidth: 760 }}>
          Turn a whole feature of the app off or on. You are changing <b>{where}</b> (pick dev or
          production in the header). A change reaches everyone within half a minute. Nothing is
          deleted when a feature is off, so turning it back on carries on from where it stopped.
        </p>
      </div>

      {error && <Card style={{ marginBottom: 12 }}><div style={{ color: theme.danger, fontSize: 13 }}>{error}</div></Card>}

      {!data && !error ? (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <SkeletonListRows rows={3} padding="14px 16px" lines={[["30%", 13], ["70%", 12]]} action={{ width: 36, height: 20 }} />
        </Card>
      ) : data && rows.length === 0 ? (
        <Card><div style={{ padding: 16, textAlign: "center", color: theme.textMuted, fontSize: 13 }}>
          {data.ready
            ? "No feature has a switch yet."
            : `The app on ${where} doesn't have these features yet, so there is nothing to switch.`}
        </div></Card>
      ) : rows.length > 0 ? (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          {rows.map((s, i) => (
            <div key={s.key} style={{
              display: "flex", gap: 14, alignItems: "flex-start", padding: "14px 16px",
              borderBottom: i === rows.length - 1 ? "none" : `1px solid ${theme.border}`,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>{s.label || s.key}</span>
                  <span style={{
                    fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4,
                    borderRadius: 4, padding: "1px 5px",
                    color: s.enabled ? "#059669" : "#DC2626", background: s.enabled ? "#D1FAE5" : "#FEE2E2",
                  }}>{s.enabled ? "On" : "Off"}</span>
                </div>
                <div style={{ fontSize: 12, color: theme.textMid, marginTop: 3, lineHeight: 1.5 }}>{s.about}</div>
                {s.updated_by && (
                  <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 4 }}>
                    Last changed by {s.updated_by}, {friendlyDate(s.updated)}
                  </div>
                )}
              </div>
              <div style={{ paddingTop: 2 }}>
                <Toggle
                  checked={s.enabled}
                  disabled={saving === s.key}
                  label={`${s.label || s.key}: ${s.enabled ? "on" : "off"}`}
                  onChange={(next) => flip(s, next)}
                />
              </div>
            </div>
          ))}
        </Card>
      ) : null}
      {dialog}
    </div>
  );
}
