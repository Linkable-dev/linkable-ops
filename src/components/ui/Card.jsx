import { useTheme } from "../../contexts/ThemeContext";
export function Card({ children, style = {} }) {
  const { theme } = useTheme();
  return (
    <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 10, padding: 24, marginBottom: 16, boxShadow: theme.shadow, transition: "background 0.2s, border-color 0.2s", ...style }}>
      {children}
    </div>
  );
}
