// Brand-group classifier for the multi-touch outbound sequencer.
// Three groups, deterministic precedence: G2 (summer) > G1 (creator-active) > G3 (cold).
// G2 wins ties because the summer angle converts harder during the May–Aug window.

import { getPrimaryProductType } from "./templates.js";

export const GROUPS = {
  G1: "G1",   // Already works with creators / affiliates / influencers
  G2: "G2",   // Summer-seasonal categories (drinks, swim, sun, fragrance, outdoor, etc.)
  G3: "G3",   // Cold catch-all
};

// Daily volume mix (fractions; sum ≤ 1). The orchestrator weights NEW T+0 picks by these.
export const DAILY_MIX = {
  G2: 0.60,
  G1: 0.25,
  G3: 0.15,
};

// Summer keyword set — extends the category map in templates.js with seasonal-specific signals.
const SUMMER_KEYWORDS = [
  // beverages / hydration
  "kombucha", "matcha", "iced tea", "cold brew", "iced coffee", "sparkling water",
  "hydration", "electrolyte", "smoothie", "juice", "lemonade",
  // swimwear / loungewear
  "swim", "swimwear", "bikini", "loungewear", "activewear", "athleisure", "beachwear",
  // sun / bath / body
  "spf", "sunscreen", "sun care", "after-sun", "self-tan", "self tan", "tanning",
  "body oil", "shower gel", "bath",
  // fragrance (lighter summer scents)
  "fragrance", "perfume", "cologne",
  // outdoor / travel
  "outdoor", "camping", "hiking", "water bottle", "cooler", "picnic", "festival",
  // frozen / summer food
  "popsicle", "ice cream", "frozen", "sorbet",
];

const SUMMER_PRODUCT_TYPES = new Set([
  "beverage", "fragrance", "outdoor", "fitness",
]);

function brandText(brand) {
  const bi = brand.brandInfo || {};
  return [
    brand.storeName, brand.name, brand.merchant_name, brand.title, brand.description,
    bi.brandStory, bi.usp, brand.about_us,
    ...(brand.matchedKeywords || []),
    ...(brand.sampleTypes || []),
  ].filter(Boolean).join(" ").toLowerCase();
}

function isSummerBrand(brand) {
  const text = brandText(brand);
  if (SUMMER_KEYWORDS.some((kw) => text.includes(kw))) return true;
  const pt = getPrimaryProductType(brand.matchedKeywords || [], brand.sampleTypes || [], text);
  if (SUMMER_PRODUCT_TYPES.has(pt)) return true;
  return false;
}

function isCreatorActive(brand) {
  const bi = brand.brandInfo || {};
  return !!(bi.hasCreators || bi.hasAffiliates || bi.hasInfluencers);
}

// Classify a brand into G1/G2/G3. Precedence: G2 > G1 > G3.
//
// `brand` shape mirrors what run-storeleads.js / lead-discovery.js produce —
// either a StoreLeads row (merchant_name, description, raw_data) or the
// scraped enrichment shape (storeName, brandInfo, matchedKeywords, sampleTypes).
export function classifyBrand(brand) {
  if (!brand) return GROUPS.G3;
  if (isSummerBrand(brand)) return GROUPS.G2;
  if (isCreatorActive(brand)) return GROUPS.G1;
  return GROUPS.G3;
}

// Allocate a daily quota to each group given a total daily cap.
// Returns { G1: n1, G2: n2, G3: n3 } with sum ≤ total.
export function allocateDailyQuota(total) {
  const g2 = Math.floor(total * DAILY_MIX.G2);
  const g1 = Math.floor(total * DAILY_MIX.G1);
  const g3 = total - g2 - g1;   // remainder so we always sum to `total`
  return { G2: g2, G1: g1, G3: g3 };
}
