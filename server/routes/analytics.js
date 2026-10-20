import express from "express";
import { cloudSqlQuery } from "../lib/cloudsql.js";
import {
  commissionEarnedSql, NOT_TEST_SUB, SHOPIFY_PLAN_SQL, CARD_PLAN_SQL,
  cardPlanAmountSql, cardPlanTierSql, subscriptionLateral,
} from "../lib/mainAppSql.js";
import { mainAppSchema } from "../lib/mainAppSchema.js";

export function analyticsRoutes() {
  const router = express.Router();

  // Dashboard: business KPIs for Linkable influencer platform
  router.get("/overview", async (req, res) => {
    try {
      // Since main app #376 a products row is a campaign (is_campaign) and the
      // catalogue is shop_products. Where the target predates it, products is
      // still the one table for both and is counted as before.
      const schema = await mainAppSchema();
      const campaignsModel = schema.isCampaign;
      const isCampaign = campaignsModel ? "AND is_campaign = true" : "";
      const results = await Promise.all([
        // Core counts
        cloudSqlQuery(`SELECT COUNT(*) as total FROM brands WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),
        cloudSqlQuery(`SELECT COUNT(*) as total FROM influencers WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),
        cloudSqlQuery(`SELECT COUNT(*) as total FROM external_creators WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),
        cloudSqlQuery(`SELECT COUNT(*) as total FROM products WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz)) ${isCampaign}`),
        // links.status 3 = accepted (the only state that is live for tracking); total includes pending/rejected/ended
        cloudSqlQuery(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 3) as active FROM links WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),
        cloudSqlQuery(`SELECT COUNT(*) as total FROM orders WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),
        cloudSqlQuery(`SELECT COUNT(*) as total FROM chats WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),
        cloudSqlQuery(`SELECT COUNT(*) as total FROM campaign_matches WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),
        cloudSqlQuery(`SELECT COUNT(*) as total FROM sample_requests WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),
        cloudSqlQuery(`SELECT COUNT(*) as total FROM invitations WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),
        cloudSqlQuery(`SELECT COUNT(*) as total FROM users WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),

        // Revenue
        cloudSqlQuery(`SELECT COALESCE(SUM(shopify_amount), 0) as total_revenue, COUNT(*) as order_count FROM orders WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),

        // New brands last 7 / 30 days
        cloudSqlQuery(`SELECT
          COUNT(*) FILTER (WHERE created >= NOW() - INTERVAL '7 days') as last_7,
          COUNT(*) FILTER (WHERE created >= NOW() - INTERVAL '30 days') as last_30
          FROM brands WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),

        // New influencers last 7 / 30 days
        cloudSqlQuery(`SELECT
          COUNT(*) FILTER (WHERE created >= NOW() - INTERVAL '7 days') as last_7,
          COUNT(*) FILTER (WHERE created >= NOW() - INTERVAL '30 days') as last_30
          FROM influencers WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),

        // New links last 7 / 30 days
        cloudSqlQuery(`SELECT
          COUNT(*) FILTER (WHERE created >= NOW() - INTERVAL '7 days') as last_7,
          COUNT(*) FILTER (WHERE created >= NOW() - INTERVAL '30 days') as last_30
          FROM links WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),

        // New users last 7 / 30 days
        cloudSqlQuery(`SELECT
          COUNT(*) FILTER (WHERE created >= NOW() - INTERVAL '7 days') as last_7,
          COUNT(*) FILTER (WHERE created >= NOW() - INTERVAL '30 days') as last_30
          FROM users WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),

        // Signups per month (all time, grouped by month)
        cloudSqlQuery(`SELECT DATE_TRUNC('month', created)::date as date, COUNT(*) as count FROM users WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz)) AND created > '2020-01-01' GROUP BY DATE_TRUNC('month', created) ORDER BY date`),

        // Links created per week (last 6 months)
        cloudSqlQuery(`SELECT DATE_TRUNC('week', created)::date as date, COUNT(*) as count FROM links WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz)) AND created >= NOW() - INTERVAL '6 months' GROUP BY DATE_TRUNC('week', created) ORDER BY date`),

        // Chats per week (last 6 months)
        cloudSqlQuery(`SELECT DATE_TRUNC('week', created)::date as date, COUNT(*) as count FROM chats WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz)) AND created >= NOW() - INTERVAL '6 months' GROUP BY DATE_TRUNC('week', created) ORDER BY date`),

        // Products (campaigns, where the target has them) per month (all time)
        cloudSqlQuery(`SELECT DATE_TRUNC('month', created)::date as date, COUNT(*) as count FROM products WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz)) ${isCampaign} AND created > '2020-01-01' GROUP BY DATE_TRUNC('month', created) ORDER BY date`),

        // Influencer locations (top countries)
        cloudSqlQuery(`SELECT location_country as country, COUNT(*) as count FROM influencers WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz)) AND location_country IS NOT NULL AND location_country != '' GROUP BY location_country ORDER BY count DESC LIMIT 10`),

        // Influencer niches
        cloudSqlQuery(`SELECT niche, COUNT(*) as count FROM influencers WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz)) AND niche IS NOT NULL AND niche != '' GROUP BY niche ORDER BY count DESC LIMIT 10`),

        // Brand locations (split pipe-separated values and aggregate)
        cloudSqlQuery(`SELECT TRIM(market) as country, COUNT(*) as count FROM brands, unnest(string_to_array(location, '|')) AS market WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz)) AND location IS NOT NULL AND location != '' GROUP BY TRIM(market) HAVING TRIM(market) != '' AND TRIM(market) != '*' ORDER BY count DESC LIMIT 10`),

        // External creator content categories
        cloudSqlQuery(`SELECT content_category, COUNT(*) as count FROM external_creators WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz)) AND content_category IS NOT NULL AND content_category != '' GROUP BY content_category ORDER BY count DESC LIMIT 10`),

        // External creator gender split
        cloudSqlQuery(`SELECT gender, COUNT(*) as count FROM external_creators WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz)) AND gender IS NOT NULL AND gender != '' GROUP BY gender ORDER BY count DESC`),

        // Sample request statuses
        cloudSqlQuery(`SELECT status, COUNT(*) as count FROM sample_requests WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz)) GROUP BY status ORDER BY count DESC`),

        // Verified vs unverified influencers
        cloudSqlQuery(`SELECT
          COUNT(*) FILTER (WHERE is_verified = true) as verified,
          COUNT(*) FILTER (WHERE is_verified = false OR is_verified IS NULL) as unverified
          FROM influencers WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),

        // Campaign match scores distribution
        cloudSqlQuery(`SELECT
          CASE
            WHEN score >= 80 THEN 'Excellent (80+)'
            WHEN score >= 60 THEN 'Good (60-79)'
            WHEN score >= 40 THEN 'Fair (40-59)'
            ELSE 'Low (<40)'
          END as bracket, COUNT(*) as count
          FROM campaign_matches WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz)) AND score IS NOT NULL
          GROUP BY bracket ORDER BY bracket`),

        // Top brands by product (campaign, where the target has them) count
        cloudSqlQuery(`SELECT b.store_name as name, COUNT(p.id) as products
          FROM brands b JOIN products p ON p.brand_id = b.id
          WHERE (b.deleted IS NULL OR b.deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))
            AND (p.deleted IS NULL OR p.deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))
            ${campaignsModel ? "AND p.is_campaign = true" : ""}
            AND b.store_name IS NOT NULL AND b.store_name != ''
          GROUP BY b.store_name ORDER BY products DESC LIMIT 8`),

        // Avg followers for influencers
        cloudSqlQuery(`SELECT
          AVG(follower_count) as avg_followers,
          AVG(engagement_percent) as avg_engagement,
          AVG(media_count) as avg_posts
          FROM instagram_analytics WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz)) AND follower_count IS NOT NULL`),

        // Brand monetization: trials, Stripe, payment methods
        cloudSqlQuery(`SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE stripe_customer_id IS NOT NULL AND stripe_customer_id != '') as has_stripe,
          COUNT(*) FILTER (WHERE default_payment_method_id IS NOT NULL AND default_payment_method_id != '') as has_payment_method,
          -- Any trial ever set (standard Shopify 14-day or Linkable-granted): the three
          -- buckets below partition the brand base, so Active + Expired + Never = total.
          COUNT(*) FILTER (WHERE trial_expiration_date IS NOT NULL AND trial_expiration_date > '-infinity'::timestamptz AND trial_expiration_date < 'infinity'::timestamptz) as on_trial,
          COUNT(*) FILTER (WHERE trial_expiration_date IS NOT NULL AND trial_expiration_date > NOW() AND trial_expiration_date < 'infinity'::timestamptz) as active_trial,
          COUNT(*) FILTER (WHERE trial_expiration_date IS NOT NULL AND trial_expiration_date <= NOW() AND trial_expiration_date > '-infinity'::timestamptz) as expired_trial,
          COUNT(*) FILTER (WHERE trial_plan_name IS NOT NULL AND trial_plan_name != '') as granted_trial
          FROM brands WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),

        // Trial plan breakdown
        cloudSqlQuery(`SELECT trial_plan_name as plan, trial_interval as interval, COUNT(*) as count
          FROM brands WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))
          AND trial_plan_name IS NOT NULL AND trial_plan_name != ''
          GROUP BY trial_plan_name, trial_interval ORDER BY count DESC`),

        // Revenue & orders
        cloudSqlQuery(`SELECT
          COALESCE(SUM(shopify_amount), 0) as total_revenue,
          COUNT(*) as total_orders,
          COALESCE(AVG(shopify_amount), 0) as avg_order_value,
          COUNT(DISTINCT link_id) as unique_links_with_orders,
          (SELECT json_agg(json_build_object('currency', c.cur, 'total', c.amt, 'orders', c.n) ORDER BY c.amt DESC)
             FROM (SELECT COALESCE(NULLIF(shopify_currency, ''), 'USD') AS cur, COALESCE(SUM(shopify_amount), 0) AS amt, COUNT(*) AS n
                     FROM orders WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))
                    GROUP BY 1) c) as by_currency
          FROM orders WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),

        // Creator Stripe connectivity. Joined through influencers rather than
        // a bare `users WHERE role = 3` scan: a role-3 user with no live
        // influencers row (2 on prod) never finished onboarding into an
        // actual creator profile, and counting them inflated the denominator
        // past kpis.influencers — the same population this reconciles to
        // everywhere else on the page.
        cloudSqlQuery(`SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE u.stripe_account_id IS NOT NULL AND u.stripe_account_id != '') as stripe_connected
          FROM influencers i JOIN users u ON u.id = i.user_id
          WHERE i.deleted = '-infinity'::timestamptz`),

        // Payout stats
        cloudSqlQuery(`SELECT status, COUNT(*) as count, COALESCE(SUM(amount_value::numeric), 0) as total_amount
          FROM payouts WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))
          GROUP BY status ORDER BY count DESC`),

        // The catalogue: the brands' own products, one row each however many
        // campaigns run on them. Only where the target has shop_products.
        schema.shopProducts
          ? cloudSqlQuery(`SELECT COUNT(*) as total FROM shop_products sp JOIN brands b ON b.id = sp.brand_id
              WHERE sp.deleted = '-infinity'::timestamptz AND b.deleted = '-infinity'::timestamptz`)
          : Promise.resolve({ rows: [{ total: null }] }),
      ]);

      const [
        brandsCount, influencersCount, externalCreatorsCount, productsCount,
        linksCount, ordersCount, chatsCount, matchesCount, samplesCount,
        invitationsCount, usersCount,
        revenueData,
        brandsGrowth, influencersGrowth, linksGrowth, usersGrowth,
        signupsDaily, linksDaily, chatsDaily, productsDaily,
        influencerCountries, influencerNiches, brandLocations,
        creatorCategories, creatorGender, sampleStatuses,
        verifiedSplit, matchScores, topBrands, igStats,
        brandMonetization, trialPlans, revenueStats, creatorStripe, payoutStats,
        catalogueCount,
      ] = results;

      res.json({
        kpis: {
          brands: parseInt(brandsCount.rows[0].total),
          influencers: parseInt(influencersCount.rows[0].total),
          externalCreators: parseInt(externalCreatorsCount.rows[0].total),
          // Campaigns where the target has the campaigns model, else every
          // products row (the old meaning). productsModel says which.
          products: parseInt(productsCount.rows[0].total),
          productsModel: campaignsModel ? "campaigns" : "products",
          catalogueProducts: catalogueCount.rows[0]?.total == null ? null : parseInt(catalogueCount.rows[0].total),
          links: parseInt(linksCount.rows[0].total),
          activeLinks: parseInt(linksCount.rows[0].active || 0),
          orders: parseInt(ordersCount.rows[0].total),
          chats: parseInt(chatsCount.rows[0].total),
          matches: parseInt(matchesCount.rows[0].total),
          samples: parseInt(samplesCount.rows[0].total),
          invitations: parseInt(invitationsCount.rows[0].total),
          users: parseInt(usersCount.rows[0].total),
          totalRevenue: parseFloat(revenueData.rows[0].total_revenue),
        },
        growth: {
          brands: { last7: parseInt(brandsGrowth.rows[0].last_7), last30: parseInt(brandsGrowth.rows[0].last_30) },
          influencers: { last7: parseInt(influencersGrowth.rows[0].last_7), last30: parseInt(influencersGrowth.rows[0].last_30) },
          links: { last7: parseInt(linksGrowth.rows[0].last_7), last30: parseInt(linksGrowth.rows[0].last_30) },
          users: { last7: parseInt(usersGrowth.rows[0].last_7), last30: parseInt(usersGrowth.rows[0].last_30) },
        },
        trends: {
          signups: signupsDaily.rows.map(r => ({ date: r.date, count: parseInt(r.count) })),
          links: linksDaily.rows.map(r => ({ date: r.date, count: parseInt(r.count) })),
          chats: chatsDaily.rows.map(r => ({ date: r.date, count: parseInt(r.count) })),
          products: productsDaily.rows.map(r => ({ date: r.date, count: parseInt(r.count) })),
        },
        distributions: {
          influencerCountries: influencerCountries.rows.map(r => ({ name: r.country, value: parseInt(r.count) })),
          influencerNiches: influencerNiches.rows.map(r => ({ name: r.niche, value: parseInt(r.count) })),
          brandLocations: brandLocations.rows.map(r => ({ name: r.country, value: parseInt(r.count) })),
          creatorCategories: creatorCategories.rows.map(r => ({ name: r.content_category, value: parseInt(r.count) })),
          creatorGender: creatorGender.rows.map(r => ({ name: r.gender, value: parseInt(r.count) })),
          sampleStatuses: sampleStatuses.rows.map(r => ({ name: r.status, value: parseInt(r.count) })),
          verified: {
            verified: parseInt(verifiedSplit.rows[0]?.verified || 0),
            unverified: parseInt(verifiedSplit.rows[0]?.unverified || 0),
          },
          matchScores: matchScores.rows.map(r => ({ name: r.bracket, value: parseInt(r.count) })),
          topBrands: topBrands.rows.map(r => ({ name: r.name, value: parseInt(r.products) })),
        },
        igStats: {
          avgFollowers: Math.round(parseFloat(igStats.rows[0]?.avg_followers || 0)),
          avgEngagement: parseFloat(parseFloat(igStats.rows[0]?.avg_engagement || 0).toFixed(2)),
          avgPosts: Math.round(parseFloat(igStats.rows[0]?.avg_posts || 0)),
        },
        monetization: {
          hasStripe: parseInt(brandMonetization.rows[0]?.has_stripe || 0),
          hasPaymentMethod: parseInt(brandMonetization.rows[0]?.has_payment_method || 0),
          onTrial: parseInt(brandMonetization.rows[0]?.on_trial || 0),
          activeTrial: parseInt(brandMonetization.rows[0]?.active_trial || 0),
          expiredTrial: parseInt(brandMonetization.rows[0]?.expired_trial || 0),
          grantedTrial: parseInt(brandMonetization.rows[0]?.granted_trial || 0),
          trialPlans: trialPlans.rows.map(r => ({ plan: r.plan, interval: r.interval, count: parseInt(r.count) })),
        },
        revenue: {
          total: parseFloat(revenueStats.rows[0]?.total_revenue || 0),
          totalOrders: parseInt(revenueStats.rows[0]?.total_orders || 0),
          avgOrderValue: parseFloat(parseFloat(revenueStats.rows[0]?.avg_order_value || 0).toFixed(2)),
          uniqueLinksWithOrders: parseInt(revenueStats.rows[0]?.unique_links_with_orders || 0),
          byCurrency: (revenueStats.rows[0]?.by_currency || []).map((c) => ({ currency: c.currency, total: parseFloat(c.total || 0), orders: parseInt(c.orders || 0) })),
        },
        creatorPayments: {
          stripeConnected: parseInt(creatorStripe.rows[0]?.stripe_connected || 0),
          totalCreators: parseInt(creatorStripe.rows[0]?.total || 0),
        },
        payouts: payoutStats.rows.map(r => ({ status: r.status, count: parseInt(r.count), amount: parseFloat(r.total_amount || 0) })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Home: the focused business KPIs an operator/founder actually watches —
  // recurring revenue, the brand activation funnel, marketplace throughput, and
  // subscription/trial health. Deliberately excludes vanity counts (IG stats,
  // gender/niche splits, match scores, raw chat/sample counts).
  //
  // MRR is derived from users.account_id, which encodes the plan price
  // ("shopify_<price>_<period>"): the plan string is the source of truth that
  // exists on every subscribed brand today (app_subscriptions is still rolling
  // out). A brand whose brands.trial_expiration_date is in the future is on a
  // free trial (standard 14-day or admin-granted) and NOT yet billed, so it is
  // excluded from live MRR and counted as pipeline instead.
  // A brand is "live" only if it is also visible in the marketplace. brands.hidden
  // is what an operator sets from Manage to take a store out of circulation —
  // internal stores, test shops, and brands that have uninstalled the app — and
  // the Users page has always excluded them so the list reads as the live
  // marketplace. The metrics did not, so a hidden test store on a $199 plan was
  // counted as a quarter of MRR.
  const BRAND_ACTIVE = `u.role = 2 AND u.deleted = 'infinity'::timestamptz AND b.deleted = '-infinity'::timestamptz AND COALESCE(b.hidden, false) = false`;
  router.get("/home", async (req, res) => {
    try {
      // app_subscriptions is the main app's Shopify source-of-truth, but it does
      // not exist on every DB target yet. Referencing it unconditionally would
      // make the whole /home query 500, so mainAppSchema() says what the target
      // has and the SQL below only names what exists; otherwise it falls back to
      // the account_id-only revenue logic (the original behaviour). The same goes
      // for card plans (app_subscriptions.provider) and campaigns
      // (products.is_campaign): absent on prod until the promotion.
      const schema = await mainAppSchema();
      const hasAppSubs = schema.appSubscriptions;
      const card = schema.cardBilling;
      const subLateral = subscriptionLateral(schema, "status, price_after_discount, price_amount, price_currency, test");
      const amtExpr = hasAppSubs
        ? `COALESCE(NULLIF(asub.price_after_discount, 0), (substring(u.account_id from 'shopify_([0-9]+)'))::numeric)`
        : `(substring(u.account_id from 'shopify_([0-9]+)'))::numeric`;
      // A test-mode Shopify charge stays ACTIVE forever and bills nobody, so
      // status alone is not enough — the MRR series in insights.js already
      // excludes them and the tiles disagreed with their own trend line.
      // A brand on a Shopify TEST charge is not paying anyone. Needed in the
      // subscription-health counts too, which sat next to the revenue tiles
      // reporting a different number of paying brands.
      const notTestFilter = hasAppSubs ? `AND ${NOT_TEST_SUB()}` : "";
      const isTestExpr = hasAppSubs ? `COALESCE(asub.test, false)` : "false";
      const subActiveFilter = hasAppSubs
        ? `AND (asub.status IS NULL OR asub.status = 'ACTIVE') AND ${NOT_TEST_SUB()}`
        : "";
      // Card plans (main app #371): Stripe bills each in the brand's own
      // currency (GBP, USD or EUR since main app #485, price_currency on the
      // row), so card figures are kept per currency. Same columns, in
      // the same order, as the Shopify half of each paid CTE below. A card brand is
      // live while Stripe says active, in the pipeline while trialing; past_due
      // and unpaid (FROZEN in the status column) collect nothing, as a frozen
      // Shopify charge doesn't. Stripe test-mode subscriptions (every one on
      // dev) are test rows and excluded like Shopify test charges.
      const CARD_ROW = `${CARD_PLAN_SQL} AND asub.provider = 'stripe' AND ${NOT_TEST_SUB()}`;
      const cardSelect = card
        ? `SELECT 'stripe' AS provider, ${cardPlanTierSql} AS tier, ${cardPlanAmountSql()} AS amt,
                   UPPER(COALESCE(NULLIF(asub.price_currency, ''), 'GBP')) AS currency,
                   (u.account_id LIKE '%yearly%') AS yearly,
                   (asub.stripe_status = 'trialing') AS in_trial
            FROM users u JOIN brands b ON b.user_id = u.id
            ${subLateral}
            WHERE ${BRAND_ACTIVE} AND ${CARD_ROW} AND asub.stripe_status IN ('active', 'trialing')`
        : "";
      const cardPaid = card ? `UNION ALL ${cardSelect}` : "";
      // In the subscription-health split a card brand counts where a Shopify
      // one would: paying once Stripe has billed it (a declined card stays in
      // "paying", as a frozen Shopify charge does), in trial while trialing.
      const cardPaying = card ? `OR (${CARD_ROW} AND asub.stripe_status <> 'trialing')` : "";
      const cardInTrial = card ? `OR (${CARD_ROW} AND asub.stripe_status = 'trialing')` : "";
      // Campaigns: since #376 a products row is a campaign only when
      // is_campaign; the catalogue lives in shop_products. Old rows that were
      // only ever the catalogue are is_campaign = false.
      const CAMPAIGN = (a) => (schema.isCampaign ? `AND ${a ? `${a}.` : ""}is_campaign = true` : "");

      const [
        mrr, byTier, funnel, marketplace, subs, growth, gmvSeries, cardByCurrency,
      ] = await Promise.all([
        // MRR + paying + trial pipeline. coalesce so a NULL trial date reads as
        // "not on trial" (a paying brand), not as unknown.
        cloudSqlQuery(`
          WITH paid AS (
            SELECT 'shopify' AS provider, ''::text AS tier, ${amtExpr} AS amt, 'USD'::text AS currency,
                   (u.account_id LIKE '%yearly%' OR u.account_id LIKE '%annual%') AS yearly,
                   COALESCE(b.trial_expiration_date > NOW(), false) AS in_trial
            FROM users u JOIN brands b ON b.user_id = u.id
            ${subLateral}
            WHERE ${BRAND_ACTIVE} AND ${SHOPIFY_PLAN_SQL}
              -- If a live subscription row exists it must be ACTIVE: a FROZEN
              -- (payment failed) or stale-cancelled brand keeps its account_id
              -- but collects no revenue, so counting it inflates MRR. No row (or
              -- no app_subscriptions table on this target) → fall back to
              -- account_id. amt prefers price_after_discount so the Startup
              -- Programme intro ($99 vs $199) and Shopify discounts aren't
              -- over-counted.
              ${subActiveFilter}
            ${cardPaid}
          )
          SELECT
            ROUND(SUM(CASE WHEN provider = 'shopify' AND NOT in_trial THEN (CASE WHEN yearly THEN amt/12.0 ELSE amt END) ELSE 0 END), 2) AS live_mrr,
            COUNT(*) FILTER (WHERE provider = 'shopify' AND NOT in_trial) AS paying_brands,
            ROUND(SUM(CASE WHEN provider = 'shopify' AND in_trial THEN (CASE WHEN yearly THEN amt/12.0 ELSE amt END) ELSE 0 END), 2) AS pipeline_mrr,
            COUNT(*) FILTER (WHERE provider = 'shopify' AND in_trial) AS pipeline_brands,
            ROUND(SUM(CASE WHEN provider = 'stripe' AND NOT in_trial THEN (CASE WHEN yearly THEN amt/12.0 ELSE amt END) ELSE 0 END), 2) AS card_live_mrr,
            COUNT(*) FILTER (WHERE provider = 'stripe' AND NOT in_trial) AS card_paying_brands,
            ROUND(SUM(CASE WHEN provider = 'stripe' AND in_trial THEN (CASE WHEN yearly THEN amt/12.0 ELSE amt END) ELSE 0 END), 2) AS card_pipeline_mrr,
            COUNT(*) FILTER (WHERE provider = 'stripe' AND in_trial) AS card_pipeline_brands
          FROM paid`),

        // Live MRR split by plan tier, using the customer-facing labels the brand
        // sees in-app (2026-07 rebrand: $499 tier = "Growth", $199 tier = "Starter").
        cloudSqlQuery(`
          WITH paid AS (
            SELECT
              'shopify' AS provider,
              CASE
                WHEN u.account_id LIKE '%shopify_499%' OR u.account_id LIKE '%shopify_4970%' OR u.account_id LIKE '%shopify_299%' THEN 'Growth'
                ELSE 'Starter'
              END AS tier,
              ${amtExpr} AS amt,
              'USD'::text AS currency,
              (u.account_id LIKE '%yearly%' OR u.account_id LIKE '%annual%') AS yearly,
              false AS in_trial
            FROM users u JOIN brands b ON b.user_id = u.id
            ${subLateral}
            WHERE ${BRAND_ACTIVE} AND ${SHOPIFY_PLAN_SQL}
              AND COALESCE(b.trial_expiration_date > NOW(), false) = false
              -- Same frozen/stale exclusion as the headline MRR so the tier split
              -- reconciles to live_mrr (no-op when app_subscriptions is absent).
              ${subActiveFilter}
            ${cardPaid}
          )
          -- Card tiers are named like the Shopify ones but priced in the
          -- brand's currency, so they stay separate rows, one per currency.
          SELECT provider, tier, currency, ROUND(SUM(CASE WHEN yearly THEN amt/12.0 ELSE amt END), 2) AS mrr, COUNT(*) AS brands
          FROM paid WHERE NOT in_trial GROUP BY provider, tier, currency ORDER BY provider, mrr DESC`),

        // Brand activation funnel: signed up -> launched an active campaign ->
        // got an accepted creator -> generated a sale.
        cloudSqlQuery(`
          SELECT
            (SELECT COUNT(*) FROM users u JOIN brands b ON b.user_id = u.id WHERE ${BRAND_ACTIVE}) AS signed_up,
            (SELECT COUNT(DISTINCT p.user_id) FROM products p JOIN users u ON u.id = p.user_id JOIN brands b ON b.user_id = u.id WHERE ${BRAND_ACTIVE} AND p.status = 2 AND p.deleted = '-infinity'::timestamptz ${CAMPAIGN("p")}) AS launched_campaign,
            (SELECT COUNT(DISTINCT l.brand_user_id) FROM links l JOIN users u ON u.id = l.brand_user_id JOIN brands b ON b.user_id = u.id WHERE ${BRAND_ACTIVE} AND l.status = 3 AND l.deleted = '-infinity'::timestamptz) AS got_creator,
            (SELECT COUNT(DISTINCT l.brand_user_id) FROM orders o JOIN links l ON l.id = o.link_id JOIN users u ON u.id = l.brand_user_id JOIN brands b ON b.user_id = u.id WHERE ${BRAND_ACTIVE} AND o.deleted = '-infinity'::timestamptz) AS got_sale`),

        // Marketplace throughput.
        cloudSqlQuery(`
          SELECT
            -- Signed-up creators only: users.status = 1 is a husk (an account
            -- made for a creator by an invite, never signed up for), the main
            -- app's one "signed up" rule (SignedUpUserSQL). Husks shown apart.
            (SELECT COUNT(*) FROM influencers i JOIN users u ON u.id = i.user_id
              WHERE i.deleted = '-infinity'::timestamptz AND u.status <> 1) AS creators_total,
            (SELECT COUNT(*) FROM influencers i JOIN users u ON u.id = i.user_id
              WHERE i.deleted = '-infinity'::timestamptz AND u.status = 1) AS creators_husks,
            (SELECT COUNT(DISTINCT influencer_user_id) FROM links WHERE status = 3 AND deleted = '-infinity'::timestamptz) AS creators_active,
            (SELECT COUNT(*) FROM products WHERE status = 2 AND deleted = '-infinity'::timestamptz ${CAMPAIGN()}) AS active_campaigns,
            (SELECT COALESCE(SUM(shopify_amount), 0) FROM orders WHERE deleted = '-infinity'::timestamptz) AS gmv,
            -- the currency most orders were placed in (orders are stored in the shop currency, not converted)
            (SELECT COALESCE(NULLIF(shopify_currency, ''), 'USD') FROM orders WHERE deleted = '-infinity'::timestamptz
              GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1) AS gmv_currency,
            -- orders.commission is a PERCENT RATE, not an amount (see lib/mainAppSql.js).
            (SELECT COALESCE(${commissionEarnedSql()}, 0) FROM orders WHERE deleted = '-infinity'::timestamptz) AS commission_paid,
            (SELECT COUNT(*) FROM orders WHERE deleted = '-infinity'::timestamptz) AS orders,
            (SELECT COALESCE(AVG(shopify_amount), 0) FROM orders WHERE deleted = '-infinity'::timestamptz) AS avg_order,
            (SELECT COUNT(DISTINCT link_id) FROM orders WHERE deleted = '-infinity'::timestamptz) AS links_with_orders,
            -- Money that actually left the account: pending, failed and reversed payouts excluded.
            -- amount_value is text, so only numeric-looking rows are summed.
            (SELECT COALESCE(SUM(CASE WHEN amount_value ~ '^[0-9]+(\\.[0-9]+)?$' THEN amount_value::numeric ELSE 0 END), 0)
               FROM payouts WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))
                AND LOWER(status) IN ('paid', 'succeeded', 'completed')) AS paid_out,
            (SELECT COUNT(*) FROM payouts WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))
                AND LOWER(status) IN ('paid', 'succeeded', 'completed')) AS paid_out_count,
            (SELECT COALESCE(NULLIF(amount_currency, ''), 'USD') FROM payouts
              WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))
                AND LOWER(status) IN ('paid', 'succeeded', 'completed')
              GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1) AS paid_out_currency,
            (SELECT COALESCE(SUM(clicks_counter), 0) FROM links WHERE deleted = '-infinity'::timestamptz) AS clicks,
            -- Sample fulfilment. This is where campaigns actually stall: a
            -- creator accepted and is waiting on a box, so it belongs on Home
            -- next to the money rather than only inside Campaign Operations.
            -- 'shipped' has already passed 'accepted', so accepted counts both.
            (SELECT COUNT(*) FROM sample_requests WHERE deleted = '-infinity'::timestamptz
               AND status IN ('accepted', 'shipped')) AS samples_accepted,
            (SELECT COUNT(*) FROM sample_requests WHERE deleted = '-infinity'::timestamptz
               AND status = 'shipped') AS samples_shipped,
            (SELECT COUNT(*) FROM sample_requests WHERE deleted = '-infinity'::timestamptz
               AND status = 'pending') AS samples_pending`),

        // Subscription/trial health across active brands.
        cloudSqlQuery(`
          SELECT
            COUNT(*) FILTER (WHERE (${SHOPIFY_PLAN_SQL} AND COALESCE(b.trial_expiration_date > NOW(), false) = false ${notTestFilter}) ${cardPaying}) AS paying,
            -- Standard 14-day trial only (trial_plan_name empty). Admin-granted
            -- trials carry a trial_plan_name and are counted in extended_trial_active
            -- instead, so the two buckets stay mutually exclusive rather than
            -- double-counting a brand that is on a paid plan with a granted trial.
            COUNT(*) FILTER (WHERE (${SHOPIFY_PLAN_SQL} AND COALESCE(b.trial_expiration_date > NOW(), false) = true AND COALESCE(b.trial_plan_name, '') = '') ${cardInTrial}) AS in_trial,
            COUNT(*) FILTER (WHERE COALESCE(b.trial_plan_name, '') <> '' AND b.trial_activation_date > '-infinity'::timestamptz AND b.trial_expiration_date > NOW()) AS extended_trial_active,
            -- Cancelled but still inside the trial-access window: no paid plan
            -- (account_id cleared on cancel) yet trial_expiration_date is in the
            -- future, so hasActiveBrandTrial() still ungates them. Excludes
            -- admin-granted trials (trial_plan_name set) — those are their own
            -- bucket above, and they are not a cancellation.
            COUNT(*) FILTER (WHERE (COALESCE(u.account_id, '') = '' OR u.account_id IN ('shopify_free_plan', 'free_plan')) AND COALESCE(b.trial_expiration_date > NOW(), false) = true AND COALESCE(b.trial_plan_name, '') = '') AS cancelled_in_grace,
            -- Truly no active plan: no paid account_id AND no remaining trial
            -- access. A cancelled-in-grace brand is NOT counted here (it still
            -- has access) — that was the bug where it read "signed up, not
            -- subscribed" despite having subscribed then cancelled.
            -- A live test charge belongs here rather than in "paying": it has an
            -- account_id but bills nobody.
            COUNT(*) FILTER (WHERE ((COALESCE(u.account_id, '') = '' OR u.account_id IN ('shopify_free_plan', 'free_plan')) OR ${isTestExpr})
                             AND COALESCE(b.trial_expiration_date > NOW(), false) = false) AS no_paid_plan,
            -- Card plans whose last charge was declined: Stripe retries, the
            -- brand keeps its plan meanwhile (main app payments part 2).
            ${card ? `COUNT(*) FILTER (WHERE ${CARD_ROW} AND asub.stripe_status IN ('past_due', 'unpaid'))` : "0"} AS card_past_due
          FROM users u JOIN brands b ON b.user_id = u.id ${subLateral} WHERE ${BRAND_ACTIVE}`),

        // New brands this month vs last (momentum).
        cloudSqlQuery(`
          SELECT
            COUNT(*) FILTER (WHERE u.created >= date_trunc('month', NOW())) AS this_month,
            COUNT(*) FILTER (WHERE u.created >= date_trunc('month', NOW()) - INTERVAL '1 month' AND u.created < date_trunc('month', NOW())) AS last_month
          FROM users u JOIN brands b ON b.user_id = u.id WHERE ${BRAND_ACTIVE}`),

        // GMV per month, last 6 months (marketplace trend).
        cloudSqlQuery(`
          SELECT date_trunc('month', created)::date AS date, COALESCE(SUM(shopify_amount), 0) AS gmv, COUNT(*) AS orders
          FROM orders WHERE deleted = '-infinity'::timestamptz AND created >= NOW() - INTERVAL '6 months'
          GROUP BY 1 ORDER BY 1`),
        // Card plans per currency (a brand bills in its own: GBP, USD or EUR).
        card
          ? cloudSqlQuery(`
              SELECT currency,
                ROUND(SUM(CASE WHEN NOT in_trial THEN (CASE WHEN yearly THEN amt/12.0 ELSE amt END) ELSE 0 END), 2) AS mrr,
                COUNT(*) FILTER (WHERE NOT in_trial) AS paying_brands,
                ROUND(SUM(CASE WHEN in_trial THEN (CASE WHEN yearly THEN amt/12.0 ELSE amt END) ELSE 0 END), 2) AS pipeline_mrr,
                COUNT(*) FILTER (WHERE in_trial) AS pipeline_brands
              FROM (${cardSelect}) paid GROUP BY currency ORDER BY COUNT(*) DESC, currency`)
          : Promise.resolve({ rows: [] }),
      ]);

      const m = mrr.rows[0];
      const f = funnel.rows[0];
      const mk = marketplace.rows[0];
      const s = subs.rows[0];
      const g = growth.rows[0];
      const liveMrr = parseFloat(m.live_mrr || 0);
      const payingBrands = parseInt(m.paying_brands || 0);

      res.json({
        revenue: {
          mrr: liveMrr,
          arr: Math.round(liveMrr * 12 * 100) / 100,
          payingBrands,
          arpa: payingBrands ? parseFloat((liveMrr / payingBrands).toFixed(2)) : 0,
          pipelineMrr: parseFloat(m.pipeline_mrr || 0),
          pipelineBrands: parseInt(m.pipeline_brands || 0),
          // Card plans, billed by Stripe in each brand's own currency. Kept apart
          // from the USD figures above, and from each other, rather than
          // converted: there is no exchange rate to trust here. The headline
          // fields are the currency with the most card brands (GBP when there
          // are none); byCurrency lists every one. null where the target has
          // no card billing yet.
          card: card ? (() => {
            const rows = cardByCurrency.rows.map((r) => ({
              currency: r.currency,
              mrr: parseFloat(r.mrr || 0),
              arr: Math.round(parseFloat(r.mrr || 0) * 12 * 100) / 100,
              payingBrands: parseInt(r.paying_brands || 0),
              pipelineMrr: parseFloat(r.pipeline_mrr || 0),
              pipelineBrands: parseInt(r.pipeline_brands || 0),
            }));
            const top = rows[0] || { currency: "GBP", mrr: 0, arr: 0, payingBrands: 0, pipelineMrr: 0, pipelineBrands: 0 };
            return { ...top, byCurrency: rows, pastDueBrands: parseInt(s.card_past_due || 0) };
          })() : null,
          byTier: byTier.rows.map((r) => ({
            tier: r.provider === "stripe" ? `${r.tier} · card` : r.tier,
            provider: r.provider,
            currency: r.currency || (r.provider === "stripe" ? "GBP" : "USD"),
            mrr: parseFloat(r.mrr || 0),
            brands: parseInt(r.brands),
          })),
        },
        funnel: {
          signedUp: parseInt(f.signed_up || 0),
          launchedCampaign: parseInt(f.launched_campaign || 0),
          gotCreator: parseInt(f.got_creator || 0),
          gotSale: parseInt(f.got_sale || 0),
        },
        marketplace: {
          creatorsTotal: parseInt(mk.creators_total || 0),
          creatorsHusks: parseInt(mk.creators_husks || 0),
          creatorsActive: parseInt(mk.creators_active || 0),
          activeCampaigns: parseInt(mk.active_campaigns || 0),
          gmv: parseFloat(mk.gmv || 0),
          gmvCurrency: mk.gmv_currency || "USD",
          commissionPaid: parseFloat(mk.commission_paid || 0),
          orders: parseInt(mk.orders || 0),
          avgOrder: parseFloat(mk.avg_order || 0),
          linksWithOrders: parseInt(mk.links_with_orders || 0),
          paidOut: parseFloat(mk.paid_out || 0),
          paidOutCount: parseInt(mk.paid_out_count || 0),
          paidOutCurrency: mk.paid_out_currency || "USD",
          samplesAccepted: parseInt(mk.samples_accepted || 0),
          samplesShipped: parseInt(mk.samples_shipped || 0),
          samplesPending: parseInt(mk.samples_pending || 0),
          clicks: parseInt(mk.clicks || 0),
        },
        subscriptions: {
          paying: parseInt(s.paying || 0),
          inTrial: parseInt(s.in_trial || 0),
          extendedTrialActive: parseInt(s.extended_trial_active || 0),
          cancelledInGrace: parseInt(s.cancelled_in_grace || 0),
          noPaidPlan: parseInt(s.no_paid_plan || 0),
        },
        brands: {
          newThisMonth: parseInt(g.this_month || 0),
          newLastMonth: parseInt(g.last_month || 0),
        },
        gmvSeries: gmvSeries.rows.map((r) => ({ date: r.date, gmv: parseFloat(r.gmv || 0), orders: parseInt(r.orders) })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Per-table analytics — focused on useful business data only
  router.get("/:table", async (req, res) => {
    const { table } = req.params;

    // Columns to skip for distributions/stats
    const skipCols = new Set([
      "id", "created", "updated", "deleted", "sub", "verifier", "token",
      "password_hash", "password_reset_otp", "activation_code_hash",
      "shopify_token", "shopify_storefront", "facebook_token",
      "stripe_account_id", "stripe_customer_id", "stripe_transfer_id",
      "default_payment_method_id", "payment_intent_id", "transfer_id",
      "account_id", "raw_api_response", "original_invitation_data",
      "instagram_posts_data", "feed_preview_urls", "hashtags",
      "hashtag_frequencies", "lookalikes", "language_codes", "language_confidence",
      "links_in_bio",
    ]);
    const skipPatterns = [/_id$/, /token$/i, /secret$/i, /hash$/i, /_otp$/i, /pic_name$/, /image$/, /logo$/, /banner$/, /url$/i, /storefront$/i];

    function isUsefulCol(name) {
      if (skipCols.has(name)) return false;
      if (skipPatterns.some(p => p.test(name))) return false;
      return true;
    }

    // Preferred distribution columns — these are interesting to chart
    const distPrefs = ["status", "type", "category", "role", "state", "niche", "gender", "country",
      "location", "location_country", "content_category", "platform", "currency", "plan",
      "channel", "region", "tier", "invitation_type", "commission_source", "payout_schedule"];

    try {
      const { rows: columns } = await cloudSqlQuery(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name = $1 AND table_schema = 'public' ORDER BY ordinal_position`, [table]);
      // Soft-deleted rows ('deleted' holds a real timestamp; 'infinity'/'-infinity'/NULL mean live)
      // are excluded everywhere below so this page agrees with the Dashboard KPIs and the table view.
      const hasDeleted = columns.some((c) => c.column_name === "deleted");
      const live = hasDeleted ? `("deleted" IS NULL OR "deleted" IN ('infinity'::timestamptz, '-infinity'::timestamptz))` : "TRUE";
      const { rows: countRows } = await cloudSqlQuery(`SELECT COUNT(*) as total FROM "${table}" WHERE ${live}`);
      const total = parseInt(countRows[0].total);

      // Pick text columns for distributions — prioritize meaningful ones
      const textCols = columns.filter(c =>
        ["text", "character varying", "varchar", "USER-DEFINED"].includes(c.data_type) && isUsefulCol(c.column_name)
      );
      // Sort: preferred columns first
      textCols.sort((a, b) => {
        const aIdx = distPrefs.findIndex(p => a.column_name.includes(p));
        const bIdx = distPrefs.findIndex(p => b.column_name.includes(p));
        return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
      });

      const distributions = {};
      for (const col of textCols.slice(0, 5)) {
        const { rows: dist } = await cloudSqlQuery(
          `SELECT "${col.column_name}" as value, COUNT(*) as count FROM "${table}"
           WHERE ${live} AND "${col.column_name}" IS NOT NULL AND "${col.column_name}" != ''
           GROUP BY "${col.column_name}" ORDER BY count DESC LIMIT 10`);
        // Only include if it's a real distribution (not all unique values)
        if (dist.length >= 2 && parseInt(dist[0].count) > 1) {
          distributions[col.column_name] = dist;
        }
      }

      // Numeric stats — only meaningful ones
      const numericStats = {};
      const numCols = columns.filter(c =>
        ["integer", "bigint", "numeric", "real", "double precision", "smallint"].includes(c.data_type) && isUsefulCol(c.column_name)
      );
      for (const col of numCols.slice(0, 5)) {
        const { rows: stats } = await cloudSqlQuery(
          `SELECT MIN("${col.column_name}") as min, MAX("${col.column_name}") as max,
           AVG("${col.column_name}")::numeric(20,2) as avg, COUNT("${col.column_name}") as non_null_count
           FROM "${table}" WHERE ${live} AND "${col.column_name}" IS NOT NULL`);
        if (stats[0] && stats[0].min !== null) {
          numericStats[col.column_name] = stats[0];
        }
      }

      // Time series — prefer 'created', use monthly grouping for all-time view
      const tsCols = columns.filter(c =>
        ["timestamp without time zone", "timestamp with time zone"].includes(c.data_type) &&
        (c.column_name === "created" || c.column_name === "created_at" || c.column_name === "inserted_at")
      );
      const timeSeries = {};
      for (const col of tsCols.slice(0, 1)) {
        const { rows: ts } = await cloudSqlQuery(
          `SELECT DATE_TRUNC('week', "${col.column_name}")::date as date, COUNT(*) as count
           FROM "${table}" WHERE ${live} AND "${col.column_name}" > '2020-01-01' AND "${col.column_name}" < NOW()
           GROUP BY DATE_TRUNC('week', "${col.column_name}") ORDER BY date`);
        if (ts.length >= 2) timeSeries[col.column_name] = ts;
      }

      res.json({ table, total, distributions, numericStats, timeSeries });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
}
