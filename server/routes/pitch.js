import { Router } from "express";
import { cloudSqlQuery } from "../lib/cloudsql.js";
import { signedUrls } from "../lib/gcs.js";
import {
  parseColumnFilters, filterConditions, orderBySql,
  textFilter, numberFilter, dateFilter, enumFilter, boolFilter,
} from "../lib/tableQuery.js";

// Pitch, read from ops: every pitch creators sent, who sent it, to whom, and
// what came of it; the creators who pitch; the switch that has Linkable write
// a creator's pitches ahead every Monday. The brands are in pitch-brands.js.
//
// Read-only on pitches by design. Nothing here opens the brand's proposal
// link (/p/<token>): service-grpc counts any browser visit there as the brand
// viewing it, moves the pitch to "viewed" and emails the creator. The detail
// shows what the proposal says instead.
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
           profile_pic_name, instagram_profile_image, about
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

const STATUSES = ["ready", "scheduled", "sent", "viewed", "accepted", "changes_requested", "declined", "expired", "skipped"];
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

// Creators: everyone with a pitch, and everyone switched into weekly picks.
const CREATOR_FROM = `
  FROM (SELECT user_id FROM pitch_creators
        UNION SELECT creator_user_id FROM pitches WHERE deleted = '-infinity') c
  JOIN users u ON u.id = c.user_id AND u.deleted = 'infinity'
  LEFT JOIN pitch_creators pc ON pc.user_id = u.id
  ${INFLUENCER("u.id")}
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE p.status = 'ready')::int AS drafts,
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
};
const CREATOR_FILTERS = {
  name: textFilter(CREATOR_NAME, "u.email", "i.instagram_username"),
  weekly: boolFilter("pc.enabled"),
  sent: numberFilter("COALESCE(s.sent, 0)"),
  last_sent: dateFilter("s.last_sent_at"),
};

// Since when the summary counts: a number of days, or everything.
function sinceDays(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 && n <= 3650 ? n : null;
}
const pageOf = (q, def = 25) => ({
  limit: Math.min(Math.max(parseInt(q.limit) || def, 1), 100),
  offset: Math.max(parseInt(q.offset) || 0, 0),
});

export function pitchRoutes({ query = cloudSqlQuery, sign = signedUrls } = {}) {
  const router = Router();

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
    const order = orderBySql(req.query, CREATOR_SORTS, "s.last_sent_at DESC NULLS LAST, s.first_pitch_at DESC NULLS LAST, u.id");
    const countParams = [...params];
    params.push(limit, offset);
    try {
      const [{ rows }, count] = await Promise.all([
        query(`SELECT ${CREATOR_COLUMNS} ${CREATOR_FROM} ${where} ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`, params),
        query(`SELECT count(*)::int AS n ${CREATOR_FROM} ${where}`, countParams),
      ]);
      res.json({ available: true, view, items: await withAvatars(rows, sign), total: count.rows[0]?.n ?? 0 });
    } catch (e) {
      if (notPromoted(e)) return res.json({ available: false, view, items: [], total: 0 });
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
