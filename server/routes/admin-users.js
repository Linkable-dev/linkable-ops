import express from "express";
import { cloudSqlQuery, currentDbTarget, getCloudSqlPool } from "../lib/cloudsql.js";
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

// app_subscriptions is the main app's Shopify source-of-truth (real status /
// trial-end / cancel instant). It is rolled out per-service, so it may not exist
// yet on a given target DB (e.g. prod before the grpc deploy) — reading it
// blindly would 42P01 the whole brands list. Probe once per target (short TTL so
// a freshly-deployed table is picked up without a server restart) and fall back
// to the account_id heuristic where it is absent.
const appSubsProbe = new Map(); // target -> { ok, at }
const APP_SUBS_PROBE_TTL_MS = 5 * 60_000;
async function appSubscriptionsAvailable() {
  const target = currentDbTarget();
  const cached = appSubsProbe.get(target);
  if (cached && Date.now() - cached.at < APP_SUBS_PROBE_TTL_MS) return cached.ok;
  let ok = false;
  try {
    const rows = await cloudSqlQuery(
      `SELECT to_regclass('public.app_subscriptions') IS NOT NULL AS ok`,
    );
    ok = rows[0]?.ok === true;
  } catch {
    ok = false;
  }
  appSubsProbe.set(target, { ok, at: Date.now() });
  return ok;
}

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

  // Soft-deleted brands still inside the 30-day recovery window (the main app's
  // DeleteUserAccount sets users.deleted=NOW() + deletion_scheduled_for; a
  // nightly job hard-deletes them once the schedule elapses). These rows are
  // hidden from /brands (which lists only active users) — this is where an
  // operator finds a brand to restore before it's purged for good.
  router.get("/deleted-brands", async (req, res) => {
    try {
      const { rows } = await listDeletedBrands(req.query);
      const signed = await signedUrls(rows.map((r) => r.logo_pic_name || ""));
      rows.forEach((r, i) => { r.signed_logo_pic = signed[i]; });
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

  // DEV-ONLY: hard-wipe a brand and all its data so the account can re-onboard
  // from scratch. Refuses on prod — this is a test-data reset, not a
  // production tool. Guarded again server-side so a forged x-db-target=prod
  // can't reach it.
  router.post("/:userId/wipe", async (req, res) => {
    try {
      const out = await wipeBrand(req.params.userId, req.admin, req.dbTarget || "prod");
      res.json(out);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Undo a soft-delete before the nightly purge runs. Unlike wipe this IS a
  // production tool — recovering a real brand a user (or Shopify uninstall)
  // deleted is the whole point. Mirrors the main app's RestoreUserAccount.
  router.post("/:userId/restore", async (req, res) => {
    try {
      const out = await restoreBrand(req.params.userId, req.admin, req.dbTarget || "prod");
      res.json(out);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  return router;
}

// DEV-ONLY hard delete of a brand + everything hanging off it, in one
// transaction (children before parents, so a partial delete can never commit).
// Order is FK-safe; each step's row count is returned for the operator.
async function wipeBrand(userId, admin, dbTarget) {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    const e = new Error("Invalid user_id"); e.status = 400; throw e;
  }
  if (dbTarget !== "dev") {
    const e = new Error("Brand wipe is only allowed on the dev database"); e.status = 403; throw e;
  }

  const pool = await getCloudSqlPool("dev");
  const client = await pool.connect();
  try {
    const { rows: found } = await client.query(
      `SELECT b.id AS brand_id, b.store_name, u.email
         FROM users u LEFT JOIN brands b ON b.user_id = u.id
        WHERE u.id = $1`,
      [userId],
    );
    if (!found.length) {
      const e = new Error("User not found on the dev database"); e.status = 404; throw e;
    }
    const { brand_id: brandId, store_name: storeName, email } = found[0];

    // Product-children first, then brand-side rows referencing the user, then
    // products, brand and user. `products WHERE user_id` subquery resolves for
    // every product step because products themselves are deleted only at #18.
    const steps = [
      ["campaign_matches", "DELETE FROM campaign_matches WHERE product_id IN (SELECT id FROM products WHERE user_id = $1)"],
      ["product_variants", "DELETE FROM product_variants WHERE product_id IN (SELECT id FROM products WHERE user_id = $1)"],
      ["product_files", "DELETE FROM product_files WHERE product_id IN (SELECT id FROM products WHERE user_id = $1)"],
      ["sample_requests", "DELETE FROM sample_requests WHERE product_id IN (SELECT id FROM products WHERE user_id = $1)"],
      ["invitations", "DELETE FROM invitations WHERE brand_user_id = $1 OR product_id IN (SELECT id FROM products WHERE user_id = $1)"],
      ["short_links", "DELETE FROM short_links WHERE created_by_user_id = $1 OR product_id IN (SELECT id FROM products WHERE user_id = $1)"],
      ["links", "DELETE FROM links WHERE brand_user_id = $1 OR product_id IN (SELECT id FROM products WHERE user_id = $1)"],
      ["chats", "DELETE FROM chats WHERE brand_user_id = $1"],
      ["external_creator_invites", "DELETE FROM external_creator_invites WHERE brand_user_id = $1"],
      ["external_creator_links", "DELETE FROM external_creator_links WHERE brand_user_id = $1"],
      ["external_creator_chats", "DELETE FROM external_creator_chats WHERE brand_user_id = $1"],
      ["payouts", "DELETE FROM payouts WHERE brand_id = $1"],
      ["payout_settings", "DELETE FROM payout_settings WHERE brand_id = $1"],
      ["brand_fee_rates", "DELETE FROM brand_fee_rates WHERE brand_id = $1"],
      ["brand_email_notifications", "DELETE FROM brand_email_notifications WHERE brand_user_id = $1"],
      ["brand_referrals", "DELETE FROM brand_referrals WHERE referrer_user_id = $1 OR referee_user_id = $1"],
      ["referrals", "DELETE FROM referrals WHERE referrer_user_id = $1 OR referee_user_id = $1"],
      ["products", "DELETE FROM products WHERE user_id = $1"],
      ["brands", "DELETE FROM brands WHERE user_id = $1"],
      ["users", "DELETE FROM users WHERE id = $1"],
    ];

    await client.query("BEGIN");
    const deleted = {};
    for (const [label, sql] of steps) {
      const r = await client.query(sql, [userId]);
      deleted[label] = r.rowCount;
    }
    await client.query("COMMIT");

    console.log(
      `[brand-wipe] admin=${admin?.email || "?"} dev user=${userId} brand=${brandId || "-"} ` +
      `store=${JSON.stringify(storeName)} deleted=${JSON.stringify(deleted)}`,
    );
    return { user_id: userId, brand_id: brandId, store_name: storeName, email, target_db: "dev", deleted };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Reverse a soft-delete. Runs in one transaction, mirroring the main app's
// RestoreUserAccount (service-grpc/services/users_service.go): clear the user's
// deletion sentinel + schedule, then re-activate the brand (and any influencer)
// profile rows. Ended links/collaborations are NOT reactivated — same as the
// main app; the brand re-onboards its links from the restored dashboard.
// Allowed on prod: recovering a real brand before purge is the point.
async function restoreBrand(userId, admin, dbTarget) {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    const e = new Error("Invalid user_id"); e.status = 400; throw e;
  }

  const pool = await getCloudSqlPool(dbTarget);
  const client = await pool.connect();
  try {
    // Capture pre-restore state for the audit log + operator feedback. The
    // active check runs in SQL (don't trust JS parsing of 'infinity').
    const { rows: found } = await client.query(
      `SELECT u.email,
              u.deletion_scheduled_for,
              u.deletion_reason,
              (u.deleted = ${USER_ACTIVE})                      AS already_active,
              (u.deletion_scheduled_for IS NOT NULL
                 AND u.deletion_scheduled_for <= NOW())         AS purge_overdue,
              b.id         AS brand_id,
              b.store_name
         FROM users u
         LEFT JOIN brands b ON b.user_id = u.id
        WHERE u.id = $1 AND u.role = ${ROLE_BRAND}`,
      [userId],
    );
    if (!found.length) {
      const e = new Error("Brand user not found"); e.status = 404; throw e;
    }
    const pre = found[0];
    if (pre.already_active) {
      const e = new Error("Brand is already active — nothing to restore"); e.status = 409; throw e;
    }

    await client.query("BEGIN");
    const uRes = await client.query(
      `UPDATE users
          SET deleted                = ${USER_ACTIVE},
              deletion_scheduled_for = NULL,
              deletion_reason        = ''
        WHERE id = $1 AND deleted <> ${USER_ACTIVE}`,
      [userId],
    );
    // 0 rows means the purge job or a concurrent restore beat us to it.
    if (uRes.rowCount === 0) {
      await client.query("ROLLBACK");
      const e = new Error("Brand is no longer soft-deleted (already restored or purged)"); e.status = 409; throw e;
    }
    const bRes = await client.query(
      `UPDATE brands
          SET deleted = ${ENTITY_ACTIVE}, updated = NOW()
        WHERE user_id = $1 AND deleted <> ${ENTITY_ACTIVE}`,
      [userId],
    );
    // Defensive: a brand user shouldn't have an influencer row, but if the
    // account was ever both, keep the two profiles in sync like the main app.
    await client.query(
      `UPDATE influencers
          SET deleted = ${ENTITY_ACTIVE}
        WHERE user_id = $1 AND deleted <> ${ENTITY_ACTIVE}`,
      [userId],
    );
    await client.query("COMMIT");

    console.log(
      `[brand-restore] admin=${admin?.email || "?"} db=${dbTarget} user=${userId} ` +
      `brand=${pre.brand_id || "-"} store=${JSON.stringify(pre.store_name)} ` +
      `was_scheduled_for=${pre.deletion_scheduled_for ? new Date(pre.deletion_scheduled_for).toISOString() : "-"} ` +
      `purge_overdue=${pre.purge_overdue} reason=${JSON.stringify(pre.deletion_reason || "")}`,
    );
    return {
      user_id: userId,
      brand_id: pre.brand_id,
      store_name: pre.store_name,
      email: pre.email,
      target_db: dbTarget,
      brands_restored: bRes.rowCount,
      was_scheduled_for: pre.deletion_scheduled_for,
      purge_overdue: pre.purge_overdue,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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

  // Pull the brand's authoritative Shopify subscription from app_subscriptions
  // when the table exists on this target. Prefer an ACTIVE row, else the most
  // recently synced (so a lone CANCELLED/EXPIRED row still surfaces as such).
  const hasAppSubs = await appSubscriptionsAvailable();
  const subSelect = hasAppSubs
    ? `asub.status              AS sub_status,
            asub.name                AS sub_name,
            asub.test                AS sub_test,
            asub.price_amount        AS sub_price_amount,
            asub.price_currency      AS sub_price_currency,
            asub.trial_ends_at       AS sub_trial_ends_at,
            asub.current_period_end  AS sub_current_period_end,
            asub.cancelled_at        AS sub_cancelled_at,`
    : `NULL AS sub_status, NULL AS sub_name, NULL AS sub_test,
            NULL::numeric AS sub_price_amount, NULL AS sub_price_currency,
            NULL::timestamptz AS sub_trial_ends_at, NULL::timestamptz AS sub_current_period_end,
            NULL::timestamptz AS sub_cancelled_at,`;
  const subJoin = hasAppSubs
    ? `LEFT JOIN LATERAL (
         SELECT status, name, test, price_amount, price_currency,
                trial_ends_at, current_period_end, cancelled_at
           FROM app_subscriptions
          WHERE user_id = u.id
          ORDER BY (status = 'ACTIVE') DESC, synced_at DESC NULLS LAST,
                   shopify_created_at DESC NULLS LAST
          LIMIT 1
       ) asub ON true`
    : "";

  return cloudSqlQuery(
    `SELECT u.id          AS user_id,
            u.email,
            u.created     AS user_created,
            u.role,
            u.account_id,
            ${subSelect}
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
       ${subJoin}
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT $1 OFFSET $2`,
    params,
  );
}

// Soft-deleted brands (users.deleted <> 'infinity'). Deliberately lighter than
// listBrands — no revenue/click/campaign rollups, since a purge-bound row's
// stats aren't actionable. Ordered by urgency (soonest scheduled purge first).
// Brand join is unfiltered because a soft-deleted brand's `b.deleted` is a real
// timestamp, not the ENTITY_ACTIVE sentinel.
async function listDeletedBrands(query) {
  const { q = "", limit = "100", offset = "0" } = query;
  const params = [Number(limit) || 100, Number(offset) || 0];
  let where = `u.role = ${ROLE_BRAND} AND u.deleted <> ${USER_ACTIVE}`;
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (u.email ILIKE $3 OR b.store_name ILIKE $3 OR b.store_website ILIKE $3 OR b.first_name ILIKE $3 OR b.last_name ILIKE $3)`;
  }
  return cloudSqlQuery(
    `SELECT u.id          AS user_id,
            u.email,
            u.created     AS user_created,
            u.role,
            u.account_id,
            u.deleted     AS user_deleted,
            u.deletion_scheduled_for,
            u.deletion_reason,
            CASE WHEN u.deletion_scheduled_for IS NULL THEN NULL
                 ELSE GREATEST(0, CEIL(EXTRACT(EPOCH FROM (u.deletion_scheduled_for - NOW())) / 86400))::int
            END           AS days_until_purge,
            (u.deletion_scheduled_for IS NOT NULL AND u.deletion_scheduled_for <= NOW()) AS purge_overdue,
            b.id          AS brand_id,
            b.store_name,
            b.store_website,
            b.first_name,
            b.last_name,
            b.logo_pic_name,
            b.location,
            b.niche
       FROM users u
       LEFT JOIN brands b ON b.user_id = u.id
      WHERE ${where}
      ORDER BY u.deletion_scheduled_for ASC NULLS LAST, u.deleted DESC
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
