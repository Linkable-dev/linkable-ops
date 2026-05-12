// ICP scoring for Linkable's brand outbound.
//
// Each storeleads_brands row gets a brand_score (0..10) computed from
// signals already present in raw_data + contact fields. The daily-200
// orchestrator only enrolls brands with score >= MIN_SEND_SCORE.
//
// Weights are deliberate but not load-bearing — store the per-component
// breakdown so we can tune from reply-outcome data after ~200 sends.
//
// Why 7? It cuts the bottom ~70% of the pool (low-revenue / wrong-vertical /
// stale / generic-email rows) while keeping enough volume for the daily cap.
// Adjust after we have outcome data tied to scores.

export const MIN_SEND_SCORE = 7;

// Verticals where creator-led commerce actually works for Shopify brands.
// Anything outside this set scores 0 on vertical fit.
const FIT_VERTICALS = new Set([
  "beauty", "skincare", "haircare", "makeup", "fragrance",
  "wellness", "supplements", "fitness",
  "fashion", "apparel", "jewelry",
  "food", "beverage",
  "home", "bedding",
  "pet", "baby",
]);

// Map StoreLeads category paths → our internal vertical tags. StoreLeads
// uses paths like "/Beauty & Fitness/Face & Body Care/Skin & Nail Care".
// We classify by substring against the path so we don't need the full
// taxonomy mapped.
const CATEGORY_TO_VERTICAL = [
  [/skin|face|nail/i, "skincare"],
  [/hair|shampoo|conditioner/i, "haircare"],
  [/make-?up|cosmetics/i, "makeup"],
  [/fragrance|perfume|cologne/i, "fragrance"],
  [/nutrition|supplement|vitamin/i, "supplements"],
  [/fitness|gym|exercise|workout/i, "fitness"],
  [/beauty/i, "beauty"],
  [/health|wellness/i, "wellness"],
  [/apparel|clothing|fashion/i, "apparel"],
  [/jewel|jewellery/i, "jewelry"],
  [/food|snack|grocery/i, "food"],
  [/beverage|drink|coffee|tea/i, "beverage"],
  [/home|kitchen|bedding|decor|furniture/i, "home"],
  [/pet/i, "pet"],
  [/baby|kids|children/i, "baby"],
];

function deriveVertical(row) {
  const cats = row?.raw_data?.categories;
  const catText = Array.isArray(cats) ? cats.join(" ") : (typeof cats === "string" ? cats : "");
  const blob = [
    catText,
    row?.title || "",
    row?.description || "",
    row?.about_us || "",
  ].join(" ");
  for (const [re, vertical] of CATEGORY_TO_VERTICAL) {
    if (re.test(blob)) return vertical;
  }
  return null;
}

// Mirrors detectCreatorSignals() in run-daily-200.js — keep the regex
// in sync with that file. A brand with any creator/affiliate platform
// installed has proven budget for this category, which is the strongest
// non-revenue signal we have.
const AFFILIATE_APP_NAME = /\b(refersion|shareasale|goaffpro|leaddyno|tapfiliate|uppromote|social\s*snowball|post\s*affiliate|partnerstack|awin|skimlinks|shopify\s+collabs|levanta|aspire|grin|ltk|shopmy)\b/i;
const CREATOR_APP_KEYWORD = /\b(creator|influencer|ambassador|affiliate|referral)\b/i;

function hasCreatorStack(row) {
  const apps = Array.isArray(row?.raw_data?.apps) ? row.raw_data.apps : [];
  for (const a of apps) {
    const name = `${a?.name || ""} ${a?.vendor_name || ""}`;
    const cats = Array.isArray(a?.categories) ? a.categories.join(" ") : "";
    if (AFFILIATE_APP_NAME.test(name)) return true;
    if (CREATOR_APP_KEYWORD.test(name) || CREATOR_APP_KEYWORD.test(cats)) return true;
  }
  return false;
}

// Revenue is in monthly USD (raw_data.estimated_sales). The StoreLeads
// search-time `er` field is in cents and lives only in the query payload;
// the brand response uses estimated_sales directly.
//
// Scoring band reflects budget-fit, not revenue-fit:
//   < $80k/mo   — too small, no budget for $99+ SaaS, founder is in survival
//   $80k–$300k  — founder-led, evaluating first creator tool, self-serve fit
//   $300k–$1M   — has marketing budget, prime for demo bookings
//   $1M–$2M     — still pre-enterprise tools, strong demo target
//   > $2M       — likely on Aspire/GRIN already; different sales motion
function scoreRevenue(row) {
  const rev = Number(row?.raw_data?.estimated_sales);
  if (!Number.isFinite(rev) || rev <= 0) return 0;
  if (rev < 80_000) return 0;
  if (rev < 300_000) return 2;
  if (rev < 1_000_000) return 3;
  if (rev < 2_000_000) return 2;
  return 1;   // $2M+ is reachable but harder to convert via cold
}

function scoreVertical(row) {
  const v = deriveVertical(row);
  if (v && FIT_VERTICALS.has(v)) return 2;
  return 0;
}

function scoreCreatorReady(row) {
  if (hasCreatorStack(row)) return 2;
  // Soft signal: has an /ambassadors or /affiliate page on file.
  const aboutBlob = `${row?.about_us || ""} ${row?.contact_page || ""}`.toLowerCase();
  if (/ambassador|affiliate|creator program/.test(aboutBlob)) return 1;
  return 0;
}

function scoreRecency(row) {
  const ts = row?.last_updated_at || row?.imported_at;
  if (!ts) return 0;
  const ageMs = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(ageMs)) return 0;
  const days = ageMs / 86_400_000;
  if (days <= 90) return 1;
  return 0;
}

// Email quality: a generic inbox or one without a real first name is
// nearly worthless for personalised cold. The ingestion-time getBestEmail()
// already rejects most generics, but role-based emails still slip through
// (e.g. marketing@brand.com from Hunter).
function scoreEmailQuality(row) {
  const email = (row?.email || "").toLowerCase();
  const firstName = (row?.contact_first_name || "").trim();
  if (!email || !firstName) return 0;
  const local = email.split("@")[0] || "";
  if (/^[a-z]+\.[a-z]+$/.test(local)) return 2;          // first.last@ — personal
  if (/^[a-z]{2,15}$/.test(local)) return 1;              // single word — usually a first name
  return 0;
}

// Public entry point. Returns { score, breakdown }.
//
// `row` is a storeleads_brands row (or an in-memory equivalent during
// ingestion before the row exists). Caller is responsible for writing
// brand_score / brand_score_breakdown / scored_at back to the table.
export function scoreBrand(row) {
  const revenue = scoreRevenue(row);
  const vertical = scoreVertical(row);
  const creatorReady = scoreCreatorReady(row);
  const recency = scoreRecency(row);
  const emailQuality = scoreEmailQuality(row);

  const score = revenue + vertical + creatorReady + recency + emailQuality;

  const breakdown = {
    revenue,
    vertical,
    creator_ready: creatorReady,
    recency,
    email_quality: emailQuality,
    vertical_tag: deriveVertical(row),
    estimated_sales: Number(row?.raw_data?.estimated_sales) || null,
  };

  return { score, breakdown };
}
