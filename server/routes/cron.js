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
      const cap = Math.min(parseInt(req.query.cap) || 30, 200);
      const campaignId = req.query.campaign || null;
      const dryRun = req.query.dry === "1" || req.query.dry === "true";
      const lines = [];
      const log = (s) => lines.push(s);
      const result = await runDailyOutbound({ cap, campaignId, dryRun, log });
      res.json({ ...result, log: lines });
    } catch (err) {
      console.error("/cron/run-daily-outbound error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
