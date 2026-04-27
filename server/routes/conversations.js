// REST API for the AI conversation manager.
//
//   Public (no auth — webhook from email provider):
//     POST /api/conversations/inbound       — webhook for Resend Inbound / SendGrid / etc.
//
//   Admin-only (requireOpsAdmin from auth.js — mounted by index.js):
//     GET  /api/conversations/campaigns
//     POST /api/conversations/campaigns
//     GET  /api/conversations/campaigns/:id
//     PUT  /api/conversations/campaigns/:id
//     POST /api/conversations/campaigns/:id/seed-defaults
//
//     GET  /api/conversations/threads?campaign=&status=
//     GET  /api/conversations/threads/:id
//
//     POST /api/conversations/start          — send first message to one prospect
//     POST /api/conversations/test-lab/turn  — Test Lab: simulate one turn (no send)
//     POST /api/conversations/run-due        — cron: send due scheduled outbound

import { Router } from "express";
import {
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  listConversations,
  getConversation,
  listMessages,
  getDefaultTeamId,
  logRawEvent,
  listSuppressions,
  listRawEvents,
  listBulkRuns,
} from "../automation/conversation-state.js";
import {
  sendFirstMessage,
  handleInbound,
  sendDueScheduled,
  handleResendStatusEvent,
} from "../automation/conversation-runner.js";
import { verifySvixSignature, svixHeaders } from "../lib/webhook-verify.js";
import {
  generateFirstMessage,
  generateReply,
  applyToolCalls,
} from "../automation/conversation-ai.js";
import {
  buildContextPrompt,
  DEFAULT_OFFERING,
  DEFAULT_PERSONA,
} from "../automation/conversation-prompts.js";

// Two routers: one open (webhooks), one admin-gated.
export function conversationsRoutes() {
  const router = Router();

  // ---------- CAMPAIGNS ----------

  router.get("/campaigns", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      res.json(await listCampaigns(teamId));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/campaigns", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const {
        name,
        offering,
        persona,
        contextPrompt,
        firstMessagePrompt,
        goal,
        goalLink,
        replyModel,
        firstMessageModel,
      } = req.body;
      if (!name) return res.status(400).json({ error: "name required" });

      const mergedOffering = { ...DEFAULT_OFFERING, ...(offering || {}) };
      const mergedPersona = { ...DEFAULT_PERSONA, ...(persona || {}) };
      const goalText = goal || "book a 15-min intro call";
      const goalLinkResolved = goalLink || process.env.LINKABLE_CALENDAR_URL || null;

      const ctx = contextPrompt || buildContextPrompt({
        offering: mergedOffering,
        persona: mergedPersona,
        goal: goalText,
        goalLink: goalLinkResolved,
      });
      const fm = firstMessagePrompt || "(generated per-prospect by buildFirstMessagePrompt)";

      const campaign = await createCampaign({
        teamId,
        name,
        offering: mergedOffering,
        persona: mergedPersona,
        contextPrompt: ctx,
        firstMessagePrompt: fm,
        goal: goalText,
        goalLink: goalLinkResolved,
        replyModel,
        firstMessageModel,
      });
      res.json(campaign);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/campaigns/:id", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const campaign = await getCampaign(req.params.id, teamId);
      res.json(campaign);
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  router.put("/campaigns/:id", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const allowed = [
        "name", "status", "offering", "persona", "context_prompt",
        "first_message_prompt", "goal", "goal_link",
        "reply_min_seconds", "reply_max_seconds",
        "reply_model", "first_message_model",
      ];
      const patch = {};
      for (const k of allowed) if (k in req.body) patch[k] = req.body[k];

      // If offering/persona/goal changed and the user didn't supply a context_prompt, regenerate it.
      if (("offering" in patch || "persona" in patch || "goal" in patch || "goal_link" in patch) && !("context_prompt" in patch)) {
        const current = await getCampaign(req.params.id, teamId);
        const merged = {
          offering: patch.offering || current.offering,
          persona: patch.persona || current.persona,
          goal: patch.goal || current.goal,
          goalLink: patch.goal_link ?? current.goal_link,
        };
        patch.context_prompt = buildContextPrompt(merged);
      }

      const campaign = await updateCampaign(req.params.id, teamId, patch);
      res.json(campaign);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Convenience: regenerate context prompt from current offering/persona.
  router.post("/campaigns/:id/regenerate-context", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const c = await getCampaign(req.params.id, teamId);
      const ctx = buildContextPrompt({
        offering: c.offering,
        persona: c.persona,
        goal: c.goal,
        goalLink: c.goal_link,
      });
      const updated = await updateCampaign(req.params.id, teamId, { context_prompt: ctx });
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Defaults preview (no save) — for the "Create campaign" form.
  router.get("/defaults", (req, res) => {
    res.json({
      offering: DEFAULT_OFFERING,
      persona: DEFAULT_PERSONA,
      goal: "book a 15-min intro call",
      goal_link: process.env.LINKABLE_CALENDAR_URL || null,
      reply_min_seconds: 120,
      reply_max_seconds: 900,
      reply_model: "claude-sonnet-4-6",
      first_message_model: "claude-haiku-4-5-20251001",
    });
  });

  // ---------- THREADS / MESSAGES ----------

  router.get("/threads", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const threads = await listConversations(teamId, {
        campaignId: req.query.campaign,
        status: req.query.status,
        limit: Math.min(parseInt(req.query.limit) || 100, 500),
      });
      res.json(threads);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/threads/:id", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const conv = await getConversation(req.params.id, teamId);
      const messages = await listMessages(req.params.id, teamId);
      res.json({ ...conv, messages });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // ---------- START / TEST ----------

  router.post("/start", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const { campaignId, prospect, dryRun } = req.body;
      if (!campaignId) return res.status(400).json({ error: "campaignId required" });
      if (!prospect?.email) return res.status(400).json({ error: "prospect.email required" });
      const result = await sendFirstMessage({ teamId, campaignId, prospect, dryRun: !!dryRun });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Test Lab: simulate ONE turn against a campaign without sending email.
  // Body: { campaignId, prospect, history: [{direction, body}], scenario }
  // - If history is empty → generate a first message.
  // - If history ends with an inbound → generate a reply.
  // Nothing is persisted unless you pass { persist: true }.
  router.post("/test-lab/turn", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const { campaignId, prospect, history, persist } = req.body;
      if (!campaignId) return res.status(400).json({ error: "campaignId required" });
      const campaign = await getCampaign(campaignId, teamId);
      const safeProspect = prospect || { email: "test@example.com", name: "Test Prospect" };

      // Empty history → first message
      if (!history || history.length === 0) {
        const gen = await generateFirstMessage({ campaign, prospect: safeProspect });
        return res.json({ kind: "first_message", ...gen });
      }

      // Otherwise → reply
      // Stub conversation object (the LLM uses it for dossier injection)
      const stubConv = {
        prospect_email: safeProspect.email,
        prospect_name: safeProspect.name,
        prospect_company: safeProspect.company || safeProspect.domain,
        prospect_dossier: safeProspect,
        status: "active",
        qualification_score: 0,
      };
      const gen = await generateReply({ campaign, conversation: stubConv, history });
      const stateUpdate = applyToolCalls(stubConv, gen.tool_calls);
      res.json({ kind: "reply", ...gen, derived_status: stateUpdate.status });

      // (persist: true is intentionally ignored in test lab — keeps the lab clean.
      // To actually run the campaign use /start.)
      void persist;
    } catch (err) {
      res.status(500).json({ error: err.message, stack: err.stack?.split("\n").slice(0, 4) });
    }
  });

  // Cron: pick up scheduled outbound rows whose time has come and send them.
  router.post("/run-due", async (req, res) => {
    try {
      const result = await sendDueScheduled({ limit: req.body?.limit || 50 });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Bulk first-message run (background; poll the returned run_id).
  router.post("/bulk-start", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const { campaignId, source = "scraper_results", filters = {}, limit = 50, dryRun } = req.body;
      if (!campaignId) return res.status(400).json({ error: "campaignId required" });
      const { startBulkRun } = await import("../automation/conversation-bulk.js");
      const result = await startBulkRun({
        teamId,
        campaignId,
        source,
        filters,
        limit: Math.min(parseInt(limit) || 50, 1000),
        dryRun: !!dryRun,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Stop a running bulk run (cooperative cancellation).
  router.post("/bulk-runs/:id/stop", async (req, res) => {
    try {
      const { supabase } = await import("../lib/supabase.js");
      const teamId = await getDefaultTeamId();
      const { data, error } = await supabase
        .from("ai_bulk_runs")
        .update({ status: "stopped", completed_at: new Date().toISOString() })
        .eq("id", req.params.id)
        .eq("team_id", teamId)
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Suppressions list (CAN-SPAM hygiene)
  router.get("/suppressions", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      res.json(await listSuppressions(teamId, { limit: parseInt(req.query.limit) || 200 }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Recent raw webhook events (for debugging "why didn't this reply land")
  router.get("/events", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      res.json(await listRawEvents(teamId, { limit: parseInt(req.query.limit) || 100 }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Bulk runs history
  router.get("/bulk-runs", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      res.json(await listBulkRuns(teamId, { limit: parseInt(req.query.limit) || 25 }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Debug: fetch one email via Resend's API by id. Tells us if the API even
  // returns body content for inbound emails.
  router.get("/debug/resend-email/:id", async (req, res) => {
    try {
      const { fetchResendEmail } = await import("../automation/inbound-parser.js");
      const data = await fetchResendEmail(req.params.id);
      res.json({
        ok: true,
        keys: Object.keys(data || {}),
        text_len: (data.text || "").length,
        html_len: (data.html || "").length,
        text_preview: (data.text || "").slice(0, 300),
        html_preview: (data.html || "").slice(0, 300),
        full: data,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Debug: replay a stored ai_raw_events row through handleInbound.
  // Useful to re-run after deploying parser fixes without making the user
  // send another reply.
  router.post("/debug/replay-event/:id", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const { supabase } = await import("../lib/supabase.js");
      const { data: ev, error } = await supabase
        .from("ai_raw_events")
        .select("payload, event_type")
        .eq("id", req.params.id)
        .eq("team_id", teamId)
        .maybeSingle();
      if (error || !ev) return res.status(404).json({ error: error?.message || "event not found" });
      const { handleInbound, handleResendStatusEvent } = await import("../automation/conversation-runner.js");
      const result = ev.event_type === "email.received" || ev.event_type?.includes("inbound")
        ? await handleInbound(ev.payload)
        : await handleResendStatusEvent(ev.payload);
      res.json({ replayed: true, event_type: ev.event_type, result });
    } catch (err) {
      res.status(500).json({ error: err.message, stack: err.stack?.split("\n").slice(0, 5) });
    }
  });

  return router;
}

// Webhook router — separate, mounted WITHOUT requireOpsAdmin.
//
// Resend signs every webhook payload via Svix. We verify the signature using
// the raw request body (captured by the verify callback in server/index.js),
// log the event regardless of validity, then dispatch by event type.
//
// Event types:
//   email.received           → handleInbound (prospect reply)
//   email.bounced            → suppression + mark conversation dead
//   email.complained         → suppression + opt-out
//   email.delivered          → no-op (heartbeat)
//   email.opened/clicked     → ignored (we don't act on these for now)
export function conversationsWebhookRoutes() {
  const router = Router();

  router.post("/inbound", async (req, res) => {
    const eventType = req.body?.type || null;
    const headers = req.headers || {};
    let signatureValid = null;
    let teamId = null;

    // Verify signature when a signing secret is configured.
    const signingSecret = process.env.RESEND_WEBHOOK_SIGNING_SECRET;
    if (signingSecret) {
      const { msgId, timestamp, signatureHeader } = svixHeaders(req);
      const result = verifySvixSignature({
        secret: signingSecret,
        rawBody: req.rawBody,
        msgId,
        timestamp,
        signatureHeader,
      });
      signatureValid = result.valid;
      if (!result.valid) {
        try {
          await logRawEvent({
            teamId,
            source: "resend",
            eventType,
            signatureValid: false,
            payload: req.body,
            headers: pickSafeHeaders(headers),
            handlerError: `signature: ${result.reason}`,
          });
        } catch (err) {
          console.error("logRawEvent failed:", err.message);
        }
        return res.status(401).json({ error: `bad signature (${result.reason})` });
      }
    } else {
      // Fallback: shared-secret in URL/header (dev/testing only).
      const expected = process.env.INBOUND_WEBHOOK_SECRET;
      const provided =
        req.query.secret || headers["x-webhook-secret"];
      if (expected && provided !== expected) {
        return res.status(401).json({ error: "bad secret" });
      }
    }

    try {
      teamId = await getDefaultTeamId();
    } catch (err) {
      // We don't have a team — still log to console so we know the request hit.
      console.error("getDefaultTeamId failed:", err.message);
    }

    let handlerResult = null;
    let handlerError = null;
    try {
      if (eventType === "email.received" || eventType?.includes("inbound")) {
        handlerResult = await handleInbound(req.body);
      } else if (eventType?.startsWith("email.")) {
        handlerResult = await handleResendStatusEvent(req.body);
      } else if (!eventType) {
        // No type field — assume legacy/test inbound payload.
        handlerResult = await handleInbound(req.body);
      } else {
        handlerResult = { ignored: `unhandled event: ${eventType}` };
      }
    } catch (err) {
      handlerError = err.message;
      console.error("webhook handler error:", err);
    }

    // Log every event for replay/debug. Must await — on Vercel serverless,
    // unawaited promises get killed when the function suspends after the
    // response.
    try {
      await logRawEvent({
        teamId,
        source: "resend",
        eventType,
        signatureValid,
        payload: req.body,
        headers: pickSafeHeaders(headers),
        handlerResult,
        handlerError,
      });
    } catch (err) {
      console.error("logRawEvent failed:", err.message);
    }

    if (handlerError) return res.status(500).json({ error: handlerError });
    res.json(handlerResult || { ok: true });
  });

  return router;
}

// Drop auth/cookie headers before logging — defense in depth.
function pickSafeHeaders(headers) {
  const out = {};
  const allow = [
    "svix-id", "svix-timestamp", "svix-signature",
    "webhook-id", "webhook-timestamp", "webhook-signature",
    "user-agent", "content-type",
  ];
  for (const k of allow) if (headers[k]) out[k] = headers[k];
  return out;
}
