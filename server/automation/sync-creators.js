// Sync creators from a source provider into creator_prospects.
//
// CLI:
//   node server/automation/sync-creators.js                                    # default: main_app, prod, batch=500
//   node server/automation/sync-creators.js --source main_app --target prod --limit 1000
//   node server/automation/sync-creators.js --since 2025-01-01
//
// Bio-mining (Brave Search → Linktree/Beacons):
//   node server/automation/sync-creators.js --source bio_mining \
//        --niche "beauty creator" --niche "fashion blogger" --limit 100
//   node server/automation/sync-creators.js --source bio_mining \
//        --niche "wellness coach" --site-pattern linktr.ee --site-pattern beacons.ai \
//        --search-pages 2 --limit 200
//   ENV: BRAVE_SEARCH_API_KEY (required for the bio_mining source)
//
// Behaviour:
//   - Pages through the provider until exhausted (or --limit N reached).
//   - Upserts on (team_id, source, source_id) so re-running is idempotent.
//   - Re-scores every row via creator-scoring on each sync — cheap and lets
//     us tune the scoring weights without a separate backfill pass.
//   - Stamps last_synced_at; existing imported_at is preserved on update.
//
// Returns { fetched, inserted, updated, scored, skipped, errors }.

import { supabase } from "../lib/supabase.js";
import { getProvider } from "./creator-source.js";
import { scoreCreator } from "./creator-scoring.js";
import { closeCloudSql } from "../lib/cloudsql.js";

const TEAM_ID = process.env.TEAM_ID || "a0000000-0000-0000-0000-000000000001";

function parseArgs() {
  const args = {
    source: "main_app",
    target: "prod",
    pageSize: 500,
    limit: null,                 // hard cap on rows fetched (across pages)
    since: null,                 // ISO timestamp; provider may use as cursor
    dryRun: false,

    // bio_mining-only knobs. niches and sitePatterns are repeatable so the
    // operator can `--niche A --niche B --site-pattern linktr.ee`.
    niches: [],
    sitePatterns: [],
    searchBackend: "brave",
    searchPages: 1,
  };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--source") args.source = process.argv[++i];
    else if (a === "--target") args.target = process.argv[++i];
    else if (a === "--page-size") args.pageSize = Number(process.argv[++i]);
    else if (a === "--limit") args.limit = Number(process.argv[++i]);
    else if (a === "--since") args.since = process.argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--niche") args.niches.push(process.argv[++i]);
    else if (a === "--site-pattern") args.sitePatterns.push(process.argv[++i]);
    else if (a === "--search-backend") args.searchBackend = process.argv[++i];
    else if (a === "--search-pages") args.searchPages = Number(process.argv[++i]);
  }
  return args;
}

export async function syncCreators({
  teamId = TEAM_ID,
  source = "main_app",
  target = "prod",
  pageSize = 500,
  limit = null,
  sinceTs = null,
  dryRun = false,
  // bio_mining options — ignored by other providers
  niches = [],
  sitePatterns = [],
  searchBackend = "brave",
  searchPages = 1,
  log = console.log,
} = {}) {
  const providerOpts = source === "bio_mining"
    ? {
        niches,
        ...(sitePatterns.length ? { sitePatterns } : {}),
        searchBackend,
        pages: searchPages,
        log,
      }
    : { target };
  const provider = getProvider(source, providerOpts);

  const stats = {
    fetched: 0,
    inserted: 0,
    updated: 0,
    scored: 0,
    skipped: 0,
    errors: 0,
  };

  let offset = 0;
  while (true) {
    const remaining = limit ? limit - stats.fetched : Infinity;
    if (remaining <= 0) break;

    const fetchSize = Math.min(pageSize, remaining);
    let page;
    try {
      page = await provider.fetch({ limit: fetchSize, offset, sinceTs });
    } catch (err) {
      log(`[sync-creators] provider fetch failed at offset=${offset}: ${err.message}`);
      stats.errors++;
      break;
    }

    const rows = page.rows || [];
    stats.fetched += rows.length;
    log(`[sync-creators] page offset=${offset} rows=${rows.length} hasMore=${page.hasMore}`);
    if (rows.length === 0) break;

    if (!dryRun) {
      const result = await upsertBatch(teamId, rows);
      stats.inserted += result.inserted;
      stats.updated += result.updated;
      stats.scored += result.scored;
      stats.skipped += result.skipped;
      stats.errors += result.errors;
    }

    if (!page.hasMore) break;
    offset += rows.length;
  }

  log(`[sync-creators] DONE — ${JSON.stringify(stats)}`);
  return stats;
}

// Upsert one batch of provider rows into creator_prospects. Re-scores on
// every upsert so the orchestrator's score gate reflects current weights.
//
// Strategy: do the upsert in one query via Supabase's `.upsert()` with the
// (team_id, source, source_id) conflict target so we don't pay a per-row
// SELECT to decide insert vs update. last_synced_at is bumped on every
// touch; imported_at is preserved by leaving it out of the update set
// (the DB default only fires on insert).
async function upsertBatch(teamId, rows) {
  const stats = { inserted: 0, updated: 0, scored: 0, skipped: 0, errors: 0 };
  if (rows.length === 0) return stats;

  // Score every row first — cheap, in-process.
  const scored = rows.map((r) => {
    if (!r.email) {
      stats.skipped++;
      return null;
    }
    const { score, breakdown } = scoreCreator(r);
    stats.scored++;
    return {
      team_id: teamId,
      source: r.source,
      source_id: r.source_id,
      email: r.email,
      first_name: r.first_name,
      last_name: r.last_name,
      instagram_username: r.instagram_username,
      instagram_name: r.instagram_name,
      followers_count: r.followers_count,
      engagement_rate: r.engagement_rate,
      profile_pic_name: r.profile_pic_name,
      niche: r.niche,
      country: r.country,
      city: r.city,
      raw_data: r.raw_data || {},
      creator_score: score,
      creator_score_breakdown: breakdown,
      scored_at: new Date().toISOString(),
      last_synced_at: new Date().toISOString(),
      // contact_used / emailed / emailed_at intentionally omitted — we never
      // overwrite lifecycle flags on resync. DB defaults apply on insert;
      // existing rows keep whatever the orchestrator set.
    };
  }).filter(Boolean);

  if (scored.length === 0) return stats;

  // Pre-count existing rows so we can split the upsert result into inserted
  // vs updated. The insert-via-upsert returns the row regardless of which
  // side fired, so we infer from existence.
  const sourceIds = scored.map((r) => r.source_id);
  const { data: existing } = await supabase
    .from("creator_prospects")
    .select("source_id")
    .eq("team_id", teamId)
    .in("source_id", sourceIds);
  const existingSet = new Set((existing || []).map((r) => r.source_id));

  const { data, error } = await supabase
    .from("creator_prospects")
    .upsert(scored, { onConflict: "team_id,source,source_id", ignoreDuplicates: false })
    .select("source_id");

  if (error) {
    console.error("[sync-creators] upsert failed:", error.message);
    stats.errors += scored.length;
    return stats;
  }

  for (const r of data || []) {
    if (existingSet.has(r.source_id)) stats.updated++;
    else stats.inserted++;
  }
  return stats;
}

// ---------- CLI ----------

async function main() {
  const args = parseArgs();
  try {
    await syncCreators({
      source: args.source,
      target: args.target,
      pageSize: args.pageSize,
      limit: args.limit,
      sinceTs: args.since,
      dryRun: args.dryRun,
      niches: args.niches,
      sitePatterns: args.sitePatterns,
      searchBackend: args.searchBackend,
      searchPages: args.searchPages,
    });
  } finally {
    // Close the CloudSQL pg pool so the process can exit. Without this,
    // the open pool keeps the event loop alive and the CLI hangs forever
    // after the DONE log line. Safe to call when CloudSQL was never used
    // (bio_mining run): closeCloudSql is a no-op on uninitialised pools.
    await closeCloudSql().catch(() => {});
  }
}

import { fileURLToPath } from "url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
