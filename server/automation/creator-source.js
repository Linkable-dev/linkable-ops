// Creator-prospect source providers.
//
// The influencer outbound sync is intentionally pluggable: v1 reads the
// existing main-app `influencers` table via CloudSQL; v2 will likely add a
// scraper provider (Modash / HypeAuditor / Storyclash) that emits the same
// shape. Each provider returns rows ready for upsert into `creator_prospects`
// — no provider-specific shape leaks into sync-creators.js.
//
// Provider contract:
//   async fetch({ limit, offset, sinceTs }) → { rows: Provider Row[], hasMore: bool }
//
// Provider Row shape (everything except source/source_id is optional):
//   {
//     source: string,              // e.g. 'main_app'
//     source_id: string,           // unique within source
//     email, first_name, last_name,
//     instagram_username, instagram_name,
//     followers_count, engagement_rate,
//     profile_pic_name,
//     niche, country, city,
//     raw_data: object             // full provider payload for re-derivation
//   }

import { cloudSqlQuery } from "../lib/cloudsql.js";

// Mirror the main-app role + active sentinels (see admin-users.js for the
// canonical version). ROLE_INFLUENCER=3 from linkable-new/backend/models/enums.py.
const ROLE_INFLUENCER = 3;
const USER_ACTIVE = `'infinity'::timestamptz`;
const ENTITY_ACTIVE = `'-infinity'::timestamptz`;

// ---------- Main-app provider (v1 source) ----------
//
// Pulls active creators from main-app `influencers` joined to `users`.
// Filters out:
//   - missing email (can't send to)
//   - missing first_name (can't render greeting safely)
// We don't filter by follower count here — the scoring pass owns the floor,
// so the operator can re-tune without re-running the sync.
//
// `target` selects which main-app DB to read ("prod" or "dev") via
// CloudSQL's AsyncLocalStorage pin. Defaults to "prod" since influencer
// outbound sends real email — dev DB rows would be junk.
export function mainAppProvider({ target = "prod" } = {}) {
  return {
    name: "main_app",

    async fetch({ limit = 500, offset = 0, sinceTs = null } = {}) {
      const params = [Number(limit) || 500, Number(offset) || 0];
      let where = `u.role = ${ROLE_INFLUENCER}
                   AND u.deleted = ${USER_ACTIVE}
                   AND i.deleted = ${ENTITY_ACTIVE}
                   AND u.email IS NOT NULL
                   AND i.first_name IS NOT NULL`;
      if (sinceTs) {
        // Incremental: only rows created or last modified after the cursor.
        // main-app `users.created` is the registration timestamp; we don't
        // get an updated_at on influencers, so this is best-effort newer-only.
        params.push(new Date(sinceTs).toISOString());
        where += ` AND u.created > $${params.length}`;
      }

      const { rows } = await cloudSqlQuery(
        `SELECT u.id::text             AS user_id,
                u.email,
                u.created              AS user_created,
                i.first_name,
                i.last_name,
                i.instagram_username,
                i.instagram_name,
                i.instagram_followers_count,
                i.instagram_engagement_rate,
                i.profile_pic_name,
                i.niche,
                i.location_country,
                i.location_city
           FROM users u
           JOIN influencers i ON i.user_id = u.id
          WHERE ${where}
          ORDER BY u.created DESC
          LIMIT $1 OFFSET $2`,
        params,
        target,
      );

      const mapped = rows.map((r) => ({
        source: "main_app",
        source_id: r.user_id,
        email: (r.email || "").trim().toLowerCase() || null,
        first_name: r.first_name || null,
        last_name: r.last_name || null,
        instagram_username: r.instagram_username || null,
        instagram_name: r.instagram_name || null,
        followers_count: Number.isFinite(Number(r.instagram_followers_count))
          ? Number(r.instagram_followers_count)
          : null,
        engagement_rate: Number.isFinite(Number(r.instagram_engagement_rate))
          ? Number(r.instagram_engagement_rate)
          : null,
        profile_pic_name: r.profile_pic_name || null,
        niche: r.niche || null,
        country: r.location_country || null,
        city: r.location_city || null,
        raw_data: {
          user_created: r.user_created,
          provider: "main_app",
          target,
        },
      }));

      return { rows: mapped, hasMore: rows.length === Number(limit) };
    },
  };
}

// ---------- Future: scraper provider stub ----------
//
// Stubbed signature so the sync layer is forward-compatible. Implement when
// the first external source (e.g. Modash) is wired up; until then it throws
// clearly so a misconfigured `--source modash` fails fast rather than silently
// returning zero rows.
export function scraperProvider({ name = "scraper" } = {}) {
  return {
    name,
    async fetch() {
      throw new Error(`scraper provider '${name}' not implemented yet`);
    },
  };
}

// ---------- Provider registry ----------
export function getProvider(name, opts = {}) {
  switch ((name || "main_app").toLowerCase()) {
    case "main_app":
      return mainAppProvider(opts);
    case "scraper":
      return scraperProvider(opts);
    default:
      throw new Error(`unknown creator source provider: ${name}`);
  }
}
