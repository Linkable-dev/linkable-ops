// Alert severity palette shared by the Alerts page, the Home strip and the header bell.
export const SEVERITY = {
  danger: { label: "Act now", color: "#DC2626", bg: "#FEE2E2" },
  warn:   { label: "Watch",   color: "#D97706", bg: "#FEF3C7" },
  info:   { label: "FYI",     color: "#2563EB", bg: "#DBEAFE" },
};

// Fired after a dismissal so the header bell and the Home strip refresh at once.
export const ALERTS_CHANGED = "lk-alerts-changed";
export function notifyAlertsChanged() {
  try { window.dispatchEvent(new Event(ALERTS_CHANGED)); } catch { /* no window */ }
}
