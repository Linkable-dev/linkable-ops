// Orchestrates: inbound → state update → AI → outbound. Three entry points:
//
//   handleInbound(payload)            — webhook calls this
//   sendFirstMessage({...})           — kick off a thread for one prospect
//   sendDueScheduled()                — cron picks up scheduled outbound rows
//
// All side effects (DB writes, Resend calls) happen here so the API routes
// stay thin.

import {
  getDefaultTeamId,
  getCampaign,
  getConversation,
  findConversationByThread,
  createConversation,
  updateConversation,
  insertMessage,
  buildHistoryForLLM,
  isSuppressed,
  upsertSuppression,
} from "./conversation-state.js";
import {
  generateFirstMessage,
  generateReply,
  applyToolCalls,
} from "./conversation-ai.js";
import {
  normalizeInboundPayload,
  extractReplyBody,
  looksLikeAutoReply,
  looksLikeOptOut,
} from "./inbound-parser.js";
import { supabase } from "../lib/supabase.js";

const RESEND_API_URL = "https://api.resend.com/emails";

function replyToAddress() {
  return process.env.LINKABLE_REPLY_ADDRESS || "replies@reply.linkable.link";
}

// ---------- FIRST MESSAGE ----------

export async function sendFirstMessage({ teamId, campaignId, prospect, dryRun = false }) {
  const team = teamId || (await getDefaultTeamId());
  const campaign = await getCampaign(campaignId, team);

  // Don't double-create conversations.
  const existing = await findConversationByThread({
    teamId: team,
    campaignId,
    prospectEmail: prospect.email,
  });
  if (existing) {
    return { conversation: existing, skipped: "already started" };
  }

  // Hard stop if this address has been opted out / bounced / complained anywhere.
  const supp = await isSuppressed(team, prospect.email);
  if (supp.suppressed) {
    return { skipped: "suppressed", reason: supp.reason, email: prospect.email };
  }

  const gen = await generateFirstMessage({ campaign, prospect });

  // Build a stable Message-ID we'll set on the outbound. Inbound replies
  // reference this ID via In-Reply-To, which is how we re-attach them.
  const rootMessageId = `<${cryptoRandomId()}@linkable.link>`;

  const conversation = await createConversation({
    teamId: team,
    campaignId,
    contactId: prospect.contactId || null,
    prospectEmail: prospect.email,
    prospectName: prospect.name,
    prospectCompany: prospect.company || prospect.domain,
    prospectDossier: prospect,
    threadRootMessageId: rootMessageId,
    threadSubject: gen.subject,
  });

  const sendResult = dryRun
    ? { success: true, dryRun: true }
    : await sendOutbound({
        campaign,
        toEmail: prospect.email,
        toName: prospect.name,
        subject: gen.subject,
        body: gen.body,
        messageId: rootMessageId,
        inReplyTo: null,
      });

  const outboundRow = await insertMessage({
    team_id: team,
    conversation_id: conversation.id,
    direction: "out",
    role: "assistant",
    subject: gen.subject,
    body: gen.body,
    message_id: rootMessageId,
    in_reply_to: null,
    email_provider_id: sendResult?.resendId || null,
    model: gen.model,
    tokens_in: gen.usage?.in,
    tokens_out: gen.usage?.out,
    cache_read_tokens: gen.usage?.cacheRead,
    cache_write_tokens: gen.usage?.cacheWrite,
    sent_at: sendResult?.success ? new Date().toISOString() : null,
    error: sendResult?.success ? null : sendResult?.error,
  });

  await updateConversation(conversation.id, team, {
    last_outbound_at: new Date().toISOString(),
  });

  return { conversation, outbound: outboundRow, send: sendResult, ai: gen };
}

// ---------- INBOUND ----------

export async function handleInbound(payload) {
  const team = await getDefaultTeamId();
  const norm = normalizeInboundPayload(payload);
  if (!norm) return { ignored: "unparseable" };

  // Auto-replies: log and bail.
  if (looksLikeAutoReply(norm.headers, norm.text || norm.html)) {
    return { ignored: "auto-reply", from: norm.from_email };
  }

  // Find the conversation. Try In-Reply-To, References (any), then (campaign,email).
  let conversation = null;
  const candidates = [norm.in_reply_to, ...(norm.references || [])].filter(Boolean);
  for (const ref of candidates) {
    const found = await findConversationByThread({
      teamId: team,
      threadRootMessageId: stripAngles(ref),
    });
    if (found) {
      conversation = found;
      break;
    }
  }
  if (!conversation) {
    // Fallback: scan messages table for any out-message with this Message-ID
    // (should be rare since thread_root_message_id covers the first one).
    for (const ref of candidates) {
      const { data: msg } = await supabase
        .from("ai_messages")
        .select("conversation_id")
        .eq("team_id", team)
        .eq("message_id", stripAngles(ref))
        .maybeSingle();
      if (msg?.conversation_id) {
        const conv = await getConversation(msg.conversation_id, team);
        if (conv) {
          conversation = conv;
          break;
        }
      }
    }
  }
  if (!conversation) {
    return { ignored: "no matching conversation", from: norm.from_email, refs: candidates };
  }

  // Persist the inbound.
  const cleanBody = extractReplyBody(norm);
  const isOptOut = looksLikeOptOut(cleanBody);

  const inboundRow = await insertMessage({
    team_id: team,
    conversation_id: conversation.id,
    direction: "in",
    role: "user",
    subject: norm.subject,
    body: cleanBody,
    raw_body: norm.text || norm.html || "",
    message_id: stripAngles(norm.message_id),
    in_reply_to: stripAngles(norm.in_reply_to),
  });

  await updateConversation(conversation.id, team, {
    last_inbound_at: new Date().toISOString(),
  });

  // Hard-stop on opt-outs. Also write to global suppression list so the
  // address can't be hit by any other campaign.
  if (isOptOut) {
    await updateConversation(conversation.id, team, {
      status: "opted_out",
      ai_notes: appendNote(conversation.ai_notes, "opt-out detected from inbound text"),
      next_action_at: null,
    });
    try {
      await upsertSuppression({
        teamId: team,
        email: norm.from_email,
        reason: "opt_out",
        detail: cleanBody.slice(0, 200),
        sourceConversationId: conversation.id,
      });
    } catch (err) {
      console.error("suppression insert failed:", err.message);
    }
    return { conversation_id: conversation.id, action: "opted_out", inbound: inboundRow };
  }

  // Already terminal — don't generate a reply.
  if (["dead", "opted_out", "booked", "escalated"].includes(conversation.status)) {
    return { conversation_id: conversation.id, action: "terminal", status: conversation.status };
  }

  return await generateAndScheduleReply(conversation, team);
}

// ---------- REPLY GENERATION ----------

async function generateAndScheduleReply(conversation, teamId) {
  const campaign = await getCampaign(conversation.campaign_id, teamId);
  const history = await buildHistoryForLLM(conversation.id, teamId);

  // Refresh conversation state in case insertMessage above changed anything.
  const fresh = await getConversation(conversation.id, teamId);

  let gen;
  try {
    gen = await generateReply({ campaign, conversation: fresh, history });
  } catch (err) {
    return { conversation_id: conversation.id, action: "ai-error", error: err.message };
  }

  // Apply tool effects to conversation status
  const stateUpdate = applyToolCalls(fresh, gen.tool_calls);

  // Schedule send time with jitter inside campaign's reply window.
  const minS = campaign.reply_min_seconds || 120;
  const maxS = campaign.reply_max_seconds || 900;
  const jitter = Math.floor(Math.random() * (maxS - minS + 1)) + minS;
  const scheduledFor = new Date(Date.now() + jitter * 1000).toISOString();

  const outboundRow = await insertMessage({
    team_id: teamId,
    conversation_id: conversation.id,
    direction: "out",
    role: "assistant",
    subject: replySubject(fresh.thread_subject),
    body: gen.body,
    in_reply_to: conversation.thread_root_message_id,
    model: gen.model,
    tokens_in: gen.usage?.in,
    tokens_out: gen.usage?.out,
    cache_read_tokens: gen.usage?.cacheRead,
    cache_write_tokens: gen.usage?.cacheWrite,
    tool_calls: gen.tool_calls,
    scheduled_for: scheduledFor,
  });

  await updateConversation(conversation.id, teamId, {
    status: stateUpdate.status,
    qualification_score: stateUpdate.qualification_score,
    ai_notes: stateUpdate.ai_notes,
    next_action_at: scheduledFor,
  });

  return {
    conversation_id: conversation.id,
    action: "reply-scheduled",
    scheduled_for: scheduledFor,
    outbound_id: outboundRow.id,
    body: gen.body,
    tool_calls: gen.tool_calls,
    new_status: stateUpdate.status,
  };
}

// ---------- SCHEDULED SEND CRON ----------

export async function sendDueScheduled({ limit = 50 } = {}) {
  const teamId = await getDefaultTeamId();
  const now = new Date().toISOString();

  const { data: due, error } = await supabase
    .from("ai_messages")
    .select("*")
    .eq("team_id", teamId)
    .eq("direction", "out")
    .is("sent_at", null)
    .is("error", null)
    .lte("scheduled_for", now)
    .order("scheduled_for", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);

  const results = [];
  for (const msg of due || []) {
    const conv = await getConversation(msg.conversation_id, teamId);
    if (!conv) continue;
    if (["opted_out", "dead"].includes(conv.status)) {
      // belt and suspenders — don't send if state turned terminal after scheduling
      await supabase
        .from("ai_messages")
        .update({ error: `aborted: conversation status=${conv.status}` })
        .eq("id", msg.id);
      results.push({ id: msg.id, sent: false, reason: "terminal" });
      continue;
    }
    // Suppression check (separate from conversation status — could be a brand
    // new bounce that came in via a different campaign).
    const supp = await isSuppressed(teamId, conv.prospect_email);
    if (supp.suppressed) {
      await supabase
        .from("ai_messages")
        .update({ error: `aborted: address suppressed (${supp.reason})` })
        .eq("id", msg.id);
      await updateConversation(conv.id, teamId, {
        status: supp.reason === "opt_out" ? "opted_out" : "dead",
        next_action_at: null,
      });
      results.push({ id: msg.id, sent: false, reason: `suppressed-${supp.reason}` });
      continue;
    }
    const campaign = await getCampaign(conv.campaign_id, teamId);
    const messageId = `<${cryptoRandomId()}@linkable.link>`;
    const send = await sendOutbound({
      campaign,
      toEmail: conv.prospect_email,
      toName: conv.prospect_name,
      subject: msg.subject || replySubject(conv.thread_subject),
      body: msg.body,
      messageId,
      inReplyTo: msg.in_reply_to || conv.thread_root_message_id,
      references: [conv.thread_root_message_id].filter(Boolean),
    });
    await supabase
      .from("ai_messages")
      .update({
        message_id: messageId,
        email_provider_id: send.resendId || null,
        sent_at: send.success ? new Date().toISOString() : null,
        error: send.success ? null : send.error,
      })
      .eq("id", msg.id);
    if (send.success) {
      await updateConversation(conv.id, teamId, {
        last_outbound_at: new Date().toISOString(),
        next_action_at: null,
      });
    }
    results.push({ id: msg.id, sent: send.success, error: send.error });
  }

  return { processed: results.length, results };
}

// ---------- LOW-LEVEL OUTBOUND ----------

async function sendOutbound({ campaign, toEmail, toName, subject, body, messageId, inReplyTo, references }) {
  if (!process.env.RESEND_API_KEY) {
    return { success: false, error: "RESEND_API_KEY not set" };
  }

  const fromEmail = campaign.persona?.sender_email || "brand@linkable.link";
  // sender_display_name takes precedence; agent_name (first name) is a fallback
  // and looks fine but a full name in the From header builds more trust.
  const fromName =
    campaign.persona?.sender_display_name ||
    campaign.persona?.agent_name ||
    campaign.persona?.team_name ||
    "Linkable";

  // Reply-To routes inbound to the verified inbound subdomain so Resend's MX
  // catches the reply and POSTs it to our webhook. Stays separate from `from`
  // so the visible sender remains your real outreach address.
  const replyTo = replyToAddress();

  // CAN-SPAM / Gmail-Yahoo bulk-sender requirements: List-Unsubscribe with
  // both mailto and one-click HTTPS, plus One-Click POST signal.
  const unsubMail = `<mailto:unsubscribe@linkable.link?subject=Unsubscribe>`;
  const headers = {
    "Message-ID": messageId,
    "List-Unsubscribe": unsubMail,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
  if (inReplyTo) headers["In-Reply-To"] = ensureAngles(inReplyTo);
  if (references && references.length) {
    headers["References"] = references.map(ensureAngles).join(" ");
  }

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: `${fromName} <${fromEmail}>`,
        to: toName ? [`${toName} <${toEmail}>`] : [toEmail],
        reply_to: replyTo,
        subject,
        text: body,
        html: textToHtml(body),
        headers,
      }),
    });
    const data = await res.json();
    if (!res.ok) return { success: false, error: data.message || `Resend ${res.status}` };
    return { success: true, resendId: data.id };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ---------- RESEND STATUS EVENTS (bounce / complaint / delivered) ----------
//
// Wired by the webhook route. Resend posts these for emails WE sent.
// Body shape: { type, data: { email_id, to, from, ... } }
export async function handleResendStatusEvent(payload) {
  if (!payload?.type) return { ignored: "no event type" };
  const teamId = await getDefaultTeamId();
  const data = payload.data || {};
  const recipient = Array.isArray(data.to) ? data.to[0] : data.to;
  const recipientEmail = typeof recipient === "string"
    ? recipient.replace(/.*<([^>]+)>.*/, "$1").toLowerCase()
    : recipient?.address?.toLowerCase() || recipient?.email?.toLowerCase();

  // Find the conversation via email_provider_id on the outbound message.
  let conversation = null;
  if (data.email_id) {
    const { data: msg } = await supabase
      .from("ai_messages")
      .select("conversation_id")
      .eq("team_id", teamId)
      .eq("email_provider_id", data.email_id)
      .maybeSingle();
    if (msg?.conversation_id) {
      conversation = await getConversation(msg.conversation_id, teamId);
    }
  }

  switch (payload.type) {
    case "email.bounced": {
      if (recipientEmail) {
        await upsertSuppression({
          teamId,
          email: recipientEmail,
          reason: "bounce",
          detail: data?.bounce?.message || data?.reason || null,
          sourceConversationId: conversation?.id,
        });
      }
      if (conversation) {
        await updateConversation(conversation.id, teamId, {
          status: "dead",
          ai_notes: appendNote(conversation.ai_notes, `bounced: ${recipientEmail || "(unknown)"}`),
          next_action_at: null,
        });
      }
      return { action: "bounce", email: recipientEmail, conversation_id: conversation?.id };
    }
    case "email.complained": {
      if (recipientEmail) {
        await upsertSuppression({
          teamId,
          email: recipientEmail,
          reason: "complaint",
          detail: "spam complaint",
          sourceConversationId: conversation?.id,
        });
      }
      if (conversation) {
        await updateConversation(conversation.id, teamId, {
          status: "opted_out",
          ai_notes: appendNote(conversation.ai_notes, `spam complaint from ${recipientEmail || "(unknown)"}`),
          next_action_at: null,
        });
      }
      return { action: "complaint", email: recipientEmail, conversation_id: conversation?.id };
    }
    case "email.delivered": {
      // No state change needed; useful as a heartbeat.
      return { action: "delivered", email: recipientEmail };
    }
    default:
      return { ignored: payload.type };
  }
}

// ---------- HELPERS ----------

function textToHtml(text) {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
  return `<div style="font-family:-apple-system,system-ui,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.6;">${escaped}</div>`;
}

function replySubject(originalSubject) {
  if (!originalSubject) return "Re:";
  if (/^re:/i.test(originalSubject)) return originalSubject;
  return `Re: ${originalSubject}`;
}

function stripAngles(messageId) {
  if (!messageId) return null;
  return messageId.replace(/^<|>$/g, "").trim();
}

function ensureAngles(messageId) {
  if (!messageId) return messageId;
  const stripped = stripAngles(messageId);
  return `<${stripped}>`;
}

function cryptoRandomId() {
  // Use Web Crypto if available (Node 18+), else fallback.
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function appendNote(existing, line) {
  const stamp = new Date().toISOString();
  const entry = `[${stamp}] ${line}`;
  return existing ? `${existing}\n${entry}` : entry;
}

