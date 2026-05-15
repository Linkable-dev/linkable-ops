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
import { getSearchBackend } from "./creator-search.js";
import { extractBioRecord } from "./creator-bio-extract.js";

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

// ---------- Bio-mining provider (Linktree / Beacons / similar) ----------
//
// Discovers creators by searching the open web for public bio pages in
// the operator's target niches, fetches each page, and extracts the only
// signals we need to cold-email them: contact email + IG handle + display
// name. No platform API access; no headless browser.
//
// Flow per fetch():
//   1. For each niche × site pattern (linktr.ee, beacons.ai, …) build a
//      `site:<pattern> <niche>` query and ask the search backend.
//   2. Sleep ~1.1s between queries so we stay inside Brave's 1 q/s free-tier
//      rate limit. Search-side concurrency would buy little vs the fetch
//      pass anyway.
//   3. For each unique result URL, fetch + extract. Drop rows with no
//      usable email — there's no point inserting prospects we can't mail.
//
// Each provider row carries `source: 'bio_mining'` and `source_id: <url>`.
// Re-runs upsert on `(team_id, source, source_id)` so the same Linktree
// URL only ever produces one creator_prospects row regardless of which
// niche search surfaced it (or how many times we've re-scraped).
//
// Followers / engagement remain null — the scoring path branches on
// `source` (see creator-scoring.js scoreBioMinedCreator) so these rows
// can still clear the MIN_SEND_SCORE gate when basic data is present.

const DEFAULT_SITE_PATTERNS = ["linktr.ee", "beacons.ai", "bio.link", "lnk.bio"];
const SEARCH_PAGE_COUNT = 20;          // Brave caps at 20 / page
const SEARCH_SLEEP_MS = 1100;          // Brave free tier: 1 q/s, +10% margin
const FETCH_SLEEP_MS = 250;            // be polite to bio hosts on the fetch pass
const FETCH_CONCURRENCY = 4;           // small concurrency on the fetch pass

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function processWithConcurrency(items, limit, worker) {
  const results = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const myIdx = i++;
        results[myIdx] = await worker(items[myIdx], myIdx);
      }
    }),
  );
  return results;
}

export function bioMiningProvider({
  niches = [],
  sitePatterns = DEFAULT_SITE_PATTERNS,
  searchBackend = "brave",
  searchOpts = {},
  // Maximum search-result pages per (niche, site) combo. count=20 per page;
  // pages=1 → up to 20 candidate URLs per combo. Operators tune this with
  // --search-pages on the CLI.
  pages = 1,
  log = console.log,
} = {}) {
  if (!Array.isArray(niches) || niches.length === 0) {
    throw new Error("bio_mining provider requires at least one --niche");
  }
  const backend = getSearchBackend(searchBackend, searchOpts);
  if (!backend.available) {
    throw new Error(
      `search backend '${searchBackend}' is not configured (missing API key?). ` +
      `Set BRAVE_SEARCH_API_KEY or pass a different --search-backend.`
    );
  }

  return {
    name: "bio_mining",

    async fetch({ limit = 200 } = {}) {
      // 1. Discover URLs via search. Track the niche we used so the
      //    scraped record can record it without keyword-matching the bio body.
      const seen = new Set();
      const candidates = [];     // [{ url, niche }]
      outer: for (const niche of niches) {
        for (const sitePattern of sitePatterns) {
          for (let p = 0; p < pages; p++) {
            const query = `site:${sitePattern} ${niche}`;
            let page;
            try {
              page = await backend.search(query, { count: SEARCH_PAGE_COUNT, offset: p });
            } catch (err) {
              log(`[bio_mining] search failed for "${query}" (offset=${p}): ${err.message}`);
              break;     // next site pattern; don't keep hammering on a 4xx
            }
            log(`[bio_mining] search "${query}" offset=${p} → ${page.results.length} results`);
            for (const r of page.results) {
              if (!r.url || seen.has(r.url)) continue;
              seen.add(r.url);
              candidates.push({ url: r.url, niche });
              if (candidates.length >= limit) break outer;
            }
            if (!page.hasMore) break;
            await sleep(SEARCH_SLEEP_MS);
          }
        }
      }
      log(`[bio_mining] candidate URLs after search: ${candidates.length}`);

      // 2. Fetch + extract. Drop pages with no usable email; map the rest
      //    into the canonical Provider Row shape.
      let dropped = 0, errored = 0;
      const rows = [];
      const extracted = await processWithConcurrency(candidates, FETCH_CONCURRENCY, async (c) => {
        await sleep(FETCH_SLEEP_MS);
        try {
          return await extractBioRecord(c.url, { niche: c.niche });
        } catch (err) {
          return { ok: false, url: c.url, reason: `exception: ${err.message}` };
        }
      });

      for (const ex of extracted) {
        if (!ex || !ex.ok) {
          if (ex && ex.reason && ex.reason.startsWith("fetch_failed")) errored++;
          else dropped++;
          continue;
        }
        rows.push({
          source: "bio_mining",
          source_id: ex.url,                     // unique per bio page
          email: ex.email,
          first_name: ex.first_name,
          last_name: null,
          instagram_username: ex.instagram_username,
          instagram_name: ex.instagram_name,
          followers_count: null,                 // bio pages don't expose it
          engagement_rate: null,
          profile_pic_name: null,
          niche: ex.niche,
          country: null,
          city: null,
          raw_data: {
            provider: "bio_mining",
            search_backend: backend.name,
            site_patterns: sitePatterns,
            source_url: ex.url,
            bio_text: ex.bio_text,
          },
        });
      }
      log(`[bio_mining] usable rows: ${rows.length} (dropped: ${dropped}, fetch errors: ${errored})`);

      // No real pagination — caller controls volume via --limit on the
      // top-level sync (which caps `candidates.length` above). hasMore is
      // always false because re-running this provider would repeat the
      // same search queries; idempotency comes from the upsert key.
      return { rows, hasMore: false };
    },
  };
}

// ---------- Provider registry ----------
export function getProvider(name, opts = {}) {
  switch ((name || "main_app").toLowerCase()) {
    case "main_app":
      return mainAppProvider(opts);
    case "bio_mining":
      return bioMiningProvider(opts);
    default:
      throw new Error(`unknown creator source provider: ${name}`);
  }
}
