// Plan picker for admin-granted trials. `value` is stored verbatim as
// brands.trial_plan_name and validated server-side (VALID_TRIAL_PLANS in
// admin-users.js). The main app resolves it to a billing plan via
// resolvePlanKey when the brand accepts the trial, so any of the values below
// (and the legacy "grow"/"starter" slugs still on older brands) activate
// correctly. Order = display order in the picker.
//
// Labels/prices mirror the customer-facing 2-plan lineup (2026-07 rebrand):
// the $199 tier shows to brands as "Starter", the $499 tier as "Growth".

export const TRIAL_PLANS = [
  {
    value: "growth",
    label: "Starter",
    description: "Entry tier — up to 2 campaigns, 50 creators. Default for new trials.",
    priceMonthly: 199,
    priceAnnual: 1990,
    isDefault: true,
  },
  {
    value: "scale",
    label: "Growth",
    description: "Higher tier — up to 10 campaigns, 500 creators.",
    priceMonthly: 499,
    priceAnnual: 4990,
    isDefault: false,
  },
];

// Legacy trial_plan_name slugs still stored on brands granted before the
// 2026-07 rebrand. Map them onto the current picker entries so their label and
// price still resolve (the main app resolves them for billing the same way).
const LEGACY_SLUG_ALIASES = { starter: "growth", grow: "growth" };

export const DEFAULT_PLAN = TRIAL_PLANS.find((p) => p.isDefault)?.value || "growth";
export const DEFAULT_DAYS = 14;
export const DEFAULT_INTERVAL = "monthly";

export function planByValue(value) {
  const normalized = String(value || "").toLowerCase();
  const resolved = LEGACY_SLUG_ALIASES[normalized] ?? normalized;
  return TRIAL_PLANS.find((p) => p.value === resolved) || null;
}

export function planLabel(value) {
  return planByValue(value)?.label || value || "—";
}

// Format a plan + interval pair into a single human string for confirm dialogs
// and audit displays, e.g. "Starter (Monthly, $199)".
export function formatPlanLine(value, interval) {
  const p = planByValue(value);
  const left = p ? p.label : (value || "—");
  const right = interval === "annual" ? "Annual" : "Monthly";
  const price = interval === "annual" ? p?.priceAnnual : p?.priceMonthly;
  return price ? `${left} (${right}, $${price})` : `${left} (${right})`;
}
