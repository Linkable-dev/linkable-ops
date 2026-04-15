import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useTheme } from "../contexts/ThemeContext";
import { api, friendlyName, friendlyNumber } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Skeleton, SkeletonCard } from "../components/ui/Skeleton";
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

const COLORS = ["#0A0A0A", "#404040", "#737373", "#A3A3A3", "#D4D4D4", "#525252"];
const COLORS_DARK = ["#FAFAFA", "#D4D4D4", "#A3A3A3", "#737373", "#525252", "#E5E5E5"];

export default function DashboardPage() {
  const { theme, mode } = useTheme();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const colors = mode === "dark" ? COLORS_DARK : COLORS;

  const tooltipStyle = {
    background: theme.surface, border: `1px solid ${theme.border}`,
    borderRadius: 8, boxShadow: theme.shadowMd, fontSize: 12, color: theme.text,
  };

  useEffect(() => {
    api.getOverview().then(setData).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 20 }}>
        {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 10, padding: 20, height: 260 }}>
            <Skeleton width="30%" height={12} />
            <div style={{ height: 12 }} />
            <Skeleton width="100%" height={200} radius={8} />
          </div>
        ))}
      </div>
    </div>
  );
  if (error) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "60vh" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: theme.text }}>Connection Error</div>
        <p style={{ color: theme.textMuted, fontSize: 13, marginTop: 8 }}>{error}</p>
      </div>
    </div>
  );

  const { kpis, growth, trends, distributions, igStats, monetization, revenue, creatorPayments, payouts } = data;

  return (
    <div>
      {/* Main KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 20 }}>
        <Kpi theme={theme} label="Brands" value={kpis.brands} growth={growth.brands} link="/tables/brands" />
        <Kpi theme={theme} label="Creators" value={kpis.influencers + kpis.externalCreators} sub={`${kpis.influencers} registered · ${kpis.externalCreators} external`} link="/tables/influencers" />
        <Kpi theme={theme} label="Products" value={kpis.products} link="/tables/products" />
        <Kpi theme={theme} label="Active Links" value={kpis.links} growth={growth.links} link="/tables/links" />
        <Kpi theme={theme} label="Orders" value={kpis.orders} link="/tables/orders" />
        <Kpi theme={theme} label="Users" value={kpis.users} growth={growth.users} link="/tables/users" />
      </div>

      {/* Instagram stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 20 }}>
        <MiniStat theme={theme} label="Avg Followers" value={friendlyNumber(igStats.avgFollowers)} />
        <MiniStat theme={theme} label="Avg Engagement" value={`${igStats.avgEngagement}%`} />
        <MiniStat theme={theme} label="Avg Posts" value={friendlyNumber(igStats.avgPosts)} />
        <MiniStat theme={theme} label="Campaign Matches" value={friendlyNumber(kpis.matches)} />
        <MiniStat theme={theme} label="Messages" value={friendlyNumber(kpis.chats)} />
        <MiniStat theme={theme} label="Invitations Sent" value={friendlyNumber(kpis.invitations)} />
      </div>

      {/* Money — single card with clear sections */}
      <Card style={{ padding: 0, marginBottom: 20 }}>
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${theme.border}` }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>Money</div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)" }}>
          <MetricCell theme={theme} label="Revenue" value={`$${friendlyNumber(revenue.total)}`} />
          <MetricCell theme={theme} label="Orders" value={revenue.totalOrders} border />
          <MetricCell theme={theme} label="Avg Order" value={`$${friendlyNumber(revenue.avgOrderValue)}`} border />
          <MetricCell theme={theme} label="Paid Out" value={`$${friendlyNumber(payouts.reduce((s, p) => s + p.amount, 0))}`} sub={`${payouts.reduce((s, p) => s + p.count, 0)} payouts`} border />
          <MetricCell theme={theme} label="Links That Sold" value={revenue.uniqueLinksWithOrders} sub={`of ${kpis.links} total`} border />
        </div>
      </Card>

      {/* Payments & Trials — two side-by-side cards */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 }}>
        {/* Who can pay / get paid */}
        <Card style={{ padding: 0, marginBottom: 0 }}>
          <div style={{ padding: "14px 20px", borderBottom: `1px solid ${theme.border}` }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>Payment Readiness</div>
          </div>
          <div style={{ padding: "14px 20px" }}>
            <ProgressRow theme={theme} label="Brands on Stripe" value={monetization.hasStripe} total={kpis.brands} />
            <ProgressRow theme={theme} label="Brands with card on file" value={monetization.hasPaymentMethod} total={kpis.brands} />
            <ProgressRow theme={theme} label="Creators can receive payouts" value={creatorPayments.stripeConnected} total={creatorPayments.totalCreators} />
          </div>
        </Card>

        {/* Trials */}
        <Card style={{ padding: 0, marginBottom: 0 }}>
          <div style={{ padding: "14px 20px", borderBottom: `1px solid ${theme.border}` }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>Trials</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr" }}>
            <MetricCell theme={theme} label="Active" value={monetization.activeTrial} />
            <MetricCell theme={theme} label="Expired" value={monetization.expiredTrial} border />
            <MetricCell theme={theme} label="Never trialed" value={kpis.brands - monetization.onTrial} border />
          </div>
          {monetization.trialPlans.length > 0 && (
            <div style={{ padding: "10px 20px 16px", borderTop: `1px solid ${theme.border}` }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {monetization.trialPlans.map((tp) => (
                  <span key={`${tp.plan}-${tp.interval}`} style={{
                    padding: "5px 12px", borderRadius: 20, fontSize: 12, fontWeight: 500,
                    background: theme.surfaceAlt, color: theme.text,
                  }}>
                    {tp.count} on <strong>{tp.plan}</strong> ({tp.interval})
                  </span>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* Activity Trends */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }}>
        <TrendChart theme={theme} mode={mode} title="User Signups" period="all time" data={trends.signups} color={theme.accent} tooltipStyle={tooltipStyle} />
        <TrendChart theme={theme} mode={mode} title="Links Created" period="last 6 months" data={trends.links} color={theme.accent} tooltipStyle={tooltipStyle} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }}>
        <TrendChart theme={theme} mode={mode} title="Messages" period="last 6 months" data={trends.chats} color={theme.accent} tooltipStyle={tooltipStyle} />
        <TrendChart theme={theme} mode={mode} title="Products Added" period="all time" data={trends.products} color={theme.accent} tooltipStyle={tooltipStyle} />
      </div>

      {/* Distributions */}
      <div style={{ fontSize: 14, fontWeight: 600, color: theme.text, marginBottom: 12 }}>Audience & Creator Insights</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14, marginBottom: 16 }}>
        {distributions.influencerCountries.length > 0 && (
          <DistChart theme={theme} tooltipStyle={tooltipStyle} colors={colors}
            title="Creator Locations" data={distributions.influencerCountries} type="bar" />
        )}
        {distributions.influencerNiches.length > 0 && (
          <DistChart theme={theme} tooltipStyle={tooltipStyle} colors={colors}
            title="Creator Niches" data={distributions.influencerNiches} type="pie" />
        )}
        {distributions.creatorCategories.length > 0 && (
          <DistChart theme={theme} tooltipStyle={tooltipStyle} colors={colors}
            title="Content Categories" data={distributions.creatorCategories} type="pie" />
        )}
        {distributions.creatorGender.length > 0 && (
          <DistChart theme={theme} tooltipStyle={tooltipStyle} colors={colors}
            title="Creator Gender" data={distributions.creatorGender} type="pie" />
        )}
        {distributions.brandLocations.length > 0 && (
          <DistChart theme={theme} tooltipStyle={tooltipStyle} colors={colors}
            title="Brand Locations" data={distributions.brandLocations} type="bar" />
        )}
        {distributions.matchScores.length > 0 && (
          <DistChart theme={theme} tooltipStyle={tooltipStyle} colors={colors}
            title="Campaign Match Quality" data={distributions.matchScores} type="bar" />
        )}
      </div>

      {/* Top brands + verified split */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }}>
        {distributions.topBrands.length > 0 && (
          <Card style={{ marginBottom: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 14 }}>Top Brands by Products</div>
            <ResponsiveContainer width="100%" height={Math.max(180, distributions.topBrands.length * 32)}>
              <BarChart data={distributions.topBrands.map(d => ({ ...d, name: d.name?.length > 16 ? d.name.slice(0, 14) + "…" : d.name }))} layout="vertical" margin={{ left: 120 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={theme.border} horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10, fill: theme.textMuted }} tickLine={false} allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: theme.textMid }} tickLine={false} axisLine={false} width={110} />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="value" fill={theme.accent} radius={[0, 4, 4, 0]} name="Products" />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        )}
        <Card style={{ marginBottom: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 14 }}>Creator Verification</div>
          <ResponsiveContainer width="100%" height={180}>
            <PieChart>
              <Pie
                data={[
                  { name: "Verified", value: distributions.verified.verified },
                  { name: "Unverified", value: distributions.verified.unverified },
                ]}
                cx="50%" cy="50%" innerRadius={45} outerRadius={70} dataKey="value"
                label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                labelLine={false} fontSize={11}
              >
                <Cell fill={mode === "dark" ? "#FAFAFA" : "#0A0A0A"} />
                <Cell fill={theme.border} />
              </Pie>
              <Tooltip contentStyle={tooltipStyle} />
            </PieChart>
          </ResponsiveContainer>
          <div style={{ display: "flex", justifyContent: "center", gap: 20, marginTop: 8 }}>
            <span style={{ fontSize: 12, color: theme.textMid }}>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: mode === "dark" ? "#FAFAFA" : "#0A0A0A", marginRight: 6 }} />
              {distributions.verified.verified} verified
            </span>
            <span style={{ fontSize: 12, color: theme.textMid }}>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: theme.border, marginRight: 6 }} />
              {distributions.verified.unverified} unverified
            </span>
          </div>
        </Card>
      </div>

      {/* Sample requests */}
      {distributions.sampleStatuses.length > 0 && (
        <Card>
          <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 14 }}>Sample Request Status</div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {distributions.sampleStatuses.map((s) => (
              <div key={s.name} style={{
                padding: "10px 16px", borderRadius: 8, background: theme.surfaceAlt,
                border: `1px solid ${theme.border}`, minWidth: 100,
              }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: theme.text }}>{s.value}</div>
                <div style={{ fontSize: 11, color: theme.textMuted, textTransform: "capitalize", marginTop: 2 }}>{s.name || "Unknown"}</div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function Kpi({ theme, label, value, growth, sub, link }) {
  const growthText = growth ? `${growth.last7} this week · ${growth.last30} this month` : null;
  const content = (
    <div style={{
      background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 10,
      padding: "16px 18px", boxShadow: theme.shadow, transition: "background 0.2s, border-color 0.2s",
      cursor: link ? "pointer" : "default", overflow: "hidden", height: 110, display: "flex", flexDirection: "column", justifyContent: "center",
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: theme.text }}>{friendlyNumber(value)}</div>
      {growthText && (
        <div style={{ fontSize: 11, color: theme.textMid, marginTop: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={growthText}>
          <span style={{ fontWeight: 600 }}>{growth.last7}</span> this week · <span style={{ fontWeight: 600 }}>{growth.last30}</span> this month
        </div>
      )}
      {sub && <div style={{ fontSize: 11, color: theme.textMid, marginTop: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={sub}>{sub}</div>}
    </div>
  );
  if (link) return <Link to={link} style={{ textDecoration: "none" }}>{content}</Link>;
  return content;
}

function MiniStat({ theme, label, value }) {
  return (
    <div style={{
      background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 10,
      padding: "12px 16px", boxShadow: theme.shadow, transition: "background 0.2s, border-color 0.2s",
    }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: theme.text }}>{value}</div>
      <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function TrendChart({ theme, mode, title, period, data, color, tooltipStyle }) {
  if (!data || data.length < 2) return (
    <Card style={{ marginBottom: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 12, color: theme.textMuted, padding: "24px 0", textAlign: "center" }}>No data yet</div>
    </Card>
  );
  return (
    <Card style={{ marginBottom: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 12 }}>{title} <span style={{ fontWeight: 400, color: theme.textMuted, fontSize: 11 }}>{period || "last 30 days"}</span></div>
      <ResponsiveContainer width="100%" height={180}>
        <AreaChart data={data}>
          <defs>
            <linearGradient id={`g-${title}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.1} />
              <stop offset="95%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={theme.border} vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 9, fill: theme.textMuted }} tickLine={false}
            tickFormatter={(d) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" })} />
          <YAxis tick={{ fontSize: 9, fill: theme.textMuted }} axisLine={false} tickLine={false} allowDecimals={false} />
          <Tooltip contentStyle={tooltipStyle} labelFormatter={(d) => new Date(d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} />
          <Area type="monotone" dataKey="count" stroke={color} strokeWidth={2} fill={`url(#g-${title})`} />
        </AreaChart>
      </ResponsiveContainer>
    </Card>
  );
}

function MetricCell({ theme, label, value, sub, border }) {
  return (
    <div style={{
      padding: "12px 16px",
      borderLeft: border ? `1px solid ${theme.border}` : "none",
    }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: theme.text }}>{typeof value === "number" ? friendlyNumber(value) : value}</div>
      <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 1 }}>{label}</div>
      {sub && <div style={{ fontSize: 10, color: theme.textMuted, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function ProgressRow({ theme, label, value, total }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: theme.textMid }}>{label}</span>
        <span style={{ fontSize: 12, color: theme.text }}>
          <strong>{value}</strong>
          <span style={{ color: theme.textMuted }}> / {total}</span>
          <span style={{ color: theme.textMuted, fontSize: 10, marginLeft: 4 }}>({pct}%)</span>
        </span>
      </div>
      <div style={{ height: 5, background: theme.surfaceAlt, borderRadius: 99, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: theme.accent, borderRadius: 99, transition: "width 0.4s ease" }} />
      </div>
    </div>
  );
}

function DistChart({ theme, tooltipStyle, colors, title, data, type }) {
  // Truncate long names for display
  const cleanData = data.map((d) => ({
    ...d,
    name: d.name?.length > 18 ? d.name.slice(0, 16) + "…" : (d.name || "Unknown"),
    fullName: d.name || "Unknown",
  }));

  // Auto-pick: too many slices → use bar chart instead
  const useBar = type === "bar" || cleanData.length > 6;

  // Calculate dynamic bar height
  const barHeight = Math.max(200, cleanData.length * 32);
  // Calculate max label width needed
  const maxLabelLen = Math.max(...cleanData.map((d) => d.name.length));
  const labelWidth = Math.min(Math.max(maxLabelLen * 6.5, 60), 130);

  return (
    <Card style={{ marginBottom: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 12 }}>{title}</div>
      {!useBar ? (
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <ResponsiveContainer width="55%" height={200}>
            <PieChart>
              <Pie data={cleanData} cx="50%" cy="50%" innerRadius={40} outerRadius={70} dataKey="value"
                labelLine={false} fontSize={10}>
                {cleanData.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} formatter={(val, name, props) => [val, props.payload.fullName]} />
            </PieChart>
          </ResponsiveContainer>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
            {cleanData.map((d, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: colors[i % colors.length], flexShrink: 0 }} />
                <span style={{ color: theme.textMid, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={d.fullName}>{d.name}</span>
                <span style={{ color: theme.text, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{d.value}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={barHeight}>
          <BarChart data={cleanData} layout="vertical" margin={{ left: labelWidth + 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={theme.border} horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 10, fill: theme.textMuted }} tickLine={false} allowDecimals={false} />
            <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: theme.textMid }} tickLine={false} axisLine={false} width={labelWidth} />
            <Tooltip contentStyle={tooltipStyle} formatter={(val, name, props) => [val, props.payload.fullName]} />
            <Bar dataKey="value" fill={theme.accent} radius={[0, 3, 3, 0]} name="Count" />
          </BarChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}
