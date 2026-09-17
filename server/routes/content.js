import { Router } from "express";
import { cloudSqlQuery } from "../lib/cloudsql.js";
import { signedGsUrl, signedUrl, signedUrls } from "../lib/gcs.js";

// What creators actually delivered.
//
// A brand sees its own library at /brands/dashboard/content in the main app.
// Nobody could see all of it: whether creators are delivering at all, who is
// sitting on a campaign's deadline, what the work looks like. That is the
// question this panel exists to answer and it was the one thing it could not.
//
// The files live in the bucket at link_content/<link_id>/<file_name> (see
// LinkContentPath in service-grpc/services/files.go) and the rows in
// link_content_files, which is what the main app reads too — one source, so
// the count here and the count a brand sees cannot disagree.

const ND = "deleted = '-infinity'";

// The same extensions the main app sorts by (insights_db.go), so "video" means
// here what it means there.
const VIDEO = String.raw`lower(f.file_name) ~ '\.(mp4|m4v|mov|qt|webm|mkv|avi|ogg|ogv|m4p|mpe?g|3gp)$'`;
const IMAGE = String.raw`lower(f.file_name) ~ '\.(jpe?g|png|gif|webp|avif|heic|heif|bmp|tiff?)$'`;

// Content-Disposition for a download, with the file name quoted and stripped
// of anything that would break the header.
function attachment(fileName) {
  const safe = String(fileName || "file").replace(/["\\\r\n]/g, "").slice(0, 120);
  return `attachment; filename="${safe}"`;
}

// A generated asset has no file name of its own — the object is a hash. Give
// the download something a person can find again: the campaign, the creator
// and the asset's own short id.
function generatedName(row) {
  const ext = (row.gcs_path || "").split(".").pop().split("?")[0].slice(0, 4) || "jpg";
  const parts = [row.campaign_title, row.creator_label || row.creator_source, row.id?.slice(0, 8)]
    .filter(Boolean)
    .map((p) => String(p).trim().replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, ""))
    .filter(Boolean);
  return `${parts.join("_") || "asset"}.${ext}`;
}

export function contentRoutes() {
  const router = Router();

  // GET /api/content?q=&type=&brand=&product=&creator=&days=&limit=&offset=
  router.get("/", async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 24, 1), 96);
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);
      const days = Math.max(parseInt(req.query.days) || 0, 0);
      const type = ["image", "video"].includes(req.query.type) ? req.query.type : "";
      const q = String(req.query.q || "").trim();
      const brand = /^[0-9a-f-]{36}$/i.test(req.query.brand || "") ? req.query.brand : "";
      const product = /^[0-9a-f-]{36}$/i.test(req.query.product || "") ? req.query.product : "";
      const creator = /^[0-9a-f-]{36}$/i.test(req.query.creator || "") ? req.query.creator : "";

      // Every filter written as "unset or matching", so one query serves the
      // whole library and any narrowing of it.
      const where = `
        WHERE l.${ND}
          AND ($1 = '' OR l.brand_user_id::text = $1)
          AND ($2 = '' OR l.product_id::text = $2)
          AND ($3 = '' OR l.influencer_user_id::text = $3)
          AND ($4 = '' OR ($4 = 'video' AND ${VIDEO}) OR ($4 = 'image' AND ${IMAGE}))
          AND ($5 = 0 OR f.created >= now() - make_interval(days => $5::int))
          AND ($6 = '' OR f.file_name ILIKE '%' || $6 || '%'
               OR coalesce(p.title, '') ILIKE '%' || $6 || '%'
               OR coalesce(b.store_name, '') ILIKE '%' || $6 || '%'
               OR coalesce(i.instagram_username, '') ILIKE '%' || $6 || '%'
               OR coalesce(i.first_name, '') || ' ' || coalesce(i.last_name, '') ILIKE '%' || $6 || '%')`;

      const from = `
        FROM link_content_files f
        JOIN links l ON l.id = f.link_id
        LEFT JOIN products p ON p.id = l.product_id
        LEFT JOIN brands b ON b.user_id = l.brand_user_id
        LEFT JOIN influencers i ON i.user_id = l.influencer_user_id AND i.${ND}`;

      // ILIKE reads % and _ as wildcards, so a search for "%" would return the
      // whole library rather than nothing.
      const search = q.replace(/([\\%_])/g, "\\$1");
      const params = [brand, product, creator, type, days, search];

      const { rows } = await cloudSqlQuery(
        `SELECT f.link_id::text, f.file_name, f.size_bytes, f.created,
                l.product_id::text  AS product_id,  p.title      AS campaign_title,
                l.brand_user_id::text AS brand_user_id, b.store_name AS brand_name,
                l.influencer_user_id::text AS creator_user_id,
                i.instagram_username, i.first_name, i.last_name,
                CASE WHEN ${VIDEO} THEN 'video' WHEN ${IMAGE} THEN 'image' ELSE 'file' END AS kind
         ${from} ${where}
         ORDER BY f.created DESC
         LIMIT $7 OFFSET $8`,
        [...params, limit, offset],
      );

      // The totals describe the WHOLE library, not the filtered page: they are
      // the map you choose a filter from, so they cannot themselves be filtered.
      const { rows: totals } = await cloudSqlQuery(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE ${VIDEO})::int AS videos,
                count(*) FILTER (WHERE ${IMAGE})::int AS images,
                count(DISTINCT l.brand_user_id)::int AS brands,
                count(DISTINCT l.influencer_user_id)::int AS creators
         ${from} WHERE l.${ND}`,
      );
      const { rows: matched } = await cloudSqlQuery(
        `SELECT count(*)::int AS total ${from} ${where}`, params,
      );

      // Two signed URLs per file, for an hour: one to look at and one that
      // saves. Signing is local crypto, so the second costs nothing worth
      // measuring and it is the only way a cross-origin link downloads.
      const blobs = rows.map((r) => `link_content/${r.link_id}/${r.file_name}`);
      const [urls, downloads] = await Promise.all([
        signedUrls(blobs, 3600, req.dbTarget),
        Promise.all(blobs.map((blob, i) => signedUrl(
          blob, 3600, req.dbTarget, attachment(rows[i].file_name)))),
      ]);
      rows.forEach((r, i) => { r.url = urls[i]; r.download_url = downloads[i]; });

      res.json({
        files: rows,
        matched: matched[0]?.total || 0,
        totals: totals[0] || {},
      });
    } catch (e) {
      console.error("[content/list]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/content/generated — the other half: what the machine made.
  //
  // Assets hang off a generation job, which hangs off the brand's creative
  // request; the request is what carries the campaign and the creator. Three
  // tables because a request can produce several jobs and a job one asset —
  // the join is the shape of the thing, not incidental.
  router.get("/generated", async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 24, 1), 96);
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);
      const q = String(req.query.q || "").trim().replace(/([\\%_])/g, "\\$1");
      const brand = /^[0-9a-f-]{36}$/i.test(req.query.brand || "") ? req.query.brand : "";
      const product = /^[0-9a-f-]{36}$/i.test(req.query.product || "") ? req.query.product : "";
      const days = Math.max(parseInt(req.query.days) || 0, 0);

      const from = `
        FROM content_assets a
        LEFT JOIN content_generation_jobs g ON g.asset_id = a.id
        LEFT JOIN content_creative_requests r ON r.id = g.request_id
        LEFT JOIN products p ON p.id = r.product_id
        LEFT JOIN brands b ON b.user_id = r.brand_id OR b.id = r.brand_id
        LEFT JOIN influencers i ON r.creator_source = 'influencer'
                               AND i.user_id = r.creator_id AND i.${ND}
        LEFT JOIN external_creators e ON r.creator_source = 'external_creator' AND e.id = r.creator_id
        LEFT JOIN content_avatars av ON r.creator_source = 'avatar' AND av.id = r.creator_id`;
      const where = `
        WHERE ($1 = '' OR r.brand_id::text = $1 OR b.user_id::text = $1)
          AND ($2 = '' OR r.product_id::text = $2)
          AND ($3 = 0 OR a.created >= now() - make_interval(days => $3::int))
          AND ($4 = '' OR coalesce(p.title, '') ILIKE '%' || $4 || '%'
               OR coalesce(b.store_name, '') ILIKE '%' || $4 || '%'
               OR coalesce(i.instagram_username, '') ILIKE '%' || $4 || '%'
               OR coalesce(e.instagram_username, '') ILIKE '%' || $4 || '%'
               OR coalesce(av.name, '') ILIKE '%' || $4 || '%'
               OR coalesce(a.caption, '') ILIKE '%' || $4 || '%')`;
      const params = [brand, product, days, q];

      const { rows } = await cloudSqlQuery(
        `SELECT a.id::text, a.created, a.modality, a.status, a.caption, a.gcs_path,
                a.creator_review, a.moderation_status, a.moderation_reason, a.provider,
                r.id::text AS request_id, r.status AS request_status, r.quantity,
                r.product_id::text AS product_id, p.title AS campaign_title,
                r.brand_id::text AS brand_id, b.store_name AS brand_name,
                r.creator_source, r.creator_id::text AS creator_id, i.instagram_username,
                -- Four sources, four places a name can live: a platform
                -- creator, one we sourced, one we invented, and nobody at all
                -- (product-only content depicts no person). A single join to
                -- influencers found the first and called the rest "a creator".
                coalesce(nullif(i.instagram_username, ''), nullif(e.instagram_username, ''),
                         nullif(av.name, ''), '')                                   AS creator_label,
                g.state AS job_state, g.cost_cents, g.error AS job_error
         ${from} ${where}
         ORDER BY a.created DESC
         LIMIT $5 OFFSET $6`,
        [...params, limit, offset],
      );
      const { rows: matched } = await cloudSqlQuery(`SELECT count(*)::int AS total ${from} ${where}`, params);

      // How generation itself is going, over everything rather than this page:
      // what it produced, what it is still trying, what it gave up on, and what
      // it cost. A grid of pictures cannot say "one in four requests failed".
      const { rows: totals } = await cloudSqlQuery(
        `SELECT
           (SELECT count(*)::int FROM content_assets)                                           AS assets,
           (SELECT count(*)::int FROM content_assets WHERE modality = 'video')                  AS videos,
           (SELECT count(*)::int FROM content_assets WHERE modality <> 'video')                 AS images,
           (SELECT count(*)::int FROM content_creative_requests)                                AS requests,
           (SELECT count(*)::int FROM content_creative_requests WHERE status = 'failed')        AS failed,
           (SELECT count(*)::int FROM content_creative_requests WHERE status = 'partial')       AS partial,
           (SELECT count(*)::int FROM content_creative_requests
             WHERE status NOT IN ('failed', 'partial', 'succeeded'))                            AS in_flight,
           (SELECT coalesce(sum(cost_cents), 0)::int FROM content_generation_jobs)              AS cost_cents`,
      );

      // A gs:// URI is not fetchable. Signed here rather than shown as a path,
      // which is what a broken image with a working-looking link beside it is.
      const [urls, downloads] = await Promise.all([
        Promise.all(rows.map((r) => signedGsUrl(r.gcs_path, 3600))),
        Promise.all(rows.map((r) => signedGsUrl(r.gcs_path, 3600, attachment(generatedName(r))))),
      ]);
      rows.forEach((r, i) => { r.url = urls[i]; r.download_url = downloads[i]; r.file_name = generatedName(r); });

      res.json({ files: rows, matched: matched[0]?.total || 0, totals: totals[0] || {} });
    } catch (e) {
      // The content tables arrive with the content service's own migrations, so
      // a database that has never run it should say so rather than 500.
      if (e?.code === "42P01" || e?.code === "42703") {
        return res.json({ available: false, files: [], matched: 0, totals: {} });
      }
      console.error("[content/generated]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/content/filters — the brands and campaigns worth offering, with
  // how much sits behind each. Capped: a dropdown is a picker, not a directory.
  router.get("/filters", async (req, res) => {
    try {
      const { rows: brands } = await cloudSqlQuery(
        `SELECT l.brand_user_id::text AS id, coalesce(b.store_name, '(unnamed)') AS label,
                count(*)::int AS files
           FROM link_content_files f
           JOIN links l ON l.id = f.link_id AND l.${ND}
           LEFT JOIN brands b ON b.user_id = l.brand_user_id
          GROUP BY 1, 2 ORDER BY files DESC LIMIT 50`,
      );
      const { rows: campaigns } = await cloudSqlQuery(
        `SELECT l.product_id::text AS id, coalesce(p.title, '(untitled)') AS label,
                count(*)::int AS files
           FROM link_content_files f
           JOIN links l ON l.id = f.link_id AND l.${ND}
           LEFT JOIN products p ON p.id = l.product_id
          GROUP BY 1, 2 ORDER BY files DESC LIMIT 50`,
      );
      res.json({ brands, campaigns });
    } catch (e) {
      console.error("[content/filters]", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
