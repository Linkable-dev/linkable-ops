import { useTheme } from "../../contexts/ThemeContext";
import iconDark from "../../assets/icon-dark.svg";
import iconWhite from "../../assets/icon-white.svg";

// Full-page loading state: the Linkable mark turning. Replaces the generic
// spinner (keyframes live in index.css).
export function BrandLoader({ size = 40, label }) {
  const { theme, mode } = useTheme();
  return (
    <div role="status" aria-live="polite" aria-label={label || "Loading"} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
      <img src={mode === "dark" ? iconWhite : iconDark} alt="" width={size} height={size} style={{ display: "block", animation: "lkTurn 1.4s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite" }} />
      {label && <div style={{ fontSize: 12, color: theme.textMuted }}>{label}</div>}
    </div>
  );
}

// The full-page loading state, so every phase of a cold load puts the mark in
// the same place. Auth resolving and the route chunk arriving are two separate
// loaders shown back to back; when they disagreed on vertical position the mark
// visibly jumped up the moment auth finished, right before the page painted.
// It also paints the themed ground — a transparent fallback flashed white
// between the two phases in dark mode.
export function FullPageLoader({ label, size }) {
  const { theme } = useTheme();
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      minHeight: "100vh", background: theme.bg,
    }}>
      <BrandLoader label={label} size={size} />
    </div>
  );
}
