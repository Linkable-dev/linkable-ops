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
