import { useTheme } from "../../contexts/ThemeContext";
export const Label = ({ children }) => {
  const { theme } = useTheme();
  return <div style={{ fontSize: 12, fontWeight: 600, color: theme.textMid, marginBottom: 6 }}>{children}</div>;
};
export const SectionTitle = ({ children, color }) => {
  const { theme } = useTheme();
  return <div style={{ fontSize: 11, fontWeight: 700, color: color || theme.textMuted, marginBottom: 14, textTransform: "uppercase", letterSpacing: 0.8 }}>{children}</div>;
};
export const Row = ({ children, gap = 14 }) => (
  <div style={{ display: "flex", gap, marginBottom: 14 }}>{children}</div>
);
export const Col = ({ children }) => <div style={{ flex: 1, minWidth: 0 }}>{children}</div>;
