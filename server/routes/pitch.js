import { Router } from "express";
import { cloudSqlQuery } from "../lib/cloudsql.js";
import { signedUrls } from "../lib/gcs.js";
import { pitchReviewsClient } from "../lib/pitchReviews.js";
import { pitchPartnersClient } from "../lib/pitchPartners.js";
import {
  parseColumnFilters, filterConditions, orderBySql,
  textFilter, numberFilter, dateFilter, enumFilter, boolFilter,
} from "../lib/tableQuery.js";

// Pitch, read from ops: every pitch creators sent, who sent it, to whom, and
// what came of it; the creators who pitch; who pays for Pitch Pro; the switch
// that has Linkable write a creator's pitches ahead every Monday. The brands
// are in pitch-brands.js.
//
// Read-only on pitches by design, but for the In review queue (QA 112): a
// creator's first pitches wait for the team, and Approve / Reject go through
// the main app (lib/pitchReviews.js), which sends. Nothing here opens the
// brand's proposal link (/p/<token>): service-grpc counts any browser visit
// there as the brand viewing it, moves the pitch to "viewed" and emails the
// creator. The detail shows what the proposal says instead.
//
// A database without Pitch answers available:false, never a 500.

const UNDEFINED = new Set(["42P01", "42703"]);
const notPromoted = (e) => UNDEFINED.has(e?.code);
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ""));
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// The creator's newest live influencer row; LATERAL so a user with two rows
// is still one line.
const INFLUENCER = (userCol) => `LEFT JOIN LATERAL (
    SELECT first_name, last_name, instagram_name, instagram_username, instagram_followers_count,
           profile_pic_name, instagram_profile_image, about, location_country, country
      FROM influencers WHERE user_id = ${userCol} AND deleted = '-infinity'
     ORDER BY created DESC LIMIT 1
  ) i ON true`;
const CREATOR_NAME =
  `COALESCE(NULLIF(REGEXP_REPLACE(TRIM(COALESCE(i.first_name, '') || ' ' || COALESCE(i.last_name, '')), '\\s+', ' ', 'g'), ''), NULLIF(i.instagram_name, ''), u.email, '')`;

// The bucket object name in an influencers.instagram_profile_image, or "".
const storageKey = (v) => (String(v || "").startsWith("influencer/profile/image/") ? String(v) : "");

// The creator's picture, signed: their own upload, then the stored Instagram
// picture; a plain URL is passed through (it may have expired, and the page
// falls back to an initial).
async function withAvatars(rows, sign) {
  const keys = rows.map((r) => r.profile_pic_name || storageKey(r.instagram_profile_image));
  const signed = keys.some(Boolean) ? await sign(keys).catch(() => keys.map(() => null)) : keys.map(() => null);
  return rows.map((r, n) => {
    const { profile_pic_name: _pic, instagram_profile_image: ig, ...rest } = r;
    const url = /^https?:\/\//.test(ig || "") ? ig : "";
    return { ...rest, creator_avatar: signed[n] || url || "" };
  });
}

// Where the pitch went out: Lemlist (a brand off Linkable, since 4 Oct),
// Linkable Messages (a brand on Linkable), or Linkable's own email (before
// Lemlist). Sandboxed = dev, to a tester instead of the brand.
const EVENTS_LATERAL = `LEFT JOIN LATERAL (
    SELECT bool_or(e.detail->>'sandboxed' = 'true') AS sandboxed,
           bool_or(e.detail->>'in_app' = 'true') AS in_app
      FROM pitch_events e WHERE e.pitch_id = p.id AND e.event IN ('scheduled', 'sent')
  ) ev ON true`;
const CHANNEL = `CASE WHEN p.delivery = 'lemlist' THEN 'lemlist'
                      WHEN COALESCE(ev.in_app, false) THEN 'in_app'
                      WHEN p.sent_at IS NOT NULL THEN 'email'
                      ELSE '' END`;

const PITCH_FROM = `
  FROM pitches p
  JOIN pitch_brands b ON b.id = p.pitch_brand_id
  LEFT JOIN users u ON u.id = p.creator_user_id
  ${INFLUENCER("p.creator_user_id")}
  ${EVENTS_LATERAL}`;

const PITCH_COLUMNS = `
  p.id, p.status, p.tier, p.bonus, p.created, p.sent_at, p.sent_to, p.contact_name, p.contact_role,
  p.delivery, p.lemlist_state, p.lemlist_error, p.view_count, p.first_viewed_at, p.last_viewed_at,
  p.replied_at, p.accepted_at, p.declined_at, p.trial_started_at, p.brand_paid_at, p.idea,
  ${CHANNEL} AS channel, COALESCE(ev.sandboxed, false) AS sandboxed,
  p.creator_user_id, u.email AS creator_email, ${CREATOR_NAME} AS creator_name,
  i.instagram_username AS creator_instagram, i.profile_pic_name, i.instagram_profile_image,
  b.id AS brand_id, b.name AS brand_name, b.domain AS brand_domain, b.logo_url AS brand_logo,
  (b.linkable_brand_user_id IS NOT NULL) AS brand_on_linkable`;

// The list's three views. "Sent" is every pitch a creator pressed Send on,
// including one Lemlist has not sent yet (scheduled).
const VIEWS = {
  sent: "p.sent_at IS NOT NULL",
  drafts: "p.status = 'ready'",
  all: null,
};

const STATUSES = ["ready", "in_review", "scheduled", "sent", "viewed", "accepted", "changes_requested", "declined", "expired", "skipped"];
const byId = (col) => (params, raw) => {
  if (!isUuid(raw)) return null;
  params.push(raw);
  return `${col} = $${params.length}`;
};

const PITCH_SORTS = {
  creator: CREATOR_NAME,
  brand: "b.name",
  status: "p.status",
  sent_to: "p.sent_to",
  sent: "p.sent_at",
  views: "p.view_count",
  replied: "p.replied_at",
  created: "p.created",
};
const PITCH_FILTERS = {
  creator: textFilter(CREATOR_NAME, "u.email", "i.instagram_username"),
  brand: textFilter("b.name", "b.domain"),
  status: enumFilter({
    ...Object.fromEntries(STATUSES.map((s) => [s, `p.status = '${s}'`])),
    replied: "p.replied_at IS NOT NULL",
    no_contact: "p.lemlist_state = 'failed'",
  }),
  channel: enumFilter({
    lemlist: "p.delivery = 'lemlist'",
    email: `(${CHANNEL}) = 'email'`,
    in_app: "COALESCE(ev.in_app, false)",
  }),
  sent_to: textFilter("p.sent_to", "p.contact_name"),
  sent: dateFilter("p.sent_at"),
  views: numberFilter("p.view_count"),
  creator_id: byId("p.creator_user_id"),
  brand_id: byId("p.pitch_brand_id"),
};

// Creators: everyone who opened Pitch. The first time a creator opens it,
// service-grpc records them (pitch_creators, via DetectCreatorBrands) and
// writes their first three drafts; pitch_creators.created is that moment.
// Anyone with a pitch but no row (older data) is included too.
const CREATOR_FROM = `
  FROM (SELECT user_id FROM pitch_creators
        UNION SELECT creator_user_id FROM pitches WHERE deleted = '-infinity') c
  JOIN users u ON u.id = c.user_id AND u.deleted = 'infinity'
  LEFT JOIN pitch_creators pc ON pc.user_id = u.id
  ${INFLUENCER("u.id")}
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS written,
           count(*) FILTER (WHERE p.status = 'ready')::int AS drafts,
           count(*) FILTER (WHERE p.status = 'expired')::int AS expired,
           count(*) FILTER (WHERE p.sent_at IS NOT NULL)::int AS sent,
           count(*) FILTER (WHERE p.sent_at IS NOT NULL AND p.view_count > 0)::int AS viewed,
           count(*) FILTER (WHERE p.replied_at IS NOT NULL)::int AS replied,
           count(*) FILTER (WHERE p.accepted_at IS NOT NULL OR p.status = 'accepted')::int AS accepted,
           count(*) FILTER (WHERE p.lemlist_state = 'failed' AND p.status = 'ready')::int AS no_contact,
           max(p.sent_at) AS last_sent_at,
           min(p.created) AS first_pitch_at
      FROM pitches p WHERE p.creator_user_id = u.id AND p.deleted = '-infinity'
  ) s ON true`;
const CREATOR_COLUMNS = `
  u.id AS user_id, u.email, ${CREATOR_NAME} AS name,
  i.instagram_username, i.instagram_followers_count, i.profile_pic_name, i.instagram_profile_image,
  COALESCE(pc.enabled, false) AS weekly,
  (COALESCE(pc.media_kit_url, '') <> '' OR COALESCE(pc.media_kit_path, '') <> '') AS has_media_kit,
  (COALESCE(i.about, '') <> '') AS has_about,
  COALESCE(pc.created, s.first_pitch_at) AS opened_at,
  COALESCE(s.written, 0) AS written, COALESCE(s.expired, 0) AS expired,
  COALESCE(s.drafts, 0) AS drafts, COALESCE(s.sent, 0) AS sent, COALESCE(s.viewed, 0) AS viewed,
  COALESCE(s.replied, 0) AS replied, COALESCE(s.accepted, 0) AS accepted,
  COALESCE(s.no_contact, 0) AS no_contact, s.last_sent_at, s.first_pitch_at`;
const CREATOR_VIEWS = {
  all: null,
  sent: "COALESCE(s.sent, 0) > 0",
  weekly: "COALESCE(pc.enabled, false)",
};
const CREATOR_SORTS = {
  name: CREATOR_NAME,
  followers: "i.instagram_followers_count",
  weekly: "COALESCE(pc.enabled, false)",
  drafts: "COALESCE(s.drafts, 0)",
  sent: "COALESCE(s.sent, 0)",
  viewed: "COALESCE(s.viewed, 0)",
  replied: "COALESCE(s.replied, 0)",
  accepted: "COALESCE(s.accepted, 0)",
  last_sent: "s.last_sent_at",
  opened: "COALESCE(pc.created, s.first_pitch_at)",
};
const CREATOR_FILTERS = {
  name: textFilter(CREATOR_NAME, "u.email", "i.instagram_username"),
  weekly: boolFilter("pc.enabled"),
  sent: numberFilter("COALESCE(s.sent, 0)"),
  last_sent: dateFilter("s.last_sent_at"),
  opened: dateFilter("COALESCE(pc.created, s.first_pitch_at)"),
};

// Pitch Pro: who has a plan and what it is (creator_plans, written by the
// main app from what Stripe returns; services/pitch_plan.go and
// pitch_partners.go). Read-only; nothing here calls Stripe.
//
// A creator can have several rows (a Founding Checkout left unpaid, an
// ended Pitch Pro and a new one, Pitch Pro given by Pitch Partners next to
// one she pays for). The list is one line per creator, her row picked the
// way the main app picks her plan (effectivePitchPlan): Founding paid, then
// a Pitch Pro subscription that runs, then Pitch Pro given while it runs,
// then her newest row. A Founding Checkout never paid (pending, expired)
// and a subscription whose first payment never went through
// (incomplete_expired) are not plans.
const IS_PLAN = `NOT (c.plan = 'founding' AND c.status IN ('pending', 'expired'))
  AND NOT (c.plan = 'pro' AND c.status = 'incomplete_expired')`;
const PLAN_RANK = `CASE WHEN c.plan = 'founding' AND c.status = 'paid' THEN 0
    WHEN c.plan = 'pro' AND c.stripe_subscription_id IS NOT NULL AND c.status IN ('active', 'trialing', 'past_due') AND NOT c.refund_due THEN 1
    WHEN c.plan = 'pro' AND c.status = 'granted' AND c.current_period_end > now() THEN 2
    ELSE 3 END`;

// Where her plan is, in an admin's words (the page labels these):
// paying, trial, cancels (stops at the end of what she paid or her trial),
// past_due (Stripe is retrying her card), free (Pitch Pro given by Pitch
// Partners, running), ended, refunded (or a refund due), disputed (a
// Founding payment she disputed).
const PLAN_STATE = `CASE
    WHEN r.refunded_at IS NOT NULL OR r.refund_due OR r.status = 'refunded' THEN 'refunded'
    WHEN r.status = 'disputed' THEN 'disputed'
    WHEN r.plan = 'founding' THEN 'paying'
    WHEN r.status = 'granted' THEN CASE WHEN r.current_period_end > now() THEN 'free' ELSE 'ended' END
    WHEN r.status IN ('active', 'trialing') AND r.cancel_at_period_end THEN 'cancels'
    WHEN r.status = 'trialing' THEN 'trial'
    WHEN r.status = 'active' THEN 'paying'
    WHEN r.status IN ('past_due', 'unpaid', 'incomplete') THEN 'past_due'
    ELSE 'ended' END`;
// What she is on: Founding; a gift (Pitch Pro given by Pitch Partners, or a
// paid Pitch Pro whose trial runs to the end of a gift: trial_kind gift or
// deferred); a Pitch Partner's free first month (while it runs); else Pitch
// Pro by how often it bills ('' is from before yearly existed: monthly).
const PLAN_KIND = `CASE
    WHEN r.plan = 'founding' THEN 'founding'
    WHEN r.status = 'granted' THEN 'gift'
    WHEN r.status = 'trialing' AND r.trial_kind IN ('gift', 'deferred') THEN 'gift'
    WHEN r.status = 'trialing' AND (r.trial_kind = 'partner_month' OR r.partner_free_month) THEN 'partner_trial'
    WHEN r.billing_interval = 'year' THEN 'pro_yearly'
    ELSE 'pro_monthly' END`;
// The date that matters next: her first payment (trial), the renewal
// (paying), the last day (cancels, gift), the day it ended or was refunded.
// Founding has none: it is for good.
const PLAN_NEXT = `CASE (${PLAN_STATE})
    WHEN 'trial' THEN COALESCE(r.trial_ends_at, r.current_period_end)
    WHEN 'paying' THEN CASE WHEN r.plan = 'founding' THEN NULL ELSE r.current_period_end END
    WHEN 'ended' THEN COALESCE(r.ended_at, r.current_period_end)
    WHEN 'refunded' THEN r.refunded_at
    WHEN 'disputed' THEN NULL
    ELSE r.current_period_end END`;
// How she came: Pitch Pro given is the Pitch Partners programme itself; else
// who the plan says brought her (written at Checkout), else the Pitch
// Partner whose link she signed up with (a Founding row records nobody).
const PLAN_SOURCE = `CASE
    WHEN r.status = 'granted' THEN 'partner_programme'
    WHEN r.referral_source IN ('pitch_partner', 'creator_referral') THEN r.referral_source
    WHEN ppr.partner_user_id IS NOT NULL THEN 'pitch_partner'
    ELSE 'direct' END`;
const PLAN_STARTED = "COALESCE(r.paid_at, r.created)";

const PLANS_FROM = `
  FROM (SELECT DISTINCT ON (c.user_id) c.*, count(*) OVER (PARTITION BY c.user_id)::int AS plan_rows
          FROM creator_plans c WHERE ${IS_PLAN}
         ORDER BY c.user_id, ${PLAN_RANK}, c.created DESC) r
  LEFT JOIN users u ON u.id = r.user_id
  ${INFLUENCER("r.user_id")}
  LEFT JOIN pitch_partner_referrals ppr ON ppr.referee_user_id = r.user_id
  LEFT JOIN users ru ON ru.id = CASE WHEN r.status = 'granted' THEN NULL
                                     WHEN r.referral_source IN ('pitch_partner', 'creator_referral') THEN r.referrer_user_id
                                     ELSE ppr.partner_user_id END
  LEFT JOIN LATERAL (
    SELECT first_name, last_name, instagram_name, instagram_username
      FROM influencers WHERE user_id = ru.id AND deleted = '-infinity'
     ORDER BY created DESC LIMIT 1
  ) ri ON true`;
// location_country is free text ("London, United Kingdom"): its last part.
const PLAN_COUNTRY = `COALESCE(NULLIF(TRIM(REGEXP_REPLACE(COALESCE(i.location_country, ''), '^.*,', '')), ''), NULLIF(i.country, ''), '')`;
const REFERRER_NAME =
  `COALESCE(NULLIF(REGEXP_REPLACE(TRIM(COALESCE(ri.first_name, '') || ' ' || COALESCE(ri.last_name, '')), '\\s+', ' ', 'g'), ''), NULLIF(ri.instagram_name, ''), ru.email, '')`;
const PLAN_COLUMNS = `
  r.id, r.user_id, r.plan, r.status, r.currency, r.amount_minor::float8 AS amount_minor, r.billing_interval,
  r.stripe_customer_id, COALESCE(r.stripe_subscription_id, '') AS stripe_subscription_id, r.stripe_payment_intent_id,
  r.current_period_end, r.trial_ends_at, r.cancel_at_period_end, r.ended_at, r.paid_at, r.past_due_since,
  r.refund_due, r.refunded_at, r.refund_reason, r.trial_kind, r.created, r.plan_rows,
  (${PLAN_STATE}) AS state, (${PLAN_KIND}) AS kind, (${PLAN_NEXT}) AS next_at, ${PLAN_STARTED} AS started_at,
  (${PLAN_SOURCE}) AS source, ru.id AS referrer_user_id, ${REFERRER_NAME} AS referrer_name,
  ri.instagram_username AS referrer_instagram,
  u.email, ${CREATOR_NAME} AS name, i.instagram_username, i.profile_pic_name, i.instagram_profile_image,
  ${PLAN_COUNTRY} AS country,
  (u.id IS NULL OR (u.deleted IS NOT NULL AND u.deleted <> 'infinity')) AS account_deleted`;

export const PLAN_STATES = ["paying", "trial", "free", "cancels", "past_due", "ended", "refunded", "disputed"];
export const PLAN_KINDS = ["pro_monthly", "pro_yearly", "founding", "partner_trial", "gift"];
const PLAN_SOURCES = ["pitch_partner", "creator_referral", "partner_programme", "direct"];
const PLAN_SORTS = {
  creator: CREATOR_NAME,
  plan: `(${PLAN_KIND})`,
  status: `array_position(ARRAY[${PLAN_STATES.map((s) => `'${s}'`).join(", ")}], (${PLAN_STATE}))`,
  price: "r.amount_minor",
  started: PLAN_STARTED,
  next: `(${PLAN_NEXT})`,
  source: `(${PLAN_SOURCE})`,
  country: PLAN_COUNTRY,
};
const PLAN_FILTERS = {
  creator: textFilter(CREATOR_NAME, "u.email", "i.instagram_username"),
  status: enumFilter(Object.fromEntries(PLAN_STATES.map((s) => [s, `(${PLAN_STATE}) = '${s}'`]))),
  plan: enumFilter(Object.fromEntries(PLAN_KINDS.map((k) => [k, `(${PLAN_KIND}) = '${k}'`]))),
  currency: enumFilter(Object.fromEntries(["gbp", "usd", "eur"].map((c) => [c, `lower(r.currency) = '${c}'`]))),
  source: enumFilter(Object.fromEntries(PLAN_SOURCES.map((s) => [s, `(${PLAN_SOURCE}) = '${s}'`]))),
  started: dateFilter(PLAN_STARTED),
  next: dateFilter(`(${PLAN_NEXT})`),
  country: textFilter(PLAN_COUNTRY),
};

// Where a plan's Stripe objects are: live mode for prod, test mode for dev
// (the main app on dev bills with Stripe's test keys).
const stripeDashboard = (target) => (target === "dev" ? "https://dashboard.stripe.com/test" : "https://dashboard.stripe.com");

// Since when the summary counts: a number of days, or everything.
function sinceDays(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 && n <= 3650 ? n : null;
}
const pageOf = (q, def = 25) => ({
  limit: Math.min(Math.max(parseInt(q.limit) || def, 1), 100),
  offset: Math.max(parseInt(q.offset) || 0, 0),
});

export function pitchRoutes({ query = cloudSqlQuery, sign = signedUrls, reviews = pitchReviewsClient, partners = pitchPartnersClient } = {}) {
  const router = Router();

  // The In review queue (QA 112). Errors from the main app are its own
  // sentences (a failed automatic check says what to fix).
  const reviewError = (res, e) => res.status(e.status || 500).json({ error: e.message });

  // GET /api/pitch/reviews?limit=&offset= — oldest first.
  router.get("/reviews", async (req, res) => {
    const { limit, offset } = pageOf(req.query);
    try {
      res.json(await reviews.list({ limit, offset }, req.dbTarget));
    } catch (e) { reviewError(res, e); }
  });

  // POST /api/pitch/reviews/:id/approve { contact_email? } — sends it now.
  router.post("/reviews/:id/approve", async (req, res) => {
    try {
      res.json(await reviews.approve(req.params.id, { contactEmail: req.body?.contact_email, admin: req.admin }, req.dbTarget));
    } catch (e) { reviewError(res, e); }
  });

  // POST /api/pitch/reviews/:id/reject { reason } — the creator reads the reason.
  router.post("/reviews/:id/reject", async (req, res) => {
    try {
      res.json(await reviews.reject(req.params.id, { reason: req.body?.reason, admin: req.admin }, req.dbTarget));
    } catch (e) { reviewError(res, e); }
  });

  // Pitch Partners (main app QA 132): applications to approve or reject, and
  // videos to check are live. All through the main app (lib/pitchPartners.js).
  // GET /api/pitch/partners?queue=applications|videos|approved|rejected&limit=&offset=
  router.get("/partners", async (req, res) => {
    const { limit, offset } = pageOf(req.query);
    try {
      res.json(await partners.list({ queue: String(req.query.queue || "applications"), limit, offset }, req.dbTarget));
    } catch (e) { reviewError(res, e); }
  });

  // GET /api/pitch/partners/stuck-payouts?limit=&offset= — payouts left
  // paying for over an hour, oldest first.
  router.get("/partners/stuck-payouts", async (req, res) => {
    const { limit, offset } = pageOf(req.query, 10);
    try {
      res.json(await partners.stuck({ limit, offset }, req.dbTarget));
    } catch (e) { reviewError(res, e); }
  });

  // POST /api/pitch/partners/stuck-payouts/:batch/reconcile — asks Stripe now.
  router.post("/partners/stuck-payouts/:batch/reconcile", async (req, res) => {
    try {
      res.json(await partners.reconcile(req.params.batch, { admin: req.admin }, req.dbTarget));
    } catch (e) { reviewError(res, e); }
  });

  // POST /api/pitch/partners/:userId/decide { decision: approve|reject, reason? }
  router.post("/partners/:userId/decide", async (req, res) => {
    try {
      res.json(await partners.decide(req.params.userId, {
        decision: req.body?.decision, reason: req.body?.reason,
        currency: req.body?.currency, amountMinor: req.body?.amount_minor, admin: req.admin,
      }, req.dbTarget));
    } catch (e) { reviewError(res, e); }
  });

  // POST /api/pitch/partners/:userId/video { decision: verify|reject, reason? }
  router.post("/partners/:userId/video", async (req, res) => {
    try {
      res.json(await partners.video(req.params.userId, { decision: req.body?.decision, reason: req.body?.reason, admin: req.admin }, req.dbTarget));
    } catch (e) { reviewError(res, e); }
  });

  // GET /api/pitch/summary?days=30 — the funnel, counted on when each pitch
  // was sent. "paying per 100 sent" is the number Pitch is judged on.
  router.get("/summary", async (req, res) => {
    const days = sinceDays(req.query.days);
    const params = days ? [days] : [];
    const since = days ? "AND sent_at >= now() - ($1 || ' days')::interval" : "";
    try {
      const [funnel, now, setting] = await Promise.all([
        query(
          `SELECT count(*)::int AS sent,
                  count(DISTINCT creator_user_id)::int AS creators,
                  count(DISTINCT pitch_brand_id)::int AS brands,
                  count(*) FILTER (WHERE view_count > 0)::int AS viewed,
                  count(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied,
                  count(*) FILTER (WHERE accepted_at IS NOT NULL OR status = 'accepted')::int AS accepted,
                  count(*) FILTER (WHERE trial_started_at IS NOT NULL)::int AS trials,
                  count(*) FILTER (WHERE brand_paid_at IS NOT NULL)::int AS paying
             FROM pitches WHERE deleted = '-infinity' AND sent_at IS NOT NULL ${since}`,
          params,
        ),
        // Right now, whatever the period.
        query(
          `SELECT count(*) FILTER (WHERE status = 'scheduled')::int AS sending,
                  count(*) FILTER (WHERE status = 'in_review')::int AS in_review,
                  count(*) FILTER (WHERE status = 'ready')::int AS drafts,
                  count(*) FILTER (WHERE status = 'ready' AND lemlist_state = 'failed')::int AS no_contact,
                  (SELECT count(*)::int FROM pitch_creators WHERE enabled) AS weekly_creators
             FROM pitches WHERE deleted = '-infinity'`,
        ),
        // Why the Lemlist campaign is not sending, when it is not
        // (service-grpc's pitch_lemlist_setup.go writes it).
        query(`SELECT value FROM pitch_settings WHERE key = 'lemlist_setup_problem'`).catch(() => ({ rows: [] })),
      ]);
      const f = funnel.rows[0] || {};
      res.json({
        available: true,
        days,
        funnel: f,
        paying_per_100: f.sent ? Math.round((f.paying * 100 * 10) / f.sent) / 10 : 0,
        now: now.rows[0] || {},
        sending_problem: setting.rows[0]?.value || "",
      });
    } catch (e) {
      if (notPromoted(e)) return res.json({ available: false });
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/pitch/pitches?view=sent|drafts|all&limit=&offset=&sortBy=&sortDir=&filter[col]=
  router.get("/pitches", async (req, res) => {
    const { limit, offset } = pageOf(req.query);
    const view = Object.hasOwn(VIEWS, req.query.view) ? req.query.view : "sent";
    const params = [];
    const conds = ["p.deleted = '-infinity'", VIEWS[view], ...filterConditions(parseColumnFilters(req.query), PITCH_FILTERS, params)].filter(Boolean);
    const where = `WHERE ${conds.join(" AND ")}`;
    const order = orderBySql(req.query, PITCH_SORTS, "COALESCE(p.sent_at, p.created) DESC, p.id");
    const countParams = [...params];
    params.push(limit, offset);
    try {
      const [{ rows }, count] = await Promise.all([
        query(`SELECT ${PITCH_COLUMNS} ${PITCH_FROM} ${where} ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`, params),
        query(`SELECT count(*)::int AS n ${PITCH_FROM} ${where}`, countParams),
      ]);
      res.json({ available: true, view, items: await withAvatars(rows, sign), total: count.rows[0]?.n ?? 0 });
    } catch (e) {
      if (notPromoted(e)) return res.json({ available: false, view, items: [], total: 0 });
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/pitch/pitches/:id — one pitch whole: what was sent, to whom,
  // the proposal's terms, every event, the brand's replies.
  router.get("/pitches/:id", async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: "That pitch doesn't exist." });
    try {
      const { rows } = await query(
        `SELECT ${PITCH_COLUMNS},
                p.week_start, p.subject, p.body, p.idea_description, p.proposal_idea, p.format, p.product,
                p.deliverables, p.collab_mode, p.formats, p.quantity, p.platforms,
                p.gifted, p.affiliate, p.paid, p.fee_amount::float8 AS fee_amount, p.fee_currency,
                p.open_to_discuss, p.auto_follow_up, p.tone, p.draft_source, p.offer_variant,
                p.open_count, p.acted_at, p.changes_text, p.accept_email, p.accept_store_url,
                p.accept_shop_domain, p.accept_commission::float8 AS accept_commission, p.accept_started_at,
                p.brand_user_id, p.product_id, p.completion_note,
                p.lemlist_lead_id, p.lemlist_enrolled_at, p.lemlist_last_step_at, p.lemlist_ended_at, p.lemlist_attempts,
                b.instagram AS brand_instagram, b.category AS brand_category, b.country AS brand_country,
                b.contact_email AS brand_contact_email, b.contact_name AS brand_contact_name,
                b.contact_role AS brand_contact_role, b.contact_source AS brand_contact_source,
                b.contact_bounced AS brand_contact_bounced,
                bu.email AS brand_account_email
           ${PITCH_FROM}
           LEFT JOIN users bu ON bu.id = p.brand_user_id
          WHERE p.id = $1 AND p.deleted = '-infinity'`,
        [req.params.id],
      );
      if (!rows.length) return res.status(404).json({ error: "That pitch doesn't exist." });
      const [events, replies] = await Promise.all([
        query(`SELECT id, created, event, detail FROM pitch_events WHERE pitch_id = $1 ORDER BY created, id`, [req.params.id]),
        query(
          `SELECT id, direction, from_email, subject, body, received_at, notified_at
             FROM pitch_replies WHERE pitch_id = $1 ORDER BY received_at`,
          [req.params.id],
        ).catch((e) => (notPromoted(e) ? { rows: [] } : Promise.reject(e))),
      ]);
      const [pitch] = await withAvatars(rows, sign);
      res.json({ pitch, events: events.rows, replies: replies.rows });
    } catch (e) {
      if (notPromoted(e)) return res.status(404).json({ error: "Pitch isn't on this database yet." });
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/pitch/creators?view=all|sent|weekly&limit=&offset=&sortBy=&sortDir=&filter[col]=
  router.get("/creators", async (req, res) => {
    const { limit, offset } = pageOf(req.query);
    const view = Object.hasOwn(CREATOR_VIEWS, req.query.view) ? req.query.view : "all";
    const params = [];
    const conds = [CREATOR_VIEWS[view], ...filterConditions(parseColumnFilters(req.query), CREATOR_FILTERS, params)].filter(Boolean);
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const order = orderBySql(req.query, CREATOR_SORTS, "s.last_sent_at DESC NULLS LAST, COALESCE(pc.created, s.first_pitch_at) DESC NULLS LAST, u.id");
    const countParams = [...params];
    params.push(limit, offset);
    try {
      const [{ rows }, count, counts] = await Promise.all([
        query(`SELECT ${CREATOR_COLUMNS} ${CREATOR_FROM} ${where} ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`, params),
        query(`SELECT count(*)::int AS n ${CREATOR_FROM} ${where}`, countParams),
        // The three views' sizes, whatever is filtered, for the pills.
        query(`SELECT count(*)::int AS "all",
                      count(*) FILTER (WHERE ${CREATOR_VIEWS.sent})::int AS sent,
                      count(*) FILTER (WHERE ${CREATOR_VIEWS.weekly})::int AS weekly
                 ${CREATOR_FROM}`),
      ]);
      res.json({ available: true, view, items: await withAvatars(rows, sign), total: count.rows[0]?.n ?? 0, counts: counts.rows[0] || {} });
    } catch (e) {
      if (notPromoted(e)) return res.json({ available: false, view, items: [], total: 0 });
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/pitch/plans?limit=&offset=&sortBy=&sortDir=&filter[col]= —
  // one line per creator with a Pitch Pro or Founding plan, newest first.
  router.get("/plans", async (req, res) => {
    const { limit, offset } = pageOf(req.query);
    const params = [];
    const conds = filterConditions(parseColumnFilters(req.query), PLAN_FILTERS, params);
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const order = orderBySql(req.query, PLAN_SORTS, `${PLAN_STARTED} DESC, r.user_id`);
    const countParams = [...params];
    params.push(limit, offset);
    const stripe = stripeDashboard(req.dbTarget);
    try {
      const [{ rows }, count] = await Promise.all([
        query(`SELECT ${PLAN_COLUMNS} ${PLANS_FROM} ${where} ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`, params),
        query(`SELECT count(*)::int AS n ${PLANS_FROM} ${where}`, countParams),
      ]);
      res.json({ available: true, items: await withAvatars(rows, sign), total: count.rows[0]?.n ?? 0, stripe_dashboard: stripe });
    } catch (e) {
      if (notPromoted(e)) return res.json({ available: false, items: [], total: 0, stripe_dashboard: stripe });
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/pitch/plans/summary — how many creators are in each state, and
  // per currency what the plans paying now bill: monthly and yearly Pitch Pro
  // that renews, and Founding paid once. No conversion between currencies.
  router.get("/plans/summary", async (_req, res) => {
    try {
      const [states, money] = await Promise.all([
        query(`SELECT (${PLAN_STATE}) AS state, count(*)::int AS n ${PLANS_FROM} GROUP BY 1`),
        query(
          `SELECT lower(r.currency) AS currency,
                  count(*)::int AS paying,
                  count(*) FILTER (WHERE r.plan = 'pro' AND r.billing_interval <> 'year')::int AS monthly,
                  COALESCE(sum(r.amount_minor) FILTER (WHERE r.plan = 'pro' AND r.billing_interval <> 'year'), 0)::float8 AS monthly_minor,
                  count(*) FILTER (WHERE r.plan = 'pro' AND r.billing_interval = 'year')::int AS yearly,
                  COALESCE(sum(r.amount_minor) FILTER (WHERE r.plan = 'pro' AND r.billing_interval = 'year'), 0)::float8 AS yearly_minor,
                  count(*) FILTER (WHERE r.plan = 'founding')::int AS founding,
                  COALESCE(sum(r.amount_minor) FILTER (WHERE r.plan = 'founding'), 0)::float8 AS founding_minor
             ${PLANS_FROM}
            WHERE (${PLAN_STATE}) = 'paying'
            GROUP BY 1 ORDER BY 2 DESC, 1`,
        ),
      ]);
      const counts = Object.fromEntries(PLAN_STATES.map((s) => [s, 0]));
      for (const row of states.rows) counts[row.state] = row.n;
      const total = states.rows.reduce((a, row) => a + row.n, 0);
      res.json({ available: true, total, counts, currencies: money.rows });
    } catch (e) {
      if (notPromoted(e)) return res.json({ available: false });
      res.status(500).json({ error: e.message });
    }
  });

  // Weekly picks: Linkable writes this creator's pitches ahead every Monday
  // (service-grpc RunPitchWeek reads pitch_creators.enabled). Every creator
  // can pitch either way; this only decides whose are ready before they ask.
  // `approved` is left alone: with PITCH_OPEN_TO_ALL on, nothing reads it.
  async function setWeekly(res, userId, weekly, admin, dbTarget) {
    const { rows } = await query(
      `INSERT INTO pitch_creators (user_id, enabled) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET enabled = $2, updated = current_timestamp
       RETURNING user_id, enabled AS weekly`,
      [userId, weekly],
    );
    console.log(`[pitch-creator] weekly=${weekly} admin=${admin} db=${dbTarget} user=${userId}`);
    res.json({ creator: rows[0] });
  }
  const liveCreator = `SELECT u.id, u.email FROM users u
    WHERE u.deleted = 'infinity' AND EXISTS (SELECT 1 FROM influencers i WHERE i.user_id = u.id AND i.deleted = '-infinity')`;

  // PATCH /api/pitch/creators/:userId { weekly }
  router.patch("/creators/:userId", async (req, res) => {
    if (!isUuid(req.params.userId)) return res.status(404).json({ error: "That creator doesn't exist." });
    if (typeof req.body?.weekly !== "boolean") return res.status(400).json({ error: "Say whether weekly picks are on or off." });
    try {
      const found = await query(`${liveCreator} AND u.id = $1`, [req.params.userId]);
      if (!found.rows.length) return res.status(404).json({ error: "That creator doesn't exist any more." });
      await setWeekly(res, req.params.userId, req.body.weekly, req.admin?.email, req.dbTarget);
    } catch (e) {
      if (notPromoted(e)) return res.status(409).json({ error: "Pitch isn't on this database yet." });
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/pitch/creators { email } — switch weekly picks on for a
  // creator who has not opened Pitch yet (what `pitch_admin enable` did).
  router.post("/creators", async (req, res) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!EMAIL.test(email)) return res.status(400).json({ error: "Enter the creator's account email." });
    try {
      const found = await query(`${liveCreator} AND lower(u.email) = $1 ORDER BY u.created DESC LIMIT 1`, [email]);
      if (!found.rows.length) return res.status(404).json({ error: `No creator account uses ${email}.` });
      await setWeekly(res, found.rows[0].id, true, req.admin?.email, req.dbTarget);
    } catch (e) {
      if (notPromoted(e)) return res.status(409).json({ error: "Pitch isn't on this database yet." });
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
