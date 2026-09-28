// How many creators are on Linkable, by niche - the number a DM to a brand may
// quote.
//
// The DMs Federico wrote by hand opened with "We have 10,000+ beauty and
// skincare creators on Linkable". Prod had 628 creators in total and 20 in
// beauty and skincare when this was written, so the number a drafted DM uses
// comes from here, counted live, rounded DOWN, and never from the model.
//
// Read from the product database (prod), cached for an hour: fifty drafts in a
// row should cost one query, and the count does not move that fast.

import { cloudSqlQuery, runWithDbTarget } from "./cloudsql.js";

const TTL_MS = 60 * 60 * 1000;
let cached = null;

// How the product's niche codes read in a sentence.
const NICHE_WORDS = {
  FASHION_ACCESSORIES: "fashion and accessories",
  HEALTH_WELLNESS: "health and wellness",
  BEAUTY_SKINCARE: "beauty and skincare",
  BABY_PARENTING: "parenting",
  LUXURY: "luxury",
  TRAVEL: "travel",
  HOME_LIVING: "home and lifestyle",
  PETS: "pet",
  FOOD_BEVERAGE: "food and drink",
  FITNESS_SPORTS: "fitness",
  TECHNOLOGY: "tech",
  SUSTAINABILITY_ECO: "sustainable living",
};

// Only a niche with at least this many creators is quoted by name. "20+ beauty
// creators" is true and still a reason not to reply.
export const MIN_QUOTED = 50;

// Round down to a number a person would say: 628 -> 600, 166 -> 150, 104 -> 100.
export function roundDown(n) {
  if (n >= 1000) return Math.floor(n / 500) * 500;
  if (n >= 200) return Math.floor(n / 100) * 100;
  if (n >= 100) return Math.floor(n / 50) * 50;
  return Math.floor(n / 10) * 10;
}

// Rows of { niche, n } -> { total, niches: [{ label, count }] }, largest first.
// A creator with several niches ("BEAUTY_SKINCARE | HEALTH_WELLNESS") counts in
// each of them, which is what "we have N beauty creators" means.
export function summarisePool(rows, total) {
  const byNiche = {};
  for (const row of rows) {
    for (const code of String(row.niche || "").split("|").map((s) => s.trim().toUpperCase())) {
      if (NICHE_WORDS[code]) byNiche[code] = (byNiche[code] || 0) + Number(row.n || 0);
    }
  }
  return {
    total: roundDown(Number(total) || 0),
    niches: Object.entries(byNiche)
      .filter(([, n]) => n >= MIN_QUOTED)
      .sort((a, b) => b[1] - a[1])
      .map(([code, n]) => ({ label: NICHE_WORDS[code], count: roundDown(n) })),
  };
}

// → { total, niches } or null when the product database cannot be read. A
// null means the DM states no number at all, which is always true.
export async function creatorPool() {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.pool;
  try {
    const pool = await runWithDbTarget("prod", async () => {
      // users.deleted = 'infinity' is a live account in this schema.
      const { rows } = await cloudSqlQuery(`
        SELECT i.niche, COUNT(*)::int AS n
        FROM influencers i JOIN users u ON u.id = i.user_id
        WHERE u.deleted = 'infinity' AND NULLIF(TRIM(i.niche), '') IS NOT NULL
        GROUP BY i.niche`);
      const { rows: all } = await cloudSqlQuery(`
        SELECT COUNT(*)::int AS n
        FROM influencers i JOIN users u ON u.id = i.user_id
        WHERE u.deleted = 'infinity'`);
      return summarisePool(rows, all[0]?.n);
    });
    cached = { at: Date.now(), pool };
    return pool;
  } catch (err) {
    console.error("[creator-pool] could not count creators:", err?.message);
    return null;
  }
}
