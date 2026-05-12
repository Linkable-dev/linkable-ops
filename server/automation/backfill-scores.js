#!/usr/bin/env node
// One-time backfill: scores every existing row in storeleads_brands using
// the same scoreBrand() function the ingestion path uses.
//
// Run after migration 010 has been applied:
//
//   node server/automation/backfill-scores.js                    # all teams, batches of 1000
//   node server/automation/backfill-scores.js --team <uuid>      # single team
//   node server/automation/backfill-scores.js --dry-run          # print distribution, don't write
//   node server/automation/backfill-scores.js --rescore-all      # ignore scored_at, rewrite every row
//
// Default behavior: only rows where scored_at IS NULL (new or never-scored).
// Re-running after schema/weight changes: pass --rescore-all.

import { supabase } from "../lib/supabase.js";
import { scoreBrand } from "./brand-scoring.js";

// raw_data JSONB blobs run 20–80KB each — a batch of 1000 rows pushes 30–60MB
// over the wire and routinely trips Supabase's 8s statement timeout. 200 keeps
// each fetch under ~10MB which lands in <3s on a healthy connection.
const BATCH_SIZE = 200;

function parseArgs() {
  const args = { teamId: null, dryRun: false, rescoreAll: false };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--team") args.teamId = process.argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--rescore-all") args.rescoreAll = true;
  }
  return args;
}

async function countRows({ teamId, rescoreAll }) {
  let q = supabase.from("storeleads_brands").select("id", { count: "exact", head: true });
  if (teamId) q = q.eq("team_id", teamId);
  if (!rescoreAll) q = q.is("scored_at", null);
  const { count, error } = await q;
  if (error) throw new Error(`count: ${error.message}`);
  return count || 0;
}

async function fetchBatch({ teamId, rescoreAll, cursor }) {
  let q = supabase
    .from("storeleads_brands")
    .select("id, email, contact_first_name, title, description, about_us, contact_page, last_updated_at, raw_data")
    .order("id", { ascending: true })
    .limit(BATCH_SIZE);
  if (teamId) q = q.eq("team_id", teamId);
  if (!rescoreAll) q = q.is("scored_at", null);
  if (cursor) q = q.gt("id", cursor);
  const { data, error } = await q;
  if (error) throw new Error(`fetchBatch: ${error.message}`);
  return data || [];
}

async function writeBatch(rows) {
  // Score writes are independent — fire them as parallel updates. Supabase
  // pg-pool absorbs ~50 in-flight, so cap the in-flight count via slices.
  const PARALLEL = 20;
  for (let i = 0; i < rows.length; i += PARALLEL) {
    const slice = rows.slice(i, i + PARALLEL);
    await Promise.all(slice.map((r) => {
      const { score, breakdown } = scoreBrand(r);
      return supabase
        .from("storeleads_brands")
        .update({
          brand_score: score,
          brand_score_breakdown: breakdown,
          scored_at: new Date().toISOString(),
        })
        .eq("id", r.id);
    }));
  }
}

function logDistribution(buckets) {
  const total = Object.values(buckets).reduce((a, b) => a + b, 0) || 1;
  console.log("Score distribution:");
  for (let s = 10; s >= 0; s--) {
    const n = buckets[s] || 0;
    const pct = ((n / total) * 100).toFixed(1);
    const bar = "█".repeat(Math.round((n / total) * 40));
    console.log(`  ${String(s).padStart(2)} | ${bar.padEnd(40)} ${String(n).padStart(6)} (${pct}%)`);
  }
  const sendable = Object.entries(buckets)
    .filter(([s]) => Number(s) >= 7)
    .reduce((a, [, n]) => a + n, 0);
  console.log(`  Sendable (score >= 7): ${sendable} / ${total} (${((sendable / total) * 100).toFixed(1)}%)`);
}

async function main() {
  const args = parseArgs();
  const total = await countRows(args);
  console.log(`Found ${total} rows to ${args.dryRun ? "score (dry-run)" : "score"}${args.rescoreAll ? " [rescore-all]" : ""}${args.teamId ? ` for team ${args.teamId}` : ""}`);
  if (total === 0) return;

  const buckets = {};
  let processed = 0;
  let cursor = null;

  while (processed < total) {
    const batch = await fetchBatch({ ...args, cursor });
    if (batch.length === 0) break;

    if (args.dryRun) {
      for (const r of batch) {
        const { score } = scoreBrand(r);
        buckets[score] = (buckets[score] || 0) + 1;
      }
    } else {
      for (const r of batch) {
        const { score } = scoreBrand(r);
        buckets[score] = (buckets[score] || 0) + 1;
      }
      await writeBatch(batch);
    }

    processed += batch.length;
    cursor = batch[batch.length - 1].id;
    console.log(`  ${processed}/${total} (${((processed / total) * 100).toFixed(1)}%)`);
  }

  logDistribution(buckets);
  if (args.dryRun) console.log("(dry run — no rows updated)");
}

main().catch((err) => {
  console.error("backfill-scores failed:", err);
  process.exit(1);
});
