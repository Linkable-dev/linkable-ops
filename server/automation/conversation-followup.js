// Follow-up scheduler: sends a polite nudge when a prospect ghosts.
//
// Cron picks this up periodically. We pick conversations where:
//   - status = active
//   - we sent the last message (last_outbound > last_inbound or no inbound yet)
//   - last_outbound_at older than the campaign's follow-up cadence
//   - follow_up_count < max_follow_ups
//
// The follow-up itself is generated via generateReply with a synthetic
// "still no reply, write a brief nudge" hint as the latest user turn — keeps
// the AI in the same persona without needing a third prompt template.

import {
  getDefaultTeamId,
  getCampaign,
  getConversation,
  buildHistoryForLLM,
  insertMessage,
  updateConversation,
  listFollowUpCandidates,
  isSuppressed,
} from "./conversation-state.js";
import { generateReply, applyToolCalls } from "./conversation-ai.js";

// Cadence: gap (in days) between follow-ups, indexed by attempt number.
// Attempt 0 → first follow-up after 3 days of silence.
// Attempt 1 → another 5 days, etc. Caps at 4 attempts.
const FOLLOW_UP_DAYS = [3, 5, 7, 14];

export async function processFollowUps({ limit = 50 } = {}) {
  const teamId = await getDefaultTeamId();
  // Find anything where last_outbound was > 3 days ago — narrowest cadence.
  const candidates = await listFollowUpCandidates(teamId, {
    staleMinutes: 60 * 24 * Math.min(...FOLLOW_UP_DAYS),
    limit: limit * 2,  // we'll filter further by per-conversation cadence
  });

  const results = [];
  for (const conv of candidates) {
    const attempt = conv.follow_up_count || 0;
    if (attempt >= (conv.max_follow_ups ?? 4)) continue;
    if (attempt >= FOLLOW_UP_DAYS.length) continue;

    // Have we waited long enough for THIS specific attempt?
    const baseTs = conv.last_follow_up_at || conv.last_outbound_at;
    if (!baseTs) continue;
    const minWaitMs = FOLLOW_UP_DAYS[attempt] * 24 * 3_600_000;
    if (Date.now() - new Date(baseTs).getTime() < minWaitMs) continue;

    // Suppression sanity check.
    const supp = await isSuppressed(teamId, conv.prospect_email);
    if (supp.suppressed) {
      await updateConversation(conv.id, teamId, {
        status: supp.reason === "opt_out" ? "opted_out" : "dead",
        next_action_at: null,
      });
      continue;
    }

    try {
      const result = await generateAndScheduleFollowUp(conv, teamId);
      results.push({ conversation_id: conv.id, ...result });
    } catch (err) {
      console.error(`follow-up failed for ${conv.id}:`, err.message);
      results.push({ conversation_id: conv.id, error: err.message });
    }
    if (results.length >= limit) break;
  }

  return { processed: results.length, results };
}

async function generateAndScheduleFollowUp(conv, teamId) {
  const campaign = await getCampaign(conv.campaign_id, teamId);
  const history = await buildHistoryForLLM(conv.id, teamId);

  // Inject a synthetic prospect turn instructing the AI to write a follow-up.
  // Stays inside the same Context Prompt / persona.
  const fresh = await getConversation(conv.id, teamId);
  const attempt = (fresh.follow_up_count || 0) + 1;
  const followUpHint = `(internal — write a brief follow-up: this is attempt ${attempt} of ${fresh.max_follow_ups ?? 4}. The prospect has not replied since your last message. Send a one or two sentence nudge that adds value or asks a different question. Do not apologize. Do not say "just following up" or "circling back". Avoid restating what you already said.)`;
  const augmented = [...history, { direction: "in", body: followUpHint }];

  const gen = await generateReply({ campaign, conversation: fresh, history: augmented });
  const stateUpdate = applyToolCalls(fresh, gen.tool_calls);

  // Schedule with same jitter window as a normal reply.
  const minS = campaign.reply_min_seconds || 120;
  const maxS = campaign.reply_max_seconds || 900;
  const jitter = Math.floor(Math.random() * (maxS - minS + 1)) + minS;
  const scheduledFor = new Date(Date.now() + jitter * 1000).toISOString();

  await insertMessage({
    team_id: teamId,
    conversation_id: conv.id,
    direction: "out",
    role: "assistant",
    subject: replySubject(fresh.thread_subject),
    body: gen.body,
    in_reply_to: fresh.thread_root_message_id,
    model: gen.model,
    tokens_in: gen.usage?.in,
    tokens_out: gen.usage?.out,
    cache_read_tokens: gen.usage?.cacheRead,
    cache_write_tokens: gen.usage?.cacheWrite,
    tool_calls: gen.tool_calls,
    scheduled_for: scheduledFor,
  });

  await updateConversation(conv.id, teamId, {
    status: stateUpdate.status,
    qualification_score: stateUpdate.qualification_score,
    ai_notes: stateUpdate.ai_notes,
    follow_up_count: attempt,
    last_follow_up_at: new Date().toISOString(),
    next_action_at: scheduledFor,
  });

  return {
    action: "follow-up-scheduled",
    attempt,
    scheduled_for: scheduledFor,
    body_preview: gen.body.slice(0, 80),
  };
}

function replySubject(originalSubject) {
  if (!originalSubject) return "Re:";
  if (/^re:/i.test(originalSubject)) return originalSubject;
  return `Re: ${originalSubject}`;
}
