import { useState, useEffect } from "react";
import { api } from "../lib/api";
import { useTheme } from "../contexts/ThemeContext";
import { useDbTarget } from "../contexts/DbTargetContext";
import { Skeleton, SkeletonStat, SkeletonBars, SkeletonListRows } from "../components/ui/Skeleton";
import { Sparkline } from "../components/ui/Sparkline";
import { deltaLabel } from "../lib/delta";
import { AlertRow } from "../components/alerts/AlertRow";
import { isSnoozed } from "../lib/alerts";
import { Link } from "react-router-dom";

const RANGES = [["30d", "30 days"], ["90d", "90 days"], ["12m", "12 months"], ["all", "All time"]];

// ── formatters ──────────────────────────────────────────────────────────────
const money = (n, { cents, currency = "USD" } = {}) => {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 }).format(Number(n || 0));
  } catch {
    return `${currency} ${Number(n || 0).toLocaleString("en-US")}`;
  }
};
const num = (n) => Number(n || 0).toLocaleString("en-US");
const pct = (part, base) => (base > 0 ? Math.round((part / base) * 100) : 0);

const GREEN = "#10B981";
const AMBER = "#F59E0B";
const BLUE = "#3B82F6";
const RED = "#EF4444";
const ROSE = "#E11D48";

// ── small building blocks (module level so they are stable between renders) ──
function Section({ title, hint, children }) {
  const { theme } = useTheme();
  return (
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
}

function Card({ children, span = 3, pad = 18, style }) {
  const { theme } = useTheme();
  return (
    <div
      className={`lk-c${span}`}
      style={{
        background: theme.surface,
        border: `1px solid ${theme.border}`,
        borderRadius: 12,
        padding: pad,
        minWidth: 0,
        boxSizing: "border-box",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// One stat card. All values share the same size so the eye compares them
// evenly; `spark` draws the trend for the selected range and `delta` the change
// against the previous period.
function Stat({ label, value, sub, accent, span = 3, spark, delta }) {
  const { theme } = useTheme();
  const deltaColor = delta?.dir > 0 ? GREEN : delta?.dir < 0 ? RED : theme.textMuted;
  return (
    <Card span={span}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, color: theme.textMuted, fontWeight: 500, marginBottom: 8 }}>{label}</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: accent || theme.text, lineHeight: 1.1, letterSpacing: -0.5, overflowWrap: "anywhere" }}>
            {value}
          </div>
          {sub && <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 6 }}>{sub}</div>}
        </div>
        {spark && spark.length > 1 && (
          <div style={{ alignSelf: "flex-end", flexShrink: 0 }} title="Trend over the selected range">
            <Sparkline data={spark} color={accent || theme.brand} width={span <= 2 ? 64 : 92} height={30} />
          </div>
        )}
      </div>
      {delta && <div style={{ fontSize: 11, color: deltaColor, marginTop: 8, fontWeight: 500 }}>{delta.text}</div>}
    </Card>
  );
}

export default function HomePage() {
  const { theme } = useTheme();
  const { target } = useDbTarget();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  // Time travel: sparklines + deltas for the chosen range (the headline figures are always "now").
  const [range, setRange] = useState(() => { try { return localStorage.getItem("lk-home-range") || "90d"; } catch { return "90d"; } });
  // Cached per target+range so switching back is instant and no state is reset inside effects.
  const [seriesCache, setSeriesCache] = useState({});
  const [alertsCache, setAlertsCache] = useState({});
  const seriesKey = `${target}:${range}`;
  const series = seriesCache[seriesKey] || null;
  const alerts = alertsCache[target] || null;
  useEffect(() => {
    let alive = true;
    api.getHomeSeries(range)
      .then((s) => alive && setSeriesCache((c) => ({ ...c, [seriesKey]: s })))
      .catch(() => alive && setSeriesCache((c) => ({ ...c, [seriesKey]: { buckets: [], totals: {} } })));
    return () => { alive = false; };
  }, [range, target, seriesKey]);
  useEffect(() => {
    let alive = true;
    api.getAlerts()
      .then((d) => alive && setAlertsCache((c) => ({ ...c, [target]: (d.alerts || []).filter((a) => !isSnoozed(a.key)) })))
      .catch(() => alive && setAlertsCache((c) => ({ ...c, [target]: [] })));
    return () => { alive = false; };
  }, [target]);
  const pickRange = (r) => { setRange(r); try { localStorage.setItem("lk-home-range", r); } catch { /* ignore */ } };
  const spark = (key) => series?.buckets?.map((b) => b[key]);
  const delta = (key) => series?.totals?.current ? deltaLabel(series.totals.current[key], series.totals.previous?.[key], series.previousLabel) : null;

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

  if (loading) {
    return (
      <div>
        <div style={{ fontSize: 22, fontWeight: 700, color: theme.text, marginBottom: 24 }}>Home</div>
        {/* Same sections, grids and card shapes as the loaded page. */}
        <Section title="Recurring revenue" hint="from active paid subscriptions (trials excluded)">
          <div className="lk-grid">
            {[0, 1, 2, 3].map((i) => <div key={i} className="lk-c3"><SkeletonStat variant="stat" seed={i} /></div>)}
            <Card pad={18} span={12}>
              <Skeleton width={80} height={12} />
              <div style={{ height: 14 }} />
              <SkeletonBars rows={2} labelWidth={64} valueWidth={150} barHeight={10} gap={12} />
            </Card>
          </div>
        </Section>
        <Section title="Brand activation funnel" hint="where brands drop off on the way to their first sale">
          <Card pad={20}>
            <SkeletonBars rows={4} labelWidth={150} valueWidth={110} barHeight={12} gap={14} />
          </Card>
        </Section>
        <Section title="Marketplace" hint="the two-sided activity brands and creators generate">
          <div className="lk-grid">
            {[0, 1, 2, 3].map((i) => <div key={i} className="lk-c3"><SkeletonStat variant="stat" seed={i + 4} sub={i !== 1} /></div>)}
          </div>
        </Section>
        <Section title="Subscription & trial health" hint="how the active brand base breaks down today">
          <div className="lk-grid">
            {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="lk-c2"><SkeletonStat variant="stat" seed={i + 8} sub={i !== 0} /></div>)}
          </div>
        </Section>
      </div>
    );
  }

  if (error) {
    return (
      <div>
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
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px 12px", marginBottom: 24 }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: theme.text }}>Home</div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 4, padding: 3, borderRadius: 999, background: theme.surfaceAlt }} title="Range for the trend lines and the change vs the previous period">
            {RANGES.map(([k, lbl]) => (
              <button key={k} onClick={() => pickRange(k)} style={{
                height: 26, padding: "0 10px", borderRadius: 999, fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
                border: "none", background: range === k ? theme.surface : "transparent", color: range === k ? theme.text : theme.textMuted,
                boxShadow: range === k ? theme.shadow : "none",
              }}>{lbl}</button>
            ))}
          </div>
          <div style={{ fontSize: 12, color: theme.textMuted }}>
            Live metrics · <span style={{ textTransform: "uppercase", fontWeight: 600 }}>{target}</span>
          </div>
        </div>
      </div>

      {/* ── Needs attention ───────────────────────────────────────────────── */}
      <Section title="Needs attention" hint={alerts ? (alerts.length ? `${alerts.length} alert${alerts.length === 1 ? "" : "s"} across brands and campaigns` : "nothing is blocked right now") : "checking…"}>
        <Card pad={0}>
          {alerts === null && <SkeletonListRows rows={3} padding="10px 14px" lines={[["45%", 13]]} meta={{ width: 80, lines: [[70, 11]] }} lastDivider />}
          {alerts && alerts.length === 0 && <div style={{ padding: "14px 16px", fontSize: 13, color: GREEN }}>All clear: no stuck samples, waiting applications, expiring trials or failed payments.</div>}
          {alerts && alerts.slice(0, 5).map((a, i) => <AlertRow key={a.key} alert={a} theme={theme} compact isLast={i === Math.min(alerts.length, 5) - 1 && alerts.length <= 5} />)}
          {alerts && alerts.length > 5 && (
            <div style={{ padding: "10px 14px", fontSize: 12 }}>
              <Link to="/alerts" style={{ color: theme.textMid }}>View all {alerts.length} alerts →</Link>
            </div>
          )}
        </Card>
      </Section>

      {/* ── Recurring revenue ─────────────────────────────────────────────── */}
      <Section title="Recurring revenue" hint="from active paid subscriptions (trials excluded)">
        <div className="lk-grid">
          <Stat label="MRR" value={money(revenue.mrr)} accent={GREEN} sub={`${num(revenue.payingBrands)} paying brand${revenue.payingBrands === 1 ? "" : "s"}`} spark={series?.mrrApprox ? spark("mrr") : null} delta={series?.mrrApprox && delta("mrr") ? { ...delta("mrr"), text: `${delta("mrr").text} (from subscription records)` } : null} />
          <Stat label="ARR" value={money(revenue.arr)} sub="MRR × 12" spark={series?.mrrApprox ? spark("mrr") : null} />
          <Stat label="ARPA" value={money(revenue.arpa, { cents: true })} sub="avg revenue / paying brand" />
          <Stat
            label="Trial pipeline"
            value={money(revenue.pipelineMrr)}
            accent={AMBER}
            sub={`${num(revenue.pipelineBrands)} brand${revenue.pipelineBrands === 1 ? "" : "s"} in trial → future MRR`}
          />
        </div>

        {revenue.byTier.length > 0 && (
          <Card pad={18} style={{ marginTop: 14 }}>
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
        <div className="lk-grid">
          <Stat label="Creators" value={num(marketplace.creatorsTotal)} sub={`${num(marketplace.creatorsActive)} active (accepted a campaign)`} spark={spark("creators")} delta={delta("creators") && { ...delta("creators"), text: `new creators ${delta("creators").text}` }} />
          <Stat label="Active campaigns" value={num(marketplace.activeCampaigns)} spark={spark("campaigns")} delta={delta("campaigns") && { ...delta("campaigns"), text: `launches ${delta("campaigns").text}` }} />
          <Stat label="GMV" value={money(marketplace.gmv, { currency: marketplace.gmvCurrency })} sub={`${num(marketplace.orders)} order${marketplace.orders === 1 ? "" : "s"} attributed`} spark={spark("gmv")} delta={delta("gmv")} />
          <Stat label="Commission earned" value={money(marketplace.commissionPaid, { cents: true, currency: marketplace.gmvCurrency })} sub={`${num(marketplace.clicks)} link clicks`} spark={spark("commission")} delta={delta("clicks") && { ...delta("clicks"), text: `clicks ${delta("clicks").text}` }} />
        </div>
      </Section>

      {/* ── Subscription & trial health ───────────────────────────────────── */}
      <Section title="Subscription & trial health" hint="how the active brand base breaks down today">
        <div className="lk-grid">
          <Stat span={2} label="Paying" value={num(subscriptions.paying)} accent={GREEN} />
          <Stat span={2} label="In free trial" value={num(subscriptions.inTrial)} accent={AMBER} sub="on a plan, not yet billed" />
          <Stat span={2} label="Linkable extended trials" value={num(subscriptions.extendedTrialActive)} accent={BLUE} sub="admin-granted, active" />
          <Stat span={2} label="Cancelled · in grace" value={num(subscriptions.cancelledInGrace)} accent={ROSE} sub="cancelled, trial access ending" />
          <Stat span={2} label="No plan yet" value={num(subscriptions.noPaidPlan)} sub="never subscribed / lapsed" />
          <Stat
            label="New brands this month"
            value={num(brands.newThisMonth)}
            span={2}
            spark={spark("brands")}
            delta={delta("brands") && { ...delta("brands"), text: `signups ${delta("brands").text}` }}
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
