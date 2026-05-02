// Build a human-readable campaign name from the target filters.
// Examples:
//   { countries:["US"], categories:["beauty"], min:200000, max:1000000 }
//     -> "US Beauty 200k-1M"
//   { countries:["US","GB"], categories:["wellness"], min:50000, max:150000 }
//     -> "US+GB Wellness 50k-150k"
//   { countries:[], categories:["/Beauty & Fitness/Face & Body Care/Skin & Nail Care"], min:0, max:300000 }
//     -> "Global Skin & Nail Care <300k"

export function suggestCampaignName({ countries = [], categories = [], minRevenue, maxRevenue } = {}) {
  const cs = (countries || []).map((c) => c?.toString().trim().toUpperCase()).filter(Boolean);
  const country = cs.length === 0 ? "Global"
    : cs.length <= 3 ? cs.join("+")
    : `${cs.length} countries`;

  const cats = (categories || []).map((c) => c?.toString().trim()).filter(Boolean);
  const catLabel = cats.length ? prettyCategory(cats[0]) : "";

  const minF = fmtRevenue(minRevenue);
  const maxF = fmtRevenue(maxRevenue);
  const rev = minF && maxF ? `${minF}-${maxF}`
    : minF ? `${minF}+`
    : maxF ? `<${maxF}`
    : "";

  return [country, catLabel, rev].filter(Boolean).join(" ");
}

function prettyCategory(c) {
  if (!c) return "";
  // StoreLeads path like "/Beauty & Fitness/Face & Body Care/Skin & Nail Care"
  // → use the leaf segment ("Skin & Nail Care") which is what people read.
  if (c.startsWith("/")) {
    const parts = c.split("/").filter(Boolean);
    return parts[parts.length - 1];
  }
  // Preset token like "beauty" → "Beauty".
  return c.charAt(0).toUpperCase() + c.slice(1);
}

function fmtRevenue(n) {
  const x = Number(n);
  if (!x) return "";
  if (x >= 1_000_000) {
    const m = x / 1_000_000;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (x >= 1_000) return `${Math.round(x / 1_000)}k`;
  return String(x);
}
