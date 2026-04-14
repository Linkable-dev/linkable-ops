import { useTheme } from "../../contexts/ThemeContext";
export function ProgressBar({ pct, color }) {
  const { theme } = useTheme();
  return (
    <div style={{ height: 6, background: theme.surfaceAlt, borderRadius: 99, overflow: "hidden", marginTop: 10 }}>
      <div style={{ height: "100%", width: `${pct}%`, background: color || theme.accent, borderRadius: 99, transition: "width 0.4s ease" }} />
    </div>
  );
}
