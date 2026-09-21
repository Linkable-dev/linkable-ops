// Routes for the prospecting dashboard. Powers /ai/prospecting in the UI.
//
// Endpoints (all under /api/prospecting, requireOpsAdmin):
//   GET  /leads              — list prospector_leads with filters
//   GET  /stats              — counts by tier, decision and status
//   GET  /leads/:handle      — one lead, everything known about it
//   POST /leads/:handle/decision — send | hold | hide | pending, with a note
//
// The pipeline that produces these rows (linkable-prospector) runs outside this
// app and owns every column except `decision` and `ops_note`. Those two are
// owned here, and the pipeline reads them back before it hands anything to
// Lemlist — so holding or hiding a lead on this page is what actually stops it
// being emailed, not merely what hides it from view.

import express from "express";
import { supabase } from "../lib/supabase.js";

const TABLE = "prospector_leads";
const CAMPAIGNS = "prospector_campaigns";
const RUNS = "prospector_campaign_runs";
const CREATORS = "prospector_creators";
const DECISIONS = ["pending", "send", "hold", "hide"];

// Columns the list needs. Kept explicit rather than select(*) so adding a
// column to the pipeline cannot quietly widen every response.
const LIST_COLUMNS = [
  "handle", "tier", "decision", "ops_note", "decided_at",
  "brand_name", "domain", "contact_email", "founder_name", "country",
  "affiliate_app", "product_count", "creator_activity_score",
  "distinct_creators_90d", "top_creators", "intent_signal", "intent_post_url",
  "entity_type", "entity_verified", "status", "tier_reason", "source",
  "instagram_url", "pushed_at", "first_seen_at",
].join(",");

export function prospectingRoutes() {
  const router = express.Router();

  // The table may not exist yet — the migration ships with the pipeline, not
  // with this app. Say so plainly instead of rendering an empty page that
  // looks like "no leads".
  function handleError(res, error, what) {
    const missing = error?.code === "42P01" || /does not exist/i.test(error?.message || "");
    if (missing) {
      return res.status(503).json({
        error: "prospector_leads is missing",
        hint: "apply supabase/migrations/019_prospector_leads.sql, then run `prospector sync-ops`",
      });
    }
    console.error(`[prospecting] ${what}:`, error);
    return res.status(500).json({ error: error?.message || what });
  }

  router.get("/leads", async (req, res) => {
    const { tier, decision, status, q, limit = 100, offset = 0 } = req.query;
    let query = supabase.from(TABLE).select(LIST_COLUMNS, { count: "exact" });

    if (tier) query = query.in("tier", String(tier).split(","));
    if (decision) query = query.in("decision", String(decision).split(","));
    if (status) query = query.in("status", String(status).split(","));
    if (q) {
      const term = `%${q}%`;
      query = query.or(
        `handle.ilike.${term},brand_name.ilike.${term},domain.ilike.${term},contact_email.ilike.${term}`
      );
    }

    // Tier first, then the strongest signal inside a tier.
    query = query
      .order("tier", { ascending: true, nullsFirst: false })
      .order("creator_activity_score", { ascending: false, nullsFirst: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    const { data, error, count } = await query;
    if (error) return handleError(res, error, "listing leads");
    res.json({ leads: data || [], total: count ?? (data || []).length });
  });

  router.get("/stats", async (_req, res) => {
    const { data, error } = await supabase
      .from(TABLE)
      .select("tier,decision,status,contact_email,affiliate_app,pushed_at");
    if (error) return handleError(res, error, "loading stats");

    const rows = data || [];
    const tally = (key) =>
      rows.reduce((acc, row) => {
        const k = row[key] || "unknown";
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {});

    res.json({
      total: rows.length,
      byTier: tally("tier"),
      byDecision: tally("decision"),
      byStatus: tally("status"),
      // The two numbers that say whether this is working: how many are ready to
      // contact, and how many already were.
      contactable: rows.filter(
        (r) => r.contact_email && r.status === "routed" && !["hold", "hide"].includes(r.decision)
      ).length,
      sent: rows.filter((r) => r.pushed_at).length,
      untracked: rows.filter((r) => (r.affiliate_app || "none") === "none").length,
    });
  });

  router.get("/leads/:handle", async (req, res) => {
    const { data, error } = await supabase
      .from(TABLE).select("*").eq("handle", req.params.handle).maybeSingle();
    if (error) return handleError(res, error, "loading lead");
    if (!data) return res.status(404).json({ error: "no such lead" });
    res.json(data);
  });

  router.post("/leads/:handle/decision", async (req, res) => {
    const { decision, note } = req.body || {};
    if (!DECISIONS.includes(decision)) {
      return res.status(400).json({ error: `decision must be one of ${DECISIONS.join(", ")}` });
    }
    const { data, error } = await supabase
      .from(TABLE)
      .update({ decision, ops_note: note ?? null })
      .eq("handle", req.params.handle)
      .select(LIST_COLUMNS)
      .maybeSingle();
    if (error) return handleError(res, error, "saving decision");
    if (!data) return res.status(404).json({ error: "no such lead" });
    res.json(data);
  });

  // Bulk, because triaging a list one row at a time is the thing people stop
  // doing after five rows.
  router.post("/leads/decision", async (req, res) => {
    const { handles, decision, note } = req.body || {};
    if (!Array.isArray(handles) || !handles.length) {
      return res.status(400).json({ error: "handles must be a non-empty array" });
    }
    if (!DECISIONS.includes(decision)) {
      return res.status(400).json({ error: `decision must be one of ${DECISIONS.join(", ")}` });
    }
    const { data, error } = await supabase
      .from(TABLE)
      .update({ decision, ops_note: note ?? null })
      .in("handle", handles)
      .select("handle,decision");
    if (error) return handleError(res, error, "saving decisions");
    res.json({ updated: (data || []).length });
  });

  // --- creators -----------------------------------------------------------
  //
  // The mirror of leads, and the same contract: the pipeline owns every column
  // except decision and ops_note, and a decision here is what stops an invite
  // going out rather than what hides a row.

  const CREATOR_COLUMNS = [
    "handle", "tier", "decision", "ops_note", "decided_at", "full_name",
    "biography", "contact_email", "niche", "country", "followers", "posts_count",
    "is_verified", "brands_posted_about", "brand_posts", "example_post_url",
    "example_brand", "creator_score", "tier_reason", "status", "source",
    "instagram_url", "pushed_at",
  ].join(",");

  router.get("/creators", async (req, res) => {
    const { tier, decision, q, limit = 100, offset = 0 } = req.query;
    let query = supabase.from(CREATORS).select(CREATOR_COLUMNS, { count: "exact" });
    if (tier) query = query.in("tier", String(tier).split(","));
    if (decision) query = query.in("decision", String(decision).split(","));
    if (q) {
      const term = `%${q}%`;
      query = query.or(`handle.ilike.${term},full_name.ilike.${term},niche.ilike.${term}`);
    }
    query = query
      .order("tier", { ascending: true, nullsFirst: false })
      .order("creator_score", { ascending: false, nullsFirst: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    const { data, error, count } = await query;
    if (error) return handleError(res, error, "listing creators");
    res.json({ creators: data || [], total: count ?? (data || []).length });
  });

  router.get("/creators/stats", async (_req, res) => {
    const { data, error } = await supabase
      .from(CREATORS).select("tier,decision,contact_email,brands_posted_about,pushed_at");
    if (error) return handleError(res, error, "loading creator stats");
    const rows = data || [];
    const tally = (key) => rows.reduce((acc, r) => {
      const k = r[key] || "unknown";
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    res.json({
      total: rows.length,
      byTier: tally("tier"),
      byDecision: tally("decision"),
      contactable: rows.filter((r) => r.contact_email && !["hold", "hide"].includes(r.decision)).length,
      multiBrand: rows.filter((r) => (r.brands_posted_about || 0) >= 2).length,
      invited: rows.filter((r) => r.pushed_at).length,
    });
  });

  router.post("/creators/:handle/decision", async (req, res) => {
    const { decision, note } = req.body || {};
    if (!DECISIONS.includes(decision)) {
      return res.status(400).json({ error: `decision must be one of ${DECISIONS.join(", ")}` });
    }
    const { data, error } = await supabase
      .from(CREATORS).update({ decision, ops_note: note ?? null })
      .eq("handle", req.params.handle).select(CREATOR_COLUMNS).maybeSingle();
    if (error) return handleError(res, error, "saving creator decision");
    if (!data) return res.status(404).json({ error: "no such creator" });
    res.json(data);
  });

  // --- campaigns ----------------------------------------------------------
  //
  // A campaign reports `state` and a person sets `desired_state`. Two columns
  // rather than one, because the runner is elsewhere and on its own clock: if
  // the page wrote `state` directly, a pass finishing a second later would
  // overwrite the instruction it was meant to be following.

  router.get("/campaigns", async (_req, res) => {
    const { data, error } = await supabase
      .from(CAMPAIGNS).select("*").order("id", { ascending: false });
    if (error) return handleError(res, error, "listing campaigns");
    res.json({ campaigns: data || [] });
  });

  router.get("/campaigns/:name/runs", async (req, res) => {
    const { data, error } = await supabase
      .from(RUNS).select("*")
      .eq("campaign_name", req.params.name)
      .order("started_at", { ascending: false })
      .limit(25);
    if (error) return handleError(res, error, "listing runs");
    res.json({ runs: data || [] });
  });

  router.post("/campaigns", async (req, res) => {
    const { name, goal_leads, goal_tiers, budget_usd, source, hashtags, countries } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "a campaign needs a name" });
    }
    const budget = Number(budget_usd);
    if (!Number.isFinite(budget) || budget <= 0) {
      return res.status(400).json({ error: "budget must be a positive number of dollars" });
    }
    // Created switched off. A campaign that starts the moment it is named
    // spends before anyone has read back what they typed.
    const row = {
      name: String(name).trim(),
      desired_state: "off",
      state: "off",
      goal_leads: Number(goal_leads) > 0 ? Number(goal_leads) : 20,
      goal_tiers: (goal_tiers || "A").toUpperCase(),
      budget_usd: budget,
      source: source || "creator_calls",
      hashtags: hashtags || null,
      countries: countries || null,
    };
    const { data, error } = await supabase.from(CAMPAIGNS).insert(row).select("*").maybeSingle();
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: `there is already a campaign called ${row.name}` });
      }
      return handleError(res, error, "creating campaign");
    }
    res.status(201).json(data);
  });

  router.post("/campaigns/:name/state", async (req, res) => {
    const wanted = String(req.body?.desired_state || "").toLowerCase();
    if (!["off", "running"].includes(wanted)) {
      return res.status(400).json({ error: "desired_state must be off or running" });
    }
    const { data, error } = await supabase
      .from(CAMPAIGNS).update({ desired_state: wanted })
      .eq("name", req.params.name).select("*").maybeSingle();
    if (error) return handleError(res, error, "setting campaign state");
    if (!data) return res.status(404).json({ error: "no such campaign" });
    res.json(data);
  });

  return router;
}
