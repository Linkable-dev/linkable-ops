// Cron routes — protected by CRON_SECRET, no admin auth.
// Vercel Cron hits these on a schedule (configured in vercel.json).
//
// Auth: caller must send `Authorization: Bearer ${CRON_SECRET}` OR
//       `?secret=${CRON_SECRET}`. Vercel's cron sends a special header
//       `x-vercel-cron` plus a system bearer token; we accept either.

import { Router } from "express";
import { sendDueScheduled } from "../automation/conversation-runner.js";
import { processFollowUps } from "../automation/conversation-followup.js";
import { runDailyOutbound } from "../automation/run-daily-200.js";
import { processOneRunTick, autoTopUpDiscovery } from "../automation/lead-discovery.js";
import { getDefaultTeamId } from "../automation/conversation-state.js";
import { supabase } from "../lib/supabase.js";

// Decides whether a campaign's per-campaign schedule says "fire now". Returns
// null if not due, or { cap } for the per-invocation cap when due.
//   schedule.cadence: "off" | "daily" | "hourly_business"
//   schedule.timezone: IANA tz (e.g. "Europe/London")
//   schedule.start_hour: 0-23 (for daily, the firing hour; for hourly, window start)
//   schedule.end_hour: 0-23 (hourly only — inclusive window end)
//   schedule.weekdays_only: boolean
function scheduleDecision(schedule, dailyCap, now = new Date()) {
  if (!schedule || schedule.cadence === "off") return null;
  const tz = schedule.timezone || "UTC";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "numeric", weekday: "short", hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour").value);
  const weekday = parts.find((p) => p.type === "weekday").value;
  if (schedule.weekdays_only !== false && (weekday === "Sat" || weekday === "Sun")) return null;

  const startHour = Number.isFinite(schedule.start_hour) ? schedule.start_hour : 9;
  const endHour = Number.isFinite(schedule.end_hour) ? schedule.end_hour : 17;

  if (schedule.cadence === "daily") {
    // Fire once per day at the configured hour. The orchestrator's own
    // todaySentCount check stops further sends if the cap was already hit.
    if (hour === startHour) return { cap: dailyCap || null };
    return null;
  }
  if (schedule.cadence === "hourly_business") {
    if (hour >= startHour && hour <= endHour) {
      const windowHours = Math.max(1, endHour - startHour + 1);
      return { cap: Math.max(1, Math.ceil((dailyCap || 0) / windowHours)) };
    }
    return null;
  }
  return null;
}

function checkCronAuth(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Without a secret configured, allow only Vercel's signed cron requests.
    return req.headers["x-vercel-cron"] === "1";
  }
  const auth = req.headers.authorization || "";
  const bearer = auth.replace(/^Bearer\s+/i, "");
  if (bearer === expected) return true;
  if (req.query.secret === expected) return true;
  // Vercel's built-in cron passes its own bearer; cross-check.
  if (req.headers["x-vercel-cron"] === "1") return true;
  return false;
}

export function cronRoutes() {
  const router = Router();

  // Health probe Vercel can hit to verify the cron is reachable.
  router.get("/ping", (req, res) => {
    if (!checkCronAuth(req)) return res.status(401).json({ error: "unauthorized" });
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  // Vercel Cron hits GET by default.
  router.get("/run-due", async (req, res) => {
    if (!checkCronAuth(req)) return res.status(401).json({ error: "unauthorized" });
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const result = await sendDueScheduled({ limit });
      res.json(result);
    } catch (err) {
      console.error("/cron/run-due error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/follow-ups", async (req, res) => {
    if (!checkCronAuth(req)) return res.status(401).json({ error: "unauthorized" });
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const result = await processFollowUps({ limit });
      res.json(result);
    } catch (err) {
      console.error("/cron/follow-ups error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Daily-200 outbound orchestrator. Cron hits this hourly during business
  // hours; each invocation drains a small batch (default cap=30) so the
  // function fits under Vercel's serverless timeout. The orchestrator's own
  // daily-cap check stops further sends once the campaign's daily_cap is hit.
  //
  // Query params:
  //   ?cap=30             — per-invocation cap (default 30)
  //   ?campaign=<uuid>    — explicit campaign id (else picks most-recent active daily-200)
  //   ?dry=1              — log only, no sends
  router.get("/run-daily-outbound", async (req, res) => {
    if (!checkCronAuth(req)) return res.status(401).json({ error: "unauthorized" });
    try {
      const dryRun = req.query.dry === "1" || req.query.dry === "true";
      const lines = [];
      const log = (s) => lines.push(s);

      // Explicit-campaign mode: caller knows what to run. Used by the CLI and
      // for one-off triggers from the UI.
      if (req.query.campaign) {
        const cap = Math.min(parseInt(req.query.cap) || 30, 200);
        const result = await runDailyOutbound({ cap, campaignId: req.query.campaign, dryRun, log });
        return res.json({ ...result, log: lines });
      }

      // Auto mode (default for the cron tick): walk every active campaign,
      // ask its schedule whether it should fire right now, and run the ones
      // that say yes. Returns a per-campaign breakdown.
      const { data: campaigns, error } = await supabase
        .from("email_campaigns")
        .select("id,name,daily_cap,config,status")
        .eq("status", "active");
      if (error) throw new Error(error.message);

      const now = new Date();
      const results = [];
      for (const c of campaigns || []) {
        const decision = scheduleDecision(c.config?.schedule, c.daily_cap || 200, now);
        if (!decision) continue;
        log(`[scheduler] firing ${c.name} (${c.id}) cap=${decision.cap}`);
        try {
          const r = await runDailyOutbound({ cap: decision.cap, campaignId: c.id, dryRun, log });
          results.push({ campaign_id: c.id, name: c.name, ...r });
        } catch (e) {
          results.push({ campaign_id: c.id, name: c.name, error: e.message });
        }
      }
      if (results.length === 0) log("[scheduler] no campaigns due to fire this tick");
      res.json({ tick: now.toISOString(), fired: results.length, results, log: lines });
    } catch (err) {
      console.error("/cron/run-daily-outbound error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Auto top-up: walks every active campaign, queues a discovery run when its
  // uncontacted in-band pool drops below `threshold` (default 50, batch 200).
  // Idempotent — skips campaigns with a pending/running run from the last hour.
  // Designed for a daily cron tick.
  //
  // Query params: ?threshold=50&batch=200&dry=1
  router.get("/auto-discover", async (req, res) => {
    if (!checkCronAuth(req)) return res.status(401).json({ error: "unauthorized" });
    try {
      const teamId = await getDefaultTeamId();
      const threshold = Math.max(parseInt(req.query.threshold) || 50, 0);
      const batch = Math.min(Math.max(parseInt(req.query.batch) || 200, 10), 500);
      const dryRun = req.query.dry === "1" || req.query.dry === "true";
      const result = await autoTopUpDiscovery({ teamId, threshold, batch, dryRun });
      res.json(result);
    } catch (err) {
      console.error("/cron/auto-discover error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Lead-discovery worker tick. Each invocation processes one pending or
  // already-running discovery run for ~50 seconds, then yields. Vercel Cron
  // hits this every minute; the run resumes from its persisted cursor.
  router.get("/process-discovery", async (req, res) => {
    if (!checkCronAuth(req)) return res.status(401).json({ error: "unauthorized" });
    try {
      const deadlineMs = Math.min(parseInt(req.query.deadlineMs) || 50_000, 55_000);
      const result = await processOneRunTick({ deadlineMs });
      res.json(result);
    } catch (err) {
      console.error("/cron/process-discovery error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
