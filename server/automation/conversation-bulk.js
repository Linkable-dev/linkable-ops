// Bulk first-message runner — production-tuned for safe high-volume launches.
//
// Pipeline per prospect:
//   1. Pre-checks: campaign daily cap, suppression list, cross-campaign dedup,
//      campaign auto-pause flag.
//   2. Generate first message via Claude (parallelised — concurrency 5).
//   3. Insert ai_messages row with scheduled_for staggered across the
//      campaign's business window. The send itself happens later via
//      /api/cron/run-due, which spreads outbound traffic gradually.
//
// Why we DON'T just blast: a fresh-ish sending domain with 500+ emails in
// hour 1 = sender reputation tanks. Scheduling across the business window
// looks human and respects warmup.

import PQueue from "p-queue";
import { supabase } from "../lib/supabase.js";
import {
  getDefaultTeamId,
  getCampaign,
  createBulkRun,
  updateBulkRun,
  isSuppressed,
  emailAlreadyContacted,
  countScheduledToday,
  countSentToday,
  recentBounceRate,
  updateCampaign,
} from "./conversation-state.js";
import { sendFirstMessage } from "./conversation-runner.js";

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_DAILY_CAP = 150;          // safety net when campaign cap is null
const BOUNCE_RATE_PAUSE_PCT = 5.0;      // > 5% bounces in last 100 = auto-pause
const BOUNCE_RATE_MIN_SAMPLE = 30;      // don't auto-pause until 30 sends

export async function startBulkRun({ teamId, campaignId, source = "scraper_results", filters = {}, limit = 50, dryRun = false }) {
  const team = teamId || (await getDefaultTeamId());
  const campaign = await getCampaign(campaignId, team);
  if (!campaign) throw new Error(`campaign ${campaignId} not found`);

  const candidates = await fetchCandidates({ teamId: team, source, filters, limit });

  const run = await createBulkRun({
    teamId: team,
    campaignId,
    source,
    filters,
    total: candidates.length,
  });

  // Detached promise — the API handler returns immediately. We log progress
  // to the DB so callers can poll the bulk run row.
  processBulkRun(run.id, team, campaign, candidates, dryRun).catch((err) => {
    console.error(`bulk run ${run.id} failed:`, err);
    updateBulkRun(run.id, {
      status: "failed",
      error: err.message,
      completed_at: new Date().toISOString(),
    }).catch(() => {});
  });

  return { run_id: run.id, total: candidates.length };
}

async function processBulkRun(runId, teamId, campaign, candidates, dryRun) {
  const counters = { processed: 0, sent: 0, skipped: 0, failed: 0, scheduled: 0 };
  const concurrency = DEFAULT_CONCURRENCY;
  const queue = new PQueue({ concurrency });

  // Cooperative cancellation flag, refreshed periodically.
  let cancelled = false;
  let bouncePaused = false;

  // Daily cap accounting. Pull the current day's already-scheduled count
  // up front; reserve slots as we schedule below.
  const dailyCap = campaign.daily_send_cap || DEFAULT_DAILY_CAP;
  const alreadyScheduled = await countScheduledToday({ teamId, campaignId: campaign.id });
  const alreadySent = await countSentToday({ teamId, campaignId: campaign.id });
  let slotsLeft = Math.max(0, dailyCap - alreadyScheduled - alreadySent);

  // Build the schedule timeline up-front so concurrent workers each get a
  // distinct, non-overlapping send time within the business window.
  const slotIso = nextDayScheduleSlots({
    timezone: campaign.timezone || "UTC",
    startHour: campaign.send_window_start_hour ?? 9,
    endHour: campaign.send_window_end_hour ?? 18,
    count: Math.min(candidates.length, slotsLeft),
    earliestStartMs: Date.now() + 60_000,  // give the cron a minute to pick up
  });
  let slotIdx = 0;

  const flushCounters = async () => {
    await updateBulkRun(runId, {
      processed: counters.processed,
      sent: counters.sent,           // immediate sends (rare in bulk; mostly 0)
      skipped: counters.skipped,
      failed: counters.failed,
    }).catch(() => {});
  };

  // Flush counters every 10 completes.
  let completedSinceFlush = 0;

  for (const prospect of candidates) {
    if (cancelled || bouncePaused) break;
    queue.add(async () => {
      if (cancelled || bouncePaused) return;

      // Cancellation poll — every 20 prospects, re-read run row.
      if (counters.processed % 20 === 0) {
        const { data: runRow } = await supabase
          .from("ai_bulk_runs")
          .select("status")
          .eq("id", runId)
          .maybeSingle();
        if (runRow?.status === "stopped") { cancelled = true; return; }
      }

      // Bounce-rate auto-pause: every 50 sends, check.
      if (counters.processed > 0 && counters.processed % 50 === 0) {
        const r = await recentBounceRate({ teamId, campaignId: campaign.id, windowMessages: 100 }).catch(() => null);
        if (r && r.sent >= BOUNCE_RATE_MIN_SAMPLE && r.ratePct >= BOUNCE_RATE_PAUSE_PCT) {
          bouncePaused = true;
          await updateCampaign(campaign.id, teamId, {
            status: "paused",
            auto_paused_at: new Date().toISOString(),
            auto_pause_reason: `bounce rate ${r.ratePct.toFixed(1)}% over last ${r.sent} sends`,
          }).catch(() => {});
          return;
        }
      }

      try {
        // Suppression: skip without burning an LLM call.
        const supp = await isSuppressed(teamId, prospect.email);
        if (supp.suppressed) { counters.skipped++; return; }

        // Cross-campaign dedup.
        const dup = await emailAlreadyContacted({ teamId, prospectEmail: prospect.email });
        if (dup) { counters.skipped++; return; }

        // Daily cap: reserve a slot. If none left, push to next day's window.
        let scheduledFor;
        if (slotsLeft > 0 && slotIdx < slotIso.length) {
          scheduledFor = slotIso[slotIdx++];
          slotsLeft--;
        } else {
          // Out of slots today → schedule for tomorrow's window.
          scheduledFor = nextDayScheduleSlots({
            timezone: campaign.timezone || "UTC",
            startHour: campaign.send_window_start_hour ?? 9,
            endHour: campaign.send_window_end_hour ?? 18,
            count: 1,
            earliestStartMs: tomorrowMs(),
          })[0];
        }

        const result = await sendFirstMessage({
          teamId,
          campaignId: campaign.id,
          prospect,
          dryRun,
          scheduledFor: dryRun ? null : scheduledFor,
        });
        if (result.skipped) counters.skipped++;
        else if (result.scheduled) counters.scheduled++;
        else if (result.send?.success || result.send?.dryRun) counters.sent++;
        else counters.failed++;
      } catch (err) {
        console.error(`bulk run ${runId} prospect ${prospect.email} error:`, err.message);
        counters.failed++;
      } finally {
        counters.processed++;
        completedSinceFlush++;
        if (completedSinceFlush >= 10) {
          completedSinceFlush = 0;
          await flushCounters();
        }
      }
    });
  }

  await queue.onIdle();
  await flushCounters();

  await updateBulkRun(runId, {
    processed: counters.processed,
    sent: counters.sent + counters.scheduled,   // include scheduled in "sent" for UI clarity
    skipped: counters.skipped,
    failed: counters.failed,
    status: cancelled ? "stopped" : bouncePaused ? "failed" : "complete",
    error: bouncePaused ? "auto-paused: bounce rate too high" : null,
    completed_at: new Date().toISOString(),
  });
}

// ---------- TIME-OF-DAY SPREADING ----------

// Build N evenly-spaced ISO timestamps inside today's business window,
// starting no earlier than `earliestStartMs`. Window hours are interpreted
// in the campaign's tz via Intl.DateTimeFormat — DST safe.
// If today's window is full, slots spill into following days.
function nextDayScheduleSlots({ timezone, startHour, endHour, count, earliestStartMs }) {
  if (count <= 0) return [];

  const slots = [];
  let cursor = new Date(earliestStartMs || Date.now());
  let remaining = count;
  let safety = 30; // can't hit more than 30 days ahead

  while (remaining > 0 && safety-- > 0) {
    const winStart = atHourInTz(cursor, startHour, timezone);
    const winEnd = atHourInTz(cursor, endHour, timezone);

    if (cursor >= winEnd) {
      cursor = atHourInTz(addDays(cursor, 1), startHour, timezone);
      continue;
    }
    const effectiveStart = cursor > winStart ? cursor : winStart;
    const minutesAvailable = Math.max(0, Math.floor((winEnd - effectiveStart) / 60_000));
    if (minutesAvailable === 0) {
      cursor = atHourInTz(addDays(cursor, 1), startHour, timezone);
      continue;
    }

    const fitToday = Math.min(remaining, minutesAvailable);
    const spacingMs = fitToday > 1 ? Math.floor((winEnd - effectiveStart) / fitToday) : 0;
    for (let i = 0; i < fitToday; i++) {
      const t = new Date(effectiveStart.getTime() + i * spacingMs);
      slots.push(t.toISOString());
    }
    remaining -= fitToday;
    cursor = atHourInTz(addDays(cursor, 1), startHour, timezone);
  }
  return slots;
}

// Returns a Date that, when displayed in `tz`, reads as `hour:00:00` on the
// same calendar day as `referenceDate` in that tz.
//
// Two-step: (1) determine the calendar day in tz; (2) compute UTC instant
// such that wall-clock-in-tz = "day hour:00:00", correcting for the tz
// offset at that moment (which can shift across DST).
function atHourInTz(referenceDate, hour, timezone) {
  const dayFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = Object.fromEntries(dayFmt.formatToParts(referenceDate).map((p) => [p.type, p.value]));
  const wallStr = `${parts.year}-${parts.month}-${parts.day}T${String(hour).padStart(2, "0")}:00:00Z`;
  const naiveUtc = new Date(wallStr); // T0: instant if wallStr were UTC
  // Find what naiveUtc looks like in target tz; offset = wall(tz) - wall(UTC).
  const tzFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const tzParts = Object.fromEntries(tzFmt.formatToParts(naiveUtc).map((p) => [p.type, p.value]));
  const tzWallUtc = Date.UTC(
    +tzParts.year, +tzParts.month - 1, +tzParts.day,
    +tzParts.hour, +tzParts.minute, +tzParts.second,
  );
  const offsetMs = tzWallUtc - naiveUtc.getTime();
  // Shifting earlier by offset gives the actual UTC instant for "hour in tz".
  return new Date(naiveUtc.getTime() - offsetMs);
}

function addDays(d, days) { return new Date(d.getTime() + days * 86_400_000); }
function tomorrowMs() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() + 86_400_000;
}

// ---------- CANDIDATE SOURCES ----------

async function fetchCandidates({ teamId, source, filters, limit }) {
  switch (source) {
    case "scraper_results":
      return fetchFromScraperResults({ teamId, filters, limit });
    case "contacts":
      return fetchFromContacts({ teamId, filters, limit });
    case "storeleads":
      return fetchFromStoreLeads({ teamId, filters, limit });
    case "manual":
      return Array.isArray(filters?.prospects) ? filters.prospects.slice(0, limit) : [];
    default:
      throw new Error(`unknown source: ${source}`);
  }
}

async function fetchFromStoreLeads({ teamId, filters, limit }) {
  let q = supabase
    .from("storeleads_brands")
    .select("*")
    .not("email", "is", null);
  if (teamId) q = q.or(`team_id.is.null,team_id.eq.${teamId}`);
  if (filters.country) q = q.eq("country_code", filters.country);
  q = q.order("imported_at", { ascending: false }).limit(limit);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []).map(storeLeadsToProspect);
}

function storeLeadsToProspect(row) {
  const social = (row.contact_info || []).filter((c) => ["instagram", "tiktok", "youtube"].includes(c.type) && c.followers);
  const socialFollowing = social
    .map((c) => `${c.type}: ${(c.followers || 0).toLocaleString()} followers`)
    .join(", ");
  return {
    contactId: null,
    email: row.email,
    name: [row.contact_first_name, row.contact_last_name].filter(Boolean).join(" ") || row.merchant_name || row.domain,
    company: row.merchant_name || row.title || row.domain,
    domain: row.domain,
    country: row.country_code || "",
    productTypes: [],
    brandStory: row.description || row.about_us || "",
    usp: "",
    founderName: row.contact_position && /founder|ceo/i.test(row.contact_position) ? row.contact_first_name : "",
    socialFollowing,
    hasCreators: false,
    hasAffiliates: false,
    hasInfluencers: false,
    additional: row.contact_position ? `Role: ${row.contact_position}` : "",
  };
}

async function fetchFromScraperResults({ teamId, filters, limit }) {
  let q = supabase
    .from("scraper_results")
    .select("*")
    .eq("team_id", teamId)
    .not("contact_email", "is", null)
    .order("scraped_at", { ascending: false })
    .limit(limit);
  if (filters.qualified !== undefined) q = q.eq("qualified", filters.qualified);
  if (filters.country) q = q.eq("country", filters.country);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []).map(rowToProspect);
}

async function fetchFromContacts({ teamId, filters, limit }) {
  let q = supabase
    .from("contacts")
    .select("*")
    .eq("team_id", teamId)
    .not("email", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (filters.stage) q = q.eq("stage", filters.stage);
  if (filters.country) q = q.eq("country", filters.country);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []).map(contactToProspect);
}

function rowToProspect(row) {
  return {
    contactId: row.contact_id || null,
    email: row.contact_email,
    name: row.store_name || row.contact_name || "",
    company: row.store_name || row.domain,
    domain: row.domain,
    country: row.country || "",
    productTypes: row.matched_keywords || row.sample_types || [],
    brandStory: row.brand_story || row.description || "",
    usp: row.usp || "",
    founderName: row.founder_name || "",
    socialFollowing: row.social_following || "",
    hasCreators: !!row.has_creators,
    hasAffiliates: !!row.has_affiliates,
    hasInfluencers: !!row.has_influencers,
    additional: row.notes || "",
  };
}

function contactToProspect(row) {
  return {
    contactId: row.id,
    email: row.email,
    name: row.name || "",
    company: row.company || row.domain,
    domain: row.domain,
    country: row.country || "",
    productTypes: (row.category || "").split(/,\s*/).filter(Boolean),
    additional: "",
  };
}
