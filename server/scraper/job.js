import { analyzeDomain } from "./shopify.js";
import { findContactEmails } from "./enrich.js";
import { supabase } from "../lib/supabase.js";

let currentJob = null;

export function startJob(domains, teamId, discoveringOnly = false) {
  if (currentJob?.status === "running" && !discoveringOnly) {
    return { error: "A job is already running" };
  }

  // If just setting up "discovering" state before actual domains are known
  if (discoveringOnly) {
    currentJob = {
      id: null, teamId, status: "discovering",
      total: 0, processed: 0, qualified: 0,
      results: [], errors: [], startedAt: new Date().toISOString(), stopped: false,
    };
    return { status: "discovering" };
  }

  const jobId = crypto.randomUUID();

  currentJob = {
    id: jobId,
    teamId,
    status: "running",
    total: domains.length,
    processed: 0,
    qualified: 0,
    results: [],
    errors: [],
    startedAt: new Date().toISOString(),
    stopped: false,
  };

  // Create the job row in Supabase
  supabase.from("scraper_jobs").insert({
    id: jobId,
    team_id: teamId,
    status: "running",
    mode: "manual",
    total: domains.length,
    processed: 0,
    qualified: 0,
    domains: domains,
    started_at: currentJob.startedAt,
  }).then(({ error }) => { if (error) console.error("Failed to create scraper_jobs row:", error.message); });

  // Run asynchronously
  (async () => {
    let updateCounter = 0;

    for (const domain of domains) {
      if (currentJob.stopped) {
        currentJob.status = "stopped";
        break;
      }

      try {
        const result = await analyzeDomain(domain);
        currentJob.processed++;

        if (!result.skip) {
          const qualified =
            result.beautyScore >= 0.25 &&
            result.estimatedRevenue >= 20000 &&
            result.estimatedRevenue <= 120000 &&
            ["US", "UK"].includes(result.country);

          result.qualified = qualified;
          currentJob.results.push(result);
          if (qualified) currentJob.qualified++;

          // Upsert result — updates if domain already exists for this team
          await supabase.from("scraper_results").upsert({
            job_id: jobId,
            team_id: teamId,
            domain: result.domain,
            shopify: true,
            skip: false,
            store_name: result.storeName || null,
            estimated_revenue: result.estimatedRevenue || null,
            product_count: result.productCount || null,
            beauty_score: result.beautyScore || null,
            country: result.country || null,
            aov: result.aov || null,
            matched_keywords: result.matchedKeywords || [],
            sample_types: result.sampleTypes || [],
            revenue_method: result.revenueMethod || null,
            geo_confidence: result.geoConfidence || null,
            currencies: result.currencies || [],
            qualified,
            scraped_at: new Date().toISOString(),
          }, { onConflict: "team_id,domain" });

          // Auto-enrich email for qualified results
          if (qualified) {
            try {
              const emails = await findContactEmails(result.domain);
              if (emails.best) {
                await supabase.from("scraper_results").update({ contact_email: emails.best }).eq("team_id", teamId).eq("domain", result.domain);
              }
            } catch {}
          }
        } else {
          currentJob.results.push(result);

          await supabase.from("scraper_results").upsert({
            job_id: jobId,
            team_id: teamId,
            domain: result.domain,
            shopify: result.shopify || false,
            skip: true,
            skip_reason: result.reason || null,
            qualified: false,
            scraped_at: new Date().toISOString(),
          }, { onConflict: "team_id,domain" });
        }
      } catch (err) {
        currentJob.processed++;
        currentJob.errors.push({ domain, error: err.message });
      }

      // Update job progress every 5 domains
      updateCounter++;
      if (updateCounter % 5 === 0) {
        await supabase.from("scraper_jobs").update({
          processed: currentJob.processed,
          qualified: currentJob.qualified,
          status: currentJob.status,
        }).eq("id", jobId);
      }
    }

    if (currentJob.status === "running") {
      currentJob.status = "complete";
    }

    // Final update to scraper_jobs
    await supabase.from("scraper_jobs").update({
      status: currentJob.status,
      processed: currentJob.processed,
      qualified: currentJob.qualified,
      completed_at: new Date().toISOString(),
    }).eq("id", jobId);
  })();

  return { status: "started", total: domains.length, jobId };
}

export function getJobStatus() {
  if (!currentJob) return { status: "idle", processed: 0, total: 0, qualified: 0, results: [] };
  return {
    status: currentJob.status,
    processed: currentJob.processed,
    total: currentJob.total,
    qualified: currentJob.qualified,
    results: currentJob.results,
    errors: currentJob.errors,
    startedAt: currentJob.startedAt,
  };
}

export function stopJob() {
  if (!currentJob || currentJob.status !== "running") {
    return { error: "No running job to stop" };
  }
  currentJob.stopped = true;
  return { status: "stopping" };
}
