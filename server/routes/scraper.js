import { Router } from "express";
import { startJob, getJobStatus, stopJob } from "../scraper/job.js";
import { SEED_DOMAINS } from "../scraper/seeds.js";
import { runFullDiscovery, discoverFromSearch } from "../scraper/discover.js";
import { findContactEmails } from "../scraper/enrich.js";
import { supabase } from "../lib/supabase.js";

export function scraperRoutes() {
  const router = Router();

  router.post("/start", async (req, res) => {
    const { domains, discover } = req.body;
    const teamId = req.teamId;

    const { data: existing } = await supabase.from("scraper_results").select("domain").eq("team_id", teamId);
    const alreadyScraped = new Set((existing || []).map(r => r.domain));

    if (discover) {
      const customQueries = req.body.queries;
      startJob([], teamId, true);
      res.json({ status: "discovering" });

      const discoveryFn = customQueries?.length
        ? () => discoverFromSearch(customQueries)
        : runFullDiscovery;

      discoveryFn().then(discovered => {
        const combined = [...new Set([...SEED_DOMAINS, ...discovered])];
        const fresh = combined.filter(d => !alreadyScraped.has(d));
        if (fresh.length > 0) {
          startJob(fresh, teamId);
        } else {
          startJob(SEED_DOMAINS.slice(0, 1), teamId);
        }
      }).catch(() => {
        const fresh = SEED_DOMAINS.filter(d => !alreadyScraped.has(d));
        startJob(fresh.length > 0 ? fresh : SEED_DOMAINS.slice(0, 1), teamId);
      });
      return;
    }

    let domainList = domains || [];
    domainList = domainList.filter(d => !alreadyScraped.has(d));

    if (!domainList.length) {
      return res.json({ status: "complete", total: 0, processed: 0, qualified: 0, results: [], message: "All domains already scraped" });
    }

    const result = startJob(domainList, teamId);
    if (result.error) return res.status(409).json(result);
    res.json(result);
  });

  router.get("/status", (req, res) => {
    res.json(getJobStatus());
  });

  router.post("/stop", (req, res) => {
    const result = stopJob();
    if (result.error) return res.status(400).json(result);
    res.json(result);
  });

  // Email enrichment endpoint
  router.post("/enrich-email", async (req, res) => {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ error: "Domain required" });
    try {
      const result = await findContactEmails(domain);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
