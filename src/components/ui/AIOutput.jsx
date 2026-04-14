import { useTheme } from "../../contexts/ThemeContext";
export function AIOutput({ loading, output, accentColor }) {
  const { theme } = useTheme();
  const accent = accentColor || theme.accent;
  if (!loading && !output) return null;
  return (
    <div style={{ marginTop: 16, background: theme.surfaceAlt, border: `1.5px solid ${theme.border}`, borderRadius: 10, padding: "18px 20px", fontSize: 14, lineHeight: 1.85, color: theme.text, whiteSpace: "pre-wrap", minHeight: 60 }}>
      {loading && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: theme.textMuted, marginBottom: output ? 12 : 0 }}>
          <span style={{ width: 14, height: 14, borderRadius: "50%", border: `2px solid ${theme.border}`, borderTopColor: accent, animation: "spin 0.7s linear infinite", display: "inline-block" }} />
          Generating...
        </div>
      )}
      {output}
    </div>
  );
}
