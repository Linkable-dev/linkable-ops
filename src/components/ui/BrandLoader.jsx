import { useTheme } from "../../contexts/ThemeContext";
import iconDark from "../../assets/icon-dark.svg";
import iconWhite from "../../assets/icon-white.svg";

// Full-page loading state: the Linkable mark breathing, with a soft halo.
// Replaces the generic spinner (keyframes live in index.css).
export function BrandLoader({ size = 40, label }) {
  const { theme, mode } = useTheme();
  return (
    <div role="status" aria-live="polite" aria-label={label || "Loading"} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
      <div style={{ position: "relative", width: size * 2, height: size * 2, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span aria-hidden="true" style={{ position: "absolute", inset: 0, borderRadius: "50%", background: theme.brand || "#3CBA8C", opacity: 0.18, animation: "lkHalo 1.8s ease-in-out infinite" }} />
        <img src={mode === "dark" ? iconWhite : iconDark} alt="" width={size} height={size} style={{ position: "relative", animation: "lkBreathe 1.8s ease-in-out infinite" }} />
      </div>
      {label && <div style={{ fontSize: 12, color: theme.textMuted }}>{label}</div>}
    </div>
  );
}
