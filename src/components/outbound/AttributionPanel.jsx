// What outbound produced, next to what it sent.
//
// Reply rate is where the old numbers stopped, so every choice about templates,
// senders and segments was a comparison of conversations. This shows the rest
// of the funnel — contacted, signed up, paying, MRR — and splits it by the
// things you can actually change.

import { useCallback, useEffect, useState } from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { api, friendlyDate } from "../../lib/api";
import { Card } from "../ui/Card";
import { Btn } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";

const SPLITS = [
  ["byGroup", "Segment"],
  ["bySender", "Sender"],
  ["byTemplate", "Template"],
];

export default function AttributionPanel() {
  const { theme } = useTheme();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [split, setSplit] = useState("byGroup");

  const load = useCallback(() => {
    setError("");
    api.getOutboundAttribution().then(setData).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const refresh = async () => {
    setBusy(true); setError("");
    try { await api.refreshOutboundAttribution(); load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const t = data?.totals;
  const rows = (data?.[split] || []).filter((r) => r.sends > 0).slice(0, 8);

  const stat = (label, value, sub, accent) => (
    <div key={label} style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, color: theme.textMuted, fontWeight: 500 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent || theme.text, marginTop: 3, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 2 }}>{sub}</div>}
    </div>
  );

  return (
    <Card style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>What outbound produced</div>
          <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 2, maxWidth: 620 }}>
            Sends matched to brands that later signed up, on shop domain or contact email.
            A signup only counts when it came after the first email.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {data?.computedAt && <span style={{ fontSize: 11, color: theme.textMuted }}>as of {friendlyDate(data.computedAt)}</span>}
          <Btn size="sm" variant="outline" onClick={refresh} loading={busy}>Recompute</Btn>
        </div>
      </div>

      {error && <div style={{ fontSize: 13, color: theme.danger, marginBottom: 10 }}>{error}</div>}

      {!data && !error ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 16 }}>
          {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} width="70%" height={40} />)}
        </div>
      ) : t ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 16 }}>
            {stat("Emails sent", t.sends.toLocaleString(), `${t.contacted.toLocaleString()} addresses`)}
            {stat("Signed up", t.signups.toLocaleString(),
              t.sends ? `${((t.signups / t.sends) * 100).toFixed(2)}% of sends` : null,
              t.signups ? theme.brand : theme.textMuted)}
            {stat("Paying", t.paying.toLocaleString(), "became customers", t.paying ? theme.brand : theme.textMuted)}
            {stat("MRR won", `$${t.mrr.toLocaleString()}`, "from attributed brands", t.mrr ? theme.brand : theme.textMuted)}
            {stat("Already customers", t.preExisting.toLocaleString(), "signed up before we wrote")}
          </div>

          {t.signups === 0 && (
            <div style={{ marginTop: 14, padding: "10px 12px", borderRadius: 8, background: theme.surfaceAlt, fontSize: 12, color: theme.textMid, lineHeight: 1.5 }}>
              No brand we have emailed has signed up yet. That is a measured zero, not a gap in the
              data: the {t.contacted.toLocaleString()} addresses contacted share no shop domain with
              any brand in the app.
            </div>
          )}

          <div style={{ marginTop: 16, borderTop: `1px solid ${theme.border}`, paddingTop: 12 }}>
            <div style={{ display: "flex", gap: 2, padding: 2, borderRadius: 999, background: theme.surfaceAlt, width: "fit-content", marginBottom: 10 }}>
              {SPLITS.map(([key, label]) => (
                <button key={key} onClick={() => setSplit(key)} style={{
                  height: 26, padding: "0 12px", borderRadius: 999, fontSize: 12, fontWeight: 500,
                  cursor: "pointer", fontFamily: "inherit", border: "none",
                  background: split === key ? theme.surface : "transparent",
                  color: split === key ? theme.text : theme.textMuted,
                  boxShadow: split === key ? theme.shadow : "none",
                }}>{label}</button>
              ))}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", minWidth: 420, borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ color: theme.textMuted }}>
                    {["", "Sends", "Signups", "Rate", "Paying", "MRR"].map((h, i) => (
                      <th key={h || i} style={{ textAlign: i === 0 ? "left" : "right", padding: "4px 8px", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} style={{ borderTop: `1px solid ${theme.border}` }}>
                      <td style={{ padding: "6px 8px", color: theme.text, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.key}</td>
                      {[r.sends.toLocaleString(), r.signups, `${r.signupRate}%`, r.paying, `$${r.mrr}`].map((v, i) => (
                        <td key={i} style={{ padding: "6px 8px", textAlign: "right", color: theme.textMid, fontVariantNumeric: "tabular-nums" }}>{v}</td>
                      ))}
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td colSpan={6} style={{ padding: 12, textAlign: "center", color: theme.textMuted }}>Nothing sent under this split yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}
    </Card>
  );
}
