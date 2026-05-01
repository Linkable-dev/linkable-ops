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
  findActiveConversationByEmail,
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
  fetchResendEmail,
} from "./inbound-parser.js";
import { supabase } from "../lib/supabase.js";
import { cancelPendingTouches } from "./sequencer.js";

const RESEND_API_URL = "https://api.resend.com/emails";

function replyToAddress() {
  return process.env.LINKABLE_REPLY_ADDRESS || "replies@reply.linkable.link";
}

// ---------- FIRST MESSAGE ----------

// Send a first message to one prospect. Three modes:
//   dryRun: true               — generate, don't insert/send
//   scheduledFor: <ISO>        — insert row scheduled for that time, don't send
//                                 now. Cron picks it up. Used by bulk runner.
//   neither                    — generate, insert, send immediately. Used by
//                                 the "Send to one address" button.
export async function sendFirstMessage({ teamId, campaignId, prospect, dryRun = false, scheduledFor = null }) {
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

  // Decide whether to send now or schedule.
  const willScheduleOnly = !!scheduledFor && !dryRun;
  const willSendNow = !dryRun && !scheduledFor;

  let sendResult = { success: true, dryRun: true };
  if (willSendNow) {
    sendResult = await sendOutbound({
      campaign,
      toEmail: prospect.email,
      toName: prospect.name,
      subject: gen.subject,
      body: gen.body,
      messageId: rootMessageId,
      inReplyTo: null,
    });
  }

  const outboundRow = await insertMessage({
    team_id: team,
    conversation_id: conversation.id,
    direction: "out",
    role: "assistant",
    subject: gen.subject,
    body: gen.body,
    // Only stamp message_id if we actually sent now. The cron path stamps
    // it at send time so each scheduled row gets a fresh, valid ID.
    message_id: willSendNow ? rootMessageId : null,
    in_reply_to: null,
    email_provider_id: sendResult?.resendId || null,
    model: gen.model,
    tokens_in: gen.usage?.in,
    tokens_out: gen.usage?.out,
    cache_read_tokens: gen.usage?.cacheRead,
    cache_write_tokens: gen.usage?.cacheWrite,
    scheduled_for: willScheduleOnly ? scheduledFor : null,
    sent_at: sendResult?.success && willSendNow ? new Date().toISOString() : null,
    error: sendResult?.success || willScheduleOnly ? null : sendResult?.error,
  });

  if (willSendNow) {
    await updateConversation(conversation.id, team, {
      last_outbound_at: new Date().toISOString(),
    });
  } else if (willScheduleOnly) {
    await updateConversation(conversation.id, team, {
      next_action_at: scheduledFor,
    });
  }

  return {
    conversation,
    outbound: outboundRow,
    send: sendResult,
    ai: gen,
    scheduled: willScheduleOnly ? scheduledFor : null,
  };
}

// ---------- INBOUND ----------

export async function handleInbound(payload) {
  const team = await getDefaultTeamId();
  const norm = normalizeInboundPayload(payload);
  if (!norm) return { ignored: "unparseable" };

  // Resend's email.received webhook payload is metadata-only — no body, no
  // threading headers. Fetch the full email content via their API so we
  // have the actual reply text for the LLM.
  let bodyText = norm.text || norm.html || "";
  let fetchDiag = null;
  if (!bodyText && norm.email_provider_id) {
    try {
      const full = await fetchResendEmail(norm.email_provider_id);
      norm.text = norm.text || full.text || "";
      norm.html = norm.html || full.html || "";
      bodyText = norm.text || norm.html;
      fetchDiag = {
        ok: true,
        text_len: (full.text || "").length,
        html_len: (full.html || "").length,
        keys: Object.keys(full || {}),
      };
    } catch (err) {
      console.error("fetchResendEmail failed:", err.message);
      fetchDiag = { ok: false, error: err.message };
    }
  }

  // Auto-replies: log and bail.
  if (looksLikeAutoReply(norm.headers, bodyText)) {
    return { ignored: "auto-reply", from: norm.from_email };
  }

  // Daily-200 sequencer cancel + replied_at stamp run BEFORE the conversation
  // match — daily-200 prospects don't have ai_conversations rows, so the
  // "no matching conversation" branch below would otherwise skip them.
  if (norm.from_email) {
    const isOptOutEarly = looksLikeOptOut(extractReplyBody(norm) || "");
    try {
      const cancelReason = isOptOutEarly ? "opted_out" : "replied";
      const { cancelled } = await cancelPendingTouches({
        teamId: team, email: norm.from_email, reason: cancelReason,
      });
      if (cancelled > 0) {
        console.log(`[conversation-runner] cancelled ${cancelled} pending touches for ${norm.from_email} (${cancelReason})`);
      }
      const { data: target } = await supabase
        .from("email_sends")
        .select("id")
        .eq("team_id", team)
        .ilike("to_email", norm.from_email)
        .eq("status", "sent")
        .not("sequence_id", "is", null)
        .is("replied_at", null)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (target?.id) {
        await supabase.from("email_sends")
          .update({ replied_at: new Date().toISOString() })
          .eq("id", target.id);
      }
      if (isOptOutEarly) {
        await upsertSuppression({
          teamId: team, email: norm.from_email,
          reason: "opt_out", detail: "inbound opt-out (daily-200)",
        }).catch((e) => console.error("opt-out suppression failed:", e.message));
      }
    } catch (err) {
      console.error("daily-200 inbound bookkeeping failed:", err.message);
    }
  }

  // Find the conversation. Order of attempts:
  //   1. By In-Reply-To / References headers (best, but Resend doesn't expose them)
  //   2. By scanning ai_messages.message_id for the same refs
  //   3. By prospect email + active status (works when headers are stripped)
  let conversation = null;
  const candidates = [norm.in_reply_to, ...(norm.references || [])].filter(Boolean);

  for (const ref of candidates) {
    const found = await findConversationByThread({
      teamId: team,
      threadRootMessageId: ref,
    });
    if (found) { conversation = found; break; }
  }
  if (!conversation) {
    for (const ref of candidates) {
      const stripped = stripAngles(ref);
      const { data: msg } = await supabase
        .from("ai_messages")
        .select("conversation_id")
        .eq("team_id", team)
        .in("message_id", [stripped, `<${stripped}>`])
        .maybeSingle();
      if (msg?.conversation_id) {
        const conv = await getConversation(msg.conversation_id, team);
        if (conv) { conversation = conv; break; }
      }
    }
  }
  if (!conversation && norm.from_email) {
    conversation = await findActiveConversationByEmail({
      teamId: team,
      prospectEmail: norm.from_email,
    });
  }
  // Last resort before giving up: if this address is part of a daily-200
  // sequence whose email_campaigns.auto_reply is on, spin up an ai_conversation
  // tied to the configured ai_campaign so the AI can take over from here.
  if (!conversation && norm.from_email) {
    conversation = await maybeUpgradeToAutoReply({
      teamId: team,
      fromEmail: norm.from_email,
      subject: norm.subject,
      messageId: norm.message_id,
    });
  }

  if (!conversation) {
    return {
      ignored: "no matching conversation - manual triage",
      from: norm.from_email,
      refs: candidates,
      fetch: fetchDiag,
      hint: "Reply landed but campaign is in manual mode (auto_reply=false) or no daily-200 enrollment found.",
    };
  }

  // Persist the inbound.
  const cleanBody = extractReplyBody(norm);
  const isOptOut = looksLikeOptOut(cleanBody);

  // Refuse to insert an empty inbound — Claude rejects empty user messages
  // and the conversation gets stuck. Surface the cause loudly.
  if (!cleanBody || !cleanBody.trim()) {
    return {
      action: "empty-body",
      conversation_id: conversation.id,
      from: norm.from_email,
      fetch: fetchDiag,
      norm_text_len: (norm.text || "").length,
      norm_html_len: (norm.html || "").length,
      hint: "Inbound matched a conversation but the body was empty after fetch+parse. Check fetch.ok and fetch.text_len above.",
    };
  }

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

  // (daily-200 cancel + replied_at + opt-out suppression already ran earlier,
  // before the conversation match — daily-200 prospects have no ai_conversations
  // row so they'd otherwise be skipped here.)

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

  // Find the latest inbound — its Message-ID is what the AI's reply must
  // point at via In-Reply-To so mail clients thread it correctly.
  const { data: latestIn } = await supabase
    .from("ai_messages")
    .select("message_id")
    .eq("team_id", teamId)
    .eq("conversation_id", conversation.id)
    .eq("direction", "in")
    .not("message_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const inReplyToTarget = latestIn?.message_id || conversation.thread_root_message_id;

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
    in_reply_to: inReplyToTarget,
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

    // Skip when the campaign is paused (manual or auto). Replies STILL go out
    // because once a thread is open we owe the prospect a response, but new
    // first messages stay queued until the campaign is unpaused.
    const isFirstMessage = !msg.in_reply_to;
    if (campaign.status === "paused" && isFirstMessage) {
      results.push({ id: msg.id, sent: false, reason: `campaign-paused: ${campaign.auto_pause_reason || "manual"}` });
      continue;
    }
    const messageId = `<${cryptoRandomId()}@linkable.link>`;

    // For replies only: build the full References chain so mail clients
    // thread under the original conversation. First messages have no
    // chain — sending them with a populated References would be wrong.
    let references = [];
    let inReplyTo = null;
    if (!isFirstMessage) {
      const { data: priorMsgs } = await supabase
        .from("ai_messages")
        .select("message_id")
        .eq("team_id", teamId)
        .eq("conversation_id", conv.id)
        .not("message_id", "is", null)
        .neq("id", msg.id)
        .order("created_at", { ascending: true });
      references = (priorMsgs || []).map((m) => m.message_id).filter(Boolean);
      inReplyTo = msg.in_reply_to || references[references.length - 1] || conv.thread_root_message_id;
    }

    const send = await sendOutbound({
      campaign,
      toEmail: conv.prospect_email,
      toName: conv.prospect_name,
      subject: msg.subject || (isFirstMessage ? conv.thread_subject : replySubject(conv.thread_subject)),
      body: msg.body,
      messageId,
      inReplyTo,
      references,
    });

    // First-message path: stamp the new Message-ID as the conversation's
    // thread root so future inbound replies match here.
    if (send.success && isFirstMessage) {
      await updateConversation(conv.id, teamId, {
        thread_root_message_id: messageId,
      });
    }
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
        // Plain text only — no html field. Cold outreach reads more
        // personal when it renders in the recipient's default font with
        // no styling, like a normal one-to-one email.
        text: body,
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

// ---------- RESEND STATUS EVENTS ----------
//
// Wired by the webhook route. Resend posts these for emails WE sent.
// Body shape: { type, data: { email_id, to, from, ... } }
//
// Two systems care about these:
//   1. The AI conversations system (ai_messages / ai_conversations) — legacy
//   2. The daily-200 sequencer (email_sends) — newer, drives the dashboard
// We update both whenever the corresponding row exists. resend_id / email_id
// is the join key on each side.
export async function handleResendStatusEvent(payload) {
  if (!payload?.type) return { ignored: "no event type" };
  const teamId = await getDefaultTeamId();
  const data = payload.data || {};
  const recipient = Array.isArray(data.to) ? data.to[0] : data.to;
  const recipientEmail = typeof recipient === "string"
    ? recipient.replace(/.*<([^>]+)>.*/, "$1").toLowerCase()
    : recipient?.address?.toLowerCase() || recipient?.email?.toLowerCase();
  const resendId = data.email_id || null;

  // ai_messages match (legacy system)
  let conversation = null;
  if (resendId) {
    const { data: msg } = await supabase
      .from("ai_messages")
      .select("conversation_id")
      .eq("team_id", teamId)
      .eq("email_provider_id", resendId)
      .maybeSingle();
    if (msg?.conversation_id) {
      conversation = await getConversation(msg.conversation_id, teamId);
    }
  }

  // Stamp email_sends regardless of whether the conversation exists. Returns
  // the matched row so we know whether the daily-200 cared about this event.
  const sendRow = await stampEmailSendForResendEvent({
    teamId, resendId, recipientEmail, eventType: payload.type, data,
  });

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
      return { action: "bounce", email: recipientEmail, conversation_id: conversation?.id, send_id: sendRow?.id };
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
      return { action: "complaint", email: recipientEmail, conversation_id: conversation?.id, send_id: sendRow?.id };
    }
    case "email.delivered":
      return { action: "delivered", email: recipientEmail, send_id: sendRow?.id };
    case "email.opened":
      return { action: "opened", email: recipientEmail, send_id: sendRow?.id };
    case "email.clicked":
      return { action: "clicked", email: recipientEmail, send_id: sendRow?.id };
    default:
      return { ignored: payload.type };
  }
}

// Stamp the matching email_sends row with the appropriate timestamp + status
// transition for this Resend event. First-write-wins for opened/clicked so we
// don't trample "first interaction" metrics with the second click.
async function stampEmailSendForResendEvent({ teamId, resendId, recipientEmail, eventType, data }) {
  if (!resendId && !recipientEmail) return null;

  let q = supabase.from("email_sends").select("id, status, opened_at, clicked_at").eq("team_id", teamId);
  q = resendId ? q.eq("resend_id", resendId) : q.ilike("to_email", recipientEmail);
  // Sequence rows only — legacy A-F sends share to_email but we don't want to
  // count them in the new dashboard. resend_id match is precise either way.
  if (!resendId) q = q.not("sequence_id", "is", null);
  const { data: rows } = await q.order("sent_at", { ascending: false }).limit(1);
  const row = rows?.[0];
  if (!row) return null;

  const now = new Date().toISOString();
  const patch = {};
  switch (eventType) {
    case "email.delivered":
      patch.delivered_at = now;
      break;
    case "email.opened":
      if (!row.opened_at) patch.opened_at = now;   // first-open wins
      break;
    case "email.clicked":
      if (!row.clicked_at) patch.clicked_at = now;
      // A click implies an open; backfill if missing.
      if (!row.opened_at) patch.opened_at = now;
      break;
    case "email.bounced":
      patch.bounced_at = now;
      patch.status = "bounced";
      patch.error = data?.bounce?.message || data?.reason || "bounced";
      break;
    case "email.complained":
      patch.complained_at = now;
      // Don't override bounced status — complaint after delivery is normal.
      break;
  }
  if (Object.keys(patch).length === 0) return row;

  const { data: updated, error } = await supabase
    .from("email_sends").update(patch).eq("id", row.id).select("id").single();
  if (error) console.error(`stampEmailSendForResendEvent ${eventType}: ${error.message}`);
  return updated || row;
}

// ---------- AUTO-REPLY BRIDGE ----------
//
// When a daily-200 prospect replies AND their email_campaigns.auto_reply=true
// AND the campaign has an ai_campaign_id pointing at an ai_campaigns row, we
// upgrade the thread by creating an ai_conversations row on the fly. This
// lets the existing AI reply pipeline take it from there. If any link is
// missing we return null and the caller falls through to manual triage.
async function maybeUpgradeToAutoReply({ teamId, fromEmail, subject, messageId }) {
  // Find this prospect's most recent SENT daily-200 row.
  const { data: sendRow } = await supabase
    .from("email_sends")
    .select("id, campaign_id, subject, body, resend_id, to_email, to_name, contact_id, template_key")
    .eq("team_id", teamId)
    .ilike("to_email", fromEmail)
    .eq("status", "sent")
    .not("sequence_id", "is", null)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!sendRow?.campaign_id) return null;

  const { data: campaign } = await supabase
    .from("email_campaigns")
    .select("id, name, auto_reply, ai_campaign_id")
    .eq("team_id", teamId).eq("id", sendRow.campaign_id).maybeSingle();
  if (!campaign?.auto_reply || !campaign.ai_campaign_id) return null;

  // Spin up a conversation tied to the AI campaign. Use the original outbound
  // message-id as thread_root_message_id so future inbound replies thread
  // here without re-running this logic.
  try {
    const conv = await createConversation({
      teamId,
      campaignId: campaign.ai_campaign_id,
      contactId: sendRow.contact_id,
      prospectEmail: fromEmail.toLowerCase(),
      prospectName: sendRow.to_name,
      prospectCompany: null,
      prospectDossier: { source: "daily-200", template_key: sendRow.template_key, email_campaign_id: campaign.id, email_campaign_name: campaign.name },
      threadRootMessageId: messageId ? stripAngles(messageId) : null,
      threadSubject: subject || `Re: ${sendRow.subject}`,
    });

    // Stub the original outbound so the LLM has prior turns context.
    await insertMessage({
      team_id: teamId,
      conversation_id: conv.id,
      direction: "out",
      role: "assistant",
      subject: sendRow.subject,
      body: sendRow.body,
      raw_body: sendRow.body,
      email_provider_id: sendRow.resend_id,
      message_id: null,
      in_reply_to: null,
    }).catch((e) => console.error("auto-reply stub message failed:", e.message));

    console.log(`[conversation-runner] auto-reply upgraded ${fromEmail} into ai_conversation ${conv.id}`);
    return conv;
  } catch (err) {
    console.error("maybeUpgradeToAutoReply failed:", err.message);
    return null;
  }
}

// ---------- HELPERS ----------

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

