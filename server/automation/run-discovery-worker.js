#!/usr/bin/env node
// Discovery worker — drains the ai_bulk_runs queue.
//
// Each invocation pulls the oldest 'pending' row, flips it to 'running',
// processes it to completion, then exits. Designed to be invoked on a
// schedule (cron, GitHub Action, or a scheduled Claude Code agent).
//
//   node server/automation/run-discovery-worker.js          # one job
//   node server/automation/run-discovery-worker.js --drain  # loop until empty
//
// Required env: STORELEADS_KEY, APOLLO_API_KEY, HUNTER_API_KEY,
//               SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { processOnePendingRun } from "./lead-discovery.js";

const drain = process.argv.includes("--drain");

async function runOne() {
  const final = await processOnePendingRun();
  if (!final) {
    console.log("No pending discovery runs.");
    return false;
  }
  console.log(`Run ${final.id} → ${final.status}` +
    ` (processed ${final.processed}, qualified ${final.sent}, skipped ${final.skipped}, failed ${final.failed})` +
    (final.error ? ` — ${final.error}` : ""));
  return true;
}

let did = false;
do {
  did = await runOne();
} while (drain && did);

process.exit(0);
