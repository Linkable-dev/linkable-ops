// Shared alert helpers (severity palette, per-browser snoozes).
export const SEVERITY = {
  danger: { label: "Act now", color: "#DC2626", bg: "#FEE2E2" },
  warn:   { label: "Watch",   color: "#D97706", bg: "#FEF3C7" },
  info:   { label: "FYI",     color: "#2563EB", bg: "#DBEAFE" },
};
const SNOOZE_KEY = "lk-alert-snooze";

export function readSnoozes() {
  try { return JSON.parse(localStorage.getItem(SNOOZE_KEY) || "{}"); } catch { return {}; }
}
export function writeSnoozes(map) {
  try { localStorage.setItem(SNOOZE_KEY, JSON.stringify(map)); } catch { /* storage unavailable */ }
}
export function isSnoozed(key, snoozes = readSnoozes()) {
  return !!(snoozes[key] && snoozes[key] > Date.now());
}
