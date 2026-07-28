// Routes for the daily-200 outbound dashboard. Powers /ai/outbound in the UI.
//
// Endpoints (all under /api/outbound, requireOpsAdmin):
//   GET  /sends           — list email_sends rows with filters
//   GET  /stats           — counts grouped by status × brand_group
//   GET  /runs            — distinct daily-run dates (for the run picker)
//   POST /stop            — cancel pending touches + add to ai_suppressions
//   GET  /inbox           — unified manual-triage replies + AI threads
//   GET  /inbox/manual/:sendId           — full reply detail (body from raw events)
//   POST /inbox/manual/:sendId/handle    — mark reply handled
//   POST /inbox/manual/:sendId/unhandle  — undo mark handled
//   POST /inbox/manual/:sendId/opt-out   — suppress + mark handled

import express from "express";
import { supabase } from "../lib/supabase.js";
import { getDefaultTeamId } from "../automation/conversation-state.js";
import { cancelPendingTouches } from "../automation/sequencer.js";
import { normalizeInboundPayload, extractReplyBody } from "../automation/inbound-parser.js";

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

      // Server-side sort: allow-listed columns only; unknown/absent sortBy
      // keeps the historical default (scheduled_at DESC).
      const SORTABLE = ["scheduled_at", "sent_at", "to_email", "to_name", "subject", "brand_group", "touch_number", "status"];
      const requestedSort = SORTABLE.includes(req.query.sortBy) ? req.query.sortBy : null;
      const sortBy = requestedSort || "scheduled_at";
      const ascending = requestedSort ? req.query.sortDir === "asc" : false;

      // count: 'exact' makes Supabase issue a HEAD-style count query alongside
      // the SELECT — one round trip, returns total post-filter for pagination.
      let q = supabase
        .from("email_sends")
        .select(
          "id, sequence_id, campaign_id, touch_number, brand_group, template_variant, to_email, to_name, subject, status, sender_domain, scheduled_at, sent_at, delivered_at, opened_at, clicked_at, replied_at, bounced_at, complained_at, cancelled_at, cancel_reason, error, resend_id, created_at",
          { count: "exact" }
        )
        .eq("team_id", teamId)
        .order(sortBy, { ascending })
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

  // ---------- INBOX ----------
  // Unified inbox: manual-triage replies (email_sends.replied_at) merged with
  // AI conversation threads (ai_conversations). The frontend renders one list
  // with a mode badge per row so an operator doesn't have to flip between
  // "Outbound" and "AI threads" mental models — there's one queue.
  //
  // Query:
  //   mode=all|manual|ai      (default all)
  //   status=unhandled|handled|all   (default unhandled; only meaningful for manual)
  //   audience=brand|influencer      (manual only — AI threads aren't tagged)
  //   campaign_id=<uuid>             (manual only — filters email_sends.campaign_id)
  //   q=text                         (ilike across to_email/prospect_email/subject)
  //   limit=number            (default 50, max 200)
  router.get("/inbox", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const {
        mode = "all",
        status = "unhandled",
        audience,
        campaign_id: campaignId,
      } = req.query;
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const search = (req.query.q || "").toString().trim();

      const wantManual = mode === "all" || mode === "manual";
      const wantAi = mode === "all" || mode === "ai";

      const rows = [];

      // ----- Manual replies (email_sends.replied_at) -----
      if (wantManual) {
        let q = supabase
          .from("email_sends")
          .select(`
            id, campaign_id, to_email, to_name, subject, sent_at, replied_at,
            handled_at, handled_by_email, audience_type, sender_domain,
            touch_number, status,
            email_campaigns!campaign_id ( name, auto_reply )
          `)
          .eq("team_id", teamId)
          .not("replied_at", "is", null)
          .order("replied_at", { ascending: false })
          .limit(limit);

        if (status === "unhandled") q = q.is("handled_at", null);
        else if (status === "handled") q = q.not("handled_at", "is", null);
        if (audience) q = q.eq("audience_type", audience);
        if (campaignId) q = q.eq("campaign_id", campaignId);
        if (search) {
          const esc = search.replace(/[,()*]/g, " ");
          q = q.or(`to_email.ilike.%${esc}%,to_name.ilike.%${esc}%,subject.ilike.%${esc}%`);
        }

        const { data, error } = await q;
        if (error) throw new Error(error.message);

        for (const r of data || []) {
          rows.push({
            mode: "manual",
            id: `manual:${r.id}`,
            send_id: r.id,
            to_email: r.to_email,
            to_name: r.to_name,
            subject: r.subject,
            campaign_id: r.campaign_id,
            campaign_name: r.email_campaigns?.name || null,
            auto_reply: r.email_campaigns?.auto_reply ?? null,
            audience_type: r.audience_type,
            sender_domain: r.sender_domain,
            touch_number: r.touch_number,
            sent_at: r.sent_at,
            last_activity_at: r.replied_at,
            unhandled: !r.handled_at,
            handled_at: r.handled_at,
            handled_by_email: r.handled_by_email,
          });
        }
      }

      // ----- AI threads (ai_conversations) -----
      if (wantAi) {
        let q = supabase
          .from("ai_conversations")
          .select(`
            id, campaign_id, prospect_email, prospect_name, prospect_company,
            status, thread_subject, last_inbound_at, last_outbound_at, updated_at,
            qualification_score,
            ai_campaigns!campaign_id ( name )
          `)
          .eq("team_id", teamId)
          .order("updated_at", { ascending: false })
          .limit(limit);

        if (search) {
          const esc = search.replace(/[,()*]/g, " ");
          q = q.or(`prospect_email.ilike.%${esc}%,prospect_name.ilike.%${esc}%,thread_subject.ilike.%${esc}%`);
        }

        const { data, error } = await q;
        if (error) throw new Error(error.message);

        for (const c of data || []) {
          // AI rows are "unhandled" when they need attention: status active or
          // escalated, and an inbound reply has arrived. Booked / qualified /
          // dead / opted_out are considered settled.
          const unhandled =
            (c.status === "active" || c.status === "escalated") &&
            !!c.last_inbound_at;
          rows.push({
            mode: "ai",
            id: `ai:${c.id}`,
            conversation_id: c.id,
            to_email: c.prospect_email,
            to_name: c.prospect_name,
            subject: c.thread_subject,
            campaign_id: c.campaign_id,
            campaign_name: c.ai_campaigns?.name || null,
            ai_status: c.status,
            qualification_score: c.qualification_score,
            last_activity_at: c.last_inbound_at || c.updated_at,
            unhandled,
          });
        }
      }

      // Merge by recency and cap at limit. Done in-memory because we already
      // capped each source query at `limit` — worst case we sort ~2*limit rows.
      rows.sort((a, b) => {
        const at = new Date(a.last_activity_at || 0).getTime();
        const bt = new Date(b.last_activity_at || 0).getTime();
        return bt - at;
      });

      res.json({ rows: rows.slice(0, limit), counts: { returned: Math.min(rows.length, limit), total_fetched: rows.length } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Full manual-triage detail. The reply body lives in ai_raw_events.payload
  // (Resend webhook log) — we look it up by `to_email` ↔ inbound `from` plus
  // a small time window around replied_at, then parse it on the fly.
  router.get("/inbox/manual/:sendId", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const { sendId } = req.params;

      const { data: send, error: sendErr } = await supabase
        .from("email_sends")
        .select(`
          id, campaign_id, to_email, to_name, subject, body, sent_at,
          replied_at, handled_at, handled_by_email, audience_type,
          sender_domain, touch_number, status, resend_id,
          email_campaigns!campaign_id ( name, auto_reply, ai_campaign_id )
        `)
        .eq("team_id", teamId)
        .eq("id", sendId)
        .maybeSingle();
      if (sendErr) throw new Error(sendErr.message);
      if (!send) return res.status(404).json({ error: "send not found" });

      // Find the matching raw event. Heuristic: same team + inbound + within
      // a 10-min window around replied_at, with from_email matching to_email.
      // 10 min handles webhook lag without false matches in normal traffic.
      let reply = null;
      let rawEventId = null;
      if (send.replied_at) {
        const t = new Date(send.replied_at).getTime();
        const lo = new Date(t - 10 * 60_000).toISOString();
        const hi = new Date(t + 10 * 60_000).toISOString();
        const { data: events, error: evErr } = await supabase
          .from("ai_raw_events")
          .select("id, payload, created_at, event_type")
          .eq("team_id", teamId)
          .gte("created_at", lo)
          .lte("created_at", hi)
          .order("created_at", { ascending: false })
          .limit(50);
        if (evErr) throw new Error(evErr.message);

        const target = (send.to_email || "").toLowerCase();
        for (const ev of events || []) {
          const norm = normalizeInboundPayload(ev.payload);
          if (!norm) continue;
          if ((norm.from_email || "").toLowerCase() !== target) continue;
          const body = extractReplyBody(norm);
          if (!body || !body.trim()) continue;
          reply = {
            from_email: norm.from_email,
            from_name: norm.from_name,
            subject: norm.subject,
            body,
            received_at: ev.created_at,
            message_id: norm.message_id,
          };
          rawEventId = ev.id;
          break;
        }
      }

      // Suppression state (so the UI can show "already opted out" instead of
      // offering the opt-out action again).
      const { data: sup } = await supabase
        .from("ai_suppressions")
        .select("reason, detail, created_at")
        .eq("team_id", teamId)
        .ilike("email", send.to_email)
        .maybeSingle();

      res.json({
        send: {
          id: send.id,
          campaign_id: send.campaign_id,
          campaign_name: send.email_campaigns?.name || null,
          auto_reply: send.email_campaigns?.auto_reply ?? null,
          ai_campaign_id: send.email_campaigns?.ai_campaign_id || null,
          to_email: send.to_email,
          to_name: send.to_name,
          subject: send.subject,
          body: send.body,
          sent_at: send.sent_at,
          replied_at: send.replied_at,
          handled_at: send.handled_at,
          handled_by_email: send.handled_by_email,
          audience_type: send.audience_type,
          sender_domain: send.sender_domain,
          touch_number: send.touch_number,
          status: send.status,
          resend_id: send.resend_id,
        },
        reply,
        raw_event_id: rawEventId,
        suppression: sup || null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Mark a manual-triage reply as handled. `handled_by_email` is the operator
  // (req.admin), surfaced in the row so the team can see who cleared what.
  router.post("/inbox/manual/:sendId/handle", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const { sendId } = req.params;
      const adminEmail = req.admin?.email || null;
      const { error } = await supabase
        .from("email_sends")
        .update({ handled_at: new Date().toISOString(), handled_by_email: adminEmail })
        .eq("team_id", teamId)
        .eq("id", sendId);
      if (error) throw new Error(error.message);
      res.json({ ok: true, handled_by_email: adminEmail });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Undo handled — clears handled_at + handled_by_email. Useful if an operator
  // marks a row by mistake; preferable to forcing them to remember the prior
  // audit value.
  router.post("/inbox/manual/:sendId/unhandle", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const { sendId } = req.params;
      const { error } = await supabase
        .from("email_sends")
        .update({ handled_at: null, handled_by_email: null })
        .eq("team_id", teamId)
        .eq("id", sendId);
      if (error) throw new Error(error.message);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Opt-out combo: upserts the prospect to ai_suppressions, cancels remaining
  // touches, and stamps handled_at. Saves the operator three clicks for the
  // common "they said no thanks" case.
  router.post("/inbox/manual/:sendId/opt-out", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const { sendId } = req.params;
      const adminEmail = req.admin?.email || null;
      const note = (req.body?.note || "").toString().slice(0, 500) || "ui inbox opt-out";

      const { data: send, error: sendErr } = await supabase
        .from("email_sends")
        .select("id, to_email")
        .eq("team_id", teamId)
        .eq("id", sendId)
        .maybeSingle();
      if (sendErr) throw new Error(sendErr.message);
      if (!send) return res.status(404).json({ error: "send not found" });

      const email = (send.to_email || "").toLowerCase().trim();
      if (!email) return res.status(400).json({ error: "send has no to_email" });

      const { error: supErr } = await supabase
        .from("ai_suppressions")
        .upsert(
          { team_id: teamId, email, reason: "opt_out", detail: note },
          { onConflict: "team_id,email" }
        );
      if (supErr) throw new Error(supErr.message);

      const { cancelled } = await cancelPendingTouches({ teamId, email, reason: "opted_out" });

      const { error: updErr } = await supabase
        .from("email_sends")
        .update({ handled_at: new Date().toISOString(), handled_by_email: adminEmail })
        .eq("team_id", teamId)
        .eq("id", sendId);
      if (updErr) throw new Error(updErr.message);

      res.json({ ok: true, cancelled, suppressed: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
