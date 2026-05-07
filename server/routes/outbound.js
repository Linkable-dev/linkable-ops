// Routes for the daily-200 outbound dashboard. Powers /ai/outbound in the UI.
//
// Endpoints (all under /api/outbound, requireOpsAdmin):
//   GET  /sends           — list email_sends rows with filters
//   GET  /stats           — today's counts grouped by status × brand_group
//   POST /stop            — cancel pending touches + add to ai_suppressions

import express from "express";
import { supabase } from "../lib/supabase.js";
import { getDefaultTeamId } from "../automation/conversation-state.js";
import { cancelPendingTouches } from "../automation/sequencer.js";

export function outboundRoutes() {
  const router = express.Router();

  // ---------- LIST SENDS ----------
  // Query params:
  //   group=G1|G2|G3
  //   touch=1|2|3
  //   status=pending|scheduled|sent|failed|cancelled|bounced
  //   scope=today|all      (default: today)
  //   limit=number         (default: 200)
  router.get("/sends", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const { group, touch, status, scope = "today" } = req.query;
      const limit = Math.min(Number(req.query.limit) || 200, 1000);

      let q = supabase
        .from("email_sends")
        .select("id, sequence_id, touch_number, brand_group, template_variant, to_email, to_name, subject, status, sender_domain, scheduled_at, sent_at, cancelled_at, cancel_reason, error, resend_id, created_at")
        .eq("team_id", teamId)
        .not("sequence_id", "is", null)         // only daily-200 rows, never legacy A-F
        .order("scheduled_at", { ascending: false })
        .limit(limit);

      if (group) q = q.eq("brand_group", group);
      if (touch) q = q.eq("touch_number", Number(touch));
      if (status) q = q.eq("status", status);
      if (scope === "today") {
        // "Today" = anything that actually happened or is due *today*, with
        // both ends of the window bounded. Keying on scheduled_at alone
        // pulls in historical cancellations whose scheduled_at lands today
        // (e.g. bulk-cancelled T+7 followups), and a one-sided gte() lets
        // future T+7 enrollments leak in too.
        const start = new Date(); start.setUTCHours(0, 0, 0, 0);
        const end = new Date(start); end.setUTCDate(end.getUTCDate() + 1);
        const sIso = start.toISOString(), eIso = end.toISOString();
        q = q.or([
          `and(status.eq.sent,sent_at.gte.${sIso},sent_at.lt.${eIso})`,
          `and(status.eq.cancelled,cancelled_at.gte.${sIso},cancelled_at.lt.${eIso})`,
          `and(status.in.(pending,scheduled,failed,bounced),scheduled_at.gte.${sIso},scheduled_at.lt.${eIso})`,
        ].join(","));
      }

      const { data, error } = await q;
      if (error) throw new Error(error.message);
      res.json({ rows: data || [], count: data?.length || 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- STATS ----------
  // Returns aggregate counts for today (UTC) keyed by status × brand_group.
  // Lightweight rollup so the UI can show the headline numbers at a glance.
  router.get("/stats", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const start = new Date(); start.setUTCHours(0, 0, 0, 0);

      // Mirror the /sends scope filter (both bounds, per-status timestamp)
      // so headline numbers don't disagree with the row list.
      const end = new Date(start); end.setUTCDate(end.getUTCDate() + 1);
      const sIso = start.toISOString(), eIso = end.toISOString();
      const { data, error } = await supabase
        .from("email_sends")
        .select("brand_group, status, touch_number")
        .eq("team_id", teamId)
        .not("sequence_id", "is", null)
        .or([
          `and(status.eq.sent,sent_at.gte.${sIso},sent_at.lt.${eIso})`,
          `and(status.eq.cancelled,cancelled_at.gte.${sIso},cancelled_at.lt.${eIso})`,
          `and(status.in.(pending,scheduled,failed,bounced),scheduled_at.gte.${sIso},scheduled_at.lt.${eIso})`,
        ].join(","))
        .limit(5000);

      if (error) throw new Error(error.message);

      // Roll up in JS — Supabase JS client doesn't expose group-by, and at
      // 200/day × 3 touches max we're well under 1k rows so this is fine.
      const stats = { total: 0, byStatus: {}, byGroup: {}, byTouch: {} };
      for (const r of data || []) {
        stats.total++;
        stats.byStatus[r.status] = (stats.byStatus[r.status] || 0) + 1;
        if (r.brand_group) stats.byGroup[r.brand_group] = (stats.byGroup[r.brand_group] || 0) + 1;
        if (r.touch_number) stats.byTouch[`T${r.touch_number}`] = (stats.byTouch[`T${r.touch_number}`] || 0) + 1;
      }
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- STOP (cancel + suppress) ----------
  // Body: { emails: ["a@x.com", ...], reason: "replied" | "opted_out" }
  router.post("/stop", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const { emails = [], reason = "replied" } = req.body || {};
      if (!Array.isArray(emails) || emails.length === 0) {
        return res.status(400).json({ error: "emails[] required" });
      }
      const allowed = ["replied", "opted_out", "bounced", "manual"];
      if (!allowed.includes(reason)) {
        return res.status(400).json({ error: `reason must be one of: ${allowed.join(", ")}` });
      }

      const results = [];
      for (const raw of emails) {
        const email = String(raw || "").toLowerCase().trim();
        if (!email.includes("@")) {
          results.push({ email: raw, error: "invalid email" });
          continue;
        }
        // Suppress (so no future campaign hits it).
        const { error: supErr } = await supabase
          .from("ai_suppressions")
          .upsert(
            { team_id: teamId, email, reason, detail: "ui stop-list" },
            { onConflict: "team_id,email" }
          );
        if (supErr) {
          results.push({ email, error: supErr.message });
          continue;
        }
        // Cancel pending touches.
        const { cancelled } = await cancelPendingTouches({ teamId, email, reason });
        results.push({ email, cancelled, suppressed: true });
      }

      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
