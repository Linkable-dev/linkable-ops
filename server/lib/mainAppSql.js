// SQL fragments for main-app columns whose meaning is not obvious from the
// column name. Shared so the same money never gets computed two different ways
// on two different pages.

// orders.commission is the commission RATE FOR THAT ORDER, as text, in percent
// — not an amount. It is copied from products.sale_commission at order time
// (values seen in prod: 10, 15, 20, 25, 28, 30, 40, 50, 60). Summing the column
// adds up percentages: four orders at 10/10/10/30 read as "£60 earned" when the
// commission actually earned on £162 of GMV was £24.60.
//
// `alias` is the orders table alias ("o" → o.commission), or "" for a bare
// `FROM orders`. Rows whose rate is missing, non-numeric, or outside 0–100
// contribute nothing rather than poisoning the sum.
export function commissionEarnedSql(alias = "") {
  const p = alias ? `${alias}.` : "";
  return `SUM(
    CASE WHEN ${p}commission ~ '^[0-9]+(\\.[0-9]+)?$'
              AND ${p}commission::numeric <= 100
              AND ${p}shopify_amount IS NOT NULL
         THEN ${p}shopify_amount * ${p}commission::numeric / 100.0
         ELSE 0 END)`;
}

// A Shopify subscription created in test mode bills nobody. Shopify keeps the
// row alive and ACTIVE, so revenue that filters only on status counts money
// that will never arrive. Applied wherever subscriptions become revenue.
export const NOT_TEST_SUB = (alias = "asub") => `COALESCE(${alias}.test, false) = false`;

// ── Subscriptions: Shopify plans and card plans ─────────────────────────────
//
// A brand holds a plan when users.account_id names one. Shopify plans read
// "shopify_<price>_<monthly|yearly>" and are billed in USD by Shopify. Since
// main app PR #371 a brand without a store can pay by card instead: Stripe
// bills it in GBP, account_id reads "stripe_<plan>_<monthly|yearly>" while the
// plan runs, and its app_subscriptions row has provider 'stripe' with Stripe's
// own status in stripe_status (trialing / active / past_due / unpaid / ...).
// A card plan's status column is mapped onto the Shopify vocabulary, so a
// declined card reads FROZEN there too. Every fragment below takes the
// mainAppSchema() flags and returns the pre-card SQL where the target has no
// card billing yet (prod until the promotion), so prod runs what it ran before.

export const SHOPIFY_PLAN_SQL = `u.account_id ~ '^shopify_[0-9]+'`;
export const CARD_PLAN_SQL = `u.account_id LIKE 'stripe\\_%'`;

// The brand holds a paid plan of either kind.
export const paidPlanSql = (schema) =>
  schema.cardBilling ? `(${SHOPIFY_PLAN_SQL} OR ${CARD_PLAN_SQL})` : SHOPIFY_PLAN_SQL;

// What each card plan costs, in GBP (service-grpc/services/card_billing.go
// cardPlanPence). Only a fallback for a row whose price_amount is missing: the
// subscription row carries the price Stripe actually charges.
export const CARD_PLAN_GBP = {
  starter: { monthly: 99, yearly: 990 },
  growth: { monthly: 199, yearly: 1990 },
  scale: { monthly: 499, yearly: 4990 },
};
// Card plans as the app names them (cardPlanTitles).
export const CARD_PLAN_TITLES = { starter: "Starter", growth: "Growth", scale: "Scale" };

const cardPlanPriceCase = `CASE ${Object.entries(CARD_PLAN_GBP).flatMap(([plan, p]) => [
  `WHEN u.account_id = 'stripe_${plan}_monthly' THEN ${p.monthly}`,
  `WHEN u.account_id = 'stripe_${plan}_yearly' THEN ${p.yearly}`,
]).join(" ")} END`;

// The card plan's price for one billing period, in GBP.
export const cardPlanAmountSql = (alias = "asub") =>
  `COALESCE(NULLIF(${alias}.price_amount, 0), ${cardPlanPriceCase})`;

// The card plan's tier as the brand sees it.
export const cardPlanTierSql = `CASE
  WHEN u.account_id LIKE 'stripe\\_scale\\_%' THEN 'Scale'
  WHEN u.account_id LIKE 'stripe\\_growth\\_%' THEN 'Growth'
  WHEN u.account_id LIKE 'stripe\\_starter\\_%' THEN 'Starter'
  ELSE 'Card plan' END`;

// One app_subscriptions row per brand, joined as `alias`: the live one if
// there is one, else the newest. With card billing, the row from the provider
// account_id names wins first, so a brand that moved from Shopify to a card
// (or back) is judged by the plan it holds now, not by the old one.
// `columns` is what the caller reads from it.
export function subscriptionLateral(schema, columns, alias = "asub") {
  if (!schema.appSubscriptions) return "";
  const cardCols = schema.cardBilling
    ? `, provider, stripe_status, plan_key, billing_period, cancel_at_period_end`
    : `, 'shopify'::text AS provider, ''::text AS stripe_status, ''::text AS plan_key,
         ''::text AS billing_period, false AS cancel_at_period_end`;
  const providerFirst = schema.cardBilling
    ? `(provider = CASE WHEN ${CARD_PLAN_SQL} THEN 'stripe' ELSE 'shopify' END) DESC,`
    : "";
  // A card row has no shopify_created_at; its own created stands in.
  const createdAt = schema.cardBilling ? "COALESCE(shopify_created_at, created)" : "shopify_created_at";
  return `LEFT JOIN LATERAL (
       SELECT ${columns}${cardCols}
         FROM app_subscriptions
        WHERE user_id = u.id
        ORDER BY ${providerFirst}
                 (status = 'ACTIVE' AND cancelled_at IS NULL) DESC,
                 ${createdAt} DESC NULLS LAST,
                 synced_at DESC NULLS LAST
        LIMIT 1
     ) ${alias} ON true`;
}

// Money in its own currency for a sentence ("$199", "£99.50").
export function formatMoney(amount, currency = "USD") {
  const n = Number(amount || 0);
  const cur = String(currency || "USD").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency", currency: cur,
      minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${cur} ${n}`;
  }
}
