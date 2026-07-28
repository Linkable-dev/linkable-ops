import { Router } from "express";
import { cloudSqlQuery } from "../lib/cloudsql.js";
import { parseColumnFilters, filterConditions, textFilter } from "../lib/tableQuery.js";

// Link status enum (from main proto):
//   0=unset
//   1=pending_brand        -- BRAND-initiated invitation, awaiting creator response
//                             (chat type=4 from brand side). UI: "Invited".
//   2=pending_influencer   -- CREATOR-initiated application, awaiting brand response.
//                             UI: "Applied".
//   3=accepted, 4=rejected, 5=ended
// The pending_X naming refers to whose original request is still pending — NOT who
// the system is waiting on to act. Verified against chats data 2026-05-12.
const LINK_ACCEPTED = 3;
const LINK_INVITED = 1;

// `deleted` uses '-infinity' as sentinel for "not deleted" in this DB.
const ND = `(deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`;

// Per-column filters (filter[col]=val). Only plain columns from products/brands:
// the aggregate columns (applied, shipped, sales, …) would need HAVING against
// the CTE output, which this query shape doesn't support — deliberately omitted.
const CAMPAIGN_FILTERS = {
  campaign_name: textFilter("p.title"),
  brand_name:    textFilter("b.store_name"),
};

export function opsRoutes() {
  const router = Router();

  // GET /api/ops/campaigns?limit=&offset=&search=&sortBy=&sortDir=
  // One row per product (= campaign) with aggregated counts.
  // Sorting is server-side — aggregates are computed for all matched products
  // before sort + paginate, so sort works across the full dataset.
  router.get("/campaigns", async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 200);
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);
      const search = (req.query.search || "").trim();

      // Allow-list of sortable fields → SQL expression. Anything else falls
      // back to the default created-DESC order.
      const SORTABLE = {
        campaign_name:     "campaign_name",
        brand_name:        "brand_name",
        creators_invited:  "creators_invited",
        creators_applied:  "creators_applied",
        creators_accepted: "creators_accepted",
        samples_accepted:  "samples_accepted",
        products_shipped:  "products_shipped",
        clicks:            "clicks",
        sales:             "sales",
        revenue:           "revenue",
        bottleneck:        "bottleneck_severity",
        created:           "created",
      };
      // After the SORTABLE lookup, sortColumn is a vetted SQL identifier we
      // can interpolate safely; sortKey is what we echo back to the client.
      const sortKey = SORTABLE[req.query.sortBy] ? req.query.sortBy : "created";
      const sortColumn = SORTABLE[sortKey];
      const sortDir = (req.query.sortDir || "").toLowerCase() === "asc" ? "ASC" : "DESC";

      // products.status enum: 0=unset 1=new 2=active 3=paused 4=ended
      // We only care about active campaigns for the ops view.
      const PRODUCT_ACTIVE = 2;

      const searchPattern = search ? `%${search}%` : null;
      const searchClause = `($1::text IS NULL OR p.title ILIKE $1 OR b.store_name ILIKE $1)`;

      // Per-column filters. Conditions embed positional placeholders, so each
      // query gets its own params array + its own filterConditions() pass.
      const columnFilters = parseColumnFilters(req.query);

      const countParams = [searchPattern];
      const countFilterSql = filterConditions(columnFilters, CAMPAIGN_FILTERS, countParams)
        .map((c) => ` AND ${c}`).join("");

      const { rows: countRows } = await cloudSqlQuery(
        `SELECT COUNT(*)::int AS total
         FROM products p
         LEFT JOIN brands b ON b.id = p.brand_id
         WHERE ${ND.replace(/deleted/g, "p.deleted")} AND p.status = ${PRODUCT_ACTIVE} AND ${searchClause}${countFilterSql}`,
        countParams
      );
      const total = countRows[0]?.total || 0;

      // Compute aggregates for ALL matched products (active set is small —
      // ~tens, not thousands), then sort + paginate. Sort key may reference
      // an aggregate so we can't paginate before aggregating.
      const mainParams = [searchPattern, LINK_ACCEPTED, limit, offset, LINK_INVITED];
      const baseFilterSql = filterConditions(columnFilters, CAMPAIGN_FILTERS, mainParams)
        .map((c) => ` AND ${c}`).join("");

      const { rows } = await cloudSqlQuery(`
        WITH base AS (
          SELECT p.id, p.title AS campaign_name, b.store_name AS brand_name,
                 p.status AS product_status, p.created
          FROM products p
          LEFT JOIN brands b ON b.id = p.brand_id
          WHERE ${ND.replace(/deleted/g, "p.deleted")}
            AND p.status = ${PRODUCT_ACTIVE}
            AND ($1::text IS NULL OR p.title ILIKE $1 OR b.store_name ILIKE $1)${baseFilterSql}
        ),
        link_best AS (
          -- One row per creator per product. A creator can hold several links on the
          -- same campaign (re-invites, apply-after-invite); counting rows would
          -- overstate the funnel and disagree with the drill-down. Keep the most
          -- advanced link (accepted > applied/other > invited), latest as tiebreak.
          SELECT DISTINCT ON (l.product_id, COALESCE(l.influencer_user_id::text, l.id::text))
                 l.product_id, l.status
          FROM links l
          WHERE l.product_id IN (SELECT id FROM base) AND ${ND.replace(/deleted/g, "l.deleted")}
          ORDER BY l.product_id, COALESCE(l.influencer_user_id::text, l.id::text),
                   CASE l.status WHEN $2 THEN 0 WHEN $5 THEN 2 ELSE 1 END,
                   l.created DESC NULLS LAST
        ),
        link_agg AS (
          -- "Invited" = brand reached out, creator hasn't responded yet (link.status = pending_brand = 1).
          -- "Applied" = creator-initiated or further along (anything except pending_brand). Once an
          -- invited creator responds, status moves off pending_brand and they count as Applied.
          SELECT lb.product_id,
                 COUNT(*) FILTER (WHERE lb.status = $5)                  AS creators_invited,
                 COUNT(*) FILTER (WHERE lb.status IS DISTINCT FROM $5)   AS creators_applied,
                 COUNT(*) FILTER (WHERE lb.status = $2)                  AS creators_accepted
          FROM link_best lb
          GROUP BY lb.product_id
        ),
        clicks_agg AS (
          -- Clicks sum over ALL links (not the deduped set): every link a creator
          -- holds tracks real traffic.
          SELECT l.product_id, COALESCE(SUM(l.clicks_counter), 0) AS clicks
          FROM links l
          WHERE l.product_id IN (SELECT id FROM base) AND ${ND.replace(/deleted/g, "l.deleted")}
          GROUP BY l.product_id
        ),
        ext_agg AS (
          -- External creators (not yet Linkable users) invited to the campaign by
          -- email. Same status enum family as links: pending_brand = invited; once
          -- the creator responds the row moves off pending_brand and counts as applied.
          SELECT ecl.product_id,
                 COUNT(*) FILTER (WHERE ecl.status = $5)                    AS externals_invited,
                 COUNT(*) FILTER (WHERE ecl.status IS DISTINCT FROM $5)     AS externals_applied,
                 COUNT(*) FILTER (WHERE ecl.status = $2)                    AS externals_accepted
          FROM external_creator_links ecl
          WHERE ecl.product_id IN (SELECT id FROM base) AND ${ND.replace(/deleted/g, "ecl.deleted")}
          GROUP BY ecl.product_id
        ),
        sample_agg AS (
          -- Counts are cumulative funnel stages: a sample that has shipped has also
          -- passed the "accepted" stage, so 'shipped' counts toward samples_accepted too.
          -- (shipped ⊆ accepted). Without this, shipping a sample drains samples_accepted
          -- back to 0, breaking the left-to-right funnel.
          SELECT sr.product_id,
                 COUNT(DISTINCT sr.influencer_user_id) FILTER (WHERE sr.status IN ('accepted', 'shipped')) AS samples_accepted,
                 COUNT(DISTINCT sr.influencer_user_id) FILTER (WHERE sr.status = 'shipped')  AS products_shipped
          FROM sample_requests sr
          WHERE sr.product_id IN (SELECT id FROM base) AND ${ND.replace(/deleted/g, "sr.deleted")}
          GROUP BY sr.product_id
        ),
        sales_agg AS (
          SELECT l.product_id, COUNT(*) AS sales, COALESCE(SUM(o.shopify_amount), 0) AS revenue
          FROM orders o
          JOIN links l ON l.id = o.link_id
          WHERE l.product_id IN (SELECT id FROM base) AND ${ND.replace(/deleted/g, "o.deleted")}
          GROUP BY l.product_id
        ),
        enriched AS (
          SELECT
            p.id,
            p.campaign_name,
            p.brand_name,
            p.product_status,
            p.created,
            -- Platform + external combined: one number per funnel stage. The
            -- platform/external split lives in the drill-down (Source column).
            (COALESCE(la.creators_invited, 0)  + COALESCE(ea.externals_invited, 0))::int  AS creators_invited,
            (COALESCE(la.creators_applied, 0)  + COALESCE(ea.externals_applied, 0))::int  AS creators_applied,
            (COALESCE(la.creators_accepted, 0) + COALESCE(ea.externals_accepted, 0))::int AS creators_accepted,
            COALESCE(sm.samples_accepted, 0)::int  AS samples_accepted,
            COALESCE(sm.products_shipped, 0)::int  AS products_shipped,
            COALESCE(ca.clicks, 0)::int            AS clicks,
            COALESCE(sa.sales, 0)::int             AS sales,
            COALESCE(sa.revenue, 0)                AS revenue,
            -- Bottleneck severity: mirrors computeBottleneck() on the client.
            -- Higher = more severe → sort DESC puts worst first.
            CASE
              WHEN COALESCE(sm.samples_accepted, 0) > 0
                   AND COALESCE(sm.products_shipped, 0) < COALESCE(sm.samples_accepted, 0) THEN 3 -- danger: shipping
              WHEN COALESCE(sm.products_shipped, 0)
                   < COALESCE(la.creators_accepted, 0) + COALESCE(ea.externals_accepted, 0) THEN 3 -- danger: shipping
              WHEN COALESCE(la.creators_applied, 0) + COALESCE(ea.externals_applied, 0) = 0
                   AND COALESCE(la.creators_invited, 0) + COALESCE(ea.externals_invited, 0) = 0 THEN 2 -- warn: no outreach
              WHEN COALESCE(la.creators_applied, 0) + COALESCE(ea.externals_applied, 0) = 0 THEN 1     -- info: awaiting invite responses
              WHEN COALESCE(la.creators_accepted, 0) + COALESCE(ea.externals_accepted, 0) = 0 THEN 2   -- warn: no accepts
              WHEN COALESCE(sa.sales, 0) = 0 THEN 1                                               -- info: no sales
              ELSE 0                                                                              -- healthy
            END AS bottleneck_severity
          FROM base p
          LEFT JOIN link_agg la    ON la.product_id = p.id
          LEFT JOIN clicks_agg ca  ON ca.product_id = p.id
          LEFT JOIN ext_agg ea     ON ea.product_id = p.id
          LEFT JOIN sample_agg sm  ON sm.product_id = p.id
          LEFT JOIN sales_agg sa   ON sa.product_id = p.id
        )
        SELECT * FROM enriched
        ORDER BY ${sortColumn} ${sortDir} NULLS LAST, created DESC NULLS LAST
        LIMIT $3 OFFSET $4
      `, mainParams);

      res.json({ rows, total, limit, offset, sortBy: sortKey, sortDir });
    } catch (e) {
      console.error("[ops/campaigns]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/ops/campaigns/:id/creators
  // One row per creator on a given product, with computed pipeline status.
  router.get("/campaigns/:id/creators", async (req, res) => {
    try {
      const { id } = req.params;
      // One row per creator, not per link: creators can hold several links on the
      // same campaign (re-invites, apply-after-invite). We show the most advanced
      // link's status and aggregate clicks/sales/sample state across all their
      // links, so the funnel here matches the campaign-level aggregates exactly.
      const { rows } = await cloudSqlQuery(`
        WITH nd AS (
          SELECT l.*, COALESCE(l.influencer_user_id::text, l.id::text) AS creator_key
          FROM links l
          WHERE l.product_id = $1 AND ${ND.replace(/deleted/g, "l.deleted")}
        ),
        best AS (
          SELECT DISTINCT ON (creator_key) *
          FROM nd
          ORDER BY creator_key,
                   CASE status WHEN ${LINK_ACCEPTED} THEN 0 WHEN ${LINK_INVITED} THEN 2 ELSE 1 END,
                   created DESC NULLS LAST
        )
        SELECT
          b.id                                                                                               AS link_id,
          b.influencer_user_id,
          b.status                                                                                            AS link_status,
          (SELECT COALESCE(SUM(l2.clicks_counter), 0) FROM nd l2 WHERE l2.creator_key = b.creator_key)        AS clicks,
          COALESCE(NULLIF(TRIM(CONCAT_WS(' ', i.first_name, i.last_name)), ''),
                   i.instagram_username, i.username, 'Unknown creator')                                       AS creator_name,
          i.instagram_username                                                                                AS instagram_username,
          sr_latest.status                                                                                    AS sample_request_status,
          (SELECT COUNT(*) FROM orders o JOIN nd l2 ON l2.id = o.link_id
            WHERE l2.creator_key = b.creator_key AND ${ND.replace(/deleted/g, "o.deleted")})                  AS sales,
          (SELECT COALESCE(SUM(o.shopify_amount), 0) FROM orders o JOIN nd l2 ON l2.id = o.link_id
            WHERE l2.creator_key = b.creator_key AND ${ND.replace(/deleted/g, "o.deleted")})                  AS revenue
        FROM best b
        LEFT JOIN influencers i ON i.user_id = b.influencer_user_id
        LEFT JOIN LATERAL (
          SELECT sr.status
          FROM sample_requests sr
          JOIN nd l2 ON l2.id = sr.link_id
          WHERE l2.creator_key = b.creator_key AND ${ND.replace(/deleted/g, "sr.deleted")}
          ORDER BY sr.created DESC NULLS LAST
          LIMIT 1
        ) sr_latest ON true
        ORDER BY b.created DESC NULLS LAST
      `, [id]);

      // External creators (not yet Linkable users) invited to this campaign by
      // email. They live in external_creator_links, which the links query above
      // can't see; without this they'd be invisible in the ops view.
      const { rows: extRows } = await cloudSqlQuery(`
        SELECT
          ecl.id                                                                                    AS link_id,
          ecl.status                                                                                AS link_status,
          COALESCE(NULLIF(TRIM(CONCAT_WS(' ', ec.first_name, ec.last_name)), ''),
                   ec.username, ec.instagram_username, 'Unknown creator')                           AS creator_name,
          ec.instagram_username                                                                     AS instagram_username
        FROM external_creator_links ecl
        LEFT JOIN external_creators ec ON ec.id = ecl.external_creator_id
        WHERE ecl.product_id = $1 AND ${ND.replace(/deleted/g, "ecl.deleted")}
        ORDER BY ecl.created DESC NULLS LAST
      `, [id]);

      const result = rows.map((r) => {
        const srStatus = r.sample_request_status; // 'pending' | 'accepted' | 'shipped' | other | null
        let status = "Applied";
        if (Number(r.sales) > 0) status = "Sold";
        else if (srStatus === "shipped") status = "Shipped";
        else if (srStatus === "accepted") status = "Sample Accepted";
        else if (r.link_status === LINK_ACCEPTED) status = "Accepted";
        else if (r.link_status === LINK_INVITED) status = "Invited";
        return {
          ...r,
          status,
          source: "platform",
          // Kept for any consumer still reading the booleans:
          sample_requested: srStatus != null,
          sample_shipped: srStatus === "shipped",
        };
      });

      const extResult = extRows.map((r) => {
        let status = "Applied";
        if (r.link_status === LINK_ACCEPTED) status = "Accepted";
        else if (r.link_status === LINK_INVITED) status = "Invited";
        return {
          ...r,
          status,
          source: "external",
          clicks: 0,
          sales: 0,
          revenue: 0,
          sample_request_status: null,
          sample_requested: false,
          sample_shipped: false,
        };
      });

      res.json([...result, ...extResult]);
    } catch (e) {
      console.error("[ops/creators]", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
