import { useTheme } from "../../contexts/ThemeContext";

export function Skeleton({ width = "100%", height = 14, radius = 6, style = {} }) {
  const { theme, mode } = useTheme();
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
        ...style,
      }}
    />
  );
}

export function SkeletonRow({ widths = ["70%", "40%", "50%"], gap = 8 }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap }}>
      {widths.map((w, i) => <Skeleton key={i} width={w} />)}
    </div>
  );
}

export function SkeletonCard({ height = 90 }) {
  const { theme } = useTheme();
  return (
    <div style={{
      background: theme.surface, border: `1px solid ${theme.border}`,
      borderRadius: 10, padding: 14, height,
    }}>
      <Skeleton width="40%" height={11} />
      <div style={{ height: 8 }} />
      <Skeleton width="60%" height={22} />
    </div>
  );
}

export function SkeletonTableRows({ rows = 8, cols = 9, rowHeight = 46, theme }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} style={{ borderTop: `1px solid ${theme.border}` }}>
          {Array.from({ length: cols }).map((_, c) => (
            <td key={c} style={{ padding: "12px 12px", height: rowHeight }}>
              <Skeleton width={c === 0 ? 10 : `${40 + ((r + c) * 13) % 50}%`} height={12} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
