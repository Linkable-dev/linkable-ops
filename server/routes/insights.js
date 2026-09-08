// Insights: funnel alerts, Brand 360, Home time series, "Ask the data" and the
// command-palette search. Read-only against Cloud SQL (plus Supabase for the
// outbound history), mounted behind requireOpsAdmin + dbTargetMiddleware.
import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { cloudSqlQuery, getCloudSqlPool } from "../lib/cloudsql.js";
import { supabase } from "../lib/supabase.js";
import { getDefaultTeamId } from "../automation/conversation-state.js";

// Soft-delete sentinel used across the main app's tables.
const ND = (a) => `(${a}.deleted IS NULL OR ${a}.deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`;
const BRAND_ACTIVE = `u.role = 2 AND u.deleted = 'infinity'::timestamptz AND b.deleted = '-infinity'::timestamptz`;
const LINK = { INVITED: 1, APPLIED: 2, ACCEPTED: 3, REJECTED: 4, ENDED: 5 };
// products.status 5 is a Shopify-synced product that was never launched as a campaign.
const PRODUCT_STATUS = { 0: "unset", 1: "new", 2: "active", 3: "paused", 4: "ended", 5: "not launched" };

const hasTable = (name) =>
  cloudSqlQuery(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`])
    .then((r) => r.rows[0]?.ok === true)
    .catch(() => false);

const int = (v) => parseInt(v || 0, 10) || 0;
const num = (v) => parseFloat(v || 0) || 0;

/* ------------------------------------------------------------------ alerts */

// Each alert: { key, kind, severity: danger|warn|info, title, detail, since,
// brand: { user_id, store_name, email }, campaign?: { id, title }, href? }.
// Thresholds are days; the defaults are what an operator would chase.
export async function buildAlerts({ shipDays = 5, applyDays = 7, trialDays = 3, purgeDays = 7, staleSaleDays = 30 } = {}) {
  const alerts = [];
  const brandSel = `u.id AS user_id, b.store_name, u.email`;
  const brandJoin = `JOIN users u ON u.id = p.user_id JOIN brands b ON b.user_id = u.id`;

  const [accepted, pending, applications, trials, grace, purge, staleSales, noSample] = await Promise.all([
    // Brand accepted a sample request but never shipped it.
    cloudSqlQuery(`
      SELECT ${brandSel}, p.id AS product_id, p.title, COUNT(*) AS n, MIN(sr.updated) AS since
      FROM sample_requests sr JOIN products p ON p.id = sr.product_id ${brandJoin}
      WHERE ${BRAND_ACTIVE} AND ${ND("sr")} AND ${ND("p")} AND sr.status = 'accepted'
        AND sr.updated < NOW() - ($1 || ' days')::interval
      GROUP BY u.id, b.store_name, u.email, p.id, p.title ORDER BY since`, [shipDays]),
    // Creator asked for a sample and the brand has not answered.
    cloudSqlQuery(`
      SELECT ${brandSel}, p.id AS product_id, p.title, COUNT(*) AS n, MIN(sr.created) AS since
      FROM sample_requests sr JOIN products p ON p.id = sr.product_id ${brandJoin}
      WHERE ${BRAND_ACTIVE} AND ${ND("sr")} AND ${ND("p")} AND sr.status = 'pending'
        AND sr.created < NOW() - ($1 || ' days')::interval
      GROUP BY u.id, b.store_name, u.email, p.id, p.title ORDER BY since`, [shipDays]),
    // Creator applications the brand has left waiting.
    cloudSqlQuery(`
      SELECT ${brandSel}, p.id AS product_id, p.title, COUNT(*) AS n, MIN(l.created) AS since
      FROM links l JOIN products p ON p.id = l.product_id ${brandJoin}
      WHERE ${BRAND_ACTIVE} AND ${ND("l")} AND ${ND("p")} AND p.status = 2 AND l.status = ${LINK.APPLIED}
        AND l.created < NOW() - ($1 || ' days')::interval
      GROUP BY u.id, b.store_name, u.email, p.id, p.title ORDER BY since`, [applyDays]),
    // Trials about to end. Flag harder when the brand never launched a campaign.
    cloudSqlQuery(`
      SELECT ${brandSel}, b.trial_expiration_date, b.trial_plan_name, u.account_id,
             (SELECT COUNT(*) FROM products p WHERE p.user_id = u.id AND p.status = 2 AND ${ND("p")}) AS active_campaigns
      FROM users u JOIN brands b ON b.user_id = u.id
      WHERE ${BRAND_ACTIVE} AND b.trial_expiration_date > NOW()
        AND b.trial_expiration_date < NOW() + ($1 || ' days')::interval
      ORDER BY b.trial_expiration_date`, [trialDays]),
    // Cancelled while still inside the trial-access window.
    cloudSqlQuery(`
      SELECT ${brandSel}, b.trial_expiration_date
      FROM users u JOIN brands b ON b.user_id = u.id
      WHERE ${BRAND_ACTIVE} AND (COALESCE(u.account_id, '') = '' OR u.account_id IN ('shopify_free_plan', 'free_plan'))
        AND COALESCE(b.trial_plan_name, '') = '' AND b.trial_expiration_date > NOW()
        AND b.trial_expiration_date < NOW() + ($1 || ' days')::interval
      ORDER BY b.trial_expiration_date`, [purgeDays]),
    // Soft-deleted brands whose hard delete is imminent.
    cloudSqlQuery(`
      SELECT u.id AS user_id, b.store_name, u.email, u.deletion_scheduled_for, u.deletion_reason
      FROM users u LEFT JOIN brands b ON b.user_id = u.id
      WHERE u.role = 2 AND u.deleted <> 'infinity'::timestamptz AND u.deleted <> '-infinity'::timestamptz
        AND u.deletion_scheduled_for IS NOT NULL AND u.deletion_scheduled_for < NOW() + ($1 || ' days')::interval
      ORDER BY u.deletion_scheduled_for`, [purgeDays]),
    // Samples shipped a month ago, still no sale on the campaign.
    cloudSqlQuery(`
      SELECT ${brandSel}, p.id AS product_id, p.title, COUNT(*) AS n, MIN(sr.updated) AS since
      FROM sample_requests sr JOIN products p ON p.id = sr.product_id ${brandJoin}
      WHERE ${BRAND_ACTIVE} AND ${ND("sr")} AND ${ND("p")} AND p.status = 2 AND sr.status = 'shipped'
        AND sr.updated < NOW() - ($1 || ' days')::interval
        AND NOT EXISTS (SELECT 1 FROM orders o JOIN links l ON l.id = o.link_id WHERE l.product_id = p.id AND ${ND("o")})
      GROUP BY u.id, b.store_name, u.email, p.id, p.title ORDER BY since`, [staleSaleDays]),
    // Accepted creators on a shipping campaign with no sample request at all.
    cloudSqlQuery(`
      SELECT ${brandSel}, p.id AS product_id, p.title, COUNT(DISTINCT l.influencer_user_id) AS n, MIN(COALESCE(l.accepted_at, l.updated)) AS since
      FROM links l JOIN products p ON p.id = l.product_id ${brandJoin}
      WHERE ${BRAND_ACTIVE} AND ${ND("l")} AND ${ND("p")} AND p.status = 2 AND p.shipping = true AND l.status = ${LINK.ACCEPTED}
        AND COALESCE(l.accepted_at, l.updated) < NOW() - ($1 || ' days')::interval
        AND NOT EXISTS (SELECT 1 FROM sample_requests sr WHERE sr.link_id = l.id AND ${ND("sr")})
      GROUP BY u.id, b.store_name, u.email, p.id, p.title ORDER BY since`, [applyDays]),
  ]);

  const brand = (r) => ({ user_id: r.user_id, store_name: r.store_name, email: r.email });
  const campaign = (r) => ({ id: r.product_id, title: r.title });
  const plural = (n, w) => `${n} ${w}${Number(n) === 1 ? "" : "s"}`;

  for (const r of accepted.rows) alerts.push({
    key: `ship:${r.product_id}`, kind: "shipping", severity: "danger",
    title: `Accepted sample${int(r.n) === 1 ? "" : "s"} not shipped`,
    detail: `${plural(r.n, "sample")} accepted on "${r.title}" and still not shipped after ${shipDays} days.`,
    since: r.since, brand: brand(r), campaign: campaign(r), href: "/ops/campaigns",
  });
  for (const r of pending.rows) alerts.push({
    key: `sample-pending:${r.product_id}`, kind: "shipping", severity: "warn",
    title: "Sample request unanswered",
    detail: `${plural(r.n, "creator")} asked for a sample on "${r.title}" more than ${shipDays} days ago.`,
    since: r.since, brand: brand(r), campaign: campaign(r), href: "/ops/campaigns",
  });
  for (const r of noSample.rows) alerts.push({
    key: `no-sample:${r.product_id}`, kind: "shipping", severity: "info",
    title: "Accepted creators without a sample",
    detail: `${plural(r.n, "accepted creator")} on "${r.title}" (a shipping campaign) with no sample request after ${applyDays} days.`,
    since: r.since, brand: brand(r), campaign: campaign(r), href: "/ops/campaigns",
  });
  for (const r of applications.rows) alerts.push({
    key: `apply:${r.product_id}`, kind: "applications", severity: int(r.n) >= 5 ? "danger" : "warn",
    title: "Creator applications waiting",
    detail: `${plural(r.n, "application")} on "${r.title}" unanswered for more than ${applyDays} days.`,
    since: r.since, brand: brand(r), campaign: campaign(r), href: "/ops/campaigns",
  });
  for (const r of trials.rows) {
    const launched = int(r.active_campaigns) > 0;
    const granted = !!r.trial_plan_name;
    alerts.push({
      key: `trial:${r.user_id}`, kind: "trials", severity: launched ? "info" : "warn",
      title: `${granted ? "Granted trial" : "Trial"} ends ${daysUntil(r.trial_expiration_date)}`,
      detail: launched
        ? `${plural(r.active_campaigns, "active campaign")} running; billing starts when the trial ends.`
        : "No campaign launched yet: this brand is likely to churn when the trial ends.",
      since: r.trial_expiration_date, brand: brand(r), href: "/trials",
    });
  }
  for (const r of grace.rows) alerts.push({
    key: `grace:${r.user_id}`, kind: "trials", severity: "warn",
    title: `Cancelled, access ends ${daysUntil(r.trial_expiration_date)}`,
    detail: "Subscription cancelled during the trial. Last chance to win the brand back before access closes.",
    since: r.trial_expiration_date, brand: brand(r), href: "/users",
  });
  for (const r of purge.rows) alerts.push({
    key: `purge:${r.user_id}`, kind: "deletion", severity: "info",
    title: `Brand purge ${daysUntil(r.deletion_scheduled_for)}`,
    detail: r.deletion_reason ? `Reason given: ${r.deletion_reason}` : "Hard delete scheduled; restore from Impersonation → Deleted if this is a mistake.",
    since: r.deletion_scheduled_for, brand: brand(r), href: "/users",
  });
  for (const r of staleSales.rows) alerts.push({
    key: `no-sales:${r.product_id}`, kind: "sales", severity: "info",
    title: "Shipped, no sales yet",
    detail: `${plural(r.n, "sample")} shipped on "${r.title}" over ${staleSaleDays} days ago and no order has been attributed.`,
    since: r.since, brand: brand(r), campaign: campaign(r), href: "/ops/campaigns",
  });

  // Payment failures, only where the subscription mirror exists.
  if (await hasTable("app_subscriptions")) {
    const { rows } = await cloudSqlQuery(`
      SELECT DISTINCT ON (u.id) ${brandSel}, s.status, s.updated, s.price_amount
      FROM app_subscriptions s JOIN users u ON u.id = s.user_id JOIN brands b ON b.user_id = u.id
      WHERE ${BRAND_ACTIVE} AND s.status = 'FROZEN' AND COALESCE(s.test, false) = false
      ORDER BY u.id, s.updated DESC`);
    for (const r of rows) alerts.push({
      key: `frozen:${r.user_id}`, kind: "billing", severity: "danger",
      title: "Payment failed (subscription frozen)",
      detail: `Shopify froze the $${num(r.price_amount)} subscription; the brand keeps losing access until the charge succeeds.`,
      since: r.updated, brand: brand(r), href: "/users",
    });
  }

  const rank = { danger: 0, warn: 1, info: 2 };
  alerts.sort((a, b) => rank[a.severity] - rank[b.severity] || new Date(a.since || 0) - new Date(b.since || 0));
  return alerts;
}

function daysUntil(iso) {
  if (!iso) return "soon";
  const d = Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (d <= 0) return "today";
  if (d === 1) return "tomorrow";
  return `in ${d} days`;
}

/* --------------------------------------------------------------- brand 360 */

async function brand360(userId) {
  const hasSubs = await hasTable("app_subscriptions");
  const { rows: profileRows } = await cloudSqlQuery(`
    SELECT u.id AS user_id, u.email, u.created AS user_created, u.account_id, u.shopify_shop, u.deleted AS user_deleted,
           (u.deleted = 'infinity'::timestamptz) AS active,
           u.deletion_scheduled_for, u.deletion_reason,
           b.id AS brand_id, b.store_name, b.store_website, b.first_name, b.last_name, b.location, b.niche, b.description,
           b.logo_pic_name, b.trial_plan_name, b.trial_days, b.trial_interval, b.trial_activation_date, b.trial_expiration_date,
           b.startup_programme, COALESCE(b.hidden, false) AS hidden, b.stripe_customer_id, b.default_payment_method_id,
           b.shopify_shop_default_currency,
           (SELECT MAX(t.created) FROM tokens t WHERE t.user_id = u.id::text AND COALESCE(t.state, '') NOT LIKE 'admin_impersonation%') AS last_sign_in
    FROM users u JOIN brands b ON b.user_id = u.id
    WHERE u.id = $1::uuid`, [userId]);
  const profile = profileRows[0];
  if (!profile) return null;

  const [subscription, campaigns, creators, orders, totals, impersonations, grants] = await Promise.all([
    hasSubs
      ? cloudSqlQuery(`
          SELECT status, name, test, price_amount, price_currency, interval, price_after_discount, trial_ends_at,
                 current_period_end, cancelled_at, shopify_created_at, synced_at
          FROM app_subscriptions WHERE user_id = $1::uuid
          ORDER BY (status = 'ACTIVE' AND cancelled_at IS NULL) DESC, shopify_created_at DESC NULLS LAST LIMIT 5`, [userId])
      : { rows: [] },
    cloudSqlQuery(`
      SELECT p.id, p.title, p.status, p.created, p.activated_at, p.shipping, p.sale_commission,
             COUNT(DISTINCT l.influencer_user_id) FILTER (WHERE l.status = ${LINK.INVITED})  AS invited,
             COUNT(DISTINCT l.influencer_user_id) FILTER (WHERE l.status IN (${LINK.APPLIED}, ${LINK.ACCEPTED})) AS applied,
             COUNT(DISTINCT l.influencer_user_id) FILTER (WHERE l.status = ${LINK.ACCEPTED}) AS accepted,
             (SELECT COUNT(DISTINCT sr.influencer_user_id) FROM sample_requests sr WHERE sr.product_id = p.id AND sr.status = 'shipped' AND ${ND("sr")}) AS shipped,
             COALESCE(SUM(l.clicks_counter), 0) AS clicks,
             (SELECT COUNT(*) FROM orders o JOIN links l2 ON l2.id = o.link_id WHERE l2.product_id = p.id AND ${ND("o")} AND ${ND("l2")}) AS sales,
             (SELECT COALESCE(SUM(o.shopify_amount), 0) FROM orders o JOIN links l2 ON l2.id = o.link_id WHERE l2.product_id = p.id AND ${ND("o")} AND ${ND("l2")}) AS revenue
      FROM products p LEFT JOIN links l ON l.product_id = p.id AND ${ND("l")}
      WHERE p.user_id = $1::uuid AND ${ND("p")}
      GROUP BY p.id ORDER BY (p.status = 5), (p.status = 2) DESC, p.created DESC LIMIT 100`, [userId]),
    cloudSqlQuery(`
      SELECT DISTINCT ON (l.product_id, l.influencer_user_id)
             l.id AS link_id, l.product_id, p.title AS campaign, l.status, l.created, l.accepted_at, l.clicks_counter AS clicks,
             i.user_id AS creator_user_id, i.instagram_username, i.instagram_followers_count,
             COALESCE(NULLIF(TRIM(CONCAT_WS(' ', i.first_name, i.last_name)), ''), i.instagram_username, i.username, 'Unknown creator') AS creator_name,
             (SELECT COUNT(*) FROM orders o WHERE o.link_id = l.id AND ${ND("o")}) AS sales,
             (SELECT sr.status FROM sample_requests sr WHERE sr.link_id = l.id AND ${ND("sr")} ORDER BY sr.created DESC LIMIT 1) AS sample_status
      FROM links l JOIN products p ON p.id = l.product_id LEFT JOIN influencers i ON i.user_id = l.influencer_user_id
      WHERE l.brand_user_id = $1::uuid AND ${ND("l")}
      ORDER BY l.product_id, l.influencer_user_id,
               CASE l.status WHEN ${LINK.ACCEPTED} THEN 0 WHEN ${LINK.APPLIED} THEN 1 WHEN ${LINK.INVITED} THEN 2 ELSE 3 END, l.created DESC`, [userId]),
    cloudSqlQuery(`
      SELECT o.id, o.created, o.shopify_amount, o.shopify_currency, o.commission, o.fulfillment_status, p.title AS campaign,
             COALESCE(NULLIF(TRIM(CONCAT_WS(' ', i.first_name, i.last_name)), ''), i.instagram_username) AS creator_name
      FROM orders o JOIN links l ON l.id = o.link_id LEFT JOIN products p ON p.id = l.product_id LEFT JOIN influencers i ON i.user_id = l.influencer_user_id
      WHERE l.brand_user_id = $1::uuid AND ${ND("o")}
      ORDER BY o.created DESC LIMIT 20`, [userId]),
    cloudSqlQuery(`
      SELECT COALESCE(NULLIF(o.shopify_currency, ''), 'USD') AS currency, COUNT(*) AS orders, COALESCE(SUM(o.shopify_amount), 0) AS gmv,
             COALESCE(SUM(CASE WHEN o.commission ~ '^[0-9]+(\\.[0-9]+)?$' THEN o.commission::numeric ELSE 0 END), 0) AS commission
      FROM orders o JOIN links l ON l.id = o.link_id
      WHERE l.brand_user_id = $1::uuid AND ${ND("o")} AND ${ND("l")}
      GROUP BY 1 ORDER BY gmv DESC`, [userId]),
    cloudSqlQuery(`SELECT created, admin_email FROM admin_impersonations WHERE target_user_id = $1::uuid ORDER BY created DESC LIMIT 10`, [userId]).catch(() => ({ rows: [] })),
    cloudSqlQuery(`SELECT granted_at, admin_email, plan, days, interval, note FROM admin_trial_grants WHERE target_user_id = $1::uuid ORDER BY granted_at DESC LIMIT 10`, [userId]).catch(() => ({ rows: [] })),
  ]);

  // Outbound history lives in Supabase: sends to this email, AI threads, and the
  // StoreLeads record for the shop domain.
  let outbound = { sends: [], conversations: [], lead: null };
  try {
    const teamId = await getDefaultTeamId();
    const email = (profile.email || "").toLowerCase();
    const domain = (profile.store_website || "").replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase();
    const [sends, convs, lead] = await Promise.all([
      email ? supabase.from("email_sends").select("id, campaign_id, touch_number, brand_group, subject, status, sent_at, opened_at, replied_at, bounced_at, email_campaigns!campaign_id ( name )").eq("team_id", teamId).ilike("to_email", email).order("sent_at", { ascending: false, nullsFirst: false }).limit(20) : { data: [] },
      email ? supabase.from("ai_conversations").select("id, status, thread_subject, last_inbound_at, last_outbound_at, qualification_score, ai_campaigns!campaign_id ( name )").eq("team_id", teamId).ilike("prospect_email", email).order("updated_at", { ascending: false }).limit(10) : { data: [] },
      domain ? supabase.from("storeleads_brands").select("domain, country_code, categories, emailed, emailed_at, imported_at").eq("team_id", teamId).eq("domain", domain).limit(1).maybeSingle() : { data: null },
    ]);
    outbound = {
      sends: (sends.data || []).map((s) => ({ ...s, campaign_name: s.email_campaigns?.name || null, email_campaigns: undefined })),
      conversations: (convs.data || []).map((c) => ({ ...c, campaign_name: c.ai_campaigns?.name || null, ai_campaigns: undefined })),
      lead: lead?.data || null,
    };
  } catch (e) {
    outbound.error = e.message;
  }

  const sub = subscription.rows[0] || null;
  return {
    // Row in the same shape the Users page passes to GrantTrialModal / ManageBrandModal.
    row: {
      user_id: profile.user_id, email: profile.email, store_name: profile.store_name, store_website: profile.store_website,
      trial_plan_name: profile.trial_plan_name, trial_days: profile.trial_days, trial_interval: profile.trial_interval,
      trial_activation_date: profile.trial_activation_date, trial_expiration_date: profile.trial_expiration_date,
      startup_programme: profile.startup_programme, hidden: profile.hidden, account_id: profile.account_id,
    },
    profile: { ...profile, active: profile.active === true },
    subscription: sub,
    subscriptionHistory: subscription.rows,
    // Synced-but-never-launched products (status 5) are counted, not listed.
    notLaunched: campaigns.rows.filter((c) => c.status === 5).length,
    campaigns: campaigns.rows.filter((c) => c.status !== 5).map((c) => ({
      ...c, status_label: PRODUCT_STATUS[c.status] || `status ${c.status}`,
      invited: int(c.invited), applied: int(c.applied), accepted: int(c.accepted), shipped: int(c.shipped),
      clicks: int(c.clicks), sales: int(c.sales), revenue: num(c.revenue),
    })),
    creators: creators.rows.map((c) => ({
      ...c, clicks: int(c.clicks), sales: int(c.sales),
      status_label: c.sales > 0 ? "Sold" : c.sample_status === "shipped" ? "Shipped" : c.sample_status === "accepted" ? "Sample accepted"
        : c.status === LINK.ACCEPTED ? "Accepted" : c.status === LINK.APPLIED ? "Applied" : c.status === LINK.INVITED ? "Invited"
        : c.status === LINK.REJECTED ? "Rejected" : c.status === LINK.ENDED ? "Ended" : "Unknown",
    })),
    orders: {
      items: orders.rows.map((o) => ({ ...o, shopify_amount: num(o.shopify_amount) })),
      byCurrency: totals.rows.map((t) => ({ currency: t.currency, orders: int(t.orders), gmv: num(t.gmv), commission: num(t.commission) })),
    },
    outbound,
    history: { impersonations: impersonations.rows, grants: grants.rows },
  };
}

/* ------------------------------------------------------------------ series */

const RANGES = {
  "30d": { unit: "day", step: "1 day", count: 30, label: "previous 30 days" },
  "90d": { unit: "week", step: "1 week", count: 13, label: "previous 13 weeks" },
  "12m": { unit: "month", step: "1 month", count: 12, label: "previous 12 months" },
  "all": { unit: "month", step: "1 month", count: null, label: null },
};

async function homeSeries(rangeKey) {
  const range = RANGES[rangeKey] || RANGES["90d"];
  const { unit, step } = range;
  // Two ranges back so the previous period can be compared; "all" starts at the first brand.
  let start;
  if (range.count) {
    const { rows } = await cloudSqlQuery(`SELECT (date_trunc($1, NOW()) - ($2::int * $3::interval))::date AS start`, [unit, range.count * 2 - 1, step]);
    start = rows[0].start;
  } else {
    const { rows } = await cloudSqlQuery(`SELECT date_trunc('month', LEAST(NOW(), COALESCE(MIN(created), NOW())))::date AS start FROM users WHERE role = 2 AND created > '2020-01-01'`);
    start = rows[0].start;
  }
  const bucket = (col) => `date_trunc('${unit}', ${col})::date`;
  const series = async (label, sql, params = []) => {
    try { const { rows } = await cloudSqlQuery(sql, params); return rows; } catch (e) { console.warn(`[insights/series] ${label}: ${e.message}`); return []; }
  };
  const hasSubs = await hasTable("app_subscriptions");
  const [buckets, brands, creators, campaigns, accepted, orders, clicks, trials, mrr] = await Promise.all([
    cloudSqlQuery(`SELECT g::date AS date FROM generate_series($1::date, date_trunc($2, NOW())::date, $3::interval) g`, [start, unit, step]).then((r) => r.rows.map((x) => x.date)),
    series("brands", `SELECT ${bucket("u.created")} AS date, COUNT(*) AS n FROM users u JOIN brands b ON b.user_id = u.id WHERE u.role = 2 AND u.created >= $1::date GROUP BY 1`, [start]),
    series("creators", `SELECT ${bucket("created")} AS date, COUNT(*) AS n FROM influencers WHERE created >= $1::date GROUP BY 1`, [start]),
    series("campaigns", `SELECT ${bucket("COALESCE(activated_at, created)")} AS date, COUNT(*) AS n FROM products WHERE ${ND("products")} AND activated_at IS NOT NULL AND COALESCE(activated_at, created) >= $1::date GROUP BY 1`, [start]),
    series("accepted", `SELECT ${bucket("COALESCE(accepted_at, created)")} AS date, COUNT(*) AS n FROM links WHERE ${ND("links")} AND status = ${LINK.ACCEPTED} AND COALESCE(accepted_at, created) >= $1::date GROUP BY 1`, [start]),
    series("orders", `SELECT ${bucket("created")} AS date, COUNT(*) AS n, COALESCE(SUM(shopify_amount), 0) AS gmv, COALESCE(SUM(CASE WHEN commission ~ '^[0-9]+(\\.[0-9]+)?$' THEN commission::numeric ELSE 0 END), 0) AS commission FROM orders WHERE ${ND("orders")} AND created >= $1::date GROUP BY 1`, [start]),
    series("clicks", `SELECT ${bucket("created")} AS date, COUNT(*) AS n FROM link_clicks WHERE created >= $1::date GROUP BY 1`, [start]),
    series("trials", `SELECT ${bucket("trial_activation_date")} AS date, COUNT(*) AS n FROM brands WHERE ${ND("brands")} AND trial_activation_date > '-infinity'::timestamptz AND trial_activation_date >= $1::date GROUP BY 1`, [start]),
    hasSubs
      ? series("mrr", `
          SELECT g::date AS date,
                 COALESCE(SUM(CASE WHEN s.interval ILIKE '%year%' OR s.interval ILIKE 'annual%' THEN COALESCE(NULLIF(s.price_after_discount, 0), s.price_amount) / 12.0
                                   ELSE COALESCE(NULLIF(s.price_after_discount, 0), s.price_amount) END), 0) AS mrr,
                 COUNT(s.id) AS subs
          FROM generate_series($1::date, date_trunc($2, NOW())::date, $3::interval) g
          LEFT JOIN app_subscriptions s
            ON s.shopify_created_at < g + $3::interval
           AND (s.cancelled_at IS NULL OR s.cancelled_at >= g + $3::interval)
           AND (s.trial_ends_at IS NULL OR s.trial_ends_at < g + $3::interval)
           AND COALESCE(s.test, false) = false AND s.price_amount > 0
          GROUP BY 1 ORDER BY 1`, [start, unit, step])
      : Promise.resolve(null),
  ]);

  const byDate = (rows, key = "n") => Object.fromEntries(rows.map((r) => [String(r.date).slice(0, 10), num(r[key])]));
  const maps = {
    brands: byDate(brands), creators: byDate(creators), campaigns: byDate(campaigns), accepted: byDate(accepted),
    orders: byDate(orders), gmv: byDate(orders, "gmv"), commission: byDate(orders, "commission"),
    clicks: byDate(clicks), trials: byDate(trials), mrr: mrr ? byDate(mrr, "mrr") : null,
  };
  const points = buckets.map((d) => {
    const k = String(d).slice(0, 10);
    const p = { date: k };
    for (const [name, m] of Object.entries(maps)) if (m) p[name] = m[k] || 0;
    return p;
  });
  // Split into previous / current halves for the deltas (fixed ranges only).
  let current = points, previous = null;
  if (range.count) {
    current = points.slice(-range.count);
    previous = points.slice(0, points.length - range.count);
  }
  const sum = (arr, k) => arr.reduce((a, p) => a + (p[k] || 0), 0);
  const totals = (arr) => arr && arr.length ? Object.fromEntries(Object.keys(maps).filter((k) => maps[k]).map((k) => [k, k === "mrr" ? (arr[arr.length - 1]?.mrr ?? 0) : sum(arr, k)])) : null;
  return {
    range: rangeKey in RANGES ? rangeKey : "90d", unit, previousLabel: range.label,
    buckets: current,
    totals: { current: totals(current), previous: totals(previous) },
    mrrApprox: !!mrr,
  };
}

/* --------------------------------------------------------------- ask data */

const ASK_TABLES = [
  "users", "brands", "influencers", "products", "links", "orders", "sample_requests", "chats", "invitations",
  "campaign_matches", "external_creators", "external_creator_links", "payouts", "app_subscriptions",
  "admin_trial_grants", "admin_impersonations", "link_clicks", "instagram_analytics", "referrals", "referral_programs",
  "brand_referrals", "brand_referral_payouts", "product_variants", "order_fulfillments", "shopify_partner_transactions",
];
const HIDDEN_COL = /(token|password|hash|secret|otp|verifier|stripe_|shopify_token|facebook_token|raw_json|raw_api_response|\bsub\b|storefront)/i;
const FORBIDDEN_SQL = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do|execute|vacuum|analyze|refresh|listen|notify|set|reset|begin|commit|rollback|lock|cluster|comment|security|pg_sleep|pg_read|pg_ls|lo_|dblink|current_setting)\b/i;
const ASK_MODEL = process.env.ASK_MODEL || "claude-sonnet-5";
const ASK_PRICES = { "claude-sonnet-5": { in: 2, out: 10 }, "claude-opus-5": { in: 5, out: 25 }, "claude-haiku-4-5": { in: 1, out: 5 } };

let schemaCache = { at: 0, text: "" };
async function askSchema() {
  if (Date.now() - schemaCache.at < 10 * 60_000 && schemaCache.text) return schemaCache.text;
  const { rows } = await cloudSqlQuery(`
    SELECT table_name, string_agg(column_name || ' ' || data_type, ', ' ORDER BY ordinal_position) AS cols
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ANY($1)
    GROUP BY table_name ORDER BY table_name`, [ASK_TABLES]);
  const text = rows.map((r) => `${r.table_name}(${r.cols.split(", ").filter((c) => !HIDDEN_COL.test(c.split(" ")[0])).join(", ")})`).join("\n");
  schemaCache = { at: Date.now(), text };
  return text;
}

const DOMAIN_NOTES = `
Domain notes (important):
- Soft deletes: every main table has a "deleted" timestamptz. A LIVE row has deleted IS NULL OR deleted IN ('infinity','-infinity'). Always filter live rows unless the question is about deleted data.
- users.role: 1 admin, 2 brand, 3 creator (influencer). brands.user_id and influencers.user_id reference users.id. products.user_id is the brand's user id; links.brand_user_id / links.influencer_user_id likewise.
- A "campaign" is a row in products. products.status: 1 new, 2 active, 3 paused, 4 ended. products.activated_at is when it went live.
- links = a creator on a campaign. links.status: 1 invited (brand-initiated, pending creator), 2 applied (creator-initiated, pending brand), 3 accepted, 4 rejected, 5 ended. links.clicks_counter = clicks.
- orders reference links (orders.link_id); orders.shopify_amount is in orders.shopify_currency (do not sum across currencies without grouping). orders.commission is text (numeric-looking).
- sample_requests.status: 'pending' | 'accepted' | 'shipped' | others. payouts.status 'paid' means money went out; amount_value is text.
- Paid plans: users.account_id like 'shopify_<price>_<monthly|yearly>' (e.g. shopify_199_monthly); 'shopify_free_plan' is free; empty = never subscribed. Trials: brands.trial_expiration_date > NOW() means in trial; brands.trial_plan_name set = Linkable-granted trial.
- app_subscriptions (when present) mirrors Shopify: status ACTIVE/CANCELLED/FROZEN/EXPIRED, price_amount, price_after_discount, interval, trial_ends_at, cancelled_at, test.
- Timestamps are timestamptz; use NOW() and date_trunc for periods. Prefer readable column aliases.`;

const AskSchema = z.object({
  sql: z.string().describe("One PostgreSQL SELECT (or WITH ... SELECT) statement, no semicolon, at most 200 rows"),
  explanation: z.string().describe("One or two plain sentences on how the answer was computed and any caveat"),
  chart: z.enum(["none", "bar", "line"]).describe("Best simple visualisation for the result, or none"),
});

function checkSql(sql) {
  const s = String(sql || "").trim().replace(/;+\s*$/, "");
  if (!s) throw new Error("The model returned no SQL");
  if (s.includes(";")) throw new Error("Only a single statement is allowed");
  if (!/^(select|with)\b/i.test(s)) throw new Error("Only SELECT queries are allowed");
  if (FORBIDDEN_SQL.test(s.replace(/'[^']*'/g, "''"))) throw new Error("The generated SQL contains a forbidden keyword");
  if (/--|\/\*/.test(s)) throw new Error("Comments are not allowed in the generated SQL");
  return s;
}

async function runReadOnly(sql, limit = 200) {
  const pool = await getCloudSqlPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = 10000");
    const res = await client.query(`SELECT * FROM (${sql}) AS lk_ask LIMIT ${limit + 1}`);
    await client.query("ROLLBACK");
    const rows = res.rows.slice(0, limit).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])));
    return { columns: res.fields.map((f) => f.name), rows, truncated: res.rows.length > limit };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* already aborted */ }
    throw e;
  } finally {
    client.release();
  }
}

async function askData(question) {
  const apiKey = process.env.ASK_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
  const client = new Anthropic({ apiKey });
  const schema = await askSchema();
  const system = `You translate an operator's question about the Linkable marketplace (brands run creator campaigns on Shopify) into ONE read-only PostgreSQL query.
Rules: a single SELECT or WITH…SELECT; never modify data; always LIMIT 200 or less; include only the columns needed; group money by currency; filter soft-deleted rows; return dates as dates.
If the question cannot be answered from the schema, write a SELECT that returns a single row with a column "note" explaining why.
Schema (public):
${schema}
${DOMAIN_NOTES}`;
  const first = await client.messages.parse({
    model: ASK_MODEL, max_tokens: 1500,
    output_config: { effort: "medium", format: zodOutputFormat(AskSchema) },
    system,
    messages: [{ role: "user", content: question }],
  });
  const price = ASK_PRICES[ASK_MODEL] || ASK_PRICES["claude-sonnet-5"];
  const cost = (u) => ((u?.input_tokens || 0) * price.in + (u?.output_tokens || 0) * price.out) / 1e6;
  let costUsd = cost(first.usage);
  let { sql, explanation, chart } = first.parsed_output || {};
  sql = checkSql(sql);

  let result;
  try {
    result = await runReadOnly(sql);
  } catch (e) {
    // One repair round with the database error, then give up honestly.
    const fix = await client.messages.parse({
      model: ASK_MODEL, max_tokens: 1500,
      output_config: { effort: "medium", format: zodOutputFormat(AskSchema) },
      system,
      messages: [
        { role: "user", content: question },
        { role: "assistant", content: JSON.stringify({ sql, explanation, chart }) },
        { role: "user", content: `PostgreSQL rejected that query with: ${e.message}\nReturn a corrected query.` },
      ],
    });
    costUsd += cost(fix.usage);
    sql = checkSql(fix.parsed_output?.sql);
    explanation = fix.parsed_output?.explanation || explanation;
    chart = fix.parsed_output?.chart || chart;
    result = await runReadOnly(sql);
  }

  // A one-line answer in words, from the actual rows (small payload, cheap).
  let summary = null;
  try {
    const sample = JSON.stringify(result.rows.slice(0, 30));
    const s = await client.messages.create({
      model: ASK_MODEL, max_tokens: 200,
      output_config: { effort: "low" },
      system: "Answer the operator's question in one or two plain sentences using only the query result. Give the key figures; do not mention SQL. No markdown, no dashes, no exclamation marks.",
      messages: [{ role: "user", content: `Question: ${question}\nResult rows (JSON, up to 30): ${sample}${result.truncated ? "\n(There are more rows than shown.)" : ""}` }],
    });
    costUsd += cost(s.usage);
    summary = s.content?.find((b) => b.type === "text")?.text?.trim() || null;
  } catch (e) {
    console.warn("[insights/ask] summary failed:", e.message);
  }

  return { sql, explanation, chart: chart || "none", summary, ...result, model: ASK_MODEL, cost_usd: Math.round(costUsd * 10000) / 10000 };
}

/* ------------------------------------------------------------------ search */

async function globalSearch(q) {
  const like = `%${q.replace(/[%_]/g, " ").trim()}%`;
  const [brands, creators, campaigns] = await Promise.all([
    cloudSqlQuery(`
      SELECT u.id AS user_id, b.store_name, u.email, b.store_website, u.account_id
      FROM users u JOIN brands b ON b.user_id = u.id
      WHERE ${BRAND_ACTIVE} AND (b.store_name ILIKE $1 OR u.email ILIKE $1 OR b.store_website ILIKE $1 OR b.first_name ILIKE $1 OR b.last_name ILIKE $1)
      ORDER BY (b.store_name ILIKE $1) DESC, b.store_name LIMIT 6`, [like]),
    cloudSqlQuery(`
      SELECT u.id AS user_id, u.email, i.instagram_username, i.instagram_followers_count,
             COALESCE(NULLIF(TRIM(CONCAT_WS(' ', i.first_name, i.last_name)), ''), i.instagram_username, i.username) AS name
      FROM users u JOIN influencers i ON i.user_id = u.id
      WHERE u.role = 3 AND u.deleted = 'infinity'::timestamptz AND ${ND("i")}
        AND (i.instagram_username ILIKE $1 OR u.email ILIKE $1 OR i.first_name ILIKE $1 OR i.last_name ILIKE $1 OR i.instagram_name ILIKE $1)
      ORDER BY (i.instagram_username ILIKE $1) DESC, i.instagram_username LIMIT 6`, [like]),
    cloudSqlQuery(`
      SELECT p.id, p.title, p.status, b.store_name AS brand_name, u.id AS brand_user_id
      FROM products p JOIN users u ON u.id = p.user_id JOIN brands b ON b.user_id = u.id
      WHERE ${ND("p")} AND p.title ILIKE $1 AND p.status IN (2, 3, 4)
      ORDER BY (p.status = 2) DESC, p.created DESC LIMIT 6`, [like]),
  ]);
  let outbound = [];
  try {
    const teamId = await getDefaultTeamId();
    const { data } = await supabase.from("email_campaigns").select("id, name, status, audience_type").eq("team_id", teamId).ilike("name", like).limit(5);
    outbound = data || [];
  } catch { /* outbound search is best effort */ }
  return {
    brands: brands.rows,
    creators: creators.rows,
    campaigns: campaigns.rows.map((c) => ({ ...c, status_label: PRODUCT_STATUS[c.status] || String(c.status) })),
    outbound,
  };
}

/* ------------------------------------------------------------------ router */

export function insightsRoutes() {
  const router = Router();

  router.get("/alerts", async (req, res) => {
    try {
      const alerts = await buildAlerts({
        shipDays: int(req.query.shipDays) || undefined,
        applyDays: int(req.query.applyDays) || undefined,
        trialDays: int(req.query.trialDays) || undefined,
      });
      res.json({ alerts, generatedAt: new Date().toISOString() });
    } catch (e) { console.error("[insights/alerts]", e); res.status(500).json({ error: e.message }); }
  });

  router.get("/brand/:userId", async (req, res) => {
    try {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.userId)) return res.status(400).json({ error: "Invalid user id" });
      const data = await brand360(req.params.userId);
      if (!data) return res.status(404).json({ error: "Brand not found" });
      res.json(data);
    } catch (e) { console.error("[insights/brand]", e); res.status(500).json({ error: e.message }); }
  });

  router.get("/series", async (req, res) => {
    try { res.json(await homeSeries(String(req.query.range || "90d"))); }
    catch (e) { console.error("[insights/series]", e); res.status(500).json({ error: e.message }); }
  });

  router.post("/ask", async (req, res) => {
    try {
      const question = String(req.body?.question || "").trim().slice(0, 600);
      if (question.length < 4) return res.status(400).json({ error: "Ask a question first" });
      res.json(await askData(question));
    } catch (e) { console.error("[insights/ask]", e); res.status(500).json({ error: e.message }); }
  });

  router.get("/search", async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      if (q.length < 2) return res.json({ brands: [], creators: [], campaigns: [], outbound: [] });
      res.json(await globalSearch(q));
    } catch (e) { console.error("[insights/search]", e); res.status(500).json({ error: e.message }); }
  });

  return router;
}
