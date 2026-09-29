import { useTheme } from "../../contexts/ThemeContext";

// An on/off switch for a setting that takes effect by itself, like a campaign
// running. A button labelled with the action ("Hold", "Start") made you work
// out the current state from the opposite word; a switch shows the state.
export function Toggle({ checked, onChange, disabled, label, title }) {
  const { theme } = useTheme();
  const on = Boolean(checked);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!on)}
      style={{
        position: "relative", width: 36, height: 20, borderRadius: 999, padding: 0, flexShrink: 0,
        border: "none", cursor: disabled ? "wait" : "pointer", transition: "background 0.15s",
        background: on ? theme.success : theme.border, opacity: disabled ? 0.6 : 1,
      }}
    >
      <span style={{
        position: "absolute", top: 2, left: on ? 18 : 2, width: 16, height: 16, borderRadius: 999,
        background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,0.25)", transition: "left 0.15s",
      }} />
    </button>
  );
}
