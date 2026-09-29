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
import { claudeMessage, cachedSystem } from "../lib/anthropic.js";
import { sanitizeStyle, findStyleIssues } from "../automation/conversation-ai.js";
import { discover, buildFilters, discoveryKey, COSTS } from "../lib/influencers-club.js";
import { LANGUAGES, MAX_DM_CHARS } from "../lib/instagram-dm-writer.js";
import { classifyMissing } from "../lib/lead-classifier.js";
import { SEARCH_REQUESTED_KEY, searchState, startProspectorRun } from "../lib/prospector-run.js";
import { refreshConversions } from "../lib/dm-conversions.js";
import { dmResults } from "../lib/dm-results.js";
import { sendInstagramMessage, instagramConfigured } from "../lib/instagram-graph.js";
import {
  DM_COLUMNS, SETTINGS, readSettings, settingProblem, optionsFrom, countryOf, dmOpen, isDmOpen, todoOrder,
  VERTICALS, NO_VERTICAL, verticalOf, filterVerticals, followupDue, isFollowupDue, FOLLOWUP_DAYS,
  shapeDm, draftBatch, DRAFT_BATCH,
} from "../lib/instagram-dm-queue.js";

const TABLE = "prospector_leads";
const CAMPAIGNS = "prospector_campaigns";
const RUNS = "prospector_campaign_runs";
const CREATORS = "prospector_creators";
const EVENTS = "prospector_outreach_events";
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
  // Why a lead is held at needs_review, in the pipeline's own words. It was
  // written on every held lead and shown nowhere, so six brands sat in a state
  // the page could name but not explain.
  "review_reason",
  // reply_state was missing, so the Reply column on the Brands table showed a
  // dash for every lead including the two that have been opened.
  "reply_state", "replied_at",
  // The list the first email offers to send.
  "creator_list",
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

  // Sorting reaches the database, not just the page.
  //
  // Both these lists paginate server-side, so a sort applied in the browser
  // would reorder the fifty rows on screen and leave the other rows where they
  // were - which reads as a broken sort rather than as a client-side one.
  //
  // The column is checked against a list rather than interpolated, because it
  // goes into an ORDER BY.
  function applySort(query, sortBy, sortDir, allowed, fallback) {
    const dir = String(sortDir || "desc").toLowerCase() === "asc";
    if (sortBy && allowed.includes(String(sortBy))) {
      return query.order(String(sortBy), { ascending: dir, nullsFirst: false });
    }
    return fallback(query);
  }

  // Arbitrary per-column filters, as the shared table header produces them:
  // `filter[col]=value`, where a value may be a plain term or an operator
  // expression the header's popover built.
  function applyColumnFilters(query, raw, allowed) {
    for (const [col, value] of Object.entries(raw || {})) {
      if (!allowed.includes(col) || value === "" || value == null) continue;
      const text = String(value);
      const m = text.match(/^(gte|lte|gt|lt|eq|ne|is|isnot|contains|between):(.*)$/);
      if (!m) { query = query.ilike(col, `%${text}%`); continue; }
      const [, op, rest] = m;
      if (op === "between") {
        const [a, b] = rest.split(",");
        if (a) query = query.gte(col, a);
        if (b) query = query.lte(col, b);
      } else if (op === "contains") {
        query = query.ilike(col, `%${rest}%`);
      } else if (op === "is") {
        query = rest === "null" ? query.is(col, null) : query.eq(col, rest);
      } else if (op === "isnot") {
        query = rest === "null" ? query.not(col, "is", null) : query.neq(col, rest);
      } else {
        query = query[op === "ne" ? "neq" : op](col, rest);
      }
    }
    return query;
  }

  const LEAD_SORTABLE = [
    "handle", "tier", "brand_name", "domain", "contact_email", "country",
    "affiliate_app", "product_count", "creator_activity_score",
    "distinct_creators_90d", "status", "decision", "pushed_at", "first_seen_at",
    "reply_state",
  ];

  // The four slices the Brands tiles stand for. A view is one word from the
  // client rather than a filter it assembles itself, because three of these are
  // conditions on two columns at once and a client that gets one subtly wrong
  // shows a number it cannot act on.
  //
  // They are the funnel in order, and they do not overlap:
  //   review  nobody has said send yet, and it has not gone
  //   queued  marked send, waiting for the next tick
  //   sent    handed to Lemlist
  //   blocked routed nowhere - compliance has not cleared it, so `send` on one
  //           of these is an instruction the pipeline will never carry out.
  //           Invisible until now, which is why six leads marked send had not
  //           moved and the page offered no reason.
  const VIEWS = {
    review: (qy) => qy.in("decision", ["pending", "hold"]).is("pushed_at", null)
                      .eq("status", "routed"),
    queued: (qy) => qy.eq("decision", "send").is("pushed_at", null).eq("status", "routed"),
    sent: (qy) => qy.not("pushed_at", "is", null),
    blocked: (qy) => qy.neq("status", "routed").is("pushed_at", null),
  };

  // Brands whose store is not on Shopify are published only for the Instagram
  // queue. They are never routed or emailed, so the email funnel below does not
  // count them: 107 of them in "Needs review" would bury the six that do.
  const EMAIL_LEADS = (qy) => qy.neq("status", "not_shopify");
  const isEmailLead = (r) => r.status !== "not_shopify";

  router.get("/leads", async (req, res) => {
    const { tier, decision, status, view, q, sortBy, sortDir, limit = 100, offset = 0 } = req.query;
    let query = EMAIL_LEADS(supabase.from(TABLE).select(LIST_COLUMNS, { count: "exact" }));

    if (tier) query = query.in("tier", String(tier).split(","));
    if (decision) query = query.in("decision", String(decision).split(","));
    if (status) query = query.in("status", String(status).split(","));
    if (VIEWS[view]) query = VIEWS[view](query);
    if (q) {
      const term = `%${q}%`;
      query = query.or(
        `handle.ilike.${term},brand_name.ilike.${term},domain.ilike.${term},contact_email.ilike.${term}`
      );
    }
    query = applyColumnFilters(query, req.query.filter, LEAD_SORTABLE);

    query = applySort(query, sortBy, sortDir, LEAD_SORTABLE, (qy) =>
      // Tier first, then the strongest signal inside a tier.
      qy.order("tier", { ascending: true, nullsFirst: false })
        .order("creator_activity_score", { ascending: false, nullsFirst: false })
    ).range(Number(offset), Number(offset) + Number(limit) - 1);

    const { data, error, count } = await query;
    if (error) return handleError(res, error, "listing leads");
    res.json({ leads: data || [], total: count ?? (data || []).length });
  });

  router.get("/stats", async (_req, res) => {
    const { data, error } = await supabase
      .from(TABLE)
      .select("tier,decision,status,contact_email,affiliate_app,pushed_at");
    if (error) return handleError(res, error, "loading stats");

    const rows = (data || []).filter(isEmailLead);
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
      // The same four slices the /leads `view` param selects, counted here so
      // a tile and the table it filters can never disagree about how many
      // there are. Kept in step with VIEWS above by hand - they are four lines
      // each and a shared predicate would have to run in SQL and in JS anyway.
      byView: {
        review: rows.filter(
          (r) => ["pending", "hold"].includes(r.decision) && !r.pushed_at && r.status === "routed"
        ).length,
        queued: rows.filter(
          (r) => r.decision === "send" && !r.pushed_at && r.status === "routed"
        ).length,
        sent: rows.filter((r) => r.pushed_at).length,
        blocked: rows.filter((r) => r.status !== "routed" && !r.pushed_at).length,
      },
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

  const CREATOR_SORTABLE = [
    "handle", "tier", "full_name", "contact_email", "niche", "country",
    "followers", "posts_count", "brands_posted_about", "brand_posts",
    "creator_score", "status", "decision", "source", "pushed_at", "reply_state",
  ];

  // The creator funnel, in the same four words as the brand one. The two
  // pages do the same job on different rows, so they should not need learning
  // twice.
  //
  // `blocked` is the machine-readable half of inviteBlockedReason below: a
  // creator who is not qualified, or whose bio gave up no email, cannot be
  // invited however many times somebody clicks invite.
  const CREATOR_VIEWS = {
    review: (qy) => qy.in("decision", ["pending", "hold"]).is("pushed_at", null)
                      .eq("status", "qualified").not("contact_email", "is", null),
    queued: (qy) => qy.eq("decision", "send").is("pushed_at", null),
    invited: (qy) => qy.not("pushed_at", "is", null),
    blocked: (qy) => qy.is("pushed_at", null)
                       .or("status.neq.qualified,contact_email.is.null"),
  };

  router.get("/creators", async (req, res) => {
    const { tier, decision, view, q, sortBy, sortDir, limit = 100, offset = 0 } = req.query;
    let query = supabase.from(CREATORS).select(CREATOR_COLUMNS, { count: "exact" });
    if (tier) query = query.in("tier", String(tier).split(","));
    if (decision) query = query.in("decision", String(decision).split(","));
    if (CREATOR_VIEWS[view]) query = CREATOR_VIEWS[view](query);
    if (q) {
      const term = `%${q}%`;
      query = query.or(`handle.ilike.${term},full_name.ilike.${term},niche.ilike.${term}`);
    }
    query = applyColumnFilters(query, req.query.filter, CREATOR_SORTABLE);

    query = applySort(query, sortBy, sortDir, CREATOR_SORTABLE, (qy) =>
      qy.order("tier", { ascending: true, nullsFirst: false })
        .order("creator_score", { ascending: false, nullsFirst: false })
    ).range(Number(offset), Number(offset) + Number(limit) - 1);

    const { data, error, count } = await query;
    if (error) return handleError(res, error, "listing creators");

    // Say why a creator cannot be invited, next to the button that would
    // invite them. Without this a creator found by search shows invite / hold
    // / hide, somebody clicks invite, and nothing happens - ever, and with
    // nothing anywhere saying why.
    const creators = (data || []).map((c) => ({
      ...c,
      blocked: inviteBlockedReason(c),
      // Which of the two invites they would get, so the weaker one is never
      // a surprise.
      invite: c.example_brand && c.example_post_url ? "warm" : "cold",
    }));
    res.json({ creators, total: count ?? (data || []).length });
  });

  // The same conditions push_creators_to_lemlist applies, in the same order,
  // so the page and the pipeline cannot disagree about who is sendable.
  function inviteBlockedReason(c) {
    if (c.pushed_at) return null;
    if (["hold", "hide"].includes(c.decision)) return null;   // that is the point of holding
    if (c.status !== "qualified") return "not qualified yet - run creators qualify";
    if (!c.contact_email) return "no email in their bio";
    // A creator with no observed post is not blocked any more - they get the
    // cold sequence, which opens by saying we were looking for creators in
    // their niche, because we were. Worth saying which one they will get:
    // the cold email is the weaker of the two and it should be obvious when
    // one is about to go.
    if (!c.example_brand || !c.example_post_url) return null;
    return null;
  }

  router.get("/creators/stats", async (_req, res) => {
    const { data, error } = await supabase
      .from(CREATORS).select("tier,decision,status,contact_email,brands_posted_about,pushed_at");
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
      // The four slices CREATOR_VIEWS selects, so a tile and the table it
      // filters cannot disagree about how many there are.
      byView: {
        review: rows.filter(
          (r) => ["pending", "hold"].includes(r.decision) && !r.pushed_at
                 && r.status === "qualified" && r.contact_email
        ).length,
        queued: rows.filter((r) => r.decision === "send" && !r.pushed_at).length,
        invited: rows.filter((r) => r.pushed_at).length,
        blocked: rows.filter(
          (r) => !r.pushed_at && (r.status !== "qualified" || !r.contact_email)
        ).length,
      },
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

  router.get("/creators/outreach", async (_req, res) => {
    const { data, error } = await supabase
      .from(CREATORS)
      .select("handle,full_name,tier,decision,contact_email,example_brand,example_post_url," +
              "followers,brands_posted_about,pushed_at,status")
      .order("pushed_at", { ascending: false, nullsFirst: false });
    if (error) return handleError(res, error, "loading creator outreach");

    const rows = data || [];
    // The three states that matter, and the reason each one is in it.
    const invited = rows.filter((r) => r.pushed_at);
    const blocked = rows.filter((r) => !r.pushed_at && (
      ["hold", "hide"].includes(r.decision) || !r.contact_email ||
      !r.example_brand || !r.example_post_url
    ));
    const queued = rows.filter((r) => !r.pushed_at && !blocked.includes(r));

    res.json({
      queued: queued.slice(0, 100),
      invited: invited.slice(0, 100),
      blocked: blocked.slice(0, 100).map((r) => ({
        ...r,
        why: ["hold", "hide"].includes(r.decision) ? `held: ${r.decision}`
          : !r.contact_email ? "no email"
          : "no observed post to open with",
      })),
      counts: { queued: queued.length, invited: invited.length, blocked: blocked.length },
    });
  });

  // --- replies -------------------------------------------------------------
  //
  // What came back after the send, for one audience. Read-only: unlike a lead's
  // `decision`, there is nothing here for a person to set, because a reply is
  // not an opinion. The pipeline writes these rows and nothing in this app
  // does.

  router.get("/replies", async (req, res) => {
    const kind = req.query.kind === "creator" ? "creator" : "brand";
    const table = kind === "creator" ? CREATORS : TABLE;
    const nameColumn = kind === "creator" ? "full_name" : "brand_name";

    const [events, funnel, waiting] = await Promise.all([
      supabase.from(EVENTS)
        .select("activity_id,handle,email,event,campaign_name,subject,preview,interest_score,occurred_at")
        .eq("kind", kind)
        // auto_reply is listed so it stays visible rather than silently
        // vanishing: "this brand's inbox is a ticket queue" is worth seeing,
        // it just is not a reply.
        .in("event", ["replied", "interested", "not_interested", "auto_reply",
                      "bounced", "unsubscribed"])
        .order("occurred_at", { ascending: false })
        .limit(200),
      // Counted over people, not events: a lead that opened four times is one
      // open, and a funnel counted in events flatters itself.
      supabase.from(EVENTS).select("handle,event").eq("kind", kind).limit(10000),
      supabase.from(table).select(`handle,${nameColumn},contact_email,tier,pushed_at,reply_state`)
        .not("pushed_at", "is", null)
        .order("pushed_at", { ascending: false })
        .limit(500),
    ]);

    if (events.error) return handleError(res, events.error, "loading replies");
    if (funnel.error) return handleError(res, funnel.error, "loading the reply funnel");
    if (waiting.error) return handleError(res, waiting.error, "loading who was contacted");

    const people = {};
    for (const row of funnel.data || []) {
      (people[row.event] ||= new Set()).add(row.handle);
    }
    const counts = Object.fromEntries(
      Object.entries(people).map(([event, set]) => [event, set.size])
    );

    const contacted = waiting.data || [];
    res.json({
      events: events.data || [],
      funnel: {
        ...counts,
        contacted: contacted.length,
        // Nobody has answered and nothing has failed: still out there.
        silent: contacted.filter((r) => !r.reply_state ||
          ["sent", "opened", "clicked"].includes(r.reply_state)).length,
      },
      contacted: contacted.slice(0, 200),
    });
  });

  // --- searching for creators ----------------------------------------------
  //
  // Describe the creators you want; a model turns that into a provider filter
  // set; you read it; then you run it.
  //
  // Two calls rather than one because only the second spends money. Discovery
  // bills 0.01 credits per creator RETURNED, so a search is cheap enough to run
  // often and not cheap enough to run by accident. The plan is free, and it is
  // also the part most worth a human eye: which keywords go in a creator's bio
  // is exactly where judgement still beats the model.
  //
  // The filter vocabulary is not invented here. It mirrors the Go runner in
  // service-grpc/clients/influencers_club_discovery.go, which stays the
  // authority, so the two systems cannot drift into different definitions of a
  // good creator.

  const PLAN_TOOL = {
    name: "creator_search",
    description: "A filter set for the Influencers Club discovery API.",
    input_schema: {
      type: "object",
      properties: {
        bio_keywords: {
          type: "array", items: { type: "string" },
          description: "Words likely to appear in the creator's own bio. The single most important field. 2-6 of them, lowercase, no hashtags.",
        },
        caption_keywords: {
          type: "array", items: { type: "string" },
          description: "Words likely in their post captions. Optional; leave empty unless the brief is about what they post rather than who they are.",
        },
        excluded_keywords: {
          type: "array", items: { type: "string" },
          description: "Bio words that disqualify, e.g. agency, management, shop.",
        },
        locations: {
          type: "array", items: { type: "string" },
          description: "Plain country or city names as a person writes them, e.g. 'United Kingdom'. Never ISO codes.",
        },
        languages: { type: "array", items: { type: "string" } },
        followers_min: { type: "integer", description: "Default 3000: nobody below it has ever replied." },
        followers_max: { type: "integer", description: "Default 150000. Above that they have an agent and a rate card." },
        engagement_min: { type: "number", description: "Percent. Default 0.5." },
        gender: { type: "string", enum: ["any", "male", "female"] },
        has_done_brand_deals: { type: "boolean" },
        promotes_affiliate_links: { type: "boolean" },
        rationale: {
          type: "string",
          description: "One sentence: why these filters answer the brief, and what you assumed.",
        },
      },
      required: ["bio_keywords", "rationale"],
    },
  };

  const PLAN_SYSTEM = [
    "You turn a plain-English brief into a creator search for Linkable, a Shopify",
    "app that pays creators commission on what they sell.",
    "",
    "The bio keywords are the whole search. A creator writes their own bio, so",
    "the words there are what they call themselves - 'ugc creator', 'skincare',",
    "'mum of two' - not what a marketer would call them.",
    "",
    "Defaults, from what has actually replied: followers 3,000 to 150,000,",
    "engagement at least 0.5%. Below 3k nobody replies; above 150k they have",
    "representation and a rate card, and a self-serve affiliate platform is not",
    "what they want.",
    "",
    "Do not invent a location the brief did not ask for, and do not set gender",
    "unless the product is genuinely gender-specific.",
  ].join("\n");

  router.post("/creators/search/plan", async (req, res) => {
    const prompt = String(req.body?.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "describe the creators you want" });
    if (prompt.length > 2000) return res.status(400).json({ error: "that brief is too long" });

    try {
      const out = await claudeMessage({
        model: "claude-sonnet-4-6",
        system: cachedSystem(PLAN_SYSTEM),
        maxTokens: 800,
        temperature: 0.2,
        tools: [PLAN_TOOL],
        toolChoice: { type: "tool", name: "creator_search" },
        messages: [{ role: "user", content: prompt }],
      });
      // claudeMessage returns tool_use blocks as .toolCalls [{ name, input }].
      const call = (out.toolCalls || []).find((t) => t.name === "creator_search");
      const query = call?.input;
      if (!query) return res.status(502).json({ error: "the model did not return a plan" });

      res.json({
        query,
        // Shown so a person can see what will actually be sent, including the
        // parts the model does not get to choose.
        filters: buildFilters(query),
        configured: Boolean(discoveryKey()),
        creditsPerCreator: COSTS.CREDITS_PER_CREATOR,
      });
    } catch (err) {
      const missingKey = /ANTHROPIC_API_KEY/.test(err?.message || "");
      res.status(missingKey ? 503 : 500).json({
        error: missingKey ? "planning is not configured" : "could not plan the search",
        hint: err?.message,
      });
    }
  });

  router.post("/creators/search/run", async (req, res) => {
    const query = req.body?.query;
    if (!query || typeof query !== "object") {
      return res.status(400).json({ error: "run needs the plan from /plan" });
    }
    // Capped here rather than trusted from the client: this is the call that
    // spends, and the ceiling belongs on the side that cannot be edited.
    const limit = Math.min(Math.max(Number(req.body?.limit) || 25, 1), 100);

    if (!discoveryKey()) {
      return res.status(503).json({
        error: "creator search is not configured",
        hint: "INFLUENCERS_CLUB_SOURCING_API_KEY is not set on the ops server.",
      });
    }

    try {
      const { creators, filters, creditsSpent, droppedLocations } = await discover(query, limit);

      // Which of them we already have, so the list says what is new rather than
      // showing forty creators of which thirty are already in the table.
      const handles = creators.map((c) => c.handle).filter(Boolean);
      const known = new Set();
      if (handles.length) {
        const { data } = await supabase.from(CREATORS).select("handle").in("handle", handles);
        for (const row of data || []) known.add(row.handle);
      }

      res.json({
        creators: creators.map((c) => ({ ...c, known: known.has(c.handle) })),
        filters,
        creditsSpent,
        // Names the model produced that the provider does not recognise. Shown
        // rather than swallowed: a dropped location is a much wider search
        // than the one that was asked for.
        droppedLocations,
        newCount: creators.filter((c) => !known.has(c.handle)).length,
      });
    } catch (err) {
      res.status(502).json({ error: "the provider refused the search", hint: err?.message });
    }
  });

  router.post("/creators/search/add", async (req, res) => {
    const found = Array.isArray(req.body?.creators) ? req.body.creators : [];
    const prompt = String(req.body?.prompt || "").slice(0, 300);
    if (!found.length) return res.status(400).json({ error: "nothing to add" });

    // Discovery returns no email, so these arrive unqualified and without a
    // tier. They are candidates, not leads: the pipeline decides what they are
    // worth, and `decision` stays pending because nobody has looked at them.
    const rows = found.slice(0, 200).map((c) => ({
      handle: String(c.handle || "").replace(/^@/, "").toLowerCase(),
      full_name: c.full_name || null,
      followers: c.followers ?? null,
      status: "discovered",
      source: "influencers_club",
      // What was asked for, kept with the row: six weeks later "why is this
      // creator here" has an answer that is not a guess.
      tier_reason: prompt ? `found by search: ${prompt}` : "found by search",
      instagram_url: `https://www.instagram.com/${String(c.handle || "").replace(/^@/, "")}/`,
      first_seen_at: new Date().toISOString(),
    })).filter((r) => r.handle);

    const { error } = await supabase
      .from(CREATORS)
      .upsert(rows, { onConflict: "handle", ignoreDuplicates: true });
    if (error) return handleError(res, error, "adding the creators");
    res.json({ added: rows.length });
  });

  // --- what was actually sent ----------------------------------------------
  //
  // Lemlist stores only the first line of a message on an activity, so the
  // sent email cannot simply be read back. It can be reconstructed exactly:
  // the sequence holds the template, the activity holds that lead's variables,
  // and substituting one into the other is what the provider itself did.
  //
  // Reconstructed rather than stored at push time on purpose. What a template
  // renders to is a property of the template, and the template can change
  // after a send - so a copy saved by us would eventually disagree with what
  // the recipient has in their inbox, and quietly.

  const LEMLIST_API = "https://api.lemlist.com/api";

  async function lemlist(path, params = {}) {
    const key = process.env.LEMLIST_KEY || process.env.LEMLIST_API_KEY;
    if (!key) throw new Error("LEMLIST_KEY is not set");
    const url = new URL(LEMLIST_API + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const resp = await fetch(url, {
      headers: { Authorization: "Basic " + Buffer.from(":" + key).toString("base64") },
    });
    if (!resp.ok) throw new Error(`lemlist ${path} returned ${resp.status}`);
    return resp.json();
  }

  // {{name}} -> the lead's value. A variable with no value is left visible as
  // itself rather than blanked: a hole you can see is a bug report, and a hole
  // you cannot is an email that went out reading "saw  posting about".
  function render(template, variables) {
    return String(template || "").replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, name) => {
      const value = variables?.[name];
      return value === undefined || value === null || value === "" ? whole : String(value);
    });
  }

  router.get("/leads/:handle/emails", async (req, res) => {
    const kind = req.query.kind === "creator" ? "creator" : "brand";
    const table = kind === "creator" ? CREATORS : TABLE;

    const { data: lead, error } = await supabase
      .from(table).select("handle,contact_email,pushed_at").eq("handle", req.params.handle).maybeSingle();
    if (error) return handleError(res, error, "loading the lead");
    if (!lead) return res.status(404).json({ error: "no such lead" });
    if (!lead.pushed_at) {
      return res.json({ pushed: false, steps: [], sent: [], email: lead.contact_email });
    }

    try {
      // Every activity for this address, so we know which steps went and when,
      // and so we have the variables the provider used.
      const types = ["emailsSent", "emailsOpened", "emailsClicked", "emailsReplied"];
      const pages = await Promise.all(types.map((t) => lemlist("/activities", { type: t, limit: 100 })));
      const wanted = String(lead.contact_email || "").toLowerCase();
      const mine = pages.flat().filter(
        (a) => String(a.leadEmail || a.email || "").toLowerCase() === wanted
      );
      if (!mine.length) {
        return res.json({ pushed: true, steps: [], sent: [], email: lead.contact_email,
                          note: "Handed to Lemlist, nothing sent yet." });
      }

      const campaignId = mine[0].campaignId;
      const variables = mine.find((a) => a.type === "emailsSent") || mine[0];
      const sequences = await lemlist(`/campaigns/${campaignId}/sequences`);
      const entry = Object.values(sequences)[0] || { steps: [] };

      // Which step each activity belongs to, so a step can say "sent, opened".
      const bySent = mine.filter((a) => a.type === "emailsSent");
      const eventsFor = (stepId) => mine
        .filter((a) => a.stepId === stepId)
        .map((a) => ({ type: a.type, at: a.createdAt }));

      const steps = (entry.steps || []).map((st) => {
        const sentHere = bySent.find((a) => a.stepId === st._id);
        return {
          index: st.index,
          delayDays: st.delay,
          subject: render(st.subject, variables),
          body: render(st.message, variables),
          sentAt: sentHere?.createdAt || null,
          events: eventsFor(st._id),
        };
      });

      res.json({
        pushed: true,
        email: lead.contact_email,
        campaignName: mine[0].campaignName || mine[0].name || null,
        from: variables.sendUserMailboxProviderId || null,
        steps,
      });
    } catch (err) {
      // Say which thing is wrong. "could not read what was sent" sent somebody
      // looking at the lead when the actual answer was a missing environment
      // variable on this server.
      const missingKey = /LEMLIST_KEY/.test(err?.message || "");
      res.status(missingKey ? 503 : 502).json({
        error: missingKey
          ? "Lemlist is not configured on this server"
          : "could not read what was sent",
        hint: missingKey
          ? "LEMLIST_KEY is not set, so the sequence and its activity cannot be read."
          : err?.message,
      });
    }
  });

  // --- drafting a reply ----------------------------------------------------
  //
  // Drafts only. Nothing here sends: the whole pipeline hands sending to
  // Lemlist, and a reply to a real person is exactly the wrong place to make
  // the first exception. The draft is shown, copied by a human, and sent by a
  // human who has read it.
  //
  // It reuses `claudeMessage` and the style sanitiser the AI inbox already
  // uses, so a drafted reply sounds like the rest of the outbound rather than
  // like a second system that learned English separately.

  // Whoever the Lemlist mailbox sends as. Not a guess, and not a variable the
  // model gets to fill in.
  const SENDER_NAME = process.env.PROSPECTOR_SENDER_NAME || "Federico";

  const REPLY_SYSTEM = [
    "You draft short replies to brands and creators who answered a cold email",
    "from Linkable, a Shopify app for creator affiliate tracking and payouts.",
    "",
    "Rules:",
    "- Answer the question they actually asked. If they asked nothing, say the",
    "  one useful next thing and stop.",
    "- Short sentences. Contractions. One idea per paragraph.",
    "- No em dashes. No 'I hope this finds you well', no 'reach out', no",
    "  'leverage', 'seamless' or 'exciting opportunity'.",
    "- Never invent a number, a feature, a price or a case study. If you do not",
    "  know something, say you will find out.",
    "- If they said no, accept it in one line and do not sell. Do not ask why.",
    // Told explicitly, because "sign off with a first name" without saying
    // whose makes the model pick one: a draft signed itself "Tolu", which is
    // the handle of a creator mentioned in the context, and another invented
    // "Jamie". A name is a fact like any other and is not to be guessed.
    `- Sign off with exactly this name and nothing else: ${SENDER_NAME}`,
    "- Never sign off as anyone else, and never use a name that appears in the",
    "  context below - those are the people we are writing to, not us.",
    "- Plain text. No markdown, no bullet lists, no subject line.",
  ].join("\n");

  router.post("/replies/:activityId/draft", async (req, res) => {
    const { data: event, error } = await supabase
      .from(EVENTS)
      .select("activity_id,kind,handle,email,event,subject,preview,campaign_name")
      .eq("activity_id", req.params.activityId)
      .maybeSingle();
    if (error) return handleError(res, error, "loading the reply");
    if (!event) return res.status(404).json({ error: "no such reply" });
    if (!event.preview) {
      return res.status(422).json({
        error: "there is nothing to reply to",
        hint: "Lemlist only stores the first line of a reply, and this one is empty.",
      });
    }

    // What we know about them, so the draft can be specific rather than
    // generically friendly. Missing context is left out rather than guessed.
    const table = event.kind === "creator" ? CREATORS : TABLE;
    const columns = event.kind === "creator"
      ? "handle,full_name,tier,niche,followers,example_brand,brands_posted_about"
      : "handle,brand_name,domain,tier,affiliate_app,top_creators,distinct_creators_90d";
    const { data: who } = await supabase
      .from(table).select(columns).eq("handle", event.handle).maybeSingle();

    const context = Object.entries(who || {})
      .filter(([, v]) => v !== null && v !== "" && v !== 0)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");

    try {
      const out = await claudeMessage({
        model: "claude-sonnet-4-6",
        system: cachedSystem(REPLY_SYSTEM),
        maxTokens: 400,
        temperature: 0.7,
        messages: [{
          role: "user",
          content: [
            `They are a ${event.kind}. What we know:`,
            context || "(nothing beyond their reply)",
            "",
            `Our email's subject was: ${event.subject || "(unknown)"}`,
            `Their reply (Lemlist stores only the opening): "${event.preview}"`,
            "",
            "Draft the reply.",
          ].join("\n"),
        }],
      });
      const body = sanitizeStyle(out.text);
      res.json({
        draft: body,
        // Surfaced rather than hidden: a draft that trips the house style
        // rules is still worth showing, with the reason it is suspect.
        issues: findStyleIssues(body),
        replyingTo: event.preview,
      });
    } catch (err) {
      const missingKey = /ANTHROPIC_API_KEY/.test(err?.message || "");
      res.status(missingKey ? 503 : 500).json({
        error: missingKey ? "drafting is not configured" : "could not draft a reply",
        hint: missingKey ? "ANTHROPIC_API_KEY is not set on the ops server." : err?.message,
      });
    }
  });

  // --- Instagram DMs --------------------------------------------------------
  //
  // The queue on /gtm/brands/instagram. A cold DM cannot be sent by a program -
  // Instagram's API only opens a conversation the other side started - so the
  // page does everything around the send and a person does the send: the
  // message is drafted here, copied, pasted into the conversation, and marked
  // sent by hand.
  //
  // One brand, one channel. A lead already handed to Lemlist is not offered
  // here, and a lead marked sent here is read back by the pipeline and never
  // started on the email sequence.

  const DM_VIEWS = {
    todo: (qy, opts) => todoOrder(dmOpen(qy, opts)),
    sent: (qy) => qy.in("dm_state", ["sent", "replied"])
      .order("dm_sent_at", { ascending: false, nullsFirst: false }),
    skipped: (qy) => qy.eq("dm_state", "skipped")
      .order("first_seen_at", { ascending: false, nullsFirst: false }),
    // Sent, unanswered for FOLLOWUP_DAYS, not followed up: the second message.
    followup: (qy) => followupDue(qy).order("dm_sent_at", { ascending: true }),
    // Taken out of the queue as not a brand (Claude, or a person), so the
    // verdict can be checked and undone.
    agencies: (qy) => qy.eq("is_agency", true).in("dm_state", ["none", "drafted"])
      .order("classified_at", { ascending: false, nullsFirst: false }),
  };

  // --- settings an admin chooses for the whole team ----------------------

  router.get("/settings", async (_req, res) => {
    res.json(await readSettings());
  });

  router.post("/settings", async (req, res) => {
    const { key, value } = req.body || {};
    const problem = settingProblem(key, value);
    if (problem) return res.status(400).json({ error: problem });
    const { error } = await supabase.from(SETTINGS).upsert({
      key, value, updated_at: new Date().toISOString(),
      updated_by: req.admin?.name || req.admin?.email || null,
    }, { onConflict: "key" });
    if (error) {
      if (/prospector_settings/.test(error.message || "")) {
        return res.status(503).json({
          error: "settings are not set up",
          hint: "apply supabase/migrations/026_prospector_continuous.sql",
        });
      }
      return handleError(res, error, "saving the setting");
    }
    res.json(await readSettings());
  });

  function dmError(res, error, what) {
    if (/dm_state|dm_text|ig_biography|intent_caption/.test(error?.message || "")) {
      return res.status(503).json({
        error: "the Instagram columns are missing",
        hint: "apply supabase/migrations/025_prospector_instagram_dm.sql to the ops Supabase project",
      });
    }
    return handleError(res, error, what);
  }

  router.get("/instagram", async (req, res) => {
    const view = DM_VIEWS[req.query.view] ? req.query.view : "todo";
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const settings = await readSettings();
    const opts = optionsFrom(settings);
    // Codes are checked against the known list before they reach a filter.
    const verticals = String(req.query.verticals || "").split(",")
      .map((v) => v.trim().toUpperCase())
      .filter((v) => v in VERTICALS || v === NO_VERTICAL);

    const [list, all, feed, requested] = await Promise.all([
      DM_VIEWS[view](filterVerticals(supabase.from(TABLE).select(DM_COLUMNS, { count: "exact" }), verticals), opts)
        .range(offset, offset + limit - 1),
      supabase.from(TABLE).select("tier,status,country,vertical,vertical_ai,vertical_effective,is_agency,decision,"
        + "pushed_at,dm_state,dm_text,dm_sent_at,dm_followup_sent_at,converted_at,intent_posted_at,"
        + "intent_caption,first_seen_at"),
      supabase.from("prospector_feed_status").select("*").eq("id", 1).maybeSingle(),
      supabase.from(SETTINGS).select("value").eq("key", SEARCH_REQUESTED_KEY).maybeSingle(),
    ]);
    if (list.error) return dmError(res, list.error, "listing the Instagram queue");
    if (all.error) return dmError(res, all.error, "counting the Instagram queue");

    const rows = all.data || [];
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    res.json({
      leads: (list.data || []).map(shapeDm),
      total: list.count ?? (list.data || []).length,
      settings,
      counts: {
        todo: rows.filter((r) => isDmOpen(r, opts)).length,
        drafted: rows.filter((r) => isDmOpen(r, opts) && r.dm_text).length,
        // Waiting behind the setting, so switching it on is not a leap in the dark.
        nonShopify: rows.filter((r) => r.status === "not_shopify"
          && isDmOpen(r, { nonShopify: true })).length,
        sentToday: rows.filter((r) => r.dm_sent_at && new Date(r.dm_sent_at) >= startOfDay).length,
        sent: rows.filter((r) => ["sent", "replied"].includes(r.dm_state)).length,
        replied: rows.filter((r) => r.dm_state === "replied").length,
        skipped: rows.filter((r) => r.dm_state === "skipped").length,
        followup: rows.filter(isFollowupDue).length,
        converted: rows.filter((r) => r.converted_at).length,
        agencies: rows.filter((r) => r.is_agency === true).length,
      },
      // How the logged-in Instagram read is doing, for the "log in again"
      // banner. Missing table or row reads as unknown, not as broken.
      feedStatus: feed?.data ? {
        ...feed.data,
        stale: Boolean(feed.data.last_scraped_at)
          && Date.now() - new Date(feed.data.last_scraped_at).getTime() > 3 * 86_400_000,
      } : null,
      instagramReplies: instagramConfigured(),
      followupDays: FOLLOWUP_DAYS,
      // The "Find new brands" button: running, cooling down, and how many
      // brands the last search added to the queue.
      search: (() => {
        const state = searchState({ requestedAt: requested?.data?.value, feedUpdatedAt: feed?.data?.updated_at });
        return {
          ...state,
          newBrands: state.requestedAt
            ? rows.filter((r) => isDmOpen(r, opts) && r.first_seen_at && r.first_seen_at >= state.requestedAt).length
            : 0,
        };
      })(),
      // Every country waiting, whether or not it is chosen, so an admin can see
      // what the country setting leaves out before changing it.
      countries: rows
        .filter((r) => isDmOpen(r, { nonShopify: opts.nonShopify }))
        .reduce((acc, r) => { acc[countryOf(r)] = (acc[countryOf(r)] || 0) + 1; return acc; }, {}),
      // Per vertical, over the whole queue as the team settings define it, so
      // the filter can say how many each choice leaves.
      verticals: rows
        .filter((r) => isDmOpen(r, opts))
        .reduce((acc, r) => { acc[verticalOf(r)] = (acc[verticalOf(r)] || 0) + 1; return acc; }, {}),
      verticalLabels: VERTICALS,
      maxChars: MAX_DM_CHARS,
    });
  });

  // Draft the next few, or redraft the ones named. Ten at most per call: each
  // is one model call, and the serverless function has sixty seconds.
  router.post("/instagram/draft", async (req, res) => {
    const handles = Array.isArray(req.body?.handles)
      ? req.body.handles.map((h) => String(h).toLowerCase()).filter(Boolean).slice(0, DRAFT_BATCH)
      : [];
    const language = LANGUAGES[req.body?.language] ? req.body.language : undefined;
    try {
      res.json(await draftBatch({
        handles, language, limit: Number(req.body?.limit) || DRAFT_BATCH, followUp: req.body?.followUp === true,
      }));
    } catch (error) {
      return dmError(res, error, "choosing leads to draft");
    }
  });

  // Claude's verdict on leads nobody has classified: a vertical where the
  // keywords found none, and whether the account is an agency (which takes it
  // out of the queue). The page calls this before writing messages, so no
  // message is written for an agency.
  // "Find new brands": start a prospector run now. Refused while one is
  // running and for half an hour after the last one - every search is a
  // session on the scraping Instagram account.
  router.post("/instagram/find", async (_req, res) => {
    const [requested, feed] = await Promise.all([
      supabase.from(SETTINGS).select("value").eq("key", SEARCH_REQUESTED_KEY).maybeSingle(),
      supabase.from("prospector_feed_status").select("updated_at").eq("id", 1).maybeSingle(),
    ]);
    const before = searchState({ requestedAt: requested?.data?.value, feedUpdatedAt: feed?.data?.updated_at });
    if (before.running) {
      return res.status(409).json({ error: "A search is already running.", search: before });
    }
    if (before.availableAt) {
      const at = new Date(before.availableAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
      return res.status(429).json({ error: `The last search was under half an hour ago. Next one from ${at}.`, search: before });
    }
    const now = new Date().toISOString();
    const { error: saveError } = await supabase.from(SETTINGS)
      .upsert({ key: SEARCH_REQUESTED_KEY, value: now }, { onConflict: "key" });
    if (saveError) return res.status(500).json({ error: saveError.message });
    try {
      await startProspectorRun();
    } catch (err) {
      // Put the old time back, so a run that never started does not lock the
      // button for half an hour.
      await supabase.from(SETTINGS).upsert({ key: SEARCH_REQUESTED_KEY, value: requested?.data?.value ?? null },
        { onConflict: "key" });
      console.error("/instagram/find could not start the worker:", err?.message || err);
      return res.status(502).json({ error: `Could not start the search: ${err?.message || "Cloud Run refused"}` });
    }
    res.json({ search: searchState({ requestedAt: now, feedUpdatedAt: feed?.data?.updated_at }) });
  });

  router.post("/instagram/classify", async (_req, res) => {
    try {
      res.json(await classifyMissing({ limit: 40 }));
    } catch (err) {
      res.status(500).json({ error: err?.message || "could not classify" });
    }
  });

  // What the DMs did: sent, followed up, replied, became customers - overall
  // and by vertical, country, message variant and week. Conversions are
  // re-matched against the product database first, so the page is current.
  router.get("/instagram/results", async (_req, res) => {
    try {
      const conversions = await refreshConversions().catch((err) => ({ error: err.message }));
      res.json({ ...(await dmResults()), conversions });
    } catch (err) {
      return dmError(res, err, "loading the results");
    }
  });

  // Answer a brand that replied, through Instagram's API. Only possible inside
  // the 24 hours after their message - Instagram's rule, not ours - and only
  // when the Meta connection is configured (see lib/instagram-graph.js).
  router.post("/instagram/:handle/reply", async (req, res) => {
    const handle = String(req.params.handle).toLowerCase();
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "write the reply first" });
    if (text.length > 1000) return res.status(400).json({ error: "Instagram stops at 1,000 characters" });
    const { data: lead, error } = await supabase.from(TABLE).select("handle,ig_user_id").eq("handle", handle).maybeSingle();
    if (error) return dmError(res, error, "loading the lead");
    if (!lead?.ig_user_id) return res.status(409).json({ error: "this brand has not written to us on Instagram" });
    const { data: last } = await supabase.from("prospector_dm_messages").select("sent_at")
      .eq("ig_user_id", lead.ig_user_id).eq("direction", "in")
      .order("sent_at", { ascending: false }).limit(1).maybeSingle();
    if (!last || Date.now() - new Date(last.sent_at).getTime() > 24 * 3600 * 1000) {
      return res.status(409).json({ error: "their last message is over 24 hours old; answer from the Instagram app" });
    }
    try {
      const sent = await sendInstagramMessage(lead.ig_user_id, text);
      await supabase.from("prospector_dm_messages").insert({
        mid: sent.message_id || null, ig_user_id: lead.ig_user_id, handle,
        direction: "out", text, sent_at: new Date().toISOString(),
      });
      res.json({ sent: true });
    } catch (err) {
      res.status(502).json({ error: err?.message || "Instagram refused the message" });
    }
  });

  // The conversation with one brand, as Instagram delivered it.
  router.get("/instagram/:handle/messages", async (req, res) => {
    const { data, error } = await supabase.from("prospector_dm_messages")
      .select("direction,text,sent_at").eq("handle", String(req.params.handle).toLowerCase())
      .order("sent_at", { ascending: true }).limit(50);
    if (error) return dmError(res, error, "loading the conversation");
    res.json({ messages: data || [] });
  });

  // One lead's DM: edit the text, or record what happened to it.
  router.post("/instagram/:handle", async (req, res) => {
    const handle = String(req.params.handle).toLowerCase();
    const action = String(req.body?.action || "");
    const { data: lead, error } = await supabase
      .from(TABLE).select(DM_COLUMNS).eq("handle", handle).maybeSingle();
    if (error) return dmError(res, error, "loading the lead");
    if (!lead) return res.status(404).json({ error: "no such lead" });

    const state = lead.dm_state || "none";
    const now = new Date().toISOString();
    const who = req.admin?.name || req.admin?.email || null;
    let update;

    if (action === "edit") {
      const text = String(req.body?.text ?? "").trim();
      if (text.length > 1000) return res.status(400).json({ error: "Instagram stops at 1,000 characters" });
      if (!["none", "drafted"].includes(state)) {
        return res.status(409).json({ error: "this one has already gone" });
      }
      update = { dm_text: text || null, dm_state: text ? "drafted" : "none" };
    } else if (action === "sent") {
      if (!["none", "drafted"].includes(state)) {
        return res.status(409).json({ error: "already marked" });
      }
      // Already in the email sequence: a DM now would pitch the same brand twice.
      if (lead.pushed_at) {
        return res.status(409).json({ error: "this brand was already handed to the email sequence" });
      }
      update = { dm_state: "sent", dm_sent_at: now, dm_sent_by: who };
    } else if (action === "edit_followup") {
      const text = String(req.body?.text ?? "").trim();
      if (text.length > 1000) return res.status(400).json({ error: "Instagram stops at 1,000 characters" });
      if (state !== "sent" || lead.dm_followup_sent_at) {
        return res.status(409).json({ error: "the follow-up has already gone, or they replied" });
      }
      update = { dm_followup_text: text || null };
    } else if (action === "followup_sent") {
      if (state !== "sent" || lead.dm_followup_sent_at) {
        return res.status(409).json({ error: "already followed up, or they replied" });
      }
      update = { dm_followup_sent_at: now };
    } else if (action === "replied") {
      if (!["sent", "replied"].includes(state)) {
        return res.status(409).json({ error: "mark it sent first" });
      }
      update = { dm_state: "replied", dm_replied_at: lead.dm_replied_at || now };
    } else if (action === "skip") {
      if (!["none", "drafted"].includes(state)) {
        return res.status(409).json({ error: "this one has already gone" });
      }
      update = { dm_state: "skipped" };
    } else if (action === "brand" || action === "not_brand") {
      // A person's verdict on "is this a brand at all". classified_at is set
      // so the classifier, which only looks at unclassified leads, never
      // overrules it.
      if (!["none", "drafted"].includes(state)) {
        return res.status(409).json({ error: "this one has already been written to" });
      }
      update = { is_agency: action === "not_brand", classified_at: now };
    } else if (action === "reopen") {
      // Undoing a mis-click. The pipeline may already have read the send and
      // taken the brand out of the email sequence; it is left out, which is
      // the safe direction to be wrong in.
      update = {
        dm_state: lead.dm_text ? "drafted" : "none",
        dm_sent_at: null, dm_sent_by: null, dm_replied_at: null, dm_followup_sent_at: null,
      };
    } else {
      return res.status(400).json({
        error: "action must be one of edit, sent, edit_followup, followup_sent, replied, skip, brand, not_brand, reopen",
      });
    }

    const { data, error: saveError } = await supabase
      .from(TABLE).update(update).eq("handle", handle).select(DM_COLUMNS).maybeSingle();
    if (saveError) return dmError(res, saveError, "saving the DM");
    res.json(shapeDm(data));
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
    const { name, goal_leads, goal_tiers, budget_usd, source, hashtags, countries, continuous } = req.body || {};
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
    // Only sent when asked for, so creating a normal campaign still works on a
    // database that has not had 026 yet.
    if (continuous === true) row.continuous = true;
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
