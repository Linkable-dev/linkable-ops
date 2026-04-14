import { useTheme } from "../../contexts/ThemeContext";
export function TabBar({ tabs, active, onSelect }) {
  const { theme } = useTheme();
  return (
    <div style={{ display: "flex", gap: 0, marginBottom: 20, background: theme.surfaceAlt, borderRadius: 10, padding: 4, width: "fit-content" }}>
      {tabs.map(([id, label]) => (
        <button key={id} onClick={() => onSelect(id)} style={{
          padding: "8px 18px", border: "none", borderRadius: 8,
          background: active === id ? theme.surface : "transparent",
          color: active === id ? theme.text : theme.textMuted,
          fontFamily: "inherit", fontSize: 13, fontWeight: active === id ? 600 : 400,
          cursor: "pointer", boxShadow: active === id ? theme.shadow : "none", transition: "all 0.15s",
        }}>
          {label}
        </button>
      ))}
    </div>
  );
}
