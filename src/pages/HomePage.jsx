import { useState, useEffect } from "react";
import { api } from "../lib/api";
import { useTheme } from "../contexts/ThemeContext";
import { useDbTarget } from "../contexts/DbTargetContext";

// ── formatters ──────────────────────────────────────────────────────────────
const money = (n, { cents } = {}) =>
  "$" +
  Number(n || 0).toLocaleString("en-US", {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });
const num = (n) => Number(n || 0).toLocaleString("en-US");
const pct = (part, base) => (base > 0 ? Math.round((part / base) * 100) : 0);

const GREEN = "#10B981";
const AMBER = "#F59E0B";
const BLUE = "#3B82F6";
const RED = "#EF4444";

export default function HomePage() {
  const { theme } = useTheme();
  const { target } = useDbTarget();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .getHome()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [target]);

  // ── small building blocks ──────────────────────────────────────────────────
  const Section = ({ title, hint, children }) => (
    <div style={{ marginBottom: 34 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
        <h2 style={{ fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, color: theme.textMid, margin: 0 }}>
          {title}
        </h2>
        {hint && <span style={{ fontSize: 12, color: theme.textMuted }}>{hint}</span>}
      </div>
      {children}
    </div>
  );

  const Card = ({ children, span = 1, pad = 18 }) => (
    <div
      style={{
        gridColumn: `span ${span}`,
        background: theme.surface,
        border: `1px solid ${theme.border}`,
        borderRadius: 12,
        padding: pad,
        minWidth: 0,
      }}
    >
      {children}
    </div>
  );

  const Stat = ({ label, value, sub, accent, big, span = 1 }) => (
    <Card span={span}>
      <div style={{ fontSize: 12, color: theme.textMuted, fontWeight: 500, marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: big ? 32 : 24, fontWeight: 700, color: accent || theme.text, lineHeight: 1.1, letterSpacing: -0.5 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 6 }}>{sub}</div>}
    </Card>
  );

  const grid = (cols) => ({
    display: "grid",
    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
    gap: 14,
  });

  if (loading) {
    return (
      <div style={{ maxWidth: 1120 }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: theme.text, marginBottom: 24 }}>Home</div>
        <div style={grid(4)}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              style={{
                height: 96,
                borderRadius: 12,
                background: `linear-gradient(90deg, ${theme.surfaceAlt} 0%, ${theme.surface} 50%, ${theme.surfaceAlt} 100%)`,
                backgroundSize: "200% 100%",
                animation: "skeletonShimmer 1.2s ease-in-out infinite",
              }}
            />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ maxWidth: 1120 }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: theme.text, marginBottom: 12 }}>Home</div>
        <div style={{ padding: 16, borderRadius: 10, border: `1px solid ${RED}`, color: RED, fontSize: 13 }}>
          Failed to load metrics: {error}
        </div>
      </div>
    );
  }

  const { revenue, funnel, marketplace, subscriptions, brands } = data;
  const maxTierMrr = Math.max(1, ...revenue.byTier.map((t) => t.mrr));

  // Funnel stages, each as a share of the top (signed-up) plus step conversion.
  const stages = [
    { label: "Signed up", value: funnel.signedUp, color: theme.text },
    { label: "Launched a campaign", value: funnel.launchedCampaign, color: BLUE },
    { label: "Got a creator", value: funnel.gotCreator, color: AMBER },
    { label: "Generated a sale", value: funnel.gotSale, color: GREEN },
  ];

  const momentumDelta = brands.newThisMonth - brands.newLastMonth;

  return (
    <div style={{ maxWidth: 1120 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 24 }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: theme.text }}>Home</div>
        <div style={{ fontSize: 12, color: theme.textMuted }}>
          Live metrics · <span style={{ textTransform: "uppercase", fontWeight: 600 }}>{target}</span>
        </div>
      </div>

      {/* ── Recurring revenue ─────────────────────────────────────────────── */}
      <Section title="Recurring revenue" hint="from active paid subscriptions (trials excluded)">
        <div style={grid(4)}>
          <Stat label="MRR" value={money(revenue.mrr)} accent={GREEN} big sub={`${num(revenue.payingBrands)} paying brand${revenue.payingBrands === 1 ? "" : "s"}`} />
          <Stat label="ARR" value={money(revenue.arr)} big sub="MRR × 12" />
          <Stat label="ARPA" value={money(revenue.arpa, { cents: true })} sub="avg revenue / paying brand" />
          <Stat
            label="Trial pipeline"
            value={money(revenue.pipelineMrr)}
            accent={AMBER}
            sub={`${num(revenue.pipelineBrands)} brand${revenue.pipelineBrands === 1 ? "" : "s"} in trial → future MRR`}
          />
        </div>

        {revenue.byTier.length > 0 && (
          <Card pad={18}>
            <div style={{ fontSize: 12, color: theme.textMuted, fontWeight: 500, marginBottom: 14 }}>MRR by plan</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {revenue.byTier.map((t) => (
                <div key={t.tier} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 64, fontSize: 13, fontWeight: 600, color: theme.text }}>{t.tier}</div>
                  <div style={{ flex: 1, height: 10, background: theme.surfaceAlt, borderRadius: 6, overflow: "hidden" }}>
                    <div style={{ width: `${(t.mrr / maxTierMrr) * 100}%`, height: "100%", background: GREEN, borderRadius: 6 }} />
                  </div>
                  <div style={{ width: 150, textAlign: "right", fontSize: 13, color: theme.textMid }}>
                    <span style={{ fontWeight: 600, color: theme.text }}>{money(t.mrr)}</span> · {num(t.brands)} brand{t.brands === 1 ? "" : "s"}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </Section>

      {/* ── Brand activation funnel ───────────────────────────────────────── */}
      <Section title="Brand activation funnel" hint="where brands drop off on the way to their first sale">
        <Card pad={20}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {stages.map((s, i) => {
              const share = pct(s.value, stages[0].value);
              const stepConv = i === 0 ? null : pct(s.value, stages[i - 1].value);
              return (
                <div key={s.label}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                    <span style={{ fontSize: 13, color: theme.text, fontWeight: 500 }}>{s.label}</span>
                    <span style={{ fontSize: 13, color: theme.textMid }}>
                      <span style={{ fontWeight: 700, color: theme.text }}>{num(s.value)}</span>
                      <span style={{ color: theme.textMuted }}> · {share}%</span>
                      {stepConv !== null && (
                        <span style={{ color: theme.textMuted, fontSize: 11 }}> ({stepConv}% of prev)</span>
                      )}
                    </span>
                  </div>
                  <div style={{ height: 12, background: theme.surfaceAlt, borderRadius: 6, overflow: "hidden" }}>
                    <div style={{ width: `${Math.max(share, s.value > 0 ? 2 : 0)}%`, height: "100%", background: s.color, borderRadius: 6, transition: "width 0.3s" }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </Section>

      {/* ── Marketplace ───────────────────────────────────────────────────── */}
      <Section title="Marketplace" hint="the two-sided activity brands and creators generate">
        <div style={grid(4)}>
          <Stat label="Creators" value={num(marketplace.creatorsTotal)} sub={`${num(marketplace.creatorsActive)} active (accepted a campaign)`} />
          <Stat label="Active campaigns" value={num(marketplace.activeCampaigns)} />
          <Stat label="GMV" value={money(marketplace.gmv)} sub={`${num(marketplace.orders)} order${marketplace.orders === 1 ? "" : "s"} attributed`} />
          <Stat label="Commission earned" value={money(marketplace.commissionPaid, { cents: true })} sub={`${num(marketplace.clicks)} link clicks`} />
        </div>
      </Section>

      {/* ── Subscription & trial health ───────────────────────────────────── */}
      <Section title="Subscription & trial health" hint="how the active brand base breaks down today">
        <div style={grid(4)}>
          <Stat label="Paying" value={num(subscriptions.paying)} accent={GREEN} />
          <Stat label="In free trial" value={num(subscriptions.inTrial)} accent={AMBER} sub="on a plan, not yet billed" />
          <Stat label="Linkable extended trials" value={num(subscriptions.extendedTrialActive)} accent={BLUE} sub="admin-granted, active" />
          <Stat label="No plan yet" value={num(subscriptions.noPaidPlan)} sub="signed up, not subscribed" />
        </div>
        <div style={{ marginTop: 14 }}>
          <Stat
            label="New brands this month"
            value={num(brands.newThisMonth)}
            span={1}
            sub={
              momentumDelta === 0
                ? `same as last month (${num(brands.newLastMonth)})`
                : `${momentumDelta > 0 ? "▲" : "▼"} ${num(Math.abs(momentumDelta))} vs last month (${num(brands.newLastMonth)})`
            }
            accent={momentumDelta < 0 ? RED : momentumDelta > 0 ? GREEN : undefined}
          />
        </div>
      </Section>
    </div>
  );
}
