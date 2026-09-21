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

    // Say why a creator cannot be invited, next to the button that would
    // invite them. Without this a creator found by search shows invite / hold
    // / hide, somebody clicks invite, and nothing happens - ever, and with
    // nothing anywhere saying why.
    const creators = (data || []).map((c) => ({ ...c, blocked: inviteBlockedReason(c) }));
    res.json({ creators, total: count ?? (data || []).length });
  });

  // The same conditions push_creators_to_lemlist applies, in the same order,
  // so the page and the pipeline cannot disagree about who is sendable.
  function inviteBlockedReason(c) {
    if (c.pushed_at) return null;
    if (["hold", "hide"].includes(c.decision)) return null;   // that is the point of holding
    if (c.status !== "qualified") return "not qualified yet - run creators qualify";
    if (!c.contact_email) return "no email in their bio";
    // The invite opens "saw your post about X". Without an X there is nothing
    // true to say, and it becomes the mailshot this was built not to be.
    if (!c.example_brand || !c.example_post_url) {
      return c.source === "influencers_club"
        ? "found by search, so we have not seen them post about a brand - the invite has no true opening line"
        : "no observed post to open with";
    }
    return null;
  }

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
        .in("event", ["replied", "interested", "not_interested", "bounced", "unsubscribed"])
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
