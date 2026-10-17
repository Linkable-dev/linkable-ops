// Which parts of the main app's schema the target database has.
//
// ops reads prod and dev, and the two are rarely on the same main-app release:
// dev gets a table weeks before a promotion takes it to prod. A query that names
// a table or column the target lacks fails the whole request (42P01 / 42703),
// so every query that touches something new asks here first and keeps the old
// SQL where it is absent. The answer is cached per target for a few minutes, so
// a promotion is picked up without a restart.
//
//   appSubscriptions   app_subscriptions (the Shopify subscription mirror)
//   cardBilling        app_subscriptions.provider: card plans billed by Stripe
//                      are rows with provider 'stripe' (main app PR #371)
//   billingInvoices    billing_invoices, the card plan invoices (#371)
//   invoiceRetries     billing_invoices.amount_due / attempt_count /
//                      next_payment_attempt (payments part 2, #377)
//   shopProducts       shop_products + shop_product_variants: the catalogue (#376)
//   isCampaign         products.is_campaign: a products row is a campaign (#376)
//   payoutHolds        payout_holds (#377)
//   creatorFeeCharges  creator_fee_charges, fees charged on approval (#372)
//   connectIssues      connect_account_issues (#377)
//   inviteLinks        invite_links, private campaign invite links (#379)
//   feeStop            creator_fee_charges.release_at + stopped_at: the 48h
//                      hold after the post link, and support stopping one held
//                      fee (StopCreatorFee, main app PR #446)
//   feeReports         payout_reports.fee_id: a brand's "Report a problem" on
//                      a fee row (#446)
import { cloudSqlQuery, currentDbTarget } from "./cloudsql.js";

const TTL_MS = 5 * 60_000;
const cache = new Map(); // target -> { at, value }

const col = (table, column) =>
  `EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = '${column}')`;
const tbl = (table) => `to_regclass('public.${table}') IS NOT NULL`;

const PROBE_SQL = `SELECT
  ${tbl("app_subscriptions")} AS app_subscriptions,
  ${col("app_subscriptions", "provider")} AS card_billing,
  ${tbl("billing_invoices")} AS billing_invoices,
  ${col("billing_invoices", "amount_due")} AS invoice_retries,
  ${tbl("shop_products")} AS shop_products,
  ${col("products", "is_campaign")} AS is_campaign,
  ${tbl("payout_holds")} AS payout_holds,
  ${tbl("creator_fee_charges")} AS creator_fee_charges,
  ${tbl("connect_account_issues")} AS connect_issues,
  ${tbl("invite_links")} AS invite_links,
  (${col("creator_fee_charges", "release_at")} AND ${col("creator_fee_charges", "stopped_at")}) AS fee_stop,
  ${col("payout_reports", "fee_id")} AS fee_reports`;

const NOTHING = Object.freeze({
  appSubscriptions: false, cardBilling: false, billingInvoices: false, invoiceRetries: false,
  shopProducts: false, isCampaign: false, payoutHolds: false, creatorFeeCharges: false,
  connectIssues: false, inviteLinks: false, feeStop: false, feeReports: false,
});

export async function mainAppSchema(target = currentDbTarget()) {
  const hit = cache.get(target);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value = NOTHING;
  try {
    const { rows } = await cloudSqlQuery(PROBE_SQL, [], target);
    const r = rows[0] || {};
    value = Object.freeze({
      appSubscriptions: r.app_subscriptions === true,
      cardBilling: r.card_billing === true,
      billingInvoices: r.billing_invoices === true,
      invoiceRetries: r.invoice_retries === true,
      shopProducts: r.shop_products === true,
      isCampaign: r.is_campaign === true,
      payoutHolds: r.payout_holds === true,
      creatorFeeCharges: r.creator_fee_charges === true,
      connectIssues: r.connect_issues === true,
      inviteLinks: r.invite_links === true,
      feeStop: r.fee_stop === true,
      feeReports: r.fee_reports === true,
    });
  } catch (err) {
    // A failed probe answers "nothing new", so callers run the old SQL. Not
    // cached, so the next request asks again.
    console.warn(`[mainAppSchema] probe failed on ${target}: ${err.message}`);
    return NOTHING;
  }
  cache.set(target, { at: Date.now(), value });
  return value;
}
