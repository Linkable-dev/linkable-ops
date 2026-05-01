import { useTheme } from "../../contexts/ThemeContext";
export function Input({ value, onChange, placeholder, multiline, rows = 3, style = {}, ...rest }) {
  const { theme } = useTheme();
  const base = {
    width: "100%", boxSizing: "border-box", background: theme.bg,
    border: `1.5px solid ${theme.border}`, borderRadius: 8, color: theme.text,
    fontFamily: "inherit", fontSize: 14, padding: "10px 13px",
    outline: "none", lineHeight: 1.6, resize: multiline ? "vertical" : "none",
    transition: "background 0.2s, border-color 0.2s, color 0.2s", ...style,
  };
  return multiline
    ? <textarea rows={rows} style={base} value={value} onChange={onChange} placeholder={placeholder} {...rest} />
    : <input style={base} value={value} onChange={onChange} placeholder={placeholder} {...rest} />;
}
