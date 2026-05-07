// Campaign + template management routes for the daily-200 sequencer.
// Mounted at /api/outbound (alongside outbound.js).
//
// Endpoints:
//   GET    /campaigns                          — list
//   POST   /campaigns                          — create + seed default 9 templates
//   GET    /campaigns/:id                      — detail + templates + metrics
//   PUT    /campaigns/:id                      — update fields
//   POST   /campaigns/:id/pause                — status='paused'
//   POST   /campaigns/:id/resume               — status='active'
//   POST   /campaigns/:id/archive              — status='archived'
//   GET    /campaigns/:id/metrics              — deliverability rollup
//
//   GET    /campaigns/:id/templates            — list this campaign's templates
//   POST   /campaigns/:id/templates            — create one
//   POST   /campaigns/:id/templates/seed-defaults  — copy SEQUENCE_TEMPLATES
//   POST   /campaigns/:id/templates/generate-drafts — AI generates drafts
//
//   PUT    /templates/:id                      — update one
//   DELETE /templates/:id                      — soft delete (is_active=false)

import express from "express";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { supabase } from "../lib/supabase.js";
import { getDefaultTeamId, createCampaign as createAiCampaign } from "../automation/conversation-state.js";
import { DEFAULT_OFFERING, DEFAULT_PERSONA, buildContextPrompt } from "../automation/conversation-prompts.js";
import { SEQUENCE_TEMPLATES } from "../automation/templates.js";
import { CATEGORY_PRESETS } from "../automation/lead-discovery.js";

// Snapshot of distinct StoreLeads category paths discovered by sampling the
// index. Refresh via scripts/refresh-storeleads-categories.js.
let STORELEADS_CATEGORIES = [];
try {
  const here = dirname(fileURLToPath(import.meta.url));
  STORELEADS_CATEGORIES = JSON.parse(readFileSync(join(here, "..", "data", "storeleads-categories.json"), "utf-8"));
} catch (e) {
  console.warn("storeleads-categories.json not loaded:", e.message);
}

export function outboundCampaignsRoutes() {
  const router = express.Router();

  // ---------- CAMPAIGNS ----------

  router.get("/campaigns", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const status = (req.query.status || "all").toString();
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

      let q = supabase.from("email_campaigns")
        .select("*", { count: "exact" })
        .eq("team_id", teamId);
      if (status !== "all") q = q.eq("status", status);
      q = q.order("created_at", { ascending: false }).range(offset, offset + limit - 1);

      const { data, error, count } = await q;
      if (error) throw new Error(error.message);
      res.json({ rows: data || [], total: count || 0, limit, offset });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get("/campaigns/status-counts", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const { data, error } = await supabase
        .from("email_campaigns")
        .select("status")
        .eq("team_id", teamId);
      if (error) throw new Error(error.message);
      const counts = { all: data.length };
      for (const r of data) counts[r.status] = (counts[r.status] || 0) + 1;
      res.json(counts);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post("/campaigns", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const body = req.body || {};
      if (!body.name) return res.status(400).json({ error: "name required" });

      const insertRow = {
        team_id: teamId,
        name: body.name,
        status: body.status || "active",
        source: "daily-200",
        target_filters: body.target_filters || {},
        daily_cap: body.daily_cap || 200,
        sender_from: body.sender_from || "Federico from Linkable <brand@linkable.link>",
        reply_to: body.reply_to || "brand@linkable.link",
        auto_reply: !!body.auto_reply,
        ai_campaign_id: body.ai_campaign_id || null,
        brief: body.brief || null,
      };

      const { data: campaign, error } = await supabase
        .from("email_campaigns")
        .insert(insertRow)
        .select("*")
        .single();
      if (error) throw new Error(error.message);

      // Seed the 9 default templates linked to this campaign.
      const templates = await seedDefaultTemplates(teamId, campaign.id);

      res.json({ campaign, templates });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get("/campaigns/:id", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const { data: campaign, error: cErr } = await supabase
        .from("email_campaigns")
        .select("*")
        .eq("team_id", teamId).eq("id", req.params.id)
        .single();
      if (cErr) throw new Error(cErr.message);

      const { data: templates } = await supabase
        .from("email_templates")
        .select("*")
        .eq("team_id", teamId).eq("campaign_id", campaign.id)
        .order("brand_group", { ascending: true })
        .order("touch_number", { ascending: true })
        .order("created_at", { ascending: true });

      const metrics = await rollupCampaignMetrics(teamId, campaign.id);
      res.json({ campaign, templates: templates || [], metrics });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.put("/campaigns/:id", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const allowed = ["name", "status", "target_filters", "daily_cap", "sender_from", "reply_to", "auto_reply", "ai_campaign_id", "brief", "config"];
      const patch = {};
      for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: "no updatable fields in body" });
      }

      // Auto-link the AI persona when auto_reply is turned on and the campaign
      // doesn't already have one. Keeps the UI to a single toggle by hiding the
      // ai_campaigns concept — we create or reuse an ai_campaigns row tied to
      // this email campaign so the conversation runner has somewhere to thread.
      if (patch.auto_reply === true && !patch.ai_campaign_id) {
        const { data: current } = await supabase
          .from("email_campaigns").select("id,name,brief,ai_campaign_id")
          .eq("team_id", teamId).eq("id", req.params.id).maybeSingle();
        if (current && !current.ai_campaign_id) {
          const offering = { ...DEFAULT_OFFERING };
          const persona = { ...DEFAULT_PERSONA };
          const goal = "book a 15-min intro call";
          const goalLink = process.env.LINKABLE_CALENDAR_URL || null;
          const ctx = current.brief
            ? `${buildContextPrompt({ offering, persona, goal, goalLink })}\n\nCampaign brief:\n${current.brief}`
            : buildContextPrompt({ offering, persona, goal, goalLink });
          const aiCampaign = await createAiCampaign({
            teamId,
            name: `${current.name} — replies`,
            offering,
            persona,
            contextPrompt: ctx,
            firstMessagePrompt: "(generated per-prospect by buildFirstMessagePrompt)",
            goal,
            goalLink,
          });
          patch.ai_campaign_id = aiCampaign.id;
        }
      }

      const { data, error } = await supabase
        .from("email_campaigns")
        .update(patch)
        .eq("team_id", teamId).eq("id", req.params.id)
        .select("*").single();
      if (error) throw new Error(error.message);
      res.json({ campaign: data });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post("/campaigns/:id/pause", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const { data, error } = await supabase
        .from("email_campaigns")
        .update({ status: "paused", paused_at: new Date().toISOString() })
        .eq("team_id", teamId).eq("id", req.params.id)
        .select("*").single();
      if (error) throw new Error(error.message);
      res.json({ campaign: data });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post("/campaigns/:id/resume", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const { data, error } = await supabase
        .from("email_campaigns")
        .update({ status: "active", paused_at: null })
        .eq("team_id", teamId).eq("id", req.params.id)
        .select("*").single();
      if (error) throw new Error(error.message);
      res.json({ campaign: data });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post("/campaigns/:id/archive", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const { data, error } = await supabase
        .from("email_campaigns")
        .update({ status: "archived" })
        .eq("team_id", teamId).eq("id", req.params.id)
        .select("*").single();
      if (error) throw new Error(error.message);
      res.json({ campaign: data });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get("/campaigns/:id/metrics", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const metrics = await rollupCampaignMetrics(teamId, req.params.id);
      res.json(metrics);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Run lead-discovery using this campaign's target_filters. Background job —
  // returns { run_id } immediately; UI polls ai_bulk_runs for progress.
  router.post("/campaigns/:id/discover", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const { data: campaign, error } = await supabase
        .from("email_campaigns").select("*")
        .eq("team_id", teamId).eq("id", req.params.id).single();
      if (error) throw new Error(error.message);

      const tf = campaign.target_filters || {};
      const filters = {
        countries: (tf.countries || []).join(" "),
        minRevenue: tf.min_revenue,
        maxRevenue: tf.max_revenue,
        categories: tf.categories || [],
      };
      const limit = Math.min(Number(req.body?.limit) || 100, 500);

      const { startLeadDiscovery } = await import("../automation/lead-discovery.js");
      // Pass campaignId=null because ai_bulk_runs.campaign_id FKs to ai_campaigns,
      // not email_campaigns. (Migration 009 dropped the NOT NULL constraint.)
      // Tag the run via filters so we can correlate later.
      const out = await startLeadDiscovery({
        teamId,
        campaignId: null,
        filters: { ...filters, email_campaign_id: campaign.id },
        limit,
      });
      res.json(out);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // List recent discovery runs for this campaign. The discover route tags each
  // run with filters.email_campaign_id, which is what we filter on here.
  router.get("/campaigns/:id/discovery-runs", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
      const { data, error } = await supabase
        .from("ai_bulk_runs")
        .select("id,status,source,filters,total,processed,sent,skipped,failed,error,started_at,completed_at,created_at")
        .eq("team_id", teamId)
        .eq("source", "discover_storeleads")
        .eq("filters->>email_campaign_id", req.params.id)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      res.json({ rows: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get("/storeleads/category-presets", async (_req, res) => {
    const presets = Object.entries(CATEGORY_PRESETS).map(([id, p]) => ({ id, label: p.label }));
    res.json({ presets });
  });

  // Full category list discovered from the StoreLeads index. Returns paths
  // (Google product taxonomy) with brand counts so the UI can sort by relevance.
  // Matching is token-based and plural-tolerant: "drinks" matches "Drink",
  // "kids shoes" matches "Kids' Footwear", etc.
  router.get("/storeleads/categories", async (req, res) => {
    const q = (req.query.q || "").toString().trim().toLowerCase();
    if (!q) return res.json({ categories: STORELEADS_CATEGORIES.slice(0, 200) });

    const tokens = q.split(/\s+/).filter(Boolean).map((t) => t.replace(/s$/, ""));
    const matches = STORELEADS_CATEGORIES.filter((c) => {
      const hay = c.path.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
    res.json({ categories: matches.slice(0, 200) });
  });

  // Team-wide pool of brands StoreLeads/Apollo/Hunter has discovered. Used by
  // the daily-200 sender as its inbox of available prospects, and now also by
  // the campaign-detail "Recent leads" panel.
  // Helper: apply campaign-style targeting filters to a storeleads_brands query.
  function applyLeadFilters(query, req) {
    const countries = (req.query.country || "").toString().trim();
    const minRevenue = parseInt(req.query.minRevenue, 10);
    const maxRevenue = parseInt(req.query.maxRevenue, 10);
    if (countries) {
      const list = countries.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (list.length) query = query.in("country_code", list);
    }
    // Revenue stored under raw_data.er (StoreLeads' estimated monthly USD).
    if (Number.isFinite(minRevenue) && minRevenue > 0) {
      query = query.gte("raw_data->>er", String(minRevenue));
    }
    if (Number.isFinite(maxRevenue) && maxRevenue > 0) {
      query = query.lte("raw_data->>er", String(maxRevenue));
    }
    return query;
  }

  router.get("/leads", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const q = (req.query.q || "").toString().trim();
      const onlyQualified = req.query.qualified !== "false"; // default true
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

      let query = supabase.from("storeleads_brands")
        .select("id,domain,email,contact_first_name,contact_last_name,contact_position,contact_source,country_code,categories,imported_at,emailed,emailed_at,raw_data", { count: "exact" })
        .eq("team_id", teamId);
      if (onlyQualified) query = query.not("email", "is", null);
      if (q) query = query.or(`domain.ilike.%${q}%,email.ilike.%${q}%,contact_first_name.ilike.%${q}%,contact_last_name.ilike.%${q}%`);
      query = applyLeadFilters(query, req);
      query = query.order("imported_at", { ascending: false }).range(offset, offset + limit - 1);

      const { data, error, count } = await query;
      if (error) throw new Error(error.message);
      res.json({ rows: data || [], total: count || 0 });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get("/leads/counts", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const mk = () => applyLeadFilters(supabase.from("storeleads_brands")
        .select("id", { count: "exact", head: true }).eq("team_id", teamId), req);
      const { count: total }     = await mk();
      const { count: qualified } = await mk().not("email", "is", null);
      const { count: emailed }   = await mk().eq("emailed", true);
      res.json({ total: total || 0, qualified: qualified || 0, emailed: emailed || 0 });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Cooperative cancel — the discovery worker polls for status='stopped'.
  router.post("/discovery-runs/:id/stop", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const { data, error } = await supabase
        .from("ai_bulk_runs")
        .update({ status: "stopped" })
        .eq("team_id", teamId).eq("id", req.params.id).eq("status", "running")
        .select("id").maybeSingle();
      if (error) throw new Error(error.message);
      res.json({ stopped: !!data });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ---------- TEMPLATES ----------

  router.get("/campaigns/:id/templates", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const { data, error } = await supabase
        .from("email_templates")
        .select("*")
        .eq("team_id", teamId).eq("campaign_id", req.params.id)
        .order("brand_group", { ascending: true })
        .order("touch_number", { ascending: true })
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      res.json({ rows: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post("/campaigns/:id/templates", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const body = req.body || {};
      const required = ["subject_template", "body_template"];
      for (const k of required) {
        if (!body[k]) return res.status(400).json({ error: `${k} required` });
      }
      const variant = body.variant || (body.brand_group && body.touch_number ? `${body.brand_group}-T${body.touch_number}` : "X").slice(0, 1);
      const row = {
        team_id: teamId,
        campaign_id: req.params.id,
        name: body.name || `${body.brand_group || "?"}-T${body.touch_number || "?"} variant`,
        variant: variant.toUpperCase(),
        brand_group: body.brand_group || null,
        touch_number: body.touch_number || null,
        template_key: body.template_key || (body.brand_group && body.touch_number ? `${body.brand_group}-T${body.touch_number}` : null),
        subject_template: body.subject_template,
        body_template: body.body_template,
        weight: body.weight ?? 100,
        is_active: body.is_active !== false,
        is_draft: !!body.is_draft,
        generated_by_ai: !!body.generated_by_ai,
      };
      const { data, error } = await supabase.from("email_templates").insert(row).select("*").single();
      if (error) throw new Error(error.message);
      res.json({ template: data });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post("/campaigns/:id/templates/seed-defaults", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const templates = await seedDefaultTemplates(teamId, req.params.id);
      res.json({ templates });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post("/campaigns/:id/templates/generate-drafts", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const { data: campaign, error: cErr } = await supabase
        .from("email_campaigns").select("*")
        .eq("team_id", teamId).eq("id", req.params.id).single();
      if (cErr) throw new Error(cErr.message);

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

      const opts = {
        groups: req.body?.groups || ["G1", "G2", "G3"],
        touches: req.body?.touches || [1, 2, 3],
        briefOverride: req.body?.brief,
        refinementPrompt: typeof req.body?.refinement_prompt === "string" ? req.body.refinement_prompt.trim() : "",
      };

      const drafts = await generateDraftsForCampaign({ teamId, campaign, apiKey, ...opts });
      res.json({ drafts });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.put("/templates/:id", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      const allowed = ["name", "subject_template", "body_template", "weight", "is_active", "is_draft", "brand_group", "touch_number", "template_key"];
      const patch = {};
      for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: "no updatable fields" });
      }
      const { data, error } = await supabase
        .from("email_templates")
        .update(patch)
        .eq("team_id", teamId).eq("id", req.params.id)
        .select("*").single();
      if (error) throw new Error(error.message);
      res.json({ template: data });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete("/templates/:id", async (req, res) => {
    try {
      const teamId = await getDefaultTeamId();
      // Soft delete — flip is_active=false so historical email_sends still resolve.
      const { data, error } = await supabase
        .from("email_templates")
        .update({ is_active: false })
        .eq("team_id", teamId).eq("id", req.params.id)
        .select("id").single();
      if (error) throw new Error(error.message);
      res.json({ deleted: !!data });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
}

// ---------- HELPERS ----------

async function seedDefaultTemplates(teamId, campaignId) {
  // Insert one row per (group, touch). If any rows already exist for this
  // campaign at that key, we skip — idempotent.
  const { data: existing } = await supabase
    .from("email_templates")
    .select("template_key")
    .eq("team_id", teamId).eq("campaign_id", campaignId);
  const seen = new Set((existing || []).map((r) => r.template_key));

  const rows = [];
  for (const t of SEQUENCE_TEMPLATES) {
    if (seen.has(t.key)) continue;
    rows.push({
      team_id: teamId,
      campaign_id: campaignId,
      name: t.name,
      variant: t.group.charAt(1) || "A",   // 'G1' → '1' → fits the legacy CHAR(1) field
      brand_group: t.group,
      touch_number: t.touch,
      template_key: t.key,
      subject_template: t.subject_template,
      body_template: t.body_template,
      weight: 100,
      is_active: true,
      is_draft: false,
      generated_by_ai: false,
    });
  }
  if (rows.length === 0) {
    const { data: all } = await supabase
      .from("email_templates")
      .select("*")
      .eq("team_id", teamId).eq("campaign_id", campaignId);
    return all || [];
  }

  const { data, error } = await supabase
    .from("email_templates").insert(rows).select("*");
  if (error) throw new Error(`seedDefaultTemplates: ${error.message}`);
  return data || [];
}

async function rollupCampaignMetrics(teamId, campaignId) {
  // Pull all email_sends for this campaign in JS-side rollup. At 200/day × 30
  // days × 3 touches = 18k rows, well under any reasonable batch.
  const { data, error } = await supabase
    .from("email_sends")
    .select("status, brand_group, touch_number, opened_at, clicked_at, delivered_at, bounced_at, replied_at, complained_at")
    .eq("team_id", teamId).eq("campaign_id", campaignId)
    .limit(50000);
  if (error) throw new Error(`rollupCampaignMetrics: ${error.message}`);

  // Counters split by source:
  //   - lifecycle counts come from *_at timestamps (set once by Resend webhooks)
  //   - lobby counts come from `status` for rows that never left the queue
  // Mixing the two double-counts (e.g. status='bounced' + bounced_at set).
  const m = {
    total: 0,
    sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0,
    bounced: 0, complained: 0, cancelled: 0, failed: 0, scheduled: 0, pending: 0,
    rates: {},
    byGroup: {},
    byTouch: {},
  };
  for (const r of data || []) {
    m.total++;
    const left_lobby = !!(r.delivered_at || r.bounced_at) || r.status === "sent" || r.status === "bounced";
    if (left_lobby) m.sent++;
    if (r.delivered_at) m.delivered++;
    if (r.bounced_at) m.bounced++;
    if (r.opened_at) m.opened++;
    if (r.clicked_at) m.clicked++;
    if (r.replied_at) m.replied++;
    if (r.complained_at) m.complained++;
    if (r.status === "cancelled") m.cancelled++;
    else if (r.status === "scheduled") m.scheduled++;
    else if (r.status === "pending") m.pending++;
    else if (r.status === "failed") m.failed++;
    if (r.brand_group) m.byGroup[r.brand_group] = (m.byGroup[r.brand_group] || 0) + 1;
    if (r.touch_number) m.byTouch[`T${r.touch_number}`] = (m.byTouch[`T${r.touch_number}`] || 0) + 1;
  }
  const sent = m.sent || 1;
  const delivered = m.delivered || 1;
  m.rates = {
    delivered: m.delivered / sent,
    bounced: m.bounced / sent,
    complained: m.complained / sent,
    // engagement rates use delivered as the denominator (industry convention —
    // a bounced email can't be opened, so it shouldn't drag the open rate down)
    opened: m.opened / delivered,
    clicked: m.clicked / delivered,
    replied: m.replied / delivered,
  };
  return m;
}

// ---------- AI DRAFT GENERATION ----------

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

const GROUP_DESCRIPTIONS = {
  G1: "Brands that already work with creators / affiliates / influencers. They get the model — pitch is 'measure what you're already doing, find the 5% that drive 80% of revenue'.",
  G2: "Summer-seasonal brands (drinks, swim, sun/bath/body, fragrance, outdoor). Pitch hinges on the 8-week peak window — wasted creator spend compounds during peak.",
  G3: "Cold catch-all. They may not work with creators yet. Pitch is educational + ROI: 'most brands overpay because they can't see who converts'.",
};
const TOUCH_DESCRIPTIONS = {
  1: "First cold reach (T+0). Bold diagnosis of the problem + soft asymmetric ask.",
  2: "Second touch 3 days later (T+3). Different angle from touch 1 — case study, ROI math, or trial CTA.",
  3: "Final touch 7 days after touch 1. Short reply ask — yes/no, last note, soft close.",
};

// Single source of truth per slot: each (group, touch) holds exactly one
// active template. Regenerating with AI updates that template in place
// instead of accumulating drafts. If the slot has multiple existing rows
// (legacy state), we consolidate down to one before updating.
export async function generateDraftsForCampaign({ teamId, campaign, apiKey, groups, touches, briefOverride, refinementPrompt }) {
  const brief = briefOverride || campaign.brief ||
    "Linkable is a Shopify app for creator attribution and affiliate payouts. Cold outbound to D2C brand founders / heads of marketing.";
  const refinementBlock = refinementPrompt
    ? `\nADDITIONAL DIRECTION (highest priority — override the reference if it conflicts):\n${refinementPrompt}\n`
    : "";

  const defaults = Object.fromEntries(
    SEQUENCE_TEMPLATES.map((t) => [`${t.group}-T${t.touch}`, t])
  );

  const updated = [];
  for (const group of groups) {
    for (const touch of touches) {
      const key = `${group}-T${touch}`;
      const def = defaults[key];
      if (!def) continue;

      // Collapse any pre-existing rows for this slot down to one (prefer the
      // active one; else most recent). Older duplicates are deleted so the
      // slot ends with exactly one row to update or insert against.
      const { data: existing } = await supabase
        .from("email_templates")
        .select("id,is_active,created_at")
        .eq("team_id", teamId).eq("campaign_id", campaign.id)
        .eq("brand_group", group).eq("touch_number", touch)
        .order("is_active", { ascending: false })
        .order("created_at", { ascending: false });
      const keeper = existing?.[0] || null;
      const dupes = (existing || []).slice(1).map((r) => r.id);
      if (dupes.length) {
        await supabase.from("email_templates").delete().in("id", dupes);
      }

      // Anchor on whatever's currently in the slot — if the user hand-edited
      // the active template, the AI rewrite riffs on that instead of the
      // factory default.
      let anchorSubject = def.subject_template;
      let anchorBody = def.body_template;
      if (keeper) {
        const { data: full } = await supabase
          .from("email_templates")
          .select("subject_template,body_template")
          .eq("id", keeper.id).maybeSingle();
        if (full) { anchorSubject = full.subject_template; anchorBody = full.body_template; }
      }

      const prompt = `You are an expert in cold outbound for B2B SaaS. Rewrite the email below for the slot.

CAMPAIGN BRIEF:
${brief}
${refinementBlock}
SLOT: ${group} touch ${touch} (key=${key})
- Group: ${GROUP_DESCRIPTIONS[group] || group}
- Position: ${TOUCH_DESCRIPTIONS[touch] || ""}

CURRENT VERSION (rewrite this — apply the additional direction above; if no direction was given, sharpen the angle while preserving intent):
Subject: ${anchorSubject}
Body:
${anchorBody}

CONSTRAINTS:
- Subject ≤ 80 chars, no spam triggers (no "guaranteed", "limited time", "!!!", "$$", etc.)
- Body 40–70 words, plain text, single CTA
- Use ONLY these placeholders: {{brandName}}, {{firstName}}, {{productType}}, {{observation}}
- Do NOT fabricate customer names, percentages, or case studies. Hedge claims with "if … as it does for most brands".
- Keep it bold and confrontational. No fluff. Federico signs off.

Return STRICT JSON, no prose, exactly:
{"name":"...","subject_template":"...","body_template":"..."}
`;

      let parsed = null;
      try {
        const res = await fetch(ANTHROPIC_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 1000,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        if (!res.ok) {
          console.error("Anthropic error:", res.status, await res.text());
          continue;
        }
        const data = await res.json();
        const text = data.content?.[0]?.text?.trim() || "";
        const cleaned = text.replace(/^```json\s*|\s*```$/g, "").trim();
        parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) parsed = parsed[0]; // tolerate model wrapping in array
      } catch (err) {
        console.error(`rewrite ${key} failed:`, err.message);
        continue;
      }

      if (!parsed?.subject_template || !parsed?.body_template) continue;

      const fields = {
        name: parsed.name?.slice(0, 80) || `${key} (AI rewrite)`,
        subject_template: parsed.subject_template.slice(0, 200),
        body_template: parsed.body_template.slice(0, 3000),
        generated_by_ai: true,
      };

      let row;
      if (keeper) {
        const { data, error } = await supabase.from("email_templates")
          .update(fields).eq("id", keeper.id).select("*").single();
        if (!error) row = data;
      } else {
        const { data, error } = await supabase.from("email_templates")
          .insert({
            team_id: teamId, campaign_id: campaign.id,
            brand_group: group, touch_number: touch, template_key: key,
            variant: group.charAt(1) || "A",
            weight: 100, is_active: true, is_draft: false,
            ...fields,
          }).select("*").single();
        if (!error) row = data;
      }
      if (row) updated.push(row);
    }
  }

  return updated;
}
