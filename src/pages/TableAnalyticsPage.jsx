import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { useTheme } from "../contexts/ThemeContext";
import { api, friendlyName, friendlyNumber } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Skeleton, SkeletonCard } from "../components/ui/Skeleton";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
  AreaChart, Area,
} from "recharts";

const COLORS = ["#0A0A0A", "#262626", "#404040", "#525252", "#737373", "#A3A3A3", "#D4D4D4"];
const COLORS_DARK = ["#FAFAFA", "#D4D4D4", "#A3A3A3", "#737373", "#525252", "#E5E5E5", "#404040"];

export default function TableAnalyticsPage() {
  const { table } = useParams();
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
    setLoading(true);
    api.getTableAnalytics(table).then(setData).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [table]);

  if (loading) return (
    <div>
      <Skeleton width={220} height={20} />
      <div style={{ height: 16 }} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 16 }}>
        {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
        {Array.from({ length: 3 }).map((_, i) => (
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
      <p style={{ color: theme.textMuted, fontSize: 13 }}>{error}</p>
    </div>
  );

  const hasTrends = Object.keys(data.timeSeries).length > 0;
  const hasDists = Object.keys(data.distributions).length > 0;
  const hasMetrics = Object.keys(data.numericStats).length > 0;
  const hasAnything = hasTrends || hasDists || hasMetrics;

  return (
    <div>
      <Link to={`/tables/${table}`} style={{
        display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none",
        color: theme.textMid, fontSize: 13, marginBottom: 20,
      }}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 3L5 8l5 5" />
        </svg>
        Back to {friendlyName(table)}
      </Link>

      {/* Total records */}
      <div style={{
        background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 10,
        padding: "16px 20px", boxShadow: theme.shadow, marginBottom: 20, display: "inline-block",
      }}>
        <span style={{ fontSize: 22, fontWeight: 700, color: theme.text }}>{friendlyNumber(data.total)}</span>
        <span style={{ fontSize: 13, color: theme.textMuted, marginLeft: 8 }}>records</span>
      </div>

      {/* Activity trend */}
      {hasTrends && Object.entries(data.timeSeries).map(([col, ts]) => (
        <Card key={col} style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 12 }}>
            Growth over time
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={ts.map((d) => ({ date: d.date, count: parseInt(d.count) }))}>
              <defs>
                <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={theme.accent} stopOpacity={0.1} />
                  <stop offset="95%" stopColor={theme.accent} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={theme.border} vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 9, fill: theme.textMuted }} tickLine={false}
                tickFormatter={(d) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" })} />
              <YAxis tick={{ fontSize: 9, fill: theme.textMuted }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={(d) => new Date(d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} />
              <Area type="monotone" dataKey="count" stroke={theme.accent} strokeWidth={2} fill="url(#tg)" name="New records" />
            </AreaChart>
          </ResponsiveContainer>
        </Card>
      ))}

      {/* Breakdowns + Metrics side by side */}
      {(hasDists || hasMetrics) && (
        <div style={{ display: "grid", gridTemplateColumns: hasDists && hasMetrics ? "1fr 1fr" : "1fr", gap: 14, marginBottom: 20 }}>
          {/* Distributions */}
          {hasDists && Object.entries(data.distributions).map(([col, dist]) => {
            const chartData = dist.map((d) => ({
              name: d.value?.length > 18 ? d.value.slice(0, 16) + "…" : (d.value || "Empty"),
              fullName: d.value || "Empty",
              value: parseInt(d.count),
            }));
            const usePie = chartData.length <= 6;

            return (
              <Card key={col} style={{ marginBottom: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 12, textTransform: "capitalize" }}>
                  {friendlyName(col)}
                </div>
                {usePie ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                    <ResponsiveContainer width="50%" height={180}>
                      <PieChart>
                        <Pie data={chartData} cx="50%" cy="50%" innerRadius={38} outerRadius={65} dataKey="value" labelLine={false}>
                          {chartData.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
                        </Pie>
                        <Tooltip contentStyle={tooltipStyle} formatter={(val, n, p) => [val, p.payload.fullName]} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
                      {chartData.map((d, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
                          <span style={{ width: 8, height: 8, borderRadius: 2, background: colors[i % colors.length], flexShrink: 0 }} />
                          <span style={{ color: theme.textMid, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={d.fullName}>{d.name}</span>
                          <span style={{ color: theme.text, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{d.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={Math.max(180, chartData.length * 28)}>
                    <BarChart data={chartData} layout="vertical" margin={{ left: 100 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={theme.border} horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 10, fill: theme.textMuted }} tickLine={false} allowDecimals={false} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: theme.textMid }} tickLine={false} axisLine={false} width={90} />
                      <Tooltip contentStyle={tooltipStyle} formatter={(val, n, p) => [val, p.payload.fullName]} />
                      <Bar dataKey="value" fill={theme.accent} radius={[0, 3, 3, 0]} name="Count" />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </Card>
            );
          })}

          {/* Numeric metrics */}
          {hasMetrics && (
            <Card style={{ marginBottom: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 14 }}>Key Metrics</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {Object.entries(data.numericStats).map(([col, stats]) => (
                  <div key={col} style={{ padding: "12px 14px", background: theme.surfaceAlt, borderRadius: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: theme.textMuted, marginBottom: 8, textTransform: "capitalize" }}>{friendlyName(col)}</div>
                    <div style={{ display: "flex", gap: 20 }}>
                      <div><div style={{ fontSize: 18, fontWeight: 700, color: theme.text }}>{friendlyNumber(stats.avg)}</div><div style={{ fontSize: 10, color: theme.textMuted }}>Avg</div></div>
                      <div><div style={{ fontSize: 14, fontWeight: 600, color: theme.textMid }}>{friendlyNumber(stats.min)}</div><div style={{ fontSize: 10, color: theme.textMuted }}>Min</div></div>
                      <div><div style={{ fontSize: 14, fontWeight: 600, color: theme.textMid }}>{friendlyNumber(stats.max)}</div><div style={{ fontSize: 10, color: theme.textMuted }}>Max</div></div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {!hasAnything && (
        <div style={{ textAlign: "center", padding: "48px 0", color: theme.textMuted, fontSize: 13 }}>
          {data.total === 0
            ? "No records yet — charts will appear here once the table has data."
            : "No chartable columns on this table — analytics needs at least one categorical or numeric column with values."}
        </div>
      )}
    </div>
  );
}
