import { useEffect, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api } from "../lib/api";
import { SkeletonStat, SkeletonBars, SkeletonChartCard } from "../components/ui/Skeleton";
import ProviderCosts from "../components/autopilot/ProviderCosts";
import {
  AreaChart, Area, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

// The whole P&L this business actually has two sides of: what came in (MRR —
// recurring, plus commission on creator sales — transactional) against what
// went out to the providers recruiting spends money on. Both sides reuse
// sources that already get this right elsewhere — /analytics/home for
// revenue, /provider-costs and Anthropic's own Cost API for spend — rather
// than recomputing either and risking a quiet drift from the numbers those
// already show.

const RED = "#EF4444";
const GREEN = "#10B981";

const money = (n, { currency = "USD" } = {}) => {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(Number(n || 0));
  } catch {
    return `${currency} ${Number(n || 0).toLocaleString("en-US")}`;
  }
};
const num = (n) => Number(n || 0).toLocaleString("en-US");

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
    <div className={`lk-c${span}`} style={{
      background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 12,
      padding: pad, minWidth: 0, boxSizing: "border-box", ...style,
    }}>
      {children}
    </div>
  );
}

function Stat({ label, value, sub, accent, span = 3, big }) {
  const { theme } = useTheme();
  return (
    <Card span={span}>
      <div style={{ fontSize: 12, color: theme.textMuted, fontWeight: 500, marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: big ? 30 : 22, fontWeight: 700, color: accent || theme.text, lineHeight: 1.1, letterSpacing: -0.5, overflowWrap: "anywhere" }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 6 }}>{sub}</div>}
    </Card>
  );
}

// A provider's own box, whether or not it has a rate yet — the whole point
// is that Influencers.club and Lemlist show up here even unconfigured,
// rather than only appearing once someone has entered a number.
function ProviderBox({ provider, span = 4 }) {
  const { theme } = useTheme();
  if (!provider) return null;
  return (
    <Stat
      span={span}
      label={provider.label}
      value={provider.configured ? money(provider.estimated_cost, { currency: provider.currency }) : "—"}
      accent={provider.configured ? undefined : theme.textMuted}
      sub={`${provider.quantity ?? "0"} ${provider.unit}s this month${provider.configured ? "" : " · rate not set"}`}
    />
  );
}

const CHART_COLORS = { mrr: "#0A0A0A", mrrDark: "#FAFAFA", commission: "#10B981" };

function RevenueTrendChart({ theme, mode, series }) {
  const buckets = series?.buckets || [];
  const hasMrr = !!series?.mrrApprox;
  const tickLabel = (d) => new Date(d).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  const tooltipStyle = { background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 8, boxShadow: theme.shadowMd, fontSize: 12, color: theme.text };
  const mrrColor = mode === "dark" ? CHART_COLORS.mrrDark : CHART_COLORS.mrr;
  if (buckets.length < 2) {
    return <Card pad={16}><p style={{ fontSize: 13, color: theme.textMuted, margin: 0 }}>Not enough history yet.</p></Card>;
  }
  return (
    <Card>
      <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 4 }}>Revenue over time</div>
      <div style={{ fontSize: 11, color: theme.textMuted, marginBottom: 12 }}>
        MRR (recurring, a snapshot as of each month{hasMrr ? "" : " — not available on this database"}) and
        commission earned on creator sales (transactional, summed per month, mixed shop currencies).
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={buckets}>
          <defs>
            <linearGradient id="g-commission" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={CHART_COLORS.commission} stopOpacity={0.25} />
              <stop offset="95%" stopColor={CHART_COLORS.commission} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={theme.border} vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 9, fill: theme.textMuted }} tickLine={false} tickFormatter={tickLabel} />
          <YAxis tick={{ fontSize: 9, fill: theme.textMuted }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${num(v)}`} />
          <Tooltip contentStyle={tooltipStyle} labelFormatter={tickLabel} formatter={(v, name) => [money(v), name]} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {hasMrr && <Area type="monotone" dataKey="mrr" name="MRR" stroke={mrrColor} strokeWidth={2} fill="none" />}
          <Area type="monotone" dataKey="commission" name="Commission" stroke={CHART_COLORS.commission} strokeWidth={2} fill="url(#g-commission)" />
        </AreaChart>
      </ResponsiveContainer>
    </Card>
  );
}

function CostBreakdownChart({ theme, mode, items }) {
  const colors = mode === "dark"
    ? ["#FAFAFA", "#A3A3A3", "#10B981", "#737373"]
    : ["#0A0A0A", "#737373", "#10B981", "#A3A3A3"];
  const tooltipStyle = { background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 8, boxShadow: theme.shadowMd, fontSize: 12, color: theme.text };
  if (items.length === 0) {
    return <Card pad={16}><p style={{ fontSize: 13, color: theme.textMuted, margin: 0 }}>No provider has a cost to show yet — set a rate below, or configure Anthropic's Admin key.</p></Card>;
  }
  return (
    <Card>
      <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 12 }}>This month's costs, by provider</div>
      <ResponsiveContainer width="100%" height={Math.max(120, items.length * 44)}>
        <BarChart data={items} layout="vertical" margin={{ left: 90 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={theme.border} horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 10, fill: theme.textMuted }} tickLine={false} tickFormatter={(v) => `$${num(v)}`} />
          <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: theme.textMid }} tickLine={false} axisLine={false} width={85} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v) => money(v)} />
          <Bar dataKey="value" radius={[0, 4, 4, 0]}>
            {items.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </Card>
  );
}

export default function CostsPage() {
  const { theme, mode } = useTheme();
  const [home, setHome] = useState(null);
  const [costs, setCosts] = useState(null);
  const [economics, setEconomics] = useState(null);
  const [anthropic, setAnthropic] = useState(null);
  const [series, setSeries] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.getHome(), api.getProviderCosts(), api.getSearchEconomics(),
      api.getAnthropicCostByScope(), api.getHomeSeries("12m"),
    ])
      .then(([h, c, e, a, s]) => { if (alive) { setHome(h); setCosts(c); setEconomics(e); setAnthropic(a); setSeries(s); } })
      .catch((err) => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, []);

  const loading = !error && (!home || !costs || !economics || !anthropic || !series);

  if (loading) {
    return (
      <div>
        <div style={{ fontSize: 22, fontWeight: 700, color: theme.text, marginBottom: 24 }}>Costs & margin</div>
        <Section title="This month">
          <div className="lk-grid">
            {[0, 1, 2].map((i) => <div key={i} className="lk-c4"><SkeletonStat variant="stat" seed={i} /></div>)}
          </div>
        </Section>
        <div className="lk-grid" style={{ marginBottom: 20 }}>
          <div className="lk-c6"><SkeletonChartCard height={220} /></div>
          <div className="lk-c6"><SkeletonChartCard height={220} /></div>
        </div>
        <Card pad={20}><SkeletonBars rows={2} labelWidth={150} valueWidth={110} barHeight={12} gap={14} /></Card>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <div style={{ fontSize: 22, fontWeight: 700, color: theme.text, marginBottom: 12 }}>Costs & margin</div>
        <div style={{ padding: 16, borderRadius: 10, border: `1px solid ${RED}`, color: RED, fontSize: 13 }}>
          Failed to load: {error}
        </div>
      </div>
    );
  }

  const mrr = home.revenue?.mrr ?? 0;
  const payingBrands = home.revenue?.payingBrands ?? 0;
  // Summed across each order's own shop currency, uncoverted — the same
  // approximation Home already makes for GMV. Not a true single total when
  // brands sell in more than one currency, but it's the real figure, not an
  // invented one, and it is the actual money the marketplace side earned.
  const commission = home.marketplace?.commissionPaid ?? 0;
  const gmvCurrency = home.marketplace?.gmvCurrency || "USD";
  const totalRevenue = mrr + commission;

  const providers = costs.providers || [];
  const influencersClub = providers.find((p) => p.provider === "influencers_club");
  const lemlist = providers.find((p) => p.provider === "lemlist");
  // Only USD, only configured: an unconfigured provider has no honest cost to
  // net out, and a rate in another currency can't be summed with USD revenue
  // without a conversion this page does not have.
  const usdCosted = providers.filter((p) => p.configured && (p.currency || "USD").toUpperCase() === "USD");
  const otherCurrency = providers.filter((p) => p.configured && (p.currency || "USD").toUpperCase() !== "USD");
  const uncosted = providers.filter((p) => !p.configured);
  const anthropicScopes = anthropic.scopes || [];
  const anthropicCost = anthropic.available ? anthropicScopes.reduce((sum, s) => sum + Number(s.amount || 0), 0) : 0;
  const totalCost = usdCosted.reduce((sum, p) => sum + Number(p.estimated_cost || 0), 0) + anthropicCost;
  const margin = totalRevenue - totalCost;
  const marginPct = totalRevenue > 0 ? Math.round((margin / totalRevenue) * 1000) / 10 : null;

  const costChartItems = [
    ...usdCosted.map((p) => ({ name: p.label, value: Number(p.estimated_cost || 0) })),
    ...(anthropicCost > 0 ? [{ name: "Anthropic", value: anthropicCost }] : []),
  ];

  const costsSub = [
    usdCosted.length > 0 ? usdCosted.map((p) => p.label).join(", ") : null,
    anthropic.available ? "Anthropic" : null,
    otherCurrency.length > 0 ? `+ ${otherCurrency.map((p) => `${p.label} (${p.currency})`).join(", ")} not in USD` : null,
  ].filter(Boolean).join(", ") || "no cost source configured yet";

  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 700, color: theme.text, marginBottom: 24 }}>Costs & margin</div>

      <Section title="This month" hint="every revenue and cost source this page knows about — not a full P&L (no hosting, infrastructure or payroll)">
        <div className="lk-grid" style={{ marginBottom: 12 }}>
          <Stat big span={4} label="Total revenue" value={money(totalRevenue)} sub={`MRR + commission earned`} />
          <Stat big span={4} label="Total costs" value={money(totalCost)} accent={totalCost > 0 ? undefined : theme.textMuted} sub={costsSub} />
          <Stat big span={4} label="Margin" value={money(margin)} accent={margin >= 0 ? GREEN : RED}
            sub={marginPct != null ? `${marginPct}% of revenue` : "no revenue this month"} />
        </div>
        {(uncosted.length > 0 || !anthropic.available) && (
          <p style={{ fontSize: 12, color: theme.textMuted, margin: 0 }}>
            {uncosted.length > 0 && `${uncosted.map((p) => p.label).join(", ")} ${uncosted.length === 1 ? "has" : "have"} usage but no rate set yet, so ${uncosted.length === 1 ? "it isn't" : "they aren't"} in the total.`}
            {uncosted.length > 0 && !anthropic.available && " "}
            {!anthropic.available && "Anthropic isn't configured yet, so it isn't in the total either."}
          </p>
        )}
      </Section>

      <Section title="Revenue">
        <div className="lk-grid">
          <Stat span={6} label="MRR" value={money(mrr)} sub={`${num(payingBrands)} paying brand${payingBrands === 1 ? "" : "s"} · recurring`} />
          <Stat span={6} label="Commission" value={money(commission, { currency: gmvCurrency })}
            sub={`on creator sales this month · transactional, ${gmvCurrency}-dominant, not currency-converted`} />
        </div>
      </Section>

      <Section title="Costs">
        <div className="lk-grid">
          <ProviderBox provider={influencersClub} />
          <ProviderBox provider={lemlist} />
          <Stat span={4} label="Anthropic" value={anthropic.available ? money(anthropicCost) : "—"}
            accent={anthropic.available ? undefined : theme.textMuted}
            sub={anthropic.available
              ? `${anthropicScopes.length} workspace${anthropicScopes.length === 1 ? "" : "s"} · real billed spend`
              : "ANTHROPIC_ADMIN_KEY not configured"} />
        </div>
      </Section>

      <Section title="Trends">
        <div className="lk-grid">
          <div className="lk-c6"><RevenueTrendChart theme={theme} mode={mode} series={series} /></div>
          <div className="lk-c6"><CostBreakdownChart theme={theme} mode={mode} items={costChartItems} /></div>
        </div>
      </Section>

      {/* No outer heading here: ProviderCosts renders its own ("Provider
          costs") plus the explanation of what it measures — a Section title
          on top of that would just repeat it. */}
      <div style={{ marginBottom: 34 }}>
        <Card pad={0} style={{ padding: 16 }}>
          <ProviderCosts theme={theme}
            section={{ background: "transparent", border: "none", padding: 0, margin: 0 }} />
          <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 12, marginTop: 12 }}>
            <strong style={{ fontSize: 13 }}>Anthropic, by Workspace</strong>
            <p style={{ fontSize: 12, color: theme.textMuted }}>
              This month's spend, from Anthropic's own Cost API — billed USD directly, not usage times a
              rate. Split by Anthropic Workspace, which is the finest split their reporting offers: two
              keys sharing one Workspace still show as one line below.
            </p>
            {anthropic.available ? (
              anthropicScopes.length === 0 ? (
                <p style={{ fontSize: 13, color: theme.textMuted }}>No spend recorded yet this month.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
                  {anthropicScopes.map((s) => (
                    <div key={s.workspace_id || "default"} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13 }}>
                      <div style={{ minWidth: 0 }}>
                        <div>{s.label}</div>
                        {s.keys.length > 0 && (
                          <div style={{ fontSize: 11, color: theme.textMuted }}>{s.keys.join(", ")}</div>
                        )}
                      </div>
                      <div style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{money(s.amount, { currency: s.currency })}</div>
                    </div>
                  ))}
                </div>
              )
            ) : (
              <p style={{ fontSize: 12, color: theme.textMuted }}>
                Not configured — set <code>ANTHROPIC_ADMIN_KEY</code> (an Admin API key from the
                Anthropic Console, separate from the regular API key) to include this.
              </p>
            )}
          </div>
        </Card>
      </div>

      <Section title="Search economics" hint="lifetime, from billed provider data — what one search actually costs and finds">
        {economics.available && economics.runs > 0 ? (
          <div className="lk-grid">
            <Stat span={3} label="Searches run" value={num(economics.runs)} />
            <Stat span={3} label="Avg credits / search" value={num(economics.avg_credits)} sub={`${num(economics.min_credits)}–${num(economics.max_credits)} seen`} />
            <Stat span={3} label="Avg creators found" value={num(economics.avg_found)} sub={`~${num(economics.avg_contactable)} with an email`} />
            <Stat span={3} label="Total credits" value={num(economics.total_credits)} sub="lifetime, all searches" />
          </div>
        ) : (
          <Card pad={16}>
            <p style={{ fontSize: 13, color: theme.textMuted, margin: 0 }}>
              {economics.available === false ? "Not available on this database." : "No completed searches yet."}
            </p>
          </Card>
        )}
      </Section>
    </div>
  );
}
