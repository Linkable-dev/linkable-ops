import { Router } from "express";
import { cloudSqlQuery } from "../lib/cloudsql.js";

// Link status enum (from main proto):
// 0=unset, 1=pending_brand, 2=pending_influencer, 3=accepted, 4=rejected, 5=ended
const LINK_ACCEPTED = 3;

// `deleted` uses '-infinity' as sentinel for "not deleted" in this DB.
const ND = `(deleted IS NULL OR deleted IN ('infinity'::timestamptz, '-infinity'::timestamptz))`;

export function opsRoutes() {
  const router = Router();

  // GET /api/ops/campaigns?limit=&offset=&search=
  // One row per product (= campaign) with aggregated counts.
  router.get("/campaigns", async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 200);
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);
      const search = (req.query.search || "").trim();

      // products.status enum: 0=unset 1=new 2=active 3=paused 4=ended
      // We only care about active campaigns for the ops view.
      const PRODUCT_ACTIVE = 2;

      const searchPattern = search ? `%${search}%` : null;
      const searchClause = `($1::text IS NULL OR p.title ILIKE $1 OR b.store_name ILIKE $1)`;

      const { rows: countRows } = await cloudSqlQuery(
        `SELECT COUNT(*)::int AS total
         FROM products p
         LEFT JOIN brands b ON b.id = p.brand_id
         WHERE ${ND.replace(/deleted/g, "p.deleted")} AND p.status = ${PRODUCT_ACTIVE} AND ${searchClause}`,
        [searchPattern]
      );
      const total = countRows[0]?.total || 0;

      // Paginate at the products level first, then enrich with aggregates.
      // This keeps response size + sort cost bounded regardless of total products.
      const { rows } = await cloudSqlQuery(`
        WITH page AS (
          SELECT p.id, p.title AS campaign_name, b.store_name AS brand_name,
                 p.status AS product_status, p.created
          FROM products p
          LEFT JOIN brands b ON b.id = p.brand_id
          WHERE ${ND.replace(/deleted/g, "p.deleted")}
            AND p.status = ${PRODUCT_ACTIVE}
            AND ($1::text IS NULL OR p.title ILIKE $1 OR b.store_name ILIKE $1)
          ORDER BY p.created DESC NULLS LAST
          LIMIT $3 OFFSET $4
        ),
        link_agg AS (
          SELECT l.product_id,
                 COUNT(DISTINCT COALESCE(l.influencer_user_id::text, l.id::text))            AS creators_applied,
                 COUNT(DISTINCT l.influencer_user_id) FILTER (WHERE l.status = $2)           AS creators_accepted,
                 COALESCE(SUM(l.clicks_counter), 0)                                          AS clicks
          FROM links l
          WHERE l.product_id IN (SELECT id FROM page) AND ${ND.replace(/deleted/g, "l.deleted")}
          GROUP BY l.product_id
        ),
        shipped_agg AS (
          SELECT sr.product_id, COUNT(DISTINCT sr.influencer_user_id) AS products_shipped
          FROM sample_requests sr
          WHERE sr.product_id IN (SELECT id FROM page) AND ${ND.replace(/deleted/g, "sr.deleted")} AND sr.status = 'shipped'
          GROUP BY sr.product_id
        ),
        sales_agg AS (
          SELECT l.product_id, COUNT(*) AS sales, COALESCE(SUM(o.shopify_amount), 0) AS revenue
          FROM orders o
          JOIN links l ON l.id = o.link_id
          WHERE l.product_id IN (SELECT id FROM page) AND ${ND.replace(/deleted/g, "o.deleted")}
          GROUP BY l.product_id
        )
        SELECT
          p.id,
          p.campaign_name,
          p.brand_name,
          p.product_status,
          p.created,
          COALESCE(la.creators_applied, 0)  AS creators_applied,
          COALESCE(la.creators_accepted, 0) AS creators_accepted,
          COALESCE(sh.products_shipped, 0)  AS products_shipped,
          COALESCE(la.clicks, 0)            AS clicks,
          COALESCE(sa.sales, 0)             AS sales,
          COALESCE(sa.revenue, 0)           AS revenue
        FROM page p
        LEFT JOIN link_agg la    ON la.product_id = p.id
        LEFT JOIN shipped_agg sh ON sh.product_id = p.id
        LEFT JOIN sales_agg sa   ON sa.product_id = p.id
        ORDER BY p.created DESC NULLS LAST
      `, [searchPattern, LINK_ACCEPTED, limit, offset]);

      res.json({ rows, total, limit, offset });
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
      const { rows } = await cloudSqlQuery(`
        SELECT
          l.id                                                                                               AS link_id,
          l.influencer_user_id,
          l.status                                                                                            AS link_status,
          COALESCE(l.clicks_counter, 0)                                                                       AS clicks,
          COALESCE(NULLIF(TRIM(CONCAT_WS(' ', i.first_name, i.last_name)), ''),
                   i.instagram_username, i.username, 'Unknown creator')                                       AS creator_name,
          i.instagram_username                                                                                AS instagram_username,
          (SELECT COUNT(*) FROM sample_requests sr WHERE sr.link_id = l.id AND ${ND.replace(/deleted/g, "sr.deleted")}) > 0        AS sample_requested,
          (SELECT COUNT(*) FROM sample_requests sr WHERE sr.link_id = l.id AND ${ND.replace(/deleted/g, "sr.deleted")} AND sr.status = 'shipped') > 0 AS sample_shipped,
          (SELECT COUNT(*) FROM orders o WHERE o.link_id = l.id AND ${ND.replace(/deleted/g, "o.deleted")})                        AS sales,
          (SELECT COALESCE(SUM(o.shopify_amount), 0) FROM orders o WHERE o.link_id = l.id AND ${ND.replace(/deleted/g, "o.deleted")}) AS revenue
        FROM links l
        LEFT JOIN influencers i ON i.user_id = l.influencer_user_id
        WHERE l.product_id = $1 AND ${ND.replace(/deleted/g, "l.deleted")}
        ORDER BY l.created DESC NULLS LAST
      `, [id]);

      const result = rows.map((r) => {
        let status = "Applied";
        if (Number(r.sales) > 0) status = "Sold";
        else if (r.sample_shipped) status = "Shipped";
        else if (r.link_status === LINK_ACCEPTED) status = "Accepted";
        return { ...r, status };
      });
      res.json(result);
    } catch (e) {
      console.error("[ops/creators]", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
