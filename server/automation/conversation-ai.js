// The AI brain. Two functions:
//   generateFirstMessage — opens the conversation (Haiku, low temp, JSON output)
//   generateReply        — manages every reply after that (Sonnet, cached system,
//                          tool use)
//
// Everything is structured so the runner can consume it without retries — failures
// throw, callers decide what to do.

import { claudeMessage, cachedSystem, tokenStats } from "../lib/anthropic.js";
import {
  buildContextPrompt,
  buildFirstMessagePrompt,
  CONVERSATION_TOOLS,
} from "./conversation-prompts.js";

// ---------- STYLE GUARDS ----------

const BANNED_PHRASES = [
  "impressed",
  "inspiring",
  "admire",
  "fascinating",
  "absolutely",
  "definitely",
  "circle back",
  "touch base",
  "hope this finds you well",
  "to whom it may concern",
];

// Strip em dashes and standalone hyphens used as dashes ( word - word ).
// We do NOT strip hyphens inside words (well-known) or in URLs.
export function sanitizeStyle(text) {
  if (!text) return text;
  let out = text;
  out = out.replace(/—/g, ", ");
  out = out.replace(/\s-\s/g, ", ");
  out = out.replace(/\s+,/g, ",");
  out = out.replace(/,{2,}/g, ",");
  out = out.replace(/[ \t]+/g, " ").trim();
  return out;
}

export function findStyleIssues(text) {
  const issues = [];
  if (!text || !text.trim()) {
    issues.push("empty body");
    return issues;
  }
  const lower = text.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) issues.push(`uses banned phrase: "${phrase}"`);
  }
  if (text.includes("—")) issues.push("contains em dash");
  if (/\b\w+\s-\s\w+\b/.test(text)) issues.push("contains hyphen used as dash");
  return issues;
}

// ---------- FIRST MESSAGE ----------

export async function generateFirstMessage({ campaign, prospect, apiKey }) {
  const prompt = buildFirstMessagePrompt({
    offering: campaign.offering,
    persona: campaign.persona,
    prospect,
  });

  const res = await claudeMessage({
    model: campaign.first_message_model || "claude-haiku-4-5-20251001",
    messages: [{ role: "user", content: prompt }],
    maxTokens: 400,
    temperature: 0.85,
    apiKey,
  });

  const parsed = parseJsonReply(res.text);
  if (!parsed?.subject || !parsed?.body) {
    throw new Error(`first-message: model returned invalid JSON: ${res.text.slice(0, 200)}`);
  }

  const subject = sanitizeStyle(parsed.subject);
  const body = sanitizeStyle(parsed.body);
  const issues = findStyleIssues(body);

  return {
    subject,
    body,
    style_issues: issues,
    usage: tokenStats(res),
    model: res.model,
  };
}

function parseJsonReply(text) {
  if (!text) return null;
  let parsed = tryParse(text);
  if (parsed) return parsed;
  // Fallback: pull the first {...} block.
  const m = text.match(/\{[\s\S]*\}/);
  if (m) parsed = tryParse(m[0]);
  return parsed;
}

function tryParse(s) {
  try { return JSON.parse(s); } catch (err) { void err; return null; }
}

// ---------- REPLY ----------

// `history` is the conversation as an LLM sees it: an array of
//   { direction: "in"|"out", body: string }
// in chronological order. We map to assistant/user roles for the LLM.
export async function generateReply({ campaign, conversation, history, apiKey }) {
  const system = buildContextPrompt({
    offering: campaign.offering,
    persona: campaign.persona,
    goal: campaign.goal,
    goalLink: campaign.goal_link,
  });

  const messages = history.map((m) => ({
    role: m.direction === "out" ? "assistant" : "user",
    content: m.body,
  }));

  // Anthropic requires the conversation to end with a user turn so the model
  // produces an assistant turn. If we somehow ended on an assistant turn,
  // append a synthetic nudge — but in practice generateReply is only called
  // after a fresh inbound, so the last message is always user.
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    throw new Error("generateReply: history must end with an inbound (user) message");
  }

  // Prepend a small contextual note about who the prospect is.
  // Doing this as part of the system prompt would invalidate the cache, so
  // attach it to the first user turn instead by injecting a synthetic system-
  // like user/assistant pair at the very start.
  if (conversation.prospect_dossier && Object.keys(conversation.prospect_dossier).length) {
    const dossier = `(Internal context — not shown to prospect)
You are talking to: ${conversation.prospect_name || conversation.prospect_email}
Company: ${conversation.prospect_company || "(unknown)"}
Notes: ${JSON.stringify(conversation.prospect_dossier).slice(0, 1500)}
Status: ${conversation.status}. Qualification score so far: ${conversation.qualification_score}.`;
    messages.unshift({ role: "user", content: dossier });
    messages.unshift({ role: "assistant", content: "Understood." });
  }

  const res = await claudeMessage({
    model: campaign.reply_model || "claude-sonnet-4-6",
    system: cachedSystem(system),
    messages,
    tools: CONVERSATION_TOOLS,
    maxTokens: 600,
    temperature: 0.7,
    apiKey,
  });

  const body = sanitizeStyle(res.text);
  const issues = findStyleIssues(body);

  return {
    body,
    tool_calls: res.toolCalls,
    style_issues: issues,
    usage: tokenStats(res),
    model: res.model,
    stop_reason: res.stop_reason,
  };
}

// ---------- DERIVE NEW STATUS FROM TOOL CALLS ----------

export function applyToolCalls(conversation, toolCalls) {
  let status = conversation.status;
  let qualification_score = conversation.qualification_score;
  let ai_notes = conversation.ai_notes || "";

  for (const call of toolCalls || []) {
    switch (call.name) {
      case "mark_qualified": {
        status = status === "booked" ? status : "qualified";
        if (typeof call.input?.score === "number") qualification_score = call.input.score;
        ai_notes = appendNote(ai_notes, `qualified: ${call.input?.reason || ""}`);
        break;
      }
      case "book_meeting": {
        status = "booked";
        qualification_score = Math.max(qualification_score, 90);
        ai_notes = appendNote(ai_notes, `booked: ${call.input?.reason || ""}`);
        break;
      }
      case "mark_dead": {
        status = "dead";
        ai_notes = appendNote(ai_notes, `dead: ${call.input?.reason || ""}`);
        break;
      }
      case "opt_out": {
        status = "opted_out";
        ai_notes = appendNote(ai_notes, `opt-out: ${call.input?.reason || ""}`);
        break;
      }
      case "escalate_to_human": {
        status = "escalated";
        ai_notes = appendNote(ai_notes, `escalated: ${call.input?.reason || ""}`);
        break;
      }
      default:
        break;
    }
  }

  return { status, qualification_score, ai_notes };
}

function appendNote(existing, line) {
  const stamp = new Date().toISOString();
  const entry = `[${stamp}] ${line}`;
  return existing ? `${existing}\n${entry}` : entry;
}
