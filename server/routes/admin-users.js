import express from "express";
import { cloudSqlQuery } from "../lib/cloudsql.js";
import { signedUrls } from "../lib/gcs.js";

// Mirrors the main app's role enum (see linkable-new/backend/models/enums.py
// — note `routers/users.py` has stale duplicate constants with INFLUENCER=1
// that disagree with prod data; use enums.py values).
const ROLE_ADMIN = 1;
const ROLE_BRAND = 2;
const ROLE_INFLUENCER = 3;

// Status enums used for "active" aggregates (see linkable/proto/*.proto).
const PRODUCT_STATUS_ACTIVE = 2;
const LINK_STATUS_ACCEPTED = 3;

function clientUrl() {
  // Strip trailing slash(es) so the gateway URL never has `//?token=`.
  return (process.env.MAIN_APP_CLIENT_URL || "http://localhost:3002").replace(/\/+$/, "");
}

// Active-row sentinels MUST match the main app exactly, otherwise
// our impersonation guards have a gap (see linkable-new/backend/deleted_sentinel.py
// and the per-model server_defaults):
//   users.deleted        → 'infinity'  = active   (USER_ACTIVE)
//   brands.deleted       → '-infinity' = active   (ENTITY_ACTIVE)
//   influencers.deleted  → '-infinity' = active   (ENTITY_ACTIVE)
// All three columns are NOT NULL with their respective server_defaults.
const USER_ACTIVE = `'infinity'::timestamptz`;
const ENTITY_ACTIVE = `'-infinity'::timestamptz`;

export function adminUsersRoutes() {
  const router = express.Router();

  router.get("/brands", async (req, res) => {
    try {
      const { rows } = await listBrands(req.query);
      const signed = await signedUrls(rows.map((r) => r.logo_pic_name || ""));
      rows.forEach((r, i) => { r.signed_logo_pic = signed[i]; });
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/creators", async (req, res) => {
    try {
      const { rows } = await listCreators(req.query);
      const signed = await signedUrls(rows.map((r) => r.profile_pic_name || ""));
      rows.forEach((r, i) => { r.signed_profile_pic = signed[i]; });
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/:userId/impersonate", async (req, res) => {
    try {
      const out = await impersonateUser(req.params.userId, req.admin);
      res.json(out);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  return router;
}

async function listBrands({ q = "", limit = "50", offset = "0" }) {
  const params = [Number(limit) || 50, Number(offset) || 0];
  let where = `u.role = ${ROLE_BRAND} AND u.deleted = ${USER_ACTIVE}`;
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (u.email ILIKE $3 OR b.store_name ILIKE $3 OR b.store_website ILIKE $3 OR b.first_name ILIKE $3 OR b.last_name ILIKE $3)`;
  }
  return cloudSqlQuery(
    `SELECT u.id          AS user_id,
            u.email,
            u.created     AS user_created,
            u.role,
            b.id          AS brand_id,
            b.store_name,
            b.store_website,
            b.first_name,
            b.last_name,
            b.logo_pic_name,
            b.location,
            b.niche,
            sig.last_sign_in,
            COALESCE(camp.n, 0)::int    AS active_campaigns,
            COALESCE(prom.n, 0)::int    AS active_promoters,
            COALESCE(lk.clicks, 0)::int AS total_clicks,
            COALESCE(rev.amount, 0)     AS total_revenue,
            COALESCE(rev.currency, '')  AS revenue_currency
       FROM users u
       LEFT JOIN brands b ON b.user_id = u.id
                          AND b.deleted = ${ENTITY_ACTIVE}
       LEFT JOIN LATERAL (
         -- Last real sign-in: max(tokens.created) excluding admin_impersonation
         -- tokens minted from /users (state = 'admin_impersonation:<email>').
         SELECT MAX(t.created) AS last_sign_in
           FROM tokens t
          WHERE t.user_id = u.id::text
            AND (t.state IS NULL OR t.state NOT LIKE 'admin_impersonation:%')
       ) sig ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS n FROM products p
          WHERE p.user_id = u.id
            AND p.status = ${PRODUCT_STATUS_ACTIVE}
            AND p.deleted = ${ENTITY_ACTIVE}
       ) camp ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(DISTINCT l.influencer_user_id) AS n FROM links l
          WHERE l.brand_user_id = u.id
            AND l.status = ${LINK_STATUS_ACCEPTED}
            AND l.deleted = ${ENTITY_ACTIVE}
       ) prom ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(l.clicks_counter), 0) AS clicks FROM links l
          WHERE l.brand_user_id = u.id
            AND l.deleted = ${ENTITY_ACTIVE}
       ) lk ON true
       LEFT JOIN LATERAL (
         SELECT SUM(o.shopify_amount) AS amount,
                MAX(o.shopify_currency) AS currency
           FROM orders o
           JOIN links l ON l.id = o.link_id
          WHERE l.brand_user_id = u.id
            AND o.deleted = ${ENTITY_ACTIVE}
       ) rev ON true
       WHERE ${where}
       ORDER BY u.created DESC
       LIMIT $1 OFFSET $2`,
    params,
  );
}

async function listCreators({ q = "", limit = "50", offset = "0" }) {
  const params = [Number(limit) || 50, Number(offset) || 0];
  let where = `u.role = ${ROLE_INFLUENCER} AND u.deleted = ${USER_ACTIVE}`;
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (u.email ILIKE $3 OR i.instagram_username ILIKE $3 OR i.first_name ILIKE $3 OR i.last_name ILIKE $3 OR i.instagram_name ILIKE $3)`;
  }
  return cloudSqlQuery(
    `SELECT u.id          AS user_id,
            u.email,
            u.created     AS user_created,
            u.role,
            i.id          AS influencer_id,
            i.first_name,
            i.last_name,
            i.instagram_username,
            i.instagram_name,
            i.instagram_followers_count,
            i.instagram_engagement_rate,
            i.profile_pic_name,
            i.instagram_profile_image,
            i.location_country,
            i.location_city,
            i.niche,
            sig.last_sign_in,
            COALESCE(part.n, 0)::int    AS active_partnerships,
            COALESCE(rev.amount, 0)     AS total_revenue,
            COALESCE(rev.currency, '')  AS revenue_currency
       FROM users u
       LEFT JOIN influencers i ON i.user_id = u.id
                               AND i.deleted = ${ENTITY_ACTIVE}
       LEFT JOIN LATERAL (
         -- Last real sign-in (excludes admin_impersonation tokens).
         SELECT MAX(t.created) AS last_sign_in
           FROM tokens t
          WHERE t.user_id = u.id::text
            AND (t.state IS NULL OR t.state NOT LIKE 'admin_impersonation:%')
       ) sig ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(DISTINCT l.brand_user_id) AS n FROM links l
          WHERE l.influencer_user_id = u.id
            AND l.status = ${LINK_STATUS_ACCEPTED}
            AND l.deleted = ${ENTITY_ACTIVE}
       ) part ON true
       LEFT JOIN LATERAL (
         SELECT SUM(o.shopify_amount) AS amount,
                MAX(o.shopify_currency) AS currency
           FROM orders o
           JOIN links l ON l.id = o.link_id
          WHERE l.influencer_user_id = u.id
            AND o.deleted = ${ENTITY_ACTIVE}
       ) rev ON true
       WHERE ${where}
       ORDER BY u.created DESC
       LIMIT $1 OFFSET $2`,
    params,
  );
}

async function impersonateUser(userId, admin) {
  // Validate UUID — pg will throw an opaque error on bad input, give a cleaner one.
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    const e = new Error("Invalid user_id");
    e.status = 400;
    throw e;
  }

  const { rows: userRows } = await cloudSqlQuery(
    `SELECT id, email, sub, role, deleted FROM users WHERE id = $1`,
    [userId],
  );
  if (userRows.length === 0) {
    const e = new Error("User not found");
    e.status = 404;
    throw e;
  }
  const user = userRows[0];

  // Re-check active state via SQL (don't trust JS date parsing of 'infinity').
  // Main app's USER_ACTIVE is exactly 'infinity'::timestamptz; anything else is
  // either a real deletion timestamp or '-infinity' (which is wrong for users).
  const { rows: liveRows } = await cloudSqlQuery(
    `SELECT 1 FROM users WHERE id = $1 AND deleted = ${USER_ACTIVE} LIMIT 1`,
    [userId],
  );
  if (liveRows.length === 0) {
    const e = new Error("Target user is soft-deleted or in unexpected state — refusing to impersonate");
    e.status = 409;
    throw e;
  }

  // The main app's POST /users/auth requires an email on the token row.
  if (!user.email) {
    const e = new Error("Target user has no email — cannot mint session");
    e.status = 400;
    throw e;
  }

  const targetKind = user.role === ROLE_BRAND ? "brand"
    : user.role === ROLE_INFLUENCER ? "creator"
    : `role_${user.role}`;

  // Refuse impersonation if the role-specific profile (brand/influencer) row
  // is missing. Otherwise the main app's POST /users/auth path will *create*
  // an empty profile for us — which would mutate prod data.
  if (user.role === ROLE_BRAND) {
    const { rows } = await cloudSqlQuery(
      `SELECT 1 FROM brands WHERE user_id = $1 AND deleted = ${ENTITY_ACTIVE} LIMIT 1`,
      [user.id],
    );
    if (rows.length === 0) {
      const e = new Error("Brand has no active profile row — main app would auto-create one (and send welcome email). Refusing.");
      e.status = 409;
      throw e;
    }
  } else if (user.role === ROLE_INFLUENCER) {
    const { rows } = await cloudSqlQuery(
      `SELECT 1 FROM influencers WHERE user_id = $1 AND deleted = ${ENTITY_ACTIVE} LIMIT 1`,
      [user.id],
    );
    if (rows.length === 0) {
      const e = new Error("Creator has no active influencer profile row — main app would auto-create one. Refusing.");
      e.status = 409;
      throw e;
    }
  }

  // Mint a token row in the prod tokens table. Flag via `state` so this
  // session is distinguishable from real OAuth logins in the main app's DB.
  const stateMarker = `admin_impersonation:${admin.email}`;
  const { rows: tokenRows } = await cloudSqlQuery(
    `INSERT INTO tokens (user_id, email, sub, role, state)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [user.id, user.email, user.sub || "", user.role, stateMarker],
  );
  const tokenId = tokenRows[0].id;

  await cloudSqlQuery(
    `INSERT INTO admin_impersonations
       (admin_id, admin_email, target_user_id, target_email, target_role, target_kind, token_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [admin.id, admin.email, user.id, user.email, user.role, targetKind, tokenId],
  );

  return {
    token_id: tokenId,
    target_email: user.email,
    target_role: user.role,
    target_kind: targetKind,
    gateway_url: `${clientUrl()}/?token=${tokenId}`,
  };
}
