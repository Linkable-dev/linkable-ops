import { useTheme } from "../../contexts/ThemeContext";

// variant: solid (primary) | outline | secondary (quiet, surface background) | danger (red solid)
// type defaults to "button" so a Cancel button inside a <form> never submits it.
export function Btn({ children, onClick, disabled, loading, color, variant = "solid", size = "md", style = {}, type = "button", title }) {
  const { theme, mode } = useTheme();
  const c = variant === "danger" ? "#DC2626" : (color || theme.accent);
  const pad = size === "sm" ? "7px 15px" : "10px 22px";
  const fs = size === "sm" ? 12 : 14;
  const isDisabled = disabled || loading;
  const fg = isDisabled ? theme.textMuted
    : variant === "outline" ? c
    : variant === "secondary" ? theme.text
    : (mode === "dark" && c === theme.accent ? "#0A0A0A" : "#fff");
  return (
    <button onClick={onClick} disabled={isDisabled} type={type} title={title} className={`lk-btn lk-btn-${variant}`} style={{
      padding: pad, borderRadius: 999, fontFamily: "inherit", fontSize: fs, fontWeight: 600, letterSpacing: -0.1,
      cursor: isDisabled ? "not-allowed" : "pointer", transition: "all 0.15s",
      display: "inline-flex", alignItems: "center", gap: 6,
      border: variant === "outline" ? `1.5px solid ${isDisabled ? theme.border : c}` : variant === "secondary" ? `1px solid ${theme.border}` : "none",
      background: variant === "outline" ? "transparent" : variant === "secondary" ? theme.surface : (isDisabled ? theme.surfaceAlt : c),
      color: fg,
      boxShadow: (!isDisabled && (variant === "solid" || variant === "danger")) ? `0 1px 4px ${c}20` : "none",
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
