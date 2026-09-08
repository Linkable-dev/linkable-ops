import { useTheme } from "../../contexts/ThemeContext";

/*
 * Skeleton primitives.
 *
 * Every loading state in the app is built from these so that placeholders
 * mirror the real markup one to one: a table shows the real columns, a stat
 * grid shows the same number of cards in the same grid, a form shows the same
 * labelled fields. Widths inside a row vary deterministically (never random)
 * so the shimmer is stable across re-renders.
 */

const vary = (seed, min, span) => `${min + (seed * 13) % span}%`;

export function Skeleton({ width = "100%", height = 14, radius = 6, style = {} }) {
  const { mode } = useTheme();
  const base = mode === "dark" ? "#1f1f1f" : "#EAEAEA";
  const hi   = mode === "dark" ? "#2a2a2a" : "#F5F5F5";
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width, height, borderRadius: radius,
        background: `linear-gradient(90deg, ${base} 0%, ${hi} 50%, ${base} 100%)`,
        backgroundSize: "200% 100%",
        animation: "skeletonShimmer 1.2s ease-in-out infinite",
        flexShrink: 0,
        ...style,
      }}
    />
  );
}

/* A short stack of text lines (paragraph-like content). */
export function SkeletonRow({ widths = ["70%", "40%", "50%"], gap = 8, height = 14 }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap }}>
      {widths.map((w, i) => <Skeleton key={i} width={w} height={height} />)}
    </div>
  );
}

/* ---------------------------------------------------------------- stats --- */

const STAT_VARIANTS = {
  // HomePage <Stat>: label 12 / value 24 (32 when big) / sub 12, padding 18, radius 12
  stat: { padding: 18, radius: 12, label: 12, value: 24, sub: 12, gapLabel: 8, gapSub: 6, uppercase: false },
  // DashboardPage <Kpi>: uppercase label 11 / value 24 / growth line 11, fixed height 110
  kpi:  { padding: "16px 18px", radius: 10, label: 11, value: 24, sub: 11, gapLabel: 6, gapSub: 4, height: 110, uppercase: true },
  // DashboardPage <MiniStat>: value 18 first, label 11 below
  mini: { padding: "12px 16px", radius: 10, label: 11, value: 18, sub: 0, gapLabel: 2, valueFirst: true },
  // AiCampaignDetailPage <SendStatCard>: uppercase label 11 / value 22 / sub 11, padding 12 14
  send: { padding: "12px 14px", radius: 10, label: 11, value: 22, sub: 11, gapLabel: 2, gapSub: 2, uppercase: true },
  // Legacy SkeletonCard shape
  card: { padding: 14, radius: 10, label: 11, value: 22, sub: 0, gapLabel: 8 },
};

export function SkeletonStat({ variant = "stat", big = false, sub = true, span = 1, seed = 0, style = {} }) {
  const { theme } = useTheme();
  const v = STAT_VARIANTS[variant] || STAT_VARIANTS.stat;
  const label = <Skeleton width={vary(seed, 36, 28)} height={v.label} />;
  const value = <Skeleton width={vary(seed + 1, 40, 30)} height={big ? 32 : v.value} radius={6} />;
  return (
    <div style={{
      gridColumn: span > 1 ? `span ${span}` : undefined,
      background: theme.surface, border: `1px solid ${theme.border}`,
      borderRadius: v.radius, padding: v.padding, minWidth: 0, boxSizing: "border-box",
      height: v.height, display: "flex", flexDirection: "column", justifyContent: v.height ? "center" : "flex-start",
      ...style,
    }}>
      {v.valueFirst ? value : label}
      <div style={{ height: v.gapLabel }} />
      {v.valueFirst ? label : value}
      {sub && v.sub > 0 && (
        <>
          <div style={{ height: v.gapSub }} />
          <Skeleton width={vary(seed + 2, 45, 30)} height={v.sub} />
        </>
      )}
    </div>
  );
}

/* Kept for callers that only need "a card": same shape as the old SkeletonCard. */
export function SkeletonCard({ height = 90 }) {
  return <SkeletonStat variant="card" sub={false} style={{ height, boxSizing: "border-box" }} />;
}

/*
 * A grid of stat cards. `columns` = fixed column count (repeat(n, minmax(0,1fr)))
 * or `minWidth` = auto-fit columns, matching the real grid rule of the page.
 */
export function SkeletonStatGrid({ count = 4, columns, minWidth = 170, gap = 12, variant = "stat", big = false, sub = true, style = {} }) {
  return (
    <div style={{
      display: "grid", gap,
      gridTemplateColumns: columns ? `repeat(${columns}, minmax(0, 1fr))` : `repeat(auto-fit, minmax(${minWidth}px, 1fr))`,
      ...style,
    }}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonStat key={i} variant={variant} big={big && i === 0} sub={sub} seed={i} />
      ))}
    </div>
  );
}

/* Card with a title line and a chart-sized block (optionally a legend column). */
export function SkeletonChartCard({ height = 200, title = true, legend = false, padding = 20, style = {} }) {
  const { theme } = useTheme();
  return (
    <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 10, padding, boxSizing: "border-box", ...style }}>
      {title && (
        <>
          <Skeleton width="32%" height={13} />
          <div style={{ height: 12 }} />
        </>
      )}
      {legend ? (
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <Skeleton width={height} height={height} radius="50%" />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Skeleton width={8} height={8} radius={2} />
                <Skeleton width={vary(i, 40, 40)} height={11} />
                <Skeleton width={28} height={11} style={{ marginLeft: "auto" }} />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <Skeleton width="100%" height={height} radius={8} />
      )}
    </div>
  );
}

/* Horizontal bars with a label on the left and a figure on the right (funnels, breakdowns). */
export function SkeletonBars({ rows = 4, labelWidth = 64, valueWidth = 150, barHeight = 10, gap = 12 }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Skeleton width={labelWidth} height={13} />
          <Skeleton width="100%" height={barHeight} radius={6} style={{ flex: 1 }} />
          <Skeleton width={valueWidth} height={13} />
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- tables -- */

/*
 * One table cell placeholder. `kind` mirrors what the real cell renders:
 *   expand   – chevron / checkbox (10px square)
 *   avatar   – 32px circle
 *   text     – single line of text
 *   two-line – title + smaller sub line (name + email, title + slug…)
 *   pill     – status tag
 *   num      – right-aligned figure
 *   actions  – right-aligned small buttons
 *   empty    – nothing
 */
export function SkeletonCell({ kind = "text", seed = 0, height = 12 }) {
  switch (kind) {
    case "expand": return <Skeleton width={10} height={10} radius={2} />;
    case "avatar": return <Skeleton width={32} height={32} radius="50%" />;
    case "two-line": return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Skeleton width={vary(seed, 55, 35)} height={height} />
        <Skeleton width={vary(seed + 3, 30, 30)} height={height - 2} />
      </div>
    );
    case "pill": return <Skeleton width={64} height={18} radius={999} />;
    case "num": return <div style={{ textAlign: "right" }}><Skeleton width={vary(seed, 30, 30)} height={height} /></div>;
    case "actions": return (
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <Skeleton width={36} height={height} />
        <Skeleton width={44} height={height} />
      </div>
    );
    case "empty": return null;
    default: return <Skeleton width={vary(seed, 40, 50)} height={height} />;
  }
}

const normalizeCols = (cols) =>
  typeof cols === "number"
    ? Array.from({ length: cols }, (_, i) => ({ kind: i === 0 ? "expand" : "text" }))
    : cols.map((c) => (typeof c === "string" ? { kind: c } : c));

/* Body rows only, for tables that keep their real <thead>. */
export function SkeletonTableRows({ rows = 8, cols = 9, rowHeight = 46, cellPadding = "12px 12px", theme: themeProp }) {
  const ctx = useTheme();
  const theme = themeProp || ctx.theme;
  const columns = normalizeCols(cols);
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} style={{ borderTop: `1px solid ${theme.border}` }}>
          {columns.map((c, i) => (
            <td key={i} style={{ padding: cellPadding, height: rowHeight, verticalAlign: "middle" }}>
              <SkeletonCell kind={c.kind || "text"} seed={r + i} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/*
 * A whole table: header with the real column labels (muted) plus body rows.
 * columns: [{ key, label, width, kind, align }]
 */
export function SkeletonTable({ columns, rows = 8, fontSize = 13, headerBackground, cellPadding = "12px 14px", style = {} }) {
  const { theme } = useTheme();
  const cols = normalizeCols(columns);
  return (
    <div style={{ overflowX: "auto", ...style }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize, tableLayout: cols.some((c) => c.width) ? "fixed" : "auto" }}>
        {cols.some((c) => c.width) && (
          <colgroup>
            {cols.map((c, i) => <col key={c.key || i} style={c.fill ? { minWidth: c.width || 140 } : { width: c.width }} />)}
          </colgroup>
        )}
        <thead>
          <tr style={{ background: headerBackground ?? theme.surfaceAlt, borderBottom: `1px solid ${theme.border}` }}>
            {cols.map((c, i) => (
              <th key={c.key || i} style={{
                textAlign: c.kind === "num" || c.kind === "actions" ? "right" : "left",
                padding: "10px 14px", fontSize: 11, fontWeight: 600, color: theme.textMuted,
                textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "nowrap",
              }}>
                {c.label ?? (c.kind === "expand" || c.kind === "avatar" || c.kind === "actions" ? "" : <Skeleton width={60} height={10} />)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <SkeletonTableRows rows={rows} cols={cols} cellPadding={cellPadding} theme={theme} />
        </tbody>
      </table>
    </div>
  );
}

/* CSS-grid "table" rows (UsersPage): same template and cell kinds as the real rows. */
export function SkeletonGridRows({ template, columns, rows = 8, padding = "10px 16px", gap = 8 }) {
  const { theme } = useTheme();
  const cols = normalizeCols(columns);
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} style={{
          display: "grid", gridTemplateColumns: template, alignItems: "center",
          padding, gap, borderBottom: `1px solid ${theme.border}`, minHeight: 53, boxSizing: "border-box",
        }}>
          {cols.map((c, i) => (
            <div key={c.key || i} style={{ minWidth: 0 }}>
              <SkeletonCell kind={c.kind || "text"} seed={r + i} />
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

/* ---------------------------------------------------------------- lists --- */

/*
 * Stacked list rows: optional avatar, one or two text lines, optional
 * right-aligned meta block and action button. Mirrors BrandResultRow,
 * InboxRow, topic rows…
 */
export function SkeletonListRows({
  rows = 5, avatar = null, lines = [["45%", 13], ["65%", 11]], meta = null, action = null,
  padding = "14px 16px", gap = 14, divider = true, lastDivider = false,
}) {
  const { theme } = useTheme();
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{
          display: "flex", alignItems: "center", gap, padding,
          borderBottom: divider && (lastDivider || i < rows - 1) ? `1px solid ${theme.border}` : "none",
        }}>
          {avatar && <Skeleton width={avatar.size || 40} height={avatar.size || 40} radius={avatar.radius ?? 8} />}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {lines.map(([w, h], j) => <Skeleton key={j} width={typeof w === "string" && w.endsWith("%") ? vary(i + j, parseInt(w, 10) - 8, 16) : w} height={h} />)}
          </div>
          {meta && (
            <div style={{ minWidth: meta.width || 120, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
              {(meta.lines || [[90, 12], [60, 11]]).map(([w, h], j) => <Skeleton key={j} width={w} height={h} />)}
            </div>
          )}
          {action && <Skeleton width={action.width || 80} height={action.height || 28} radius={action.radius ?? 999} />}
        </div>
      ))}
    </>
  );
}

/* Sidebar nav entries: icon square + label, same 34px row height as navItem. */
export function SkeletonNavItems({ count = 8, indent = false, showLabel = true }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, height: 34, padding: indent ? "0 10px 0 22px" : "0 10px" }}>
          <Skeleton width={14} height={14} radius={3} />
          {showLabel && <Skeleton width={vary(i, 45, 40)} height={11} />}
        </div>
      ))}
    </div>
  );
}

/* Tab bar / pill group placeholder. */
export function SkeletonPills({ count = 4, height = 30, widths = [88, 72, 96, 80, 70, 92] }) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {Array.from({ length: count }).map((_, i) => <Skeleton key={i} width={widths[i % widths.length]} height={height} radius={999} />)}
    </div>
  );
}

/* Two-column "label / value" grid (From / Reply-to / To, timelines). */
export function SkeletonKeyValue({ rows = 3, labelWidth = 56, gap = "6px 12px" }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap, alignItems: "center" }}>
      {Array.from({ length: rows }).map((_, i) => (
        <FragmentRow key={i} seed={i} labelWidth={labelWidth} />
      ))}
    </div>
  );
}
function FragmentRow({ seed, labelWidth }) {
  return (
    <>
      <Skeleton width={labelWidth} height={11} />
      <Skeleton width={vary(seed, 35, 45)} height={12} />
    </>
  );
}

/* ---------------------------------------------------------------- forms --- */

/* Label + input box. `height` 41 matches <Input>, 38 a <select>, taller for textareas. */
export function SkeletonField({ label = true, height = 41, labelWidth = 90, style = {} }) {
  return (
    <div style={{ flex: 1, minWidth: 0, ...style }}>
      {label && (
        <>
          <Skeleton width={labelWidth} height={11} />
          <div style={{ height: 8 }} />
        </>
      )}
      <Skeleton width="100%" height={height} radius={8} />
    </div>
  );
}

/*
 * A form made of rows of fields. rows: [[{ height, labelWidth }, …], …]
 * Each inner array is rendered side by side like the editor's <Row>/<Col>.
 */
export function SkeletonForm({ rows, gap = 14, rowGap = 14 }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: rowGap }}>
      {rows.map((fields, i) => (
        <div key={i} style={{ display: "flex", gap }}>
          {fields.map((f, j) => <SkeletonField key={j} {...f} />)}
        </div>
      ))}
    </div>
  );
}

/* RecordForm layout: stacked fields separated by hairlines, label above input. */
export function SkeletonFieldList({ count = 6, inputHeight = 38 }) {
  const { theme } = useTheme();
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{ padding: "12px 0", borderBottom: i < count - 1 ? `1px solid ${theme.border}` : "none" }}>
          <Skeleton width={vary(i, 18, 20)} height={12} />
          <div style={{ height: 8 }} />
          <Skeleton width="100%" height={inputHeight} radius={8} />
        </div>
      ))}
    </div>
  );
}

/* Standalone select / input box (no label). */
export function SkeletonInput({ height = 38, width = "100%" }) {
  return <Skeleton width={width} height={height} radius={8} />;
}
