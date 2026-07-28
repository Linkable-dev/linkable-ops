import express from "express";
import { cloudSqlQuery, currentDbTarget } from "../lib/cloudsql.js";
import { signedUrls } from "../lib/gcs.js";
import {
  parseColumnFilters, orderBySql, filterConditions,
  textFilter, minNumberFilter, enumFilter,
} from "../lib/tableQuery.js";

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
  // Token rows live in whichever DB the request is targeting, so the gateway
  // URL must point at the matching main-app deployment.
  const target = currentDbTarget();
  const raw = target === "dev"
    ? (process.env.MAIN_APP_CLIENT_URL_DEV || "http://localhost:3002")
    : (process.env.MAIN_APP_CLIENT_URL || "http://localhost:3002");
  return raw.replace(/\/+$/, "");
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

  // Grant a fresh trial to a brand (re-activates the "Start Free Trial" path
  // in the main app). Writes to brands in whichever DB the request targets;
  // the audit row in admin_trial_grants always lives in prod.
  router.post("/:userId/grant-trial", async (req, res) => {
    try {
      const out = await grantTrial(req.params.userId, req.body || {}, req.admin, req.dbTarget || "prod");
      res.json(out);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Enroll/remove a brand in the hidden Startup Programme. The main app reads
  // brands.startup_programme and gives enrolled brands the introductory price
  // on their first monthly Growth subscription ($99/mo for 3 months, then
  // $199) via a Shopify App Billing discount. Body: { enabled: boolean }.
  // Only affects brands who haven't subscribed yet — the discount applies at
  // subscription creation, so flipping it after purchase changes nothing.
  router.post("/:userId/startup-programme", async (req, res) => {
    try {
      const out = await setStartupProgramme(req.params.userId, req.body || {});
      res.json(out);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  return router;
}

async function setStartupProgramme(userId, body) {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    const e = new Error("Invalid user_id"); e.status = 400; throw e;
  }
  const enabled = Boolean(body.enabled);
  const { rows } = await cloudSqlQuery(
    `UPDATE brands
        SET startup_programme = $2,
            updated           = NOW()
      WHERE user_id = $1
        AND deleted = ${ENTITY_ACTIVE}
      RETURNING startup_programme`,
    [userId, enabled],
  );
  if (rows.length === 0) {
    const e = new Error("No active brand found for that user"); e.status = 404; throw e;
  }
  return { startup_programme: rows[0].startup_programme };
}

// Plan rank + trial state expressions mirror the UsersPage cells (PlanCell /
// deriveTrialState) so server-side sort/filter orders rows exactly like the
// old client-side sort did. Higher plan rank = "more paying".
const BRAND_PLAN_RANK_SQL = `CASE
  WHEN u.account_id LIKE '%shopify_499%' OR u.account_id LIKE '%shopify_4970%' OR u.account_id LIKE '%shopify_299%' THEN 100
  WHEN u.account_id LIKE '%shopify_199%' THEN 90
  WHEN u.account_id LIKE '%shopify_99%'  THEN 80
  WHEN u.account_id = 'shopify_free_plan' THEN 50
  WHEN COALESCE(u.account_id, '') = '' AND u.created >= NOW() - INTERVAL '14 days' THEN 40
  WHEN COALESCE(u.account_id, '') = '' THEN 10
  ELSE 0
END`;

// Trial "urgency": active = days remaining, granted = offer length,
// expired = -1, none = -2 (matches the client's trial_time_left sort rank).
const BRAND_TRIAL_TIME_SQL = `CASE
  WHEN b.trial_activation_date > '-infinity'::timestamptz AND b.trial_expiration_date > NOW()
    THEN CEIL(EXTRACT(EPOCH FROM (b.trial_expiration_date - NOW())) / 86400)
  WHEN COALESCE(b.trial_plan_name, '') <> '' AND COALESCE(b.trial_activation_date, '-infinity'::timestamptz) = '-infinity'::timestamptz
    THEN COALESCE(b.trial_days, 0)
  WHEN b.trial_activation_date > '-infinity'::timestamptz THEN -1
  ELSE -2
END`;

const BRAND_TRIAL_ACTIVE_SQL   = `(b.trial_activation_date > '-infinity'::timestamptz AND b.trial_expiration_date > NOW())`;
const BRAND_TRIAL_GRANTED_SQL  = `(COALESCE(b.trial_plan_name, '') <> '' AND COALESCE(b.trial_activation_date, '-infinity'::timestamptz) = '-infinity'::timestamptz)`;
const BRAND_TRIAL_EXPIRED_SQL  = `(b.trial_activation_date > '-infinity'::timestamptz AND b.trial_expiration_date <= NOW())`;

const BRAND_SORTS = {
  store_name:      `LOWER(COALESCE(b.store_name, ''))`,
  email:           `LOWER(u.email)`,
  owner_name:      `LOWER(TRIM(COALESCE(b.first_name, '') || ' ' || COALESCE(b.last_name, '')))`,
  user_created:    `u.created`,
  last_sign_in:    `sig.last_sign_in`,
  plan:            BRAND_PLAN_RANK_SQL,
  trial_plan_name: `LOWER(COALESCE(b.trial_plan_name, ''))`,
  trial_time_left: BRAND_TRIAL_TIME_SQL,
};

// Cutoff mirrors PAID_PLANS_LAUNCH_TS in UsersPage: brands created before
// paid plans launched are "Legacy free"; after, an empty account_id is a
// "No record" anomaly.
const BRAND_FILTERS = {
  store_name:      textFilter("b.store_name", "b.store_website"),
  email:           textFilter("u.email"),
  owner_name:      textFilter(`(COALESCE(b.first_name, '') || ' ' || COALESCE(b.last_name, ''))`),
  trial_plan_name: textFilter("b.trial_plan_name"),
  plan: enumFilter({
    scale:      `(u.account_id LIKE '%shopify_499%' OR u.account_id LIKE '%shopify_4970%' OR u.account_id LIKE '%shopify_299%')`,
    growth:     `(u.account_id LIKE '%shopify_199%' OR u.account_id LIKE '%shopify_99%')`,
    free:       `u.account_id = 'shopify_free_plan'`,
    free_trial: `(COALESCE(u.account_id, '') = '' AND u.created >= NOW() - INTERVAL '14 days')`,
    legacy:     `(COALESCE(u.account_id, '') = '' AND u.created < NOW() - INTERVAL '14 days' AND u.created < '2025-11-20'::timestamptz)`,
    no_record:  `(COALESCE(u.account_id, '') = '' AND u.created < NOW() - INTERVAL '14 days' AND u.created >= '2025-11-20'::timestamptz)`,
  }),
  trial_time_left: enumFilter({
    active:  BRAND_TRIAL_ACTIVE_SQL,
    granted: BRAND_TRIAL_GRANTED_SQL,
    expired: BRAND_TRIAL_EXPIRED_SQL,
    none:    `NOT (${BRAND_TRIAL_ACTIVE_SQL} OR ${BRAND_TRIAL_GRANTED_SQL} OR ${BRAND_TRIAL_EXPIRED_SQL})`,
  }),
};

async function listBrands(query) {
  const { q = "", limit = "50", offset = "0" } = query;
  const params = [Number(limit) || 50, Number(offset) || 0];
  let where = `u.role = ${ROLE_BRAND} AND u.deleted = ${USER_ACTIVE}`;
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (u.email ILIKE $3 OR b.store_name ILIKE $3 OR b.store_website ILIKE $3 OR b.first_name ILIKE $3 OR b.last_name ILIKE $3)`;
  }
  for (const cond of filterConditions(parseColumnFilters(query), BRAND_FILTERS, params)) {
    where += ` AND ${cond}`;
  }
  const orderBy = orderBySql(query, BRAND_SORTS, "u.created DESC");
  return cloudSqlQuery(
    `SELECT u.id          AS user_id,
            u.email,
            u.created     AS user_created,
            u.role,
            u.account_id,
            b.id          AS brand_id,
            b.store_name,
            b.store_website,
            b.first_name,
            b.last_name,
            b.logo_pic_name,
            b.location,
            b.niche,
            b.trial_plan_name,
            b.trial_days,
            b.trial_interval,
            b.trial_activation_date,
            b.trial_expiration_date,
            b.startup_programme,
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
         -- Real OAuth tokens are inserted with user_id='000…0' and identify the
         -- user via sub/email instead, so join on those.
         SELECT MAX(t.created) AS last_sign_in
           FROM tokens t
          WHERE ((COALESCE(u.sub, '') <> '' AND t.sub = u.sub)
                 OR t.email = u.email)
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
       ORDER BY ${orderBy}
       LIMIT $1 OFFSET $2`,
    params,
  );
}

// Followers is a text column that can hold garbage (literally "undefined"),
// so strip to digits and NULL out anything non-numeric before casting.
const CREATOR_FOLLOWERS_SQL =
  `NULLIF(REGEXP_REPLACE(COALESCE(i.instagram_followers_count, ''), '[^0-9]', '', 'g'), '')::bigint`;
const CREATOR_NAME_SQL =
  `COALESCE(NULLIF(TRIM(COALESCE(i.first_name, '') || ' ' || COALESCE(i.last_name, '')), ''), i.instagram_name, '')`;

const CREATOR_SORTS = {
  creator_name:              `LOWER(${CREATOR_NAME_SQL})`,
  email:                     `LOWER(u.email)`,
  instagram_username:        `LOWER(REGEXP_REPLACE(COALESCE(i.instagram_username, ''), '^@+', ''))`,
  instagram_followers_count: CREATOR_FOLLOWERS_SQL,
  last_sign_in:              `sig.last_sign_in`,
  user_created:              `u.created`,
};

const CREATOR_FILTERS = {
  creator_name:              textFilter(CREATOR_NAME_SQL, "i.instagram_name"),
  email:                     textFilter("u.email"),
  instagram_username:        textFilter("i.instagram_username"),
  instagram_followers_count: minNumberFilter(CREATOR_FOLLOWERS_SQL),
};

async function listCreators(query) {
  const { q = "", limit = "50", offset = "0" } = query;
  const params = [Number(limit) || 50, Number(offset) || 0];
  let where = `u.role = ${ROLE_INFLUENCER} AND u.deleted = ${USER_ACTIVE}`;
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (u.email ILIKE $3 OR i.instagram_username ILIKE $3 OR i.first_name ILIKE $3 OR i.last_name ILIKE $3 OR i.instagram_name ILIKE $3)`;
  }
  for (const cond of filterConditions(parseColumnFilters(query), CREATOR_FILTERS, params)) {
    where += ` AND ${cond}`;
  }
  const orderBy = orderBySql(query, CREATOR_SORTS, "u.created DESC");
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
         -- Last real sign-in (excludes admin_impersonation tokens). OAuth tokens
         -- use user_id='000…0' and identify by sub/email — see brands query above.
         SELECT MAX(t.created) AS last_sign_in
           FROM tokens t
          WHERE ((COALESCE(u.sub, '') <> '' AND t.sub = u.sub)
                 OR t.email = u.email)
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
       ORDER BY ${orderBy}
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

  // Audit trail lives in prod regardless of target — admin_impersonations.admin_id
  // FKs into ops_admins (prod-only) and the table is the canonical ops audit log.
  // token_id has no FK so storing a dev token UUID here is safe.
  await cloudSqlQuery(
    `INSERT INTO admin_impersonations
       (admin_id, admin_email, target_user_id, target_email, target_role, target_kind, token_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [admin.id, admin.email, user.id, user.email, user.role, targetKind, tokenId],
    "prod",
  );

  return {
    token_id: tokenId,
    target_email: user.email,
    target_role: user.role,
    target_kind: targetKind,
    gateway_url: `${clientUrl()}/?token=${tokenId}`,
  };
}

// Valid Shopify plan names from the main app's billing config. Keeping the
// set tight prevents typos that would silently break the activation gate.
const VALID_TRIAL_PLANS = new Set(["starter", "grow", "scale"]);
const VALID_TRIAL_INTERVALS = new Set(["monthly", "annual"]);

async function grantTrial(userId, body, admin, dbTarget) {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    const e = new Error("Invalid user_id"); e.status = 400; throw e;
  }
  const plan = String(body.plan || "").toLowerCase();
  const interval = String(body.interval || "").toLowerCase();
  const days = Number(body.days);
  const note = body.note ? String(body.note).slice(0, 500) : null;

  if (!VALID_TRIAL_PLANS.has(plan)) {
    const e = new Error(`plan must be one of: ${[...VALID_TRIAL_PLANS].join(", ")}`); e.status = 400; throw e;
  }
  if (!VALID_TRIAL_INTERVALS.has(interval)) {
    const e = new Error(`interval must be monthly or annual`); e.status = 400; throw e;
  }
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    const e = new Error("days must be an integer between 1 and 90"); e.status = 400; throw e;
  }

  // Verify the brand row exists, is active, and capture previous trial state
  // for the audit row. Pinned to the request's DB target.
  const { rows: brandRows } = await cloudSqlQuery(
    `SELECT b.id          AS brand_id,
            u.email,
            b.trial_plan_name,
            b.trial_days,
            b.trial_interval,
            b.trial_activation_date,
            b.trial_expiration_date
       FROM brands b
       JOIN users  u ON u.id = b.user_id
      WHERE b.user_id = $1
        AND b.deleted = ${ENTITY_ACTIVE}
      LIMIT 1`,
    [userId],
  );
  if (brandRows.length === 0) {
    const e = new Error("No active brand found for that user"); e.status = 404; throw e;
  }
  const prev = brandRows[0];

  // Re-arm the trial: write new plan/days/interval and clear the activation
  // window so the main app's `/brands/settings/subscription` page surfaces the
  // "Start Free Trial" button again. Shopify still owns the actual billing
  // state — see admin_trial_grants.sql header for the Shopify caveat.
  const { rows: updated } = await cloudSqlQuery(
    `UPDATE brands
        SET trial_plan_name       = $2,
            trial_days            = $3,
            trial_interval        = $4,
            trial_activation_date = NULL,
            trial_expiration_date = NULL,
            updated               = NOW()
      WHERE user_id = $1
        AND deleted = ${ENTITY_ACTIVE}
      RETURNING trial_plan_name, trial_days, trial_interval,
                trial_activation_date, trial_expiration_date`,
    [userId, plan, days, interval],
  );

  // Audit row goes to the same DB the brand UPDATE landed in (admin_trial_grants
  // exists in both prod and dev). Diverges from admin_impersonations (always
  // prod) by design — see server/sql/admin_trial_grants.sql header.
  await cloudSqlQuery(
    `INSERT INTO admin_trial_grants
       (admin_id, admin_email, target_user_id, target_email, target_brand_id,
        plan, days, "interval",
        previous_plan, previous_days, previous_interval,
        previous_activation, previous_expiration,
        target_db, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      admin.id, admin.email, userId, prev.email, prev.brand_id,
      plan, days, interval,
      prev.trial_plan_name, prev.trial_days, prev.trial_interval,
      prev.trial_activation_date, prev.trial_expiration_date,
      dbTarget, note,
    ],
    dbTarget,
  );

  return {
    user_id: userId,
    target_db: dbTarget,
    trial: updated[0],
    previous: {
      trial_plan_name: prev.trial_plan_name,
      trial_days: prev.trial_days,
      trial_interval: prev.trial_interval,
      trial_activation_date: prev.trial_activation_date,
      trial_expiration_date: prev.trial_expiration_date,
    },
  };
}
