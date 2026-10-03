import { Router } from "express";
import { cloudSqlQuery } from "../lib/cloudsql.js";
import { parseColumnFilters, filterConditions, orderBySql, textFilter, numberFilter, dateFilter } from "../lib/tableQuery.js";

// Pitch brands: the external brands creators can pitch from Discover.
//
// An admin adds one by typing its Instagram handle or store address. This
// route only writes the request (pitch_brand_requests); service-grpc picks it
// up within ten seconds and does the reading — the store, its logo, products,
// contact email, signals and follower counts (RunPitchBrandRequests in
// service-grpc/services/pitch_brand_requests.go). The page polls the request
// until it says added, updated or failed.
//
// Pitch has not reached production yet, so on prod these tables do not exist:
// reads answer available:false and writes 409, never a 500.

const UNDEFINED = new Set(["42P01", "42703"]);
const notPromoted = (e) => UNDEFINED.has(e?.code);
const notHere = (target) => `Pitch isn't on ${target === "dev" ? "dev" : "prod"} yet, so brands can only be added on dev for now.`;
const ND = "deleted = '-infinity'";

// The brand categories service-grpc accepts (nicheLabels there), as labels.
export const CATEGORIES = {
  BEAUTY_SKINCARE: "Beauty & Skincare",
  FASHION_ACCESSORIES: "Fashion & Accessories",
  HEALTH_WELLNESS: "Health & Wellness",
  FITNESS_SPORTS: "Fitness & Sports",
  FOOD_BEVERAGE: "Food & Beverage",
  HOME_LIVING: "Home & Living",
  PETS: "Pets",
  BABY_PARENTING: "Baby & Parenting",
  TECHNOLOGY: "Technology",
  TRAVEL: "Travel",
  OUTDOOR_ADVENTURE: "Outdoor & Adventure",
  LUXURY: "Luxury",
  GAMING: "Gaming",
  ENTERTAINMENT: "Entertainment",
  ART_DESIGN: "Art & Design",
  DIY_CRAFTS: "DIY & Crafts",
  EDUCATION: "Education",
  FINANCE: "Finance",
  SUSTAINABILITY_ECO: "Sustainability & Eco-Friendly",
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const SORTS = {
  name: "b.name",
  domain: "b.domain",
  instagram_followers: "b.instagram_followers",
  tiktok_followers: "b.tiktok_followers",
  youtube_followers: "b.youtube_followers",
  category: "b.category",
  source: "b.source",
  created: "b.created",
};
const FILTERS = {
  name: textFilter("b.name", "b.domain", "b.instagram"),
  domain: textFilter("b.domain"),
  instagram: textFilter("b.instagram"),
  contact_email: textFilter("b.contact_email"),
  category: textFilter("b.category"),
  source: textFilter("b.source"),
  instagram_followers: numberFilter("b.instagram_followers"),
  created: dateFilter("b.created"),
};

const BRAND_COLUMNS = `
  b.id, b.name, b.domain, b.instagram, b.logo_url, b.category, b.country, b.source,
  b.contact_email, b.contact_verified, b.is_target, b.created,
  b.instagram_followers, b.tiktok, b.tiktok_followers, b.youtube, b.youtube_followers,
  b.latest_product_title, b.latest_product_at, b.program_kind,
  (b.linkable_brand_user_id IS NOT NULL) AS on_linkable`;

export function pitchBrandsRoutes({ query = cloudSqlQuery } = {}) {
  const router = Router();

  router.get("/categories", (_req, res) => {
    res.json({ categories: Object.entries(CATEGORIES).map(([value, label]) => ({ value, label })) });
  });

  // GET /api/pitch-brands?limit=&offset=&sortBy=&sortDir=&filter[col]=
  router.get("/", async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 100);
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);
      const params = [];
      const conds = [`b.${ND}`, "b.name <> ''", ...filterConditions(parseColumnFilters(req.query), FILTERS, params)];
      const where = `WHERE ${conds.join(" AND ")}`;
      const order = orderBySql(req.query, SORTS, "b.created DESC, b.id");
      const countParams = [...params];
      params.push(limit, offset);
      const [{ rows }, count] = await Promise.all([
        query(`SELECT ${BRAND_COLUMNS} FROM pitch_brands b ${where} ORDER BY ${order}, b.id LIMIT $${params.length - 1} OFFSET $${params.length}`, params),
        query(`SELECT count(*)::int AS n FROM pitch_brands b ${where}`, countParams),
      ]);
      res.json({ available: true, items: rows, total: count.rows[0]?.n ?? 0 });
    } catch (e) {
      if (notPromoted(e)) return res.json({ available: false, items: [], total: 0 });
      res.status(500).json({ error: e.message });
    }
  });

  // The latest requests, newest first, with the brand each one produced.
  router.get("/requests", async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 50);
      const { rows } = await query(
        `SELECT r.id, r.created, r.requested_by, r.input, r.status, r.error, r.credits::float8 AS credits, r.finished_at,
                b.id AS brand_id, b.name, b.domain, b.instagram, b.logo_url, b.contact_email,
                b.instagram_followers, b.tiktok_followers, b.youtube_followers
           FROM pitch_brand_requests r
           LEFT JOIN pitch_brands b ON b.id = r.pitch_brand_id
          ORDER BY r.created DESC
          LIMIT $1`,
        [limit],
      );
      res.json({ available: true, requests: rows });
    } catch (e) {
      if (notPromoted(e)) return res.json({ available: false, requests: [] });
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/pitch-brands/requests { input, contact_email?, category? }
  router.post("/requests", async (req, res) => {
    const input = String(req.body?.input ?? "").trim();
    const email = String(req.body?.contact_email ?? "").trim().toLowerCase();
    const category = String(req.body?.category ?? "").trim();
    if (!input) return res.status(400).json({ error: "Enter an Instagram handle or a store address." });
    if (input.length > 200) return res.status(400).json({ error: "That's too long for a handle or a store address." });
    if (email && !EMAIL.test(email)) return res.status(400).json({ error: "That contact email doesn't look right." });
    if (category && !CATEGORIES[category]) return res.status(400).json({ error: "Pick a category from the list." });
    try {
      const { rows } = await query(
        `INSERT INTO pitch_brand_requests (requested_by, input, contact_email, category)
         VALUES ($1, $2, $3, $4)
         RETURNING id, created, requested_by, input, status, error`,
        [req.admin?.email || "", input, email, category],
      );
      console.log(`[pitch-brand] admin=${req.admin?.email} db=${req.dbTarget} input=${JSON.stringify(input)}`);
      res.json({ request: rows[0] });
    } catch (e) {
      if (notPromoted(e)) return res.status(409).json({ error: notHere(req.dbTarget) });
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
