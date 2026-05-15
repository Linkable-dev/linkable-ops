// Friendly labels + descriptions for the main-app billing plans.
// Slugs (`starter`/`grow`/`scale`) are validated server-side in
// admin-users.js (VALID_TRIAL_PLANS); changing them here without updating
// the backend will produce 400s. Order = display order in the picker.
//
// TODO(luca): drop the actual monthly + annual prices into `priceMonthly`
// and `priceAnnual` so the picker shows "$X/mo" instead of just the
// description. Pulled from main-app billing config — values aren't in the
// ops repo today.

export const TRIAL_PLANS = [
  {
    value: "starter",
    label: "Starter",
    description: "Entry tier — solo brand, getting started.",
    priceMonthly: null,
    priceAnnual: null,
    isDefault: false,
  },
  {
    value: "grow",
    label: "Grow",
    description: "Most common trial plan. Default for new trials.",
    priceMonthly: null,
    priceAnnual: null,
    isDefault: true,
  },
  {
    value: "scale",
    label: "Scale",
    description: "Enterprise tier — high-volume brands.",
    priceMonthly: null,
    priceAnnual: null,
    isDefault: false,
  },
];

export const DEFAULT_PLAN = TRIAL_PLANS.find((p) => p.isDefault)?.value || "grow";
export const DEFAULT_DAYS = 14;
export const DEFAULT_INTERVAL = "monthly";

export function planByValue(value) {
  return TRIAL_PLANS.find((p) => p.value === value) || null;
}

export function planLabel(value) {
  return planByValue(value)?.label || value || "—";
}

// Format a plan + interval pair into a single human string for confirm
// dialogs and audit displays. Falls back gracefully when fields are sparse.
export function formatPlanLine(value, interval) {
  const p = planByValue(value);
  const left = p ? p.label : (value || "—");
  const right = interval === "annual" ? "Annual" : "Monthly";
  // Drop the price suffix until the constants are populated; once a plan has
  // a priceMonthly/priceAnnual set, the picker and confirm dialog will start
  // showing it automatically.
  const price = interval === "annual" ? p?.priceAnnual : p?.priceMonthly;
  return price ? `${left} (${right}, ${price})` : `${left} (${right})`;
}
