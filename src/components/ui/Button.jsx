import { useTheme } from "../../contexts/ThemeContext";
export function Btn({ children, onClick, disabled, color, variant = "solid", size = "md" }) {
  const { theme, mode } = useTheme();
  const c = color || theme.accent;
  const pad = size === "sm" ? "7px 14px" : "10px 20px";
  const fs = size === "sm" ? 12 : 14;
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: pad, borderRadius: 8, fontFamily: "inherit", fontSize: fs, fontWeight: 600,
      cursor: disabled ? "not-allowed" : "pointer", transition: "all 0.15s",
      display: "inline-flex", alignItems: "center", gap: 6,
      border: variant === "outline" ? `1.5px solid ${disabled ? theme.border : c}` : "none",
      background: variant === "outline" ? "transparent" : (disabled ? theme.surfaceAlt : c),
      color: disabled ? theme.textMuted : (variant === "outline" ? c : (mode === "dark" && c === theme.accent ? "#0A0A0A" : "#fff")),
      boxShadow: (!disabled && variant === "solid") ? `0 1px 4px ${c}20` : "none",
    }}>{children}</button>
  );
}
