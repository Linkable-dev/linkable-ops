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
import { MIN_SEND_SCORE } from "./brand-scoring.js";

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

// Detect creator/affiliate/influencer platform install from a storeleads
// raw_data.apps[] array. Strict app-level matching only — substring-scanning
// the whole raw_data blob produces false positives (Smile.io has "referral",
// half the Shopify ecosystem mentions "impact"). Probe against 1000 rows in
// May 2026 showed app-level matching fires on ~12% of pool — enough to feed
// the 25% G1 daily quota; orchestrator backfills the rest from G2/G3.
const AFFILIATE_APP_NAME = /\b(refersion|shareasale|goaffpro|leaddyno|tapfiliate|uppromote|social\s*snowball|post\s*affiliate|partnerstack|awin|skimlinks|shopify\s+collabs)\b/i;
const CREATOR_APP_NAME = /\b(creator|influencer|ambassador)\b/i;
const AFFILIATE_CATEGORY = /\b(affiliate|referral)\b/i;
const CREATOR_CATEGORY = /\b(creator|influencer|ambassador)\b/i;

function detectCreatorSignals(apps) {
  let hasCreators = false, hasAffiliates = false, hasInfluencers = false;
  for (const a of apps || []) {
    const name = `${a?.name || ""} ${a?.vendor_name || ""}`;
    const cats = Array.isArray(a?.categories) ? a.categories.join(" ") : "";
    if (AFFILIATE_APP_NAME.test(name) || AFFILIATE_CATEGORY.test(cats)) hasAffiliates = true;
    if (CREATOR_APP_NAME.test(name) || CREATOR_CATEGORY.test(cats)) {
      // "influencer" → influencers; "creator"/"ambassador" → creators
      if (/influencer/i.test(name) || /influencer/i.test(cats)) hasInfluencers = true;
      else hasCreators = true;
    }
    if (hasCreators && hasAffiliates && hasInfluencers) break;
  }
  return { hasCreators, hasAffiliates, hasInfluencers };
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
//
// IMPORTANT: applies the campaign's target_filters so a US campaign only
// emails US brands (and within its revenue band). Without this guard, the
// pool is team-wide and the sender will happily email any brand it finds —
// which means US Beauty 200k-1.5M would email UK $50k brands. Bug discovered
// 2026-05-02 after a Saturday test fired 50 emails to wrong-country leads.
async function fetchFreshProspectsByGroup({ teamId, perGroupQuota, targetFilters = {} }) {
  const totalNeeded = perGroupQuota.G1 + perGroupQuota.G2 + perGroupQuota.G3;

  let q = supabase
    .from("storeleads_brands")
    .select("*")
    .eq("team_id", teamId)
    .eq("contact_used", false)
    .not("email", "is", null)
    .not("contact_first_name", "is", null)
    // ICP gate: only enroll brands that scored above MIN_SEND_SCORE at
    // ingestion. Score is computed from revenue band, vertical fit, creator
    // stack signal, recency, and email quality (see brand-scoring.js). Brands
    // ingested before migration 010 are scored by backfill-scores.js; rows
    // with NULL brand_score are skipped here so the gate is strict by default.
    .gte("brand_score", MIN_SEND_SCORE);

  const countries = (targetFilters.countries || []).map((c) => c?.toString().trim().toUpperCase()).filter(Boolean);
  if (countries.length) q = q.in("country_code", countries);

  // Revenue is filtered in JS, not at the DB layer. raw_data is jsonb and
  // jsonb->>'key' returns text — `.gte("raw_data->>er", "1000000")` does
  // a *string* compare and silently drops everything outside lex order.
  // It also reads the wrong key: StoreLeads payloads expose
  // estimated_sales (monthly USD) — `er` is only the search-time alias.
  // Campaign target_filters are also in $/mo (the form labels say so), so
  // we compare directly against estimated_sales without unit conversion.
  const minRev = Number(targetFilters.min_revenue);
  const maxRev = Number(targetFilters.max_revenue);
  const hasRevFilter = (Number.isFinite(minRev) && minRev > 0) || (Number.isFinite(maxRev) && maxRev > 0);
  // Pull wide so post-filtering doesn't starve the run. Revenue gate can drop
  // 80%+ of the pool, so when a band is set we 10x; otherwise 5x is enough
  // for the group classifier to balance G1/G2/G3.
  const fetchSize = Math.max(totalNeeded * (hasRevFilter ? 10 : 5), 200);

  // Score-first ordering: highest-scoring brands burn first, with recency as
  // a tiebreaker. This is the lever that 2x's reply rate — without it the
  // gate just removes the floor without lifting the median.
  q = q
    .order("brand_score", { ascending: false })
    .order("imported_at", { ascending: false })
    .limit(fetchSize);
  const { data, error } = await q;

  if (error) throw new Error(`fetchFreshProspects: ${error.message}`);

  const inBand = (row) => {
    if (!hasRevFilter) return true;
    const rev = Number(row?.raw_data?.estimated_sales);   // monthly USD
    if (!Number.isFinite(rev)) return false;
    if (Number.isFinite(minRev) && minRev > 0 && rev < minRev) return false;
    if (Number.isFinite(maxRev) && maxRev > 0 && rev > maxRev) return false;
    return true;
  };

  const buckets = { G1: [], G2: [], G3: [] };
  for (const row of (data || []).filter(inBand)) {
    // G1 signal lives in raw_data.apps[] — about 12% of brands have a
    // dedicated affiliate/creator platform installed (UpPromote, GoAffPro,
    // Awin, Shopify Collabs, Refersion, etc.). Without this derivation, the
    // classifier's isCreatorActive() check is always false → G1 is dead.
    // We intentionally do NOT substring-scan raw_data wholesale ("referral"
    // would match Smile.io review apps, "impact" matches unrelated apps).
    const apps = Array.isArray(row.raw_data?.apps) ? row.raw_data.apps : [];
    const { hasCreators, hasAffiliates, hasInfluencers } = detectCreatorSignals(apps);

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
        hasCreators,
        hasAffiliates,
        hasInfluencers,
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
  const senderPoolTag = campaign.sender_pool_tag || null;
  const templateBuckets = await loadTemplateBucketsForCampaign(teamId, campaignId);

  // ---------- 1. Drain due rows from prior enrollments (T+3, T+7, T+12) ----------
  const dueRows = await fetchDueRows({ teamId, limit: remaining });
  log(`[daily-200] due rows from prior enrollments: ${dueRows.length}`);

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
    // All inboxes hit daily cap — no point iterating the remaining due rows;
    // they'll be picked up on tomorrow's run. Stop the drain loop early.
    if (result.deferred) {
      log(`[daily-200] inbox pool exhausted (deferred=${deferred}), stopping drain`);
      break;
    }
  }

  // ---------- 2. Enroll fresh prospects into the daily mix ----------
  const slotsLeft = remaining - sent;
  // Slots-left is the *send* budget. Enrolling N fresh prospects only adds
  // N T+1 sends today (T+3/T+7/T+12 will be on future days), so we can enroll
  // up to slotsLeft new prospects.
  if (slotsLeft <= 0) {
    log("[daily-200] cap hit during drain phase, no fresh enrollment");
  } else {
    const quota = allocateDailyQuota(slotsLeft);
    log(`[daily-200] enrolling fresh: ${JSON.stringify(quota)}`);

    const buckets = await fetchFreshProspectsByGroup({
      teamId,
      perGroupQuota: quota,
      targetFilters: campaign.target_filters || {},
    });
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
        senderPoolTag,
        audienceType: "brand",
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
