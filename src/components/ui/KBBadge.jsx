import { useTheme } from "../../contexts/ThemeContext";
export function KBBadge({ label, filled, color }) {
  const { theme } = useTheme();
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "4px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600,
      background: filled ? color + "18" : theme.surfaceAlt,
      color: filled ? color : theme.textMuted,
      border: `1px solid ${filled ? color + "40" : theme.border}`,
    }}>
      <span style={{ fontSize: 9 }}>{filled ? "●" : "○"}</span> {label}
    </span>
  );
}
