// Daily influencer outbound orchestrator.
// One run = one pass through (drain due touches → enroll fresh creators →
// send everything due up to the daily cap). Mirrors run-daily-200.js but
// pulls prospects from creator_prospects and bands them into C1/C2/C3 by
// follower tier instead of brand groups.
//
// Cron this once per business morning (or piggyback on /cron/run-daily-outbound
// which auto-dispatches by campaign.audience_type). Re-running on the same
// day is safe — same enrollment guard + daily cap query as the brand path.
//
// Usage:
//   node server/automation/run-daily-influencer.js [--cap 100] [--dry-run]
//   node server/automation/run-daily-influencer.js --campaign <uuid>

import { supabase } from "../lib/supabase.js";
import { delaySend } from "./send.js";
import {
  enrollCreator,
  fetchDueRows,
  sendDueRow,
  resolveActiveCampaign,
  loadTemplateBucketsForCampaign,
} from "./sequencer.js";
import { classifyCreator, allocateDailyQuota } from "./creator-groups.js";
import { MIN_SEND_SCORE } from "./creator-scoring.js";

const TEAM_ID = process.env.TEAM_ID || "a0000000-0000-0000-0000-000000000001";
const DEFAULT_CAP = 100;

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

// How many influencer-audience emails has this team already sent today?
// Audience-scoped so brand sends don't eat into the influencer cap (and
// vice versa) — the two campaigns share email_sends but should bill
// against their own daily budgets.
async function todaySentCount(teamId) {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { count, error } = await supabase
    .from("email_sends")
    .select("id", { count: "exact", head: true })
    .eq("team_id", teamId)
    .eq("audience_type", "influencer")
    .eq("status", "sent")
    .gte("sent_at", startOfDay.toISOString());
  if (error) throw new Error(`todaySentCount: ${error.message}`);
  return count || 0;
}

// Pull fresh creators from creator_prospects, apply campaign target_filters,
// then bucket into C1/C2/C3 tiers up to per-tier quota. Filter shape:
//   {
//     countries:       ["US","GB"],
//     niches:          ["beauty","wellness"],     // matched substring on niche
//     min_followers:   10000,
//     max_followers:   200000,
//     min_engagement:  0.02                        // fraction
//   }
async function fetchFreshCreatorsByGroup({ teamId, perGroupQuota, targetFilters = {} }) {
  const totalNeeded = perGroupQuota.C1 + perGroupQuota.C2 + perGroupQuota.C3;

  let q = supabase
    .from("creator_prospects")
    .select("*")
    .eq("team_id", teamId)
    .eq("contact_used", false)
    .not("email", "is", null)
    .not("first_name", "is", null)
    .gte("creator_score", MIN_SEND_SCORE);

  const countries = (targetFilters.countries || [])
    .map((c) => c?.toString().trim().toUpperCase())
    .filter(Boolean);
  if (countries.length) q = q.in("country", countries);

  const minFollowers = Number(targetFilters.min_followers);
  const maxFollowers = Number(targetFilters.max_followers);
  const minEngagement = Number(targetFilters.min_engagement);
  // followers_count is a real INTEGER column so DB-side compare is safe.
  if (Number.isFinite(minFollowers) && minFollowers > 0) q = q.gte("followers_count", minFollowers);
  if (Number.isFinite(maxFollowers) && maxFollowers > 0) q = q.lte("followers_count", maxFollowers);
  if (Number.isFinite(minEngagement) && minEngagement > 0) q = q.gte("engagement_rate", minEngagement);

  // Niche filter is a free-form string match — main-app `influencers.niche`
  // is operator-entered text, so we substring-match against the user's
  // requested niches. No-op when empty.
  const niches = (targetFilters.niches || [])
    .map((n) => n?.toString().trim().toLowerCase())
    .filter(Boolean);

  // Pull wider than needed so tier-classification can spread across buckets.
  // Engagement / niche filters drop a fair chunk of the pool, so 5x is the
  // floor; bump to 10x when both are set.
  const tightFilter = niches.length || Number.isFinite(minEngagement);
  const fetchSize = Math.max(totalNeeded * (tightFilter ? 10 : 5), 200);

  q = q
    .order("creator_score", { ascending: false })
    .order("imported_at", { ascending: false })
    .limit(fetchSize);

  const { data, error } = await q;
  if (error) throw new Error(`fetchFreshCreators: ${error.message}`);

  const matchesNiche = (row) => {
    if (!niches.length) return true;
    const n = (row.niche || "").toLowerCase();
    return niches.some((target) => n.includes(target));
  };

  const buckets = { C1: [], C2: [], C3: [] };
  for (const row of (data || []).filter(matchesNiche)) {
    const grp = classifyCreator(row);
    if (buckets[grp].length < perGroupQuota[grp]) {
      buckets[grp].push({ row, group: grp });
    }
    if (
      buckets.C1.length >= perGroupQuota.C1 &&
      buckets.C2.length >= perGroupQuota.C2 &&
      buckets.C3.length >= perGroupQuota.C3
    ) break;
  }
  return buckets;
}

async function markCreatorUsed(rowId) {
  await supabase.from("creator_prospects").update({ contact_used: true }).eq("id", rowId);
}

async function resolveCampaign(teamId, explicitId) {
  const c = await resolveActiveCampaign(teamId, explicitId, "influencer");
  if (!c) {
    throw new Error(
      "No active influencer campaign found. Create one via the AI Outbound Campaigns page (audience_type='influencer'), " +
      "or pass --campaign <uuid>."
    );
  }
  if (c.status === "paused") {
    throw new Error(`Campaign ${c.name} is paused. Resume it from the UI to run.`);
  }
  if (c.status === "archived") {
    throw new Error(`Campaign ${c.name} is archived.`);
  }
  if (c.audience_type !== "influencer") {
    throw new Error(`Campaign ${c.name} is audience_type=${c.audience_type}, not 'influencer'.`);
  }
  return c;
}

// ---------- CALLABLE FROM CRON ROUTE ----------

export async function runDailyInfluencer({
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
  const perRunCap = capOverride ?? dailyCap;
  const senderPoolTag = campaign.sender_pool_tag || null;

  log(`[influencer] campaign=${campaign.name} (${campaign.id}) perRunCap=${perRunCap} dailyCap=${dailyCap} dryRun=${dryRun}`);

  const sentToday = await todaySentCount(teamId);
  const dailyRemaining = Math.max(0, dailyCap - sentToday);
  const remaining = Math.min(perRunCap, dailyRemaining);
  log(`[influencer] sent today: ${sentToday}/${dailyCap}; daily remaining: ${dailyRemaining}; this-run cap: ${remaining}`);

  if (remaining === 0) {
    log("[influencer] daily cap reached or per-run cap=0; exiting");
    return { campaign_id: campaign.id, sent: 0, failed: 0, cancelled: 0, reason: "cap-reached" };
  }

  const campaignId = campaign.id;
  const senderFrom = campaign.sender_from;
  const replyTo = campaign.reply_to;
  const templateBuckets = await loadTemplateBucketsForCampaign(teamId, campaignId);

  // ---------- 1. Drain due touches from prior enrollments ----------
  // fetchDueRows is audience-agnostic — it picks any pending/scheduled row.
  // For the influencer runner we restrict to influencer rows so brand
  // touches don't get drained on the influencer's send budget. We do this
  // by post-filtering since fetchDueRows doesn't take an audience param —
  // adding one would couple the helper too tightly to one caller.
  const candidateDue = await fetchDueRows({ teamId, limit: remaining * 2 });
  const dueRows = candidateDue.filter((r) => r.audience_type === "influencer").slice(0, remaining);
  log(`[influencer] due rows from prior enrollments: ${dueRows.length}`);

  let sent = 0, failed = 0, cancelled = 0, deferred = 0;
  for (const row of dueRows) {
    if (sent + failed >= remaining) break;
    if (dryRun) {
      log(`  DRY: would send seq=${row.sequence_id} touch=${row.touch_number} to=${row.to_email} variant=${row.template_variant}`);
      continue;
    }
    const result = await sendDueRow(row, { resendApiKey, senderFrom, replyTo, senderPoolTag });
    if (result.cancelled) cancelled++;
    else if (result.deferred) deferred++;
    else if (result.sent) sent++;
    else failed++;
    const tag = result.sent ? "OK" : result.cancelled ? "cancelled" : result.deferred ? "deferred" : "FAIL";
    log(`  [drain] ${row.template_variant} → ${row.to_email}: ${tag} ${result.error || result.reason || ""}`);
    await delaySend();
    if (result.deferred) {
      log(`[influencer] inbox pool exhausted (deferred=${deferred}), stopping drain`);
      break;
    }
  }

  // ---------- 2. Enroll fresh creators ----------
  const slotsLeft = remaining - sent;
  if (slotsLeft <= 0) {
    log("[influencer] cap hit during drain phase, no fresh enrollment");
  } else {
    const quota = allocateDailyQuota(slotsLeft);
    log(`[influencer] enrolling fresh: ${JSON.stringify(quota)}`);

    const buckets = await fetchFreshCreatorsByGroup({
      teamId,
      perGroupQuota: quota,
      targetFilters: campaign.target_filters || {},
    });
    log(`[influencer] available pool: C1=${buckets.C1.length} C2=${buckets.C2.length} C3=${buckets.C3.length}`);

    // Round-robin so today's sends spread across tiers — no 100 micros from
    // one IP in a row, which Gmail penalises as bursty.
    const interleaved = interleave([buckets.C2, buckets.C3, buckets.C1]);

    for (const { row, group } of interleaved) {
      if (sent + failed >= remaining) break;

      if (dryRun) {
        log(`  DRY: would enroll ${group} ${row.email} (${row.instagram_username || row.first_name})`);
        continue;
      }

      const enroll = await enrollCreator({
        teamId,
        campaignId,
        contactId: null,
        toEmail: row.email,
        toName: [row.first_name, row.last_name].filter(Boolean).join(" ") || null,
        creator: row,
        apiKey: anthropicApiKey,
        group,
        templateBuckets,
        senderPoolTag,
      });

      if (enroll.skipped) {
        log(`  [enroll skip] ${row.email}: ${enroll.skipped}`);
        await markCreatorUsed(row.id);
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

      const result = await sendDueRow(t1Row, { resendApiKey, senderFrom, replyTo, senderPoolTag });
      if (result.cancelled) cancelled++;
      else if (result.sent) sent++;
      else failed++;
      log(`  [enroll T1] ${group} → ${row.email}: ${result.sent ? "OK" : result.cancelled ? "cancelled" : "FAIL"} ${result.error || ""}`);

      await markCreatorUsed(row.id);
      await delaySend();
    }
  }

  log(`[influencer] DONE — sent=${sent} failed=${failed} cancelled=${cancelled}`);
  return { campaign_id: campaign.id, sent, failed, cancelled };
}

// ---------- CLI ----------

async function main() {
  const { cap, dryRun, campaignId } = parseArgs();
  await runDailyInfluencer({ cap, dryRun, campaignId });
}

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

import { fileURLToPath } from "url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
