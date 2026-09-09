// Brand health: one score per brand, and the two lists it makes possible.
//
// The activation funnel on Home shows where brands drop off in aggregate. It
// has never named the brand that is sliding. These are lists of names an
// operator can work down.

import { useEffect, useMemo, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { useDbTarget } from "../contexts/DbTargetContext";
import { api, friendlyDate } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { SkeletonStatGrid, SkeletonListRows } from "../components/ui/Skeleton";
import { BrandLink } from "../components/brand/BrandLink";
import { useBrandDrawer } from "../contexts/BrandDrawerContext";

const BANDS = {
  healthy: { label: "Healthy", color: "#059669", bg: "#D1FAE5" },
  watch: { label: "Watch", color: "#B45309", bg: "#FEF3C7" },
  "at risk": { label: "At risk", color: "#DC2626", bg: "#FEE2E2" },
};

function ScoreDial({ score, band, theme }) {
  const b = BANDS[band] || BANDS.watch;
  return (
    <div style={{ flexShrink: 0, width: 46, textAlign: "center" }}>
      <div style={{ fontSize: 19, fontWeight: 700, color: b.color, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{score}</div>
      <div style={{ height: 3, borderRadius: 2, background: theme.surfaceAlt, marginTop: 5, overflow: "hidden" }}>
        <div style={{ width: `${score}%`, height: "100%", background: b.color }} />
      </div>
    </div>
  );
}

function BrandRow({ b, theme, isLast, onOpen, showTrial }) {
  const band = BANDS[b.band] || BANDS.watch;
  const lines = showTrial ? b.reasons : b.risks.length ? b.risks : b.reasons;
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "12px 16px", borderBottom: isLast ? "none" : `1px solid ${theme.border}` }}>
      <ScoreDial score={b.score} band={b.band} theme={theme} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <BrandLink userId={b.user_id} style={{ fontSize: 13, fontWeight: 600, color: theme.text, textDecoration: "none" }}>
            {b.store_name || b.email}
          </BrandLink>
          <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: band.color, background: band.bg, borderRadius: 4, padding: "1px 5px" }}>{band.label}</span>
          {b.delta != null && b.delta !== 0 && (
            <span style={{ fontSize: 11, fontWeight: 600, color: b.delta < 0 ? "#DC2626" : "#059669" }}>
              {b.delta > 0 ? "▲" : "▼"} {Math.abs(b.delta)} since yesterday
            </span>
          )}
          {showTrial && b.trial_ends && (
            <span style={{ fontSize: 11, color: theme.textMuted }}>trial ends {friendlyDate(b.trial_ends)}</span>
          )}
          {b.sub_status === "FROZEN" && (
            <span style={{ fontSize: 11, fontWeight: 600, color: "#DC2626" }}>payment failed</span>
          )}
        </div>
        <div style={{ fontSize: 12, color: theme.textMid, marginTop: 3, lineHeight: 1.5 }}>
          {lines.length ? lines.join(" · ") : "Nothing recorded either way."}
        </div>
      </div>
      <Btn size="sm" variant="outline" onClick={() => onOpen(b.user_id)}>Brand 360</Btn>
    </div>
  );
}

export default function HealthPage() {
  const { theme } = useTheme();
  const { target } = useDbTarget();
  const { openBrand } = useBrandDrawer();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [view, setView] = useState("churn");

  useEffect(() => {
    let alive = true;
    api.getBrandHealth({ limit: 50 })
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [target]);

  const t = data?.totals;
  const rows = useMemo(() => (view === "churn" ? data?.churnRadar : data?.trialRanking) || [], [data, view]);

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: theme.text, margin: 0 }}>Brand health</h1>
        <p style={{ fontSize: 13, color: theme.textMuted, margin: "4px 0 0", maxWidth: 760 }}>
          Every brand scored out of 100 on whether they log in, launched a campaign, got creators,
          shipped what they accepted, and sold anything. The <b>churn radar</b> is your paying base,
          worst first; the <b>trial ranking</b> puts the trials most likely to convert at the top so
          limited hours go to the right ten.
        </p>
      </div>

      {error && <Card><div style={{ color: theme.danger, fontSize: 13 }}>{error}</div></Card>}

      {!data && !error ? <SkeletonStatGrid count={4} minWidth={170} variant="kpi" style={{ marginBottom: 16 }} /> : t ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 16 }}>
          {[["healthy", t.bands.healthy], ["watch", t.bands.watch], ["at risk", t.bands["at risk"]]].map(([k, n]) => (
            <div key={k} style={{ padding: "14px 16px", borderRadius: 12, background: theme.surface, border: `1px solid ${theme.border}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textMuted }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: BANDS[k].color }} />{BANDS[k].label}
              </div>
              <div style={{ fontSize: 24, fontWeight: 700, color: n ? BANDS[k].color : theme.textMuted, marginTop: 6 }}>{n}</div>
              <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 2 }}>of {t.brands} brands</div>
            </div>
          ))}
          <div style={{ padding: "14px 16px", borderRadius: 12, background: theme.surface, border: `1px solid ${theme.border}` }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textMuted }}>Average score</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: theme.text, marginTop: 6 }}>{t.averageScore}</div>
            <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 2 }}>{t.paying} paying · {t.inTrial} in trial</div>
          </div>
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 2, padding: 2, borderRadius: 999, background: theme.surfaceAlt, width: "fit-content", marginBottom: 12 }}>
        {[["churn", `Churn radar${t ? ` (${t.paying})` : ""}`], ["trials", `Trial ranking${t ? ` (${t.inTrial})` : ""}`]].map(([k, label]) => (
          <button key={k} onClick={() => setView(k)} style={{
            height: 28, padding: "0 14px", borderRadius: 999, fontSize: 12, fontWeight: 500,
            cursor: "pointer", fontFamily: "inherit", border: "none",
            background: view === k ? theme.surface : "transparent",
            color: view === k ? theme.text : theme.textMuted,
            boxShadow: view === k ? theme.shadow : "none",
          }}>{label}</button>
        ))}
      </div>

      {data && !t?.hasTrend && (
        <Card style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: theme.textMid }}>
            Today is the first snapshot, so there is no direction to show yet. From tomorrow each
            brand carries the change since the day before — a falling score is the signal, not the level.
          </div>
        </Card>
      )}

      {!data && !error ? (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <SkeletonListRows rows={4} padding="12px 16px" lines={[["40%", 13], ["65%", 12]]} action={{ width: 90, height: 26 }} />
        </Card>
      ) : rows.length === 0 ? (
        <Card><div style={{ padding: 16, textAlign: "center", color: theme.textMuted, fontSize: 13 }}>
          {view === "churn" ? "No paying brands to watch." : "No brands are in a trial right now."}
        </div></Card>
      ) : (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          {rows.map((b, i) => (
            <BrandRow key={b.user_id} b={b} theme={theme} isLast={i === rows.length - 1}
              onOpen={openBrand} showTrial={view === "trials"} />
          ))}
        </Card>
      )}
    </div>
  );
}
