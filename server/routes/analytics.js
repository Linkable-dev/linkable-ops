import express from "express";
import { cloudSqlQuery } from "../lib/cloudsql.js";

export function analyticsRoutes() {
  const router = express.Router();

  // Dashboard: business KPIs for Linkable influencer platform
  router.get("/overview", async (req, res) => {
    try {
      const results = await Promise.all([
        // Core counts
        cloudSqlQuery(`SELECT COUNT(*) as total FROM brands WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),
        cloudSqlQuery(`SELECT COUNT(*) as total FROM influencers WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),
        cloudSqlQuery(`SELECT COUNT(*) as total FROM external_creators WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),
        cloudSqlQuery(`SELECT COUNT(*) as total FROM products WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),
        cloudSqlQuery(`SELECT COUNT(*) as total FROM links WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),
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

        // Products per month (all time)
        cloudSqlQuery(`SELECT DATE_TRUNC('month', created)::date as date, COUNT(*) as count FROM products WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz)) AND created > '2020-01-01' GROUP BY DATE_TRUNC('month', created) ORDER BY date`),

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

        // Top brands by product count
        cloudSqlQuery(`SELECT b.store_name as name, COUNT(p.id) as products
          FROM brands b JOIN products p ON p.brand_id = b.id
          WHERE b.deleted IS NULL AND p.deleted IS NULL AND b.store_name IS NOT NULL
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
          COUNT(*) FILTER (WHERE trial_plan_name IS NOT NULL AND trial_plan_name != '') as on_trial,
          COUNT(*) FILTER (WHERE trial_expiration_date IS NOT NULL AND trial_expiration_date > NOW() AND trial_expiration_date < 'infinity'::timestamptz) as active_trial,
          COUNT(*) FILTER (WHERE trial_expiration_date IS NOT NULL AND trial_expiration_date <= NOW() AND trial_expiration_date > '-infinity'::timestamptz AND trial_plan_name IS NOT NULL AND trial_plan_name != '') as expired_trial
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
          COUNT(DISTINCT link_id) as unique_links_with_orders
          FROM orders WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),

        // Creator Stripe connectivity
        cloudSqlQuery(`SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE stripe_account_id IS NOT NULL AND stripe_account_id != '') as stripe_connected
          FROM users WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`),

        // Payout stats
        cloudSqlQuery(`SELECT status, COUNT(*) as count, COALESCE(SUM(amount_value::numeric), 0) as total_amount
          FROM payouts WHERE (deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))
          GROUP BY status ORDER BY count DESC`),
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
      ] = results;

      res.json({
        kpis: {
          brands: parseInt(brandsCount.rows[0].total),
          influencers: parseInt(influencersCount.rows[0].total),
          externalCreators: parseInt(externalCreatorsCount.rows[0].total),
          products: parseInt(productsCount.rows[0].total),
          links: parseInt(linksCount.rows[0].total),
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
          trialPlans: trialPlans.rows.map(r => ({ plan: r.plan, interval: r.interval, count: parseInt(r.count) })),
        },
        revenue: {
          total: parseFloat(revenueStats.rows[0]?.total_revenue || 0),
          totalOrders: parseInt(revenueStats.rows[0]?.total_orders || 0),
          avgOrderValue: parseFloat(parseFloat(revenueStats.rows[0]?.avg_order_value || 0).toFixed(2)),
          uniqueLinksWithOrders: parseInt(revenueStats.rows[0]?.unique_links_with_orders || 0),
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
  const BRAND_ACTIVE = `u.role = 2 AND u.deleted = 'infinity'::timestamptz AND b.deleted = '-infinity'::timestamptz`;
  router.get("/home", async (req, res) => {
    try {
      const [
        mrr, byTier, funnel, marketplace, subs, growth, gmvSeries,
      ] = await Promise.all([
        // MRR + paying + trial pipeline. coalesce so a NULL trial date reads as
        // "not on trial" (a paying brand), not as unknown.
        cloudSqlQuery(`
          WITH paid AS (
            SELECT (substring(u.account_id from 'shopify_([0-9]+)'))::numeric AS amt,
                   (u.account_id LIKE '%yearly%' OR u.account_id LIKE '%annual%') AS yearly,
                   COALESCE(b.trial_expiration_date > NOW(), false) AS in_trial
            FROM users u JOIN brands b ON b.user_id = u.id
            WHERE ${BRAND_ACTIVE} AND u.account_id ~ '^shopify_[0-9]+'
          )
          SELECT
            ROUND(SUM(CASE WHEN NOT in_trial THEN (CASE WHEN yearly THEN amt/12.0 ELSE amt END) ELSE 0 END), 2) AS live_mrr,
            COUNT(*) FILTER (WHERE NOT in_trial) AS paying_brands,
            ROUND(SUM(CASE WHEN in_trial THEN (CASE WHEN yearly THEN amt/12.0 ELSE amt END) ELSE 0 END), 2) AS pipeline_mrr,
            COUNT(*) FILTER (WHERE in_trial) AS pipeline_brands
          FROM paid`),

        // Live MRR split by plan tier (mirrors the app's Growth/Scale lineup).
        cloudSqlQuery(`
          WITH paid AS (
            SELECT
              CASE
                WHEN u.account_id LIKE '%shopify_499%' OR u.account_id LIKE '%shopify_4970%' OR u.account_id LIKE '%shopify_299%' THEN 'Scale'
                ELSE 'Growth'
              END AS tier,
              (substring(u.account_id from 'shopify_([0-9]+)'))::numeric AS amt,
              (u.account_id LIKE '%yearly%' OR u.account_id LIKE '%annual%') AS yearly
            FROM users u JOIN brands b ON b.user_id = u.id
            WHERE ${BRAND_ACTIVE} AND u.account_id ~ '^shopify_[0-9]+'
              AND COALESCE(b.trial_expiration_date > NOW(), false) = false
          )
          SELECT tier, ROUND(SUM(CASE WHEN yearly THEN amt/12.0 ELSE amt END), 2) AS mrr, COUNT(*) AS brands
          FROM paid GROUP BY tier ORDER BY mrr DESC`),

        // Brand activation funnel: signed up -> launched an active campaign ->
        // got an accepted creator -> generated a sale.
        cloudSqlQuery(`
          SELECT
            (SELECT COUNT(*) FROM users u JOIN brands b ON b.user_id = u.id WHERE ${BRAND_ACTIVE}) AS signed_up,
            (SELECT COUNT(DISTINCT p.user_id) FROM products p WHERE p.status = 2 AND p.deleted = '-infinity'::timestamptz) AS launched_campaign,
            (SELECT COUNT(DISTINCT l.brand_user_id) FROM links l WHERE l.status = 3 AND l.deleted = '-infinity'::timestamptz) AS got_creator,
            (SELECT COUNT(DISTINCT l.brand_user_id) FROM orders o JOIN links l ON l.id = o.link_id WHERE o.deleted = '-infinity'::timestamptz) AS got_sale`),

        // Marketplace throughput.
        cloudSqlQuery(`
          SELECT
            (SELECT COUNT(*) FROM influencers WHERE deleted = '-infinity'::timestamptz) AS creators_total,
            (SELECT COUNT(DISTINCT influencer_user_id) FROM links WHERE status = 3 AND deleted = '-infinity'::timestamptz) AS creators_active,
            (SELECT COUNT(*) FROM products WHERE status = 2 AND deleted = '-infinity'::timestamptz) AS active_campaigns,
            (SELECT COALESCE(SUM(shopify_amount), 0) FROM orders WHERE deleted = '-infinity'::timestamptz) AS gmv,
            (SELECT COALESCE(SUM((commission)::numeric), 0) FROM orders WHERE deleted = '-infinity'::timestamptz AND commission ~ '^[0-9.]+$') AS commission_paid,
            (SELECT COUNT(*) FROM orders WHERE deleted = '-infinity'::timestamptz) AS orders,
            (SELECT COALESCE(SUM(clicks_counter), 0) FROM links WHERE deleted = '-infinity'::timestamptz) AS clicks`),

        // Subscription/trial health across active brands.
        cloudSqlQuery(`
          SELECT
            COUNT(*) FILTER (WHERE u.account_id ~ '^shopify_[0-9]+' AND COALESCE(b.trial_expiration_date > NOW(), false) = false) AS paying,
            COUNT(*) FILTER (WHERE u.account_id ~ '^shopify_[0-9]+' AND COALESCE(b.trial_expiration_date > NOW(), false) = true) AS in_trial,
            COUNT(*) FILTER (WHERE COALESCE(b.trial_plan_name, '') <> '' AND b.trial_activation_date > '-infinity'::timestamptz AND b.trial_expiration_date > NOW()) AS extended_trial_active,
            COUNT(*) FILTER (WHERE COALESCE(u.account_id, '') = '' OR u.account_id = 'shopify_free_plan' OR u.account_id = 'free_plan') AS no_paid_plan
          FROM users u JOIN brands b ON b.user_id = u.id WHERE ${BRAND_ACTIVE}`),

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
          arr: Math.round(liveMrr * 12),
          payingBrands,
          arpa: payingBrands ? parseFloat((liveMrr / payingBrands).toFixed(2)) : 0,
          pipelineMrr: parseFloat(m.pipeline_mrr || 0),
          pipelineBrands: parseInt(m.pipeline_brands || 0),
          byTier: byTier.rows.map((r) => ({ tier: r.tier, mrr: parseFloat(r.mrr || 0), brands: parseInt(r.brands) })),
        },
        funnel: {
          signedUp: parseInt(f.signed_up || 0),
          launchedCampaign: parseInt(f.launched_campaign || 0),
          gotCreator: parseInt(f.got_creator || 0),
          gotSale: parseInt(f.got_sale || 0),
        },
        marketplace: {
          creatorsTotal: parseInt(mk.creators_total || 0),
          creatorsActive: parseInt(mk.creators_active || 0),
          activeCampaigns: parseInt(mk.active_campaigns || 0),
          gmv: parseFloat(mk.gmv || 0),
          commissionPaid: parseFloat(mk.commission_paid || 0),
          orders: parseInt(mk.orders || 0),
          clicks: parseInt(mk.clicks || 0),
        },
        subscriptions: {
          paying: parseInt(s.paying || 0),
          inTrial: parseInt(s.in_trial || 0),
          extendedTrialActive: parseInt(s.extended_trial_active || 0),
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
      const { rows: countRows } = await cloudSqlQuery(`SELECT COUNT(*) as total FROM "${table}"`);
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
           WHERE "${col.column_name}" IS NOT NULL AND "${col.column_name}" != ''
           GROUP BY "${col.column_name}" ORDER BY count DESC LIMIT 10`);
        // Only include if it's a real distribution (not all unique values)
        if (dist.length >= 2 && dist.length <= 15 && parseInt(dist[0].count) > 1) {
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
           FROM "${table}" WHERE "${col.column_name}" IS NOT NULL`);
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
           FROM "${table}" WHERE "${col.column_name}" > '2020-01-01' AND "${col.column_name}" < NOW()
           GROUP BY DATE_TRUNC('week', "${col.column_name}") ORDER BY date`);
        if (ts.length >= 2) timeSeries[col.column_name] = ts;
      }

      res.json({ table, total, distributions, numericStats, timeSeries });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
}
