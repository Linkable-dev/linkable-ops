// Bulk first-message runner.
// Pulls candidates (e.g. from scraper_results), spreads sends with jitter to
// stay under Resend rate limits, and feeds each one through sendFirstMessage.
//
// Designed to run in the background (response returns immediately).
// Progress is tracked in the ai_bulk_runs table so the UI can poll.

import { supabase } from "../lib/supabase.js";
import {
  getDefaultTeamId,
  getCampaign,
  createBulkRun,
  updateBulkRun,
  isSuppressed,
} from "./conversation-state.js";
import { sendFirstMessage } from "./conversation-runner.js";

const SEND_INTERVAL_MS = 2_000;        // 2s between sends — well under Resend's 2/sec limit
const MAX_PER_HOUR = 200;              // conservative; warm up gradually

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
  let processed = 0;
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let hourBucket = Math.floor(Date.now() / 3_600_000);
  let hourCount = 0;

  for (const prospect of candidates) {
    // Cooperative cancellation: re-read the run row to check for "stopped".
    const { data: runRow } = await supabase
      .from("ai_bulk_runs")
      .select("status")
      .eq("id", runId)
      .maybeSingle();
    if (runRow?.status === "stopped") break;

    // Hourly cap.
    const currentHour = Math.floor(Date.now() / 3_600_000);
    if (currentHour !== hourBucket) {
      hourBucket = currentHour;
      hourCount = 0;
    }
    if (hourCount >= MAX_PER_HOUR) {
      const waitMs = (hourBucket + 1) * 3_600_000 - Date.now();
      await sleep(Math.max(60_000, waitMs));
      continue;
    }

    try {
      // Suppression check (sendFirstMessage also checks, but doing it here means
      // we don't burn an LLM call for nothing).
      const supp = await isSuppressed(teamId, prospect.email);
      if (supp.suppressed) {
        skipped++;
        processed++;
        await updateBulkRun(runId, { processed, skipped });
        continue;
      }
      const result = await sendFirstMessage({
        teamId,
        campaignId: campaign.id,
        prospect,
        dryRun,
      });
      if (result.skipped) skipped++;
      else if (result.send?.success || result.send?.dryRun) sent++;
      else failed++;
      hourCount++;
    } catch (err) {
      console.error(`bulk run ${runId} prospect ${prospect.email} error:`, err.message);
      failed++;
    }

    processed++;
    if (processed % 5 === 0) {
      await updateBulkRun(runId, { processed, sent, skipped, failed });
    }

    if (processed < candidates.length) await sleep(SEND_INTERVAL_MS);
  }

  await updateBulkRun(runId, {
    processed,
    sent,
    skipped,
    failed,
    status: "complete",
    completed_at: new Date().toISOString(),
  });
}

// ---------- CANDIDATE SOURCES ----------

async function fetchCandidates({ teamId, source, filters, limit }) {
  switch (source) {
    case "scraper_results":
      return fetchFromScraperResults({ teamId, filters, limit });
    case "contacts":
      return fetchFromContacts({ teamId, filters, limit });
    case "manual":
      // Caller passes prospects directly under filters.prospects.
      return Array.isArray(filters?.prospects) ? filters.prospects.slice(0, limit) : [];
    default:
      throw new Error(`unknown source: ${source}`);
  }
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
  // Best-effort mapping from a scraper_results row to a prospect dossier.
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
