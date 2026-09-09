// Which alert kinds are allowed to chase a brand without an operator.
//
// Everything starts off. An unanswered sample request and an unanswered
// application are clocks running down while a creator loses interest, so they
// are the ones worth automating; anything touching money, a trial or an
// account is not offered here at all.

import { useEffect, useState } from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { api, friendlyDate } from "../../lib/api";
import { Card } from "../ui/Card";
import { Btn } from "../ui/Button";

const COPY = {
  shipping: "Samples accepted but never sent, and sample requests left unanswered.",
  applications: "Creator applications the brand has not accepted or rejected.",
  sales: "Samples shipped a month ago with no sale attributed yet.",
};

export default function AutoNudgeSettings({ onClose }) {
  const { theme } = useTheme();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    let alive = true;
    api.getNudgeRules()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, []);

  const toggle = async (rule) => {
    setBusy(rule.kind); setError("");
    try { setData(await api.setNudgeRule(rule.kind, !rule.auto, rule.min_age_hours)); }
    catch (e) { setError(e.message); }
    finally { setBusy(null); }
  };

  const on = (data?.rules || []).filter((r) => r.auto);

  return (
    <Card style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>Chase these automatically</div>
          <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 2, maxWidth: 640 }}>
            {data
              ? `A brand is written to at most once every ${data.limits.quietDays} days, at most ${data.limits.brandsPerRun} brands a run, and only after an alert has been open long enough for someone to get there first.`
              : "Loading…"}
          </div>
        </div>
        {onClose && <Btn size="sm" variant="outline" onClick={onClose}>Close</Btn>}
      </div>

      {error && <div style={{ fontSize: 13, color: theme.danger, marginBottom: 10 }}>{error}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {(data?.rules || []).map((r) => (
          <div key={r.kind} style={{
            display: "flex", alignItems: "center", gap: 12, padding: "10px 12px",
            borderRadius: 8, border: `1px solid ${r.auto ? theme.brand : theme.border}`,
            background: r.auto ? theme.accentLight : "transparent",
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, textTransform: "capitalize" }}>{r.kind}</div>
              <div style={{ fontSize: 12, color: theme.textMid, marginTop: 2 }}>{COPY[r.kind]}</div>
              <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 3 }}>
                {r.auto
                  ? `On — chases once an alert is ${r.min_age_hours}h old${r.updated_by ? `, switched on by ${r.updated_by}` : ""}${r.updated ? ` ${friendlyDate(r.updated)}` : ""}`
                  : "Off — these are only sent when someone presses the button"}
              </div>
            </div>
            <Btn size="sm" variant={r.auto ? "solid" : "outline"} loading={busy === r.kind} onClick={() => toggle(r)}>
              {r.auto ? "On" : "Off"}
            </Btn>
          </div>
        ))}
      </div>

      {data && on.length > 0 && (
        <div style={{ fontSize: 12, color: theme.textMid, marginTop: 12, padding: "8px 11px", borderRadius: 8, background: "#FEF3C7", border: "1px solid #FDE68A" }}>
          <b>{on.length === 1 ? `${on[0].kind} alerts` : `${on.length} kinds`}</b> will email brands without anyone reading the message first.
          Everything sent is logged on the alert and shows who — or what — sent it.
        </div>
      )}
    </Card>
  );
}
