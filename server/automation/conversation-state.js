// All Supabase reads/writes for the conversation manager.
// Keeps the AI module pure and the route handlers thin.

import { supabase } from "../lib/supabase.js";
import { DEFAULT_OFFERING, DEFAULT_PERSONA } from "./conversation-prompts.js";

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

export async function createCampaign({ teamId, name, offering, persona, contextPrompt, firstMessagePrompt, goal, goalLink, replyModel, firstMessageModel }) {
  const row = {
    team_id: teamId,
    name,
    status: "draft",
    offering: { ...DEFAULT_OFFERING, ...(offering || {}) },
    persona: { ...DEFAULT_PERSONA, ...(persona || {}) },
    context_prompt: contextPrompt,
    first_message_prompt: firstMessagePrompt,
    goal: goal || "book a 15-min intro call",
    goal_link: goalLink || process.env.LINKABLE_CALENDAR_URL || null,
    reply_model: replyModel || "claude-sonnet-4-6",
    first_message_model: firstMessageModel || "claude-haiku-4-5-20251001",
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
    const byThread = await supabase
      .from("ai_conversations")
      .select("*")
      .eq("team_id", teamId)
      .eq("thread_root_message_id", threadRootMessageId)
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

export async function createBulkRun({ teamId, campaignId, source, filters, total }) {
  const { data, error } = await supabase
    .from("ai_bulk_runs")
    .insert({
      team_id: teamId,
      campaign_id: campaignId,
      source,
      filters: filters || {},
      total: total || 0,
      status: "running",
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
