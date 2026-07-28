// All Supabase reads/writes for the conversation manager.
// Keeps the AI module pure and the route handlers thin.

import { supabase } from "../lib/supabase.js";
import { DEFAULT_OFFERING, DEFAULT_PERSONA, DEFAULT_CREATOR_PERSONA } from "./conversation-prompts.js";

let _defaultTeamIdCache = null;
export async function getDefaultTeamId() {
  if (_defaultTeamIdCache) return _defaultTeamIdCache;
  const { data, error } = await supabase.from("teams").select("id").limit(1);
  if (error) throw new Error(`teams lookup failed: ${error.message}`);
  if (!data?.[0]?.id) throw new Error("no team in teams table");
  _defaultTeamIdCache = data[0].id;
  return _defaultTeamIdCache;
}

// ---------- CAMPAIGNS ----------

export async function listCampaigns(teamId) {
  const { data, error } = await supabase
    .from("ai_campaigns")
    .select("*")
    .eq("team_id", teamId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data;
}

export async function getCampaign(id, teamId) {
  const { data, error } = await supabase
    .from("ai_campaigns")
    .select("*")
    .eq("id", id)
    .eq("team_id", teamId)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function createCampaign({ teamId, name, offering, persona, contextPrompt, firstMessagePrompt, goal, goalLink, replyModel, firstMessageModel, audienceType, brandName, knowledgeBase }) {
  const row = {
    team_id: teamId,
    name,
    status: "draft",
    offering: { ...DEFAULT_OFFERING, ...(offering || {}) },
    persona: {
      ...(audienceType === "influencer" ? DEFAULT_CREATOR_PERSONA : DEFAULT_PERSONA),
      ...(persona || {}),
    },
    context_prompt: contextPrompt,
    first_message_prompt: firstMessagePrompt,
    goal: goal || "book a 15-min intro call",
    goal_link: goalLink || process.env.LINKABLE_CALENDAR_URL || null,
    reply_model: replyModel || "claude-sonnet-4-6",
    first_message_model: firstMessageModel || "claude-haiku-4-5-20251001",
    audience_type: audienceType === "influencer" ? "influencer" : "brand",
    brand_name: brandName || null,
    knowledge_base: knowledgeBase || null,
  };
  const { data, error } = await supabase.from("ai_campaigns").insert(row).select("*").single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateCampaign(id, teamId, patch) {
  const { data, error } = await supabase
    .from("ai_campaigns")
    .update(patch)
    .eq("id", id)
    .eq("team_id", teamId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// ---------- CONVERSATIONS ----------

export async function listConversations(teamId, { campaignId, status, limit = 100 } = {}) {
  let q = supabase
    .from("ai_conversations")
    .select("*")
    .eq("team_id", teamId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (campaignId) q = q.eq("campaign_id", campaignId);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data;
}

export async function getConversation(id, teamId) {
  const { data, error } = await supabase
    .from("ai_conversations")
    .select("*")
    .eq("id", id)
    .eq("team_id", teamId)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function findConversationByThread({ teamId, campaignId, prospectEmail, threadRootMessageId }) {
  if (threadRootMessageId) {
    // Match against both stripped and angle-bracketed forms — different
    // mail systems present Message-IDs differently and we historically
    // stored them with angles.
    const stripped = String(threadRootMessageId).replace(/^<|>$/g, "").trim();
    const wrapped = `<${stripped}>`;
    const byThread = await supabase
      .from("ai_conversations")
      .select("*")
      .eq("team_id", teamId)
      .in("thread_root_message_id", [stripped, wrapped])
      .maybeSingle();
    if (byThread.data) return byThread.data;
  }
  if (campaignId && prospectEmail) {
    const byPair = await supabase
      .from("ai_conversations")
      .select("*")
      .eq("team_id", teamId)
      .eq("campaign_id", campaignId)
      .ilike("prospect_email", prospectEmail)
      .maybeSingle();
    if (byPair.data) return byPair.data;
  }
  return null;
}

// Fallback when threading headers aren't available (Resend's inbound webhook
// strips them). Pick the most recently updated non-terminal conversation
// for this prospect — works because in practice a prospect rarely has more
// than one active thread with us at a time.
export async function findActiveConversationByEmail({ teamId, prospectEmail }) {
  if (!prospectEmail) return null;
  const { data, error } = await supabase
    .from("ai_conversations")
    .select("*")
    .eq("team_id", teamId)
    .ilike("prospect_email", prospectEmail)
    .not("status", "in", "(dead,opted_out,booked)")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  return data?.[0] || null;
}

// Cross-campaign dedup: has this address EVER been contacted, in any campaign?
// Used in bulk runner to skip prospects already in our system.
export async function emailAlreadyContacted({ teamId, prospectEmail }) {
  if (!prospectEmail) return false;
  const { count, error } = await supabase
    .from("ai_conversations")
    .select("id", { count: "exact", head: true })
    .eq("team_id", teamId)
    .ilike("prospect_email", prospectEmail);
  if (error) throw new Error(error.message);
  return (count || 0) > 0;
}

// ---------- DAILY CAP / BOUNCE RATE ----------

// Sends already shipped today for a campaign (uses sent_at, not scheduled_for).
// Counts only successful sends — failed rows don't burn the cap.
export async function countSentToday({ teamId, campaignId }) {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  // Join through conversations to filter by campaign.
  const { data: convs } = await supabase
    .from("ai_conversations")
    .select("id")
    .eq("team_id", teamId)
    .eq("campaign_id", campaignId);
  const convIds = (convs || []).map((c) => c.id);
  if (convIds.length === 0) return 0;
  const { count, error } = await supabase
    .from("ai_messages")
    .select("id", { count: "exact", head: true })
    .eq("team_id", teamId)
    .eq("direction", "out")
    .in("conversation_id", convIds)
    .gte("sent_at", dayStart.toISOString());
  if (error) throw new Error(error.message);
  return count || 0;
}

// Sends scheduled for today for a campaign (regardless of sent_at).
// Used to spread bulk runs across the business window without exceeding cap.
export async function countScheduledToday({ teamId, campaignId }) {
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  const { data: convs } = await supabase
    .from("ai_conversations")
    .select("id")
    .eq("team_id", teamId)
    .eq("campaign_id", campaignId);
  const convIds = (convs || []).map((c) => c.id);
  if (convIds.length === 0) return 0;
  const { count, error } = await supabase
    .from("ai_messages")
    .select("id", { count: "exact", head: true })
    .eq("team_id", teamId)
    .eq("direction", "out")
    .in("conversation_id", convIds)
    .gte("scheduled_for", dayStart.toISOString())
    .lt("scheduled_for", dayEnd.toISOString());
  if (error) throw new Error(error.message);
  return count || 0;
}

// Bounce-rate over the last `windowMessages` outbound sends for a campaign.
// Returns { sent, bounced, ratePct }. Used to decide auto-pause.
export async function recentBounceRate({ teamId, campaignId, windowMessages = 100 }) {
  const { data: convs } = await supabase
    .from("ai_conversations")
    .select("id")
    .eq("team_id", teamId)
    .eq("campaign_id", campaignId);
  const convIds = (convs || []).map((c) => c.id);
  if (convIds.length === 0) return { sent: 0, bounced: 0, ratePct: 0 };

  const { data: msgs, error } = await supabase
    .from("ai_messages")
    .select("id, email_provider_id")
    .eq("team_id", teamId)
    .eq("direction", "out")
    .in("conversation_id", convIds)
    .not("sent_at", "is", null)
    .order("sent_at", { ascending: false })
    .limit(windowMessages);
  if (error) throw new Error(error.message);
  const sent = (msgs || []).length;
  if (sent === 0) return { sent: 0, bounced: 0, ratePct: 0 };

  const providerIds = msgs.map((m) => m.email_provider_id).filter(Boolean);
  if (providerIds.length === 0) return { sent, bounced: 0, ratePct: 0 };

  // Bounce events were dispatched by handleResendStatusEvent and updated the
  // conversation. We count bounces by matching ai_suppressions where the
  // source_conversation_id is in our set AND created in the same window.
  const { count: bounced, error: e2 } = await supabase
    .from("ai_suppressions")
    .select("id", { count: "exact", head: true })
    .eq("team_id", teamId)
    .eq("reason", "bounce")
    .in("source_conversation_id", convIds);
  if (e2) throw new Error(e2.message);

  return {
    sent,
    bounced: bounced || 0,
    ratePct: ((bounced || 0) / sent) * 100,
  };
}

// ---------- METRICS DASHBOARD ----------

// Per-campaign funnel aggregates. One round trip via Postgres aggregation
// would be cleaner but supabase-js requires a stored function for that;
// for now we do it client-side over a single conversations + messages pull.
export async function getCampaignMetrics(teamId) {
  const { data: campaigns } = await supabase
    .from("ai_campaigns")
    .select("id, name, status, auto_paused_at, auto_pause_reason, daily_send_cap, send_window_start_hour, send_window_end_hour, timezone")
    .eq("team_id", teamId)
    .order("created_at", { ascending: false });
  if (!campaigns?.length) return [];

  const campaignIds = campaigns.map((c) => c.id);
  const { data: conversations } = await supabase
    .from("ai_conversations")
    .select("id, campaign_id, status, qualification_score, last_inbound_at")
    .eq("team_id", teamId)
    .in("campaign_id", campaignIds);

  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const { data: messages } = await supabase
    .from("ai_messages")
    .select("conversation_id, direction, sent_at, scheduled_for, error")
    .eq("team_id", teamId)
    .in("conversation_id", (conversations || []).map((c) => c.id))
    .gte("created_at", new Date(Date.now() - 30 * 24 * 3_600_000).toISOString());

  const byCampaign = Object.fromEntries(
    campaigns.map((c) => [
      c.id,
      {
        ...c,
        conversations: 0,
        active: 0,
        qualified: 0,
        booked: 0,
        dead: 0,
        opted_out: 0,
        escalated: 0,
        replied: 0,                 // had at least one inbound
        sent_total: 0,
        sent_today: 0,
        scheduled_pending: 0,
        avg_qualification: 0,
      },
    ])
  );

  const sumQual = {};
  for (const conv of conversations || []) {
    const c = byCampaign[conv.campaign_id];
    if (!c) continue;
    c.conversations++;
    if (conv.status === "active") c.active++;
    if (conv.status === "qualified") c.qualified++;
    if (conv.status === "booked") c.booked++;
    if (conv.status === "dead") c.dead++;
    if (conv.status === "opted_out") c.opted_out++;
    if (conv.status === "escalated") c.escalated++;
    if (conv.last_inbound_at) c.replied++;
    sumQual[conv.campaign_id] = (sumQual[conv.campaign_id] || 0) + (conv.qualification_score || 0);
  }
  for (const c of Object.values(byCampaign)) {
    c.avg_qualification = c.conversations > 0
      ? Math.round((sumQual[c.id] || 0) / c.conversations)
      : 0;
  }

  const convToCampaign = Object.fromEntries((conversations || []).map((c) => [c.id, c.campaign_id]));
  for (const m of messages || []) {
    const cid = convToCampaign[m.conversation_id];
    if (!cid) continue;
    const c = byCampaign[cid];
    if (m.direction !== "out") continue;
    if (m.sent_at) {
      c.sent_total++;
      if (new Date(m.sent_at) >= dayStart) c.sent_today++;
    } else if (m.scheduled_for && !m.error) {
      c.scheduled_pending++;
    }
  }

  return Object.values(byCampaign);
}

export async function createConversation({ teamId, campaignId, contactId, prospectEmail, prospectName, prospectCompany, prospectDossier, threadRootMessageId, threadSubject }) {
  const row = {
    team_id: teamId,
    campaign_id: campaignId,
    contact_id: contactId || null,
    prospect_email: prospectEmail,
    prospect_name: prospectName || null,
    prospect_company: prospectCompany || null,
    prospect_dossier: prospectDossier || {},
    status: "active",
    thread_root_message_id: threadRootMessageId || null,
    thread_subject: threadSubject || null,
    qualification_score: 0,
  };
  const { data, error } = await supabase.from("ai_conversations").insert(row).select("*").single();
  if (error) {
    // unique-constraint conflict — caller likely raced; fetch the existing row.
    if (error.code === "23505") {
      const existing = await findConversationByThread({
        teamId,
        campaignId,
        prospectEmail,
      });
      if (existing) return existing;
    }
    throw new Error(error.message);
  }
  return data;
}

export async function updateConversation(id, teamId, patch) {
  const { data, error } = await supabase
    .from("ai_conversations")
    .update(patch)
    .eq("id", id)
    .eq("team_id", teamId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// ---------- MESSAGES ----------

export async function listMessages(conversationId, teamId) {
  const { data, error } = await supabase
    .from("ai_messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .eq("team_id", teamId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return data;
}

export async function insertMessage(message) {
  const { data, error } = await supabase
    .from("ai_messages")
    .insert(message)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// History formatted for the LLM.
export async function buildHistoryForLLM(conversationId, teamId) {
  const messages = await listMessages(conversationId, teamId);
  return messages.map((m) => ({
    direction: m.direction,
    body: m.body,
  }));
}

// ---------- SUPPRESSIONS ----------

export async function isSuppressed(teamId, email) {
  if (!email) return false;
  const { data, error } = await supabase
    .from("ai_suppressions")
    .select("id, reason")
    .eq("team_id", teamId)
    .ilike("email", email)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? { suppressed: true, reason: data.reason } : { suppressed: false };
}

export async function upsertSuppression({ teamId, email, reason, detail, sourceConversationId }) {
  if (!email) return null;
  const { data, error } = await supabase
    .from("ai_suppressions")
    .upsert(
      {
        team_id: teamId,
        email: email.toLowerCase(),
        reason,
        detail: detail || null,
        source_conversation_id: sourceConversationId || null,
      },
      { onConflict: "team_id,email" }
    )
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function listSuppressions(teamId, { limit = 200 } = {}) {
  const { data, error } = await supabase
    .from("ai_suppressions")
    .select("*")
    .eq("team_id", teamId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data;
}

// ---------- RAW EVENTS ----------

export async function logRawEvent({ teamId, source, eventType, signatureValid, payload, headers, handlerResult, handlerError }) {
  const row = {
    team_id: teamId || null,
    source,
    event_type: eventType || null,
    signature_valid: signatureValid ?? null,
    payload: payload || {},
    headers: headers || null,
    handler_result: handlerResult || null,
    handler_error: handlerError || null,
  };
  const { data, error } = await supabase
    .from("ai_raw_events")
    .insert(row)
    .select("id")
    .single();
  if (error) {
    // Logging failure must not break the webhook handler — just log to console.
    console.error("ai_raw_events insert failed:", error.message);
    return null;
  }
  return data;
}

export async function listRawEvents(teamId, { limit = 100 } = {}) {
  const { data, error } = await supabase
    .from("ai_raw_events")
    .select("id, source, event_type, signature_valid, handler_error, created_at")
    .eq("team_id", teamId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data;
}

// ---------- BULK RUNS ----------

export async function createBulkRun({ teamId, campaignId, source, filters, total, status }) {
  const { data, error } = await supabase
    .from("ai_bulk_runs")
    .insert({
      team_id: teamId,
      campaign_id: campaignId,
      source,
      filters: filters || {},
      total: total || 0,
      status: status || "running",
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateBulkRun(id, patch) {
  const { data, error } = await supabase
    .from("ai_bulk_runs")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function listBulkRuns(teamId, { limit = 25 } = {}) {
  const { data, error } = await supabase
    .from("ai_bulk_runs")
    .select("*")
    .eq("team_id", teamId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data;
}

// ---------- FOLLOW-UP CANDIDATES ----------

// Returns conversations due for a follow-up:
//   - status = active
//   - last_outbound_at older than `staleMinutes`
//   - last_inbound_at IS NULL OR older than last_outbound_at (we only follow up
//     if our message was the most recent; if they replied, the reply path runs)
//   - follow_up_count < max_follow_ups
export async function listFollowUpCandidates(teamId, { staleMinutes = 60 * 24 * 3, limit = 50 } = {}) {
  const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("ai_conversations")
    .select("*")
    .eq("team_id", teamId)
    .eq("status", "active")
    .lt("last_outbound_at", cutoff)
    .order("last_outbound_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  // Filter in app code — the lt+last_inbound_at compound is awkward in PostgREST.
  return (data || []).filter((c) => {
    if (c.follow_up_count >= (c.max_follow_ups ?? 4)) return false;
    if (!c.last_inbound_at) return true;
    return new Date(c.last_inbound_at) < new Date(c.last_outbound_at);
  });
}
