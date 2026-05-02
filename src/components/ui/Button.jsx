import { useTheme } from "../../contexts/ThemeContext";

export function Btn({ children, onClick, disabled, loading, color, variant = "solid", size = "md", style = {}, type, title }) {
  const { theme, mode } = useTheme();
  const c = color || theme.accent;
  const pad = size === "sm" ? "7px 14px" : "10px 20px";
  const fs = size === "sm" ? 12 : 14;
  const isDisabled = disabled || loading;
  const fg = isDisabled ? theme.textMuted : (variant === "outline" ? c : (mode === "dark" && c === theme.accent ? "#0A0A0A" : "#fff"));
  return (
    <button onClick={onClick} disabled={isDisabled} type={type} title={title} style={{
      padding: pad, borderRadius: 8, fontFamily: "inherit", fontSize: fs, fontWeight: 600,
      cursor: isDisabled ? "not-allowed" : "pointer", transition: "all 0.15s",
      display: "inline-flex", alignItems: "center", gap: 6,
      border: variant === "outline" ? `1.5px solid ${isDisabled ? theme.border : c}` : "none",
      background: variant === "outline" ? "transparent" : (isDisabled ? theme.surfaceAlt : c),
      color: fg,
      boxShadow: (!isDisabled && variant === "solid") ? `0 1px 4px ${c}20` : "none",
      ...style,
    }}>
      {loading && <Spinner size={fs - 2} color={fg} />}
      {children}
    </button>
  );
}

export function Spinner({ size = 14, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ animation: "spin 0.8s linear infinite", flexShrink: 0 }} aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke={color} strokeOpacity="0.25" strokeWidth="3" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke={color} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
