// Routes for the daily-200 outbound dashboard. Powers /ai/outbound in the UI.
//
// Endpoints (all under /api/outbound, requireOpsAdmin):
//   GET  /sends           — list email_sends rows with filters
//   GET  /stats           — counts grouped by status × brand_group
//   GET  /runs            — distinct daily-run dates (for the run picker)
//   POST /stop            — cancel pending touches + add to ai_suppressions

import express from "express";
import { supabase } from "../lib/supabase.js";
import { getDefaultTeamId } from "../automation/conversation-state.js";
import { cancelPendingTouches } from "../automation/sequencer.js";

// Shared scope-window builder. Returns null when scope/run_date imply lifetime.
// Callers apply the returned .or(...) clause to a Supabase query.
function buildScopeOr({ scope, runDate }) {
  let start, end;
  if (runDate) {
    // Single-day window keyed off the UTC date (YYYY-MM-DD).
    start = new Date(`${runDate}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime())) return null;
    end = new Date(start); end.setUTCDate(end.getUTCDate() + 1);
  } else if (scope === "today") {
    start = new Date(); start.setUTCHours(0, 0, 0, 0);
    end = new Date(start); end.setUTCDate(end.getUTCDate() + 1);
  } else {
    return null; // scope=all + no run_date → no window
  }
  const sIso = start.toISOString(), eIso = end.toISOString();
  // Keying on per-status timestamps avoids historical cancellations whose
  // scheduled_at lands today leaking into "today" rollups.
  return [
    `and(status.eq.sent,sent_at.gte.${sIso},sent_at.lt.${eIso})`,
    `and(status.eq.cancelled,cancelled_at.gte.${sIso},cancelled_at.lt.${eIso})`,
    `and(status.in.(pending,scheduled,failed,bounced),scheduled_at.gte.${sIso},scheduled_at.lt.${eIso})`,
  ].join(",");
}

export function outboundRoutes() {
  const router = express.Router();

  // ---------- LIST SENDS ----------
  // Query params:
  //   group=G1|G2|G3
  //   touch=1|2|3
  //   status=pending|scheduled|sent|failed|cancelled|bounced
  //   scope=today|all       (default: today; ignored when run_date is set)
  //   campaign_id=<uuid>    (filter to one campaign; otherwise all sequencer runs)
  //   run_date=YYYY-MM-DD   (filter to one daily run; overrides scope)
  //   q=text                (ilike across to_email, to_name, subject)
  //   limit=number          (default: 50, max 200)
  //   offset=number         (default: 0)
  router.get("/sends", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const { group, touch, status, scope = "today", campaign_id: campaignId, run_date: runDate } = req.query;
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const search = (req.query.q || "").toString().trim();

      // count: 'exact' makes Supabase issue a HEAD-style count query alongside
      // the SELECT — one round trip, returns total post-filter for pagination.
      let q = supabase
        .from("email_sends")
        .select(
          "id, sequence_id, campaign_id, touch_number, brand_group, template_variant, to_email, to_name, subject, status, sender_domain, scheduled_at, sent_at, delivered_at, opened_at, clicked_at, replied_at, bounced_at, complained_at, cancelled_at, cancel_reason, error, resend_id, created_at",
          { count: "exact" }
        )
        .eq("team_id", teamId)
        .order("scheduled_at", { ascending: false })
        .range(offset, offset + limit - 1);

      // When a campaign is specified, trust the campaign_id filter on its own.
      // Otherwise restrict to daily-200 sequencer rows (never legacy A-F).
      if (campaignId) q = q.eq("campaign_id", campaignId);
      else q = q.not("sequence_id", "is", null);

      if (group) q = q.eq("brand_group", group);
      if (touch) q = q.eq("touch_number", Number(touch));
      if (status) q = q.eq("status", status);

      if (search) {
        // PostgREST .or() requires comma-escape on user input — strip the few
        // chars that would break the filter string. ilike + % gives substring.
        const safe = search.replace(/[,()%*]/g, " ").trim();
        if (safe) q = q.or(`to_email.ilike.%${safe}%,to_name.ilike.%${safe}%,subject.ilike.%${safe}%`);
      }

      const orClause = buildScopeOr({ scope, runDate });
      if (orClause) q = q.or(orClause);

      const { data, error, count } = await q;
      if (error) throw new Error(error.message);
      res.json({ rows: data || [], total: count ?? data?.length ?? 0, limit, offset });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- GET ONE SEND ----------
  // Full row including the rendered body — kept off /sends to avoid bloating
  // the list response. Used by the in-app email preview modal.
  router.get("/sends/:id", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const { data, error } = await supabase
        .from("email_sends")
        .select("id, sequence_id, campaign_id, contact_id, touch_number, brand_group, template_variant, template_key, to_email, to_name, subject, body, status, sender_domain, scheduled_at, sent_at, delivered_at, opened_at, clicked_at, replied_at, bounced_at, complained_at, cancelled_at, cancel_reason, error, resend_id, created_at")
        .eq("team_id", teamId)
        .eq("id", req.params.id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return res.status(404).json({ error: "send not found" });
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- STATS ----------
  // Returns aggregate counts keyed by status × brand_group.
  //   scope=today (default) | all     — lifetime when "all"
  //   campaign_id=<uuid>              — filter to one campaign
  //   run_date=YYYY-MM-DD             — filter to one run; overrides scope
  router.get("/stats", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const scope = req.query.scope === "all" ? "all" : "today";
      const { campaign_id: campaignId, run_date: runDate } = req.query;
      const windowed = !!(scope === "today" || runDate);

      let q = supabase
        .from("email_sends")
        .select("brand_group, status, touch_number, delivered_at, opened_at, clicked_at, replied_at, bounced_at, complained_at")
        .eq("team_id", teamId)
        .limit(windowed ? 5000 : 50000);

      if (campaignId) q = q.eq("campaign_id", campaignId);
      else q = q.not("sequence_id", "is", null);

      const orClause = buildScopeOr({ scope, runDate });
      if (orClause) q = q.or(orClause);

      const { data, error } = await q;

      if (error) throw new Error(error.message);

      // Roll up in JS — Supabase JS client doesn't expose group-by, and at
      // 200/day × 3 touches max we're well under 1k rows so this is fine.
      // Engagement counters key off *_at columns (Resend webhooks stamp these
      // and leave row.status='sent'); operational counters key off status.
      const stats = {
        total: 0,
        byStatus: {},
        byGroup: {},
        byTouch: {},
        sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, bounced: 0, complained: 0,
        rates: {},
      };
      for (const r of data || []) {
        stats.total++;
        stats.byStatus[r.status] = (stats.byStatus[r.status] || 0) + 1;
        if (r.brand_group) stats.byGroup[r.brand_group] = (stats.byGroup[r.brand_group] || 0) + 1;
        if (r.touch_number) stats.byTouch[`T${r.touch_number}`] = (stats.byTouch[`T${r.touch_number}`] || 0) + 1;
        const leftLobby = !!(r.delivered_at || r.bounced_at) || r.status === "sent" || r.status === "bounced";
        if (leftLobby) stats.sent++;
        if (r.delivered_at) stats.delivered++;
        if (r.opened_at) stats.opened++;
        if (r.clicked_at) stats.clicked++;
        if (r.replied_at) stats.replied++;
        if (r.bounced_at) stats.bounced++;
        if (r.complained_at) stats.complained++;
      }
      // Engagement rates use delivered as denominator (industry convention —
      // a bounced email can't be opened). Bounce rate uses sent. Guard div-by-0.
      const sent = stats.sent || 1;
      const delivered = stats.delivered || 1;
      stats.rates = {
        delivered: stats.delivered / sent,
        bounced: stats.bounced / sent,
        opened: stats.opened / delivered,
        clicked: stats.clicked / delivered,
        replied: stats.replied / delivered,
      };
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- RUNS ----------
  // Distinct daily-run dates derived from T+0 scheduled_at (UTC). One row per
  // date with the cohort size (sequences enrolled that day). Used by the UI
  // run picker.
  //   campaign_id=<uuid>  (optional — restrict to one campaign)
  router.get("/runs", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const { campaign_id: campaignId } = req.query;

      let q = supabase
        .from("email_sends")
        .select("scheduled_at")
        .eq("team_id", teamId)
        .eq("touch_number", 1)
        .order("scheduled_at", { ascending: false })
        .limit(50000);
      if (campaignId) q = q.eq("campaign_id", campaignId);
      else q = q.not("sequence_id", "is", null);

      const { data, error } = await q;
      if (error) throw new Error(error.message);

      // Group by UTC date in JS — Supabase JS has no DISTINCT/GROUP BY.
      const counts = new Map();
      for (const r of data || []) {
        if (!r.scheduled_at) continue;
        const date = r.scheduled_at.slice(0, 10); // YYYY-MM-DD (already ISO/UTC)
        counts.set(date, (counts.get(date) || 0) + 1);
      }
      const runs = [...counts.entries()]
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => (a.date < b.date ? 1 : -1));
      res.json({ runs });
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
