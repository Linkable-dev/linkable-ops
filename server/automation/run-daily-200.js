// Daily-200 outbound orchestrator.
// One run = one pass through (drain due touches → enroll new prospects →
// send everything due up to the daily cap).
//
// Cron this once per business morning. Re-running on the same day is safe —
// the sequencer's enrollment guard (already-enrolled email check) and the
// daily cap query (today's `sent_at`) make this idempotent.
//
// Usage:
//   node server/automation/run-daily-200.js [--cap 200] [--dry-run]

// supabase.js loads .env from server/.env when SUPABASE_URL is unset, so importing
// it first guarantees the rest of process.env is populated for downstream callers.
import { supabase } from "../lib/supabase.js";
import { delaySend } from "./send.js";
import {
  enrollProspect,
  fetchDueRows,
  sendDueRow,
  resolveActiveCampaign,
  loadTemplateBucketsForCampaign,
} from "./sequencer.js";
import { classifyBrand, allocateDailyQuota, GROUPS } from "./brand-groups.js";

const TEAM_ID = process.env.TEAM_ID || "a0000000-0000-0000-0000-000000000001";
const DEFAULT_CAP = 200;

function parseArgs() {
  const args = { cap: null, dryRun: false, campaignId: null };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--cap") args.cap = Number(process.argv[++i]);
    else if (a === "--campaign") args.campaignId = process.argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
  }
  return args;
}

// How many emails has this team already sent today? Used to enforce the
// daily cap across multiple invocations (re-runs, retries).
async function todaySentCount(teamId) {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { count, error } = await supabase
    .from("email_sends")
    .select("id", { count: "exact", head: true })
    .eq("team_id", teamId)
    .eq("status", "sent")
    .gte("sent_at", startOfDay.toISOString());
  if (error) throw new Error(`todaySentCount: ${error.message}`);
  return count || 0;
}

// Pick fresh prospects from storeleads_brands and split them into G1/G2/G3
// buckets so the orchestrator can hit the 60/25/15 daily mix.
async function fetchFreshProspectsByGroup({ teamId, perGroupQuota }) {
  const totalNeeded = perGroupQuota.G1 + perGroupQuota.G2 + perGroupQuota.G3;
  // Pull a bigger pool so we have enough of each group after classification.
  const fetchSize = Math.max(totalNeeded * 5, 100);

  const { data, error } = await supabase
    .from("storeleads_brands")
    .select("*")
    .eq("team_id", teamId)
    .eq("contact_used", false)
    .not("email", "is", null)
    .not("contact_first_name", "is", null)
    .order("imported_at", { ascending: false })
    .limit(fetchSize);

  if (error) throw new Error(`fetchFreshProspects: ${error.message}`);

  const buckets = { G1: [], G2: [], G3: [] };
  for (const row of data || []) {
    // Adapt storeleads_brands row → classifier input shape.
    const brand = {
      storeName: row.merchant_name || row.title || row.domain,
      name: row.merchant_name,
      merchant_name: row.merchant_name,
      title: row.title,
      description: row.description,
      domain: row.domain,
      country: row.country_code,
      about_us: row.about_us,
      brandInfo: {
        brandStory: row.description || row.about_us,
      },
      // No matchedKeywords/sampleTypes from storeleads — classifier falls back to text scan.
      matchedKeywords: [],
      sampleTypes: [],
    };
    const grp = classifyBrand(brand);
    if (buckets[grp].length < perGroupQuota[grp]) {
      buckets[grp].push({ row, brand, group: grp });
    }
    if (
      buckets.G1.length >= perGroupQuota.G1 &&
      buckets.G2.length >= perGroupQuota.G2 &&
      buckets.G3.length >= perGroupQuota.G3
    ) break;
  }
  return buckets;
}

// Mark this storeleads row as consumed so we don't re-pick it on the next run.
async function markStoreleadsUsed(rowId) {
  await supabase.from("storeleads_brands").update({ contact_used: true }).eq("id", rowId);
}

// Resolve the campaign for this run. Either the explicitly-passed --campaign
// or the most recently-created active 'daily-200' campaign. Throws when none
// exists — we want explicit campaign creation through the UI now, not
// implicit one-per-day rows.
async function resolveCampaign(teamId, explicitId) {
  const c = await resolveActiveCampaign(teamId, explicitId);
  if (!c) {
    throw new Error(
      "No active daily-200 campaign found. Create one via the AI Outbound Campaigns page first, " +
      "or pass --campaign <uuid> to use a specific campaign."
    );
  }
  if (c.status === "paused") {
    throw new Error(`Campaign ${c.name} is paused. Resume it from the UI to run.`);
  }
  if (c.status === "archived") {
    throw new Error(`Campaign ${c.name} is archived.`);
  }
  return c;
}

// ---------- CALLABLE FROM CRON ROUTE ----------

// Same logic as the CLI main(), but takes options + returns a structured
// result instead of console.log-only. The cron route at /api/cron/run-daily-outbound
// calls this; the CLI wraps it with arg parsing + stdout printing.
//
// Important: Vercel serverless functions have hard timeouts (10s Hobby,
// up to 300s Pro). With 1.5s rate-limit per send, ~30 sends fits a 60s
// function. Pass `cap: 30` from the cron and run it hourly to spread load.
export async function runDailyOutbound({
  teamId = TEAM_ID,
  campaignId: explicitCampaignId = null,
  cap: capOverride = null,
  dryRun = false,
  log = console.log,
} = {}) {
  const resendApiKey = process.env.RESEND_API_KEY;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!resendApiKey && !dryRun) throw new Error("RESEND_API_KEY not set");

  const campaign = await resolveCampaign(teamId, explicitCampaignId);
  const dailyCap = campaign.daily_cap ?? DEFAULT_CAP;
  const perRunCap = capOverride ?? dailyCap;   // cap-per-invocation; daily total enforced separately

  log(`[daily-200] campaign=${campaign.name} (${campaign.id}) perRunCap=${perRunCap} dailyCap=${dailyCap} dryRun=${dryRun}`);

  const sentToday = await todaySentCount(teamId);
  const dailyRemaining = Math.max(0, dailyCap - sentToday);
  const remaining = Math.min(perRunCap, dailyRemaining);
  log(`[daily-200] sent today: ${sentToday}/${dailyCap}; daily remaining: ${dailyRemaining}; this-run cap: ${remaining}`);

  if (remaining === 0) {
    log("[daily-200] daily cap reached or per-run cap=0; exiting");
    return { campaign_id: campaign.id, sent: 0, failed: 0, cancelled: 0, reason: "cap-reached" };
  }

  const campaignId = campaign.id;
  const senderFrom = campaign.sender_from;
  const replyTo = campaign.reply_to;
  const templateBuckets = await loadTemplateBucketsForCampaign(teamId, campaignId);

  // ---------- 1. Drain due rows from prior enrollments (T+3, T+7) ----------
  const dueRows = await fetchDueRows({ teamId, limit: remaining });
  log(`[daily-200] due rows from prior enrollments: ${dueRows.length}`);

  let sent = 0, failed = 0, cancelled = 0;
  for (const row of dueRows) {
    if (sent + failed >= remaining) break;
    if (dryRun) {
      log(`  DRY: would send seq=${row.sequence_id} touch=${row.touch_number} to=${row.to_email} variant=${row.template_variant}`);
      continue;
    }
    const result = await sendDueRow(row, { resendApiKey, senderFrom, replyTo });
    if (result.cancelled) cancelled++;
    else if (result.sent) sent++;
    else failed++;
    log(`  [drain] ${row.template_variant} → ${row.to_email}: ${result.sent ? "OK" : result.cancelled ? "cancelled" : "FAIL"} ${result.error || ""}`);
    await delaySend();
  }

  // ---------- 2. Enroll fresh prospects into the daily mix ----------
  const slotsLeft = remaining - sent;
  // Slots-left is the *send* budget. Enrolling N fresh prospects only adds
  // N T+1 sends today (T+3/T+7 will be on future days), so we can enroll up
  // to slotsLeft new prospects.
  if (slotsLeft <= 0) {
    log("[daily-200] cap hit during drain phase, no fresh enrollment");
  } else {
    const quota = allocateDailyQuota(slotsLeft);
    log(`[daily-200] enrolling fresh: ${JSON.stringify(quota)}`);

    const buckets = await fetchFreshProspectsByGroup({ teamId, perGroupQuota: quota });
    log(`[daily-200] available pool: G1=${buckets.G1.length} G2=${buckets.G2.length} G3=${buckets.G3.length}`);

    // Round-robin across groups so the day's sends aren't 120 G2 emails in a
    // row from one IP — better deliverability spread.
    const interleaved = interleave([buckets.G2, buckets.G1, buckets.G3]);

    for (const { row, brand, group } of interleaved) {
      if (sent + failed >= remaining) break;

      if (dryRun) {
        log(`  DRY: would enroll ${group} ${row.email} (${row.merchant_name})`);
        continue;
      }

      const enroll = await enrollProspect({
        teamId,
        campaignId,
        contactId: null,
        toEmail: row.email,
        toName: [row.contact_first_name, row.contact_last_name].filter(Boolean).join(" ") || null,
        brand,
        apiKey: anthropicApiKey,
        group,
        templateBuckets,
      });

      if (enroll.skipped) {
        log(`  [enroll skip] ${row.email}: ${enroll.skipped}`);
        await markStoreleadsUsed(row.id);
        continue;
      }

      const t1 = enroll.touches.find((t) => t.touch_number === 1);
      if (!t1) {
        log(`  [enroll warn] no T1 row for ${row.email}`);
        continue;
      }
      const { data: t1Row } = await supabase
        .from("email_sends").select("*").eq("id", t1.id).single();
      if (!t1Row) continue;

      const result = await sendDueRow(t1Row, { resendApiKey, senderFrom, replyTo });
      if (result.cancelled) cancelled++;
      else if (result.sent) sent++;
      else failed++;
      log(`  [enroll T1] ${group} → ${row.email}: ${result.sent ? "OK" : result.cancelled ? "cancelled" : "FAIL"} ${result.error || ""}`);

      await markStoreleadsUsed(row.id);
      await delaySend();
    }
  }

  log(`[daily-200] DONE — sent=${sent} failed=${failed} cancelled=${cancelled}`);
  return { campaign_id: campaign.id, sent, failed, cancelled };
}

// ---------- CLI WRAPPER ----------

async function main() {
  const { cap, dryRun, campaignId } = parseArgs();
  await runDailyOutbound({ cap, dryRun, campaignId });
}

// Round-robin merge of N arrays.
function interleave(arrays) {
  const out = [];
  let i = 0;
  while (true) {
    let pushed = false;
    for (const arr of arrays) {
      if (i < arr.length) {
        out.push(arr[i]);
        pushed = true;
      }
    }
    if (!pushed) break;
    i++;
  }
  return out;
}

// Only run as a CLI when invoked directly (`node run-daily-200.js`); when
// imported by the cron route, just expose runDailyOutbound.
import { fileURLToPath } from "url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
