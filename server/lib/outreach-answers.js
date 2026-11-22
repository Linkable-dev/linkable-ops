// Answering replies by itself.
//
// When someone our own sender wrote to (lib/direct-outreach.js) writes back,
// this reads the whole exchange, decides what their message is, and either
// answers it from the mailbox it was sent from or passes it to a person. It
// answers what it can answer from the verified facts and nothing else: a
// question about terms, a complaint, anything legal, anything it is unsure of,
// goes to a person, with the reason. Nobody is ever told a person wrote it.
//
// It never runs unless the team setting `reply_auto` is on.

import crypto from "node:crypto";
import { supabase } from "./supabase.js";
import { claudeMessage, cachedSystem } from "./anthropic.js";
import { facts } from "./outside-agents.js";
import { MAILBOXES, SEQUENCES, compose } from "./direct-outreach.js";
import { sandboxRecipient } from "./outbound-sandbox.js";

const TABLE = "prospector_outbox";
const EMAILS = "prospector_outbox_emails";
const RESEND_API_URL = "https://api.resend.com/emails";

export const ANSWER_MODEL = "claude-opus-5-5";
// US dollars per million tokens, for the cost kept on each person.
const PRICE = { in: 4, out: 20 };

// After this many answers to one person, the next message is a person's.
export const MAX_AUTO_ANSWERS = 3;

export const INTENTS = ["interested", "question", "not_interested", "not_now", "wrong_person", "other"];

const replyTo = () => process.env.LINKABLE_REPLY_ADDRESS || "replies@reply.linkable.link";

// The only links an answer may carry.
export const LINKS = {
  signup: "https://app.linkable.link",
  pitch: "https://www.linkable.link/pitch",
  site: "https://www.linkable.link",
  demo: "https://calendly.com/federico-linkable/linkable-demo",
  shopify: "https://apps.shopify.com/linkable-1",
};

const RULES = `You answer emails for Linkable, a platform where ecommerce brands and creators work together. Someone we emailed has written back, and you write the reply that goes to them.

How to decide:
- "answer": their message is something you can answer fully and truthfully from the verified facts below. That covers interest ("yes, send it"), and plain questions about what Linkable is, how it works, what it costs, and how to start.
- "no_answer": they said no, not now, or that they are the wrong person, and asked nothing. Leave them alone. Never argue with a no.
- "hand_over": everything else. A question the facts do not answer. A request for special terms, a discount, a contract, a call at a set time, or anything about their own account. A complaint, an angry or upset message, anything legal or about their data. A question about whether they are talking to a person, a bot or an AI. Anything you are not sure about. A person will answer these.

How to write an answer. You are writing as the team member whose name signs the email, in the first person ("I"), the way they would type a quick reply between other things:
- Answer what they asked in the first sentence. Then stop as soon as they have what they need.
- Match them. A one-line message gets one or two lines back. A longer, more careful message gets a few sentences. Use their first name if they gave one, and the greeting they used ("Hi Anna," back to "Hi Luca,"); if they gave no name, just "Hi,". If they were casual, be casual.
- Sound like a person talking: contractions (it's, you'll, I'd), everyday words, sentences of different lengths. Say "yes" or "no" plainly. It is fine to start with "Sure," or "Good question."
- Never sound like a brochure or a help page: no feature lists, no "Once you have connected...", no "feel free to", "I hope this helps", "don't hesitate", "happy to help", "great question", "I'd be delighted", "rest assured", "seamless", "simply". No sentence that only sells.
- One idea per reply. If they asked one thing, do not volunteer three more.
- No emoji, no bullet points, no bold, no headings, at most one exclamation mark and usually none. British spelling.
- Write in the language they wrote to you in. We write to brands and creators in the UK, the US, Italy and Spain, so an Italian message gets an Italian answer and a Spanish one a Spanish answer, as a native speaker would write it. British spelling applies to English only.
- State only what the verified facts say. No other number, price, promise or claim. Prices are in US dollars, as written.
- Do not invent anything about yourself: no personal stories, no "I checked with the team", no "I just looked at your profile", nothing that did not happen.
- If they ask whether they are talking to a person, a bot or an AI, do not answer: hand over, and a team member replies.
- Do not sign it; the name is added for you. At most one link, only one of the links listed below, written out in full.
- End on the next step, in a few words, or just end. Do not ask more than one question, and do not ask one at all if there is nothing you need to know.
- Do not repeat what our earlier emails already said.
`;

const FOR_AUDIENCE = {
  creator: `This person is a creator. What we want for them is Pitch: they pick any brand they would like to work with, Linkable helps write the proposal, sends it to the right person at the brand and follows up. Ten pitches a month are free.
When they say yes or ask how to start, give them ${LINKS.signup} and say it takes a few minutes. For more about Pitch, ${LINKS.pitch}.`,
  brand: `This person works at a brand. What we want for them is to try Linkable: they can start free at ${LINKS.signup}, or see it first in a 15 minute call at ${LINKS.demo}.
When they ask for the list of creators we mentioned and "The list" is given below, send it: one short sentence, then the lines exactly as given, each on its own line, then one sentence on the next step. Those lines and their links are the one exception to the rules on links and length. If no list is given below, or they ask for anything else about their own store or results, hand over.`,
};

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: INTENTS, description: "What their latest message is." },
    action: { type: "string", enum: ["answer", "no_answer", "hand_over"] },
    reply: { type: "string", description: "The reply text, starting with a short greeting line and with no signature. Empty unless action is answer." },
    reason: { type: "string", description: "One plain sentence: why this action. For hand_over, what the person who picks it up needs to know." },
  },
  required: ["intent", "action", "reply", "reason"],
  additionalProperties: false,
};

// ---------------------------------------------------------------- the exchange --

/** Everything said so far, oldest first: our planned emails that have left,
 *  their messages, and the answers written for them. Pure. */
export function exchange(row, now = new Date()) {
  const stamp = new Date(now).toISOString();
  const out = [];
  let subject = "";
  (row.thread || []).forEach((sent, i) => {
    if (sent.at > stamp) return;
    const composed = compose({ ...row, subject }, i);
    if (composed.problem) return;
    if (i === 0) subject = composed.subject;
    out.push({ from: "us", at: sent.at, subject: composed.subject, text: composed.text });
  });
  for (const m of row.conversation || []) {
    if (m.from === "us" && m.at > stamp) continue;
    out.push({ from: m.from, at: m.at, subject: m.subject || "", text: m.text || "" });
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** The creators we saw posting about a brand, one line each ("@handle link"),
 *  as the worker handed them over. Pure. */
export function creatorList(row) {
  return String(row.variables?.creatorList || "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 15);
}

function brief(row, now) {
  const lines = exchange(row, now).map((m) =>
    `--- ${m.from === "us" ? "We wrote" : "They wrote"} (${m.at.slice(0, 16).replace("T", " ")})${m.subject ? `, subject "${m.subject}"` : ""}:\n${m.text}`);
  const list = creatorList(row);
  const theList = row.audience === "brand" && list.length
    ? `\n\nThe list (creators we saw posting about this brand, with the post):\n${list.join("\n")}`
    : "";
  return `${FOR_AUDIENCE[row.audience]}${theList}\n\nThe exchange so far, oldest first:\n\n${lines.join("\n\n")}\n\nDecide what their latest message is and what to do. If you answer, write the reply.`;
}

// ---------------------------------------------------------------- the checks --

const allowedLink = (url) => Object.values(LINKS).some((ok) => url.replace(/[).,]+$/, "") === ok || url.startsWith(`${ok}/`) || url.startsWith(`${ok}?`));

/** Why an answer may not be sent; "" when it may. Pure. */
export function answerProblem(reply, factsText = facts(), list = []) {
  const text = String(reply || "").trim();
  if (text.length < 20) return "the answer came back empty";
  // The list a brand asked for is long by nature, and its links are theirs to have.
  const listLinks = list.flatMap((l) => l.match(/https?:\/\/\S+/g) || []);
  if (text.length > 1200 + list.join("\n").length) return "the answer is too long for an email reply";
  if (/\*\*|^#+\s|^\s*[-•*]\s/m.test(text)) return "the answer has bold, headings or bullet points";
  if ((text.match(/!/g) || []).length > 1) return "the answer has more than one exclamation mark";
  const stock = text.match(/feel free to|i hope this helps|don't hesitate|do not hesitate|happy to help|great question|i'd be delighted|rest assured|seamless|as an ai|language model/i);
  if (stock) return `the answer says "${stock[0]}", which reads as a machine or a help page`;
  const links = (text.match(/https?:\/\/\S+/g) || []).filter((l) => !listLinks.includes(l.replace(/[).,]+$/, "")));
  if (links.length > 1) return "the answer has more than one link";
  if (links.some((l) => !allowedLink(l))) return "the answer has a link that is not one of ours";
  // Any money figure must be one the facts state.
  for (const amount of text.match(/[$£€]\s?\d[\d,.]*/g) || []) {
    if (!factsText.includes(amount.replace(/\s/g, "").replace(/[.,]$/, ""))) return `the answer quotes ${amount}, which the facts do not state`;
  }
  if (/\b\d+(\.\d+)?\s?%/.test(text) && !(text.match(/\b\d+(\.\d+)?\s?%/g) || []).every((p) => factsText.includes(p.replace(/\s/g, "")))) {
    return "the answer quotes a percentage the facts do not state";
  }
  if (/\b(i am|i'm) (a )?(real )?(person|human)\b|\bnot (a |an )?(bot|ai|robot)\b|\bwritten by a (person|human)\b/i.test(text)) {
    return "the answer says a person wrote it";
  }
  if (/guarantee|promise you|i'll make sure|we will definitely/i.test(text)) return "the answer makes a promise the facts do not";
  return "";
}

/** When an answer leaves. Minutes after their message, never the same
 *  number twice, and never in the night. */
export function answerTime(now = new Date(), random = Math.random) {
  // Usually within a quarter of an hour, sometimes most of an hour: a person
  // who is at their desk, and one who was not.
  const minutes = random() < 0.7 ? 4 + random() * 14 : 18 + random() * 40;
  const at = new Date(new Date(now).getTime() + minutes * 60000);
  const hour = at.getUTCHours();
  if (hour >= 7 && hour < 20) return at;
  const morning = new Date(at);
  if (hour >= 20) morning.setUTCDate(morning.getUTCDate() + 1);
  morning.setUTCHours(8, Math.floor(random() * 40), 0, 0);
  return morning;
}

// ---------------------------------------------------------------- deciding --

/** Ask the model what to do with their latest message. Returns
 *  { action, intent, reply, reason, cost }. Any failure is a hand-over. */
export async function decide(row, { ask = claudeMessage, now = new Date() } = {}) {
  if ((row.auto_answers || 0) >= MAX_AUTO_ANSWERS) {
    return { action: "hand_over", intent: "other", reply: "", reason: `Already answered ${MAX_AUTO_ANSWERS} times by itself; the next one is yours.`, cost: 0 };
  }
  let cost = 0;
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await ask({
        model: ANSWER_MODEL,
        system: cachedSystem(`${RULES}\nLinks you may use, and no others:\n${Object.values(LINKS).join("\n")}\n\nVerified facts:\n\n${facts()}`),
        maxTokens: 4000,
        temperature: null, // not accepted by this model
        outputConfig: { effort: "low", format: { type: "json_schema", schema: ANSWER_SCHEMA } },
        messages: [{ role: "user", content: brief(row, now) + (problem ? `\n\nYour last reply was refused: ${problem}. Fix that, or hand over.` : "") }],
      });
    } catch (err) {
      return { action: "hand_over", intent: "other", reply: "", reason: `The answer could not be written (${String(err.message).slice(0, 120)}).`, cost };
    }
    const u = res.usage || {};
    cost += ((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1) / 1e6 * PRICE.in
      + (u.output_tokens || 0) / 1e6 * PRICE.out;
    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") {
      return { action: "hand_over", intent: "other", reply: "", reason: "The answer could not be written for this message.", cost };
    }
    let out;
    try {
      out = JSON.parse(res.text);
    } catch {
      problem = "the reply was not in the form asked for";
      continue;
    }
    const intent = INTENTS.includes(out.intent) ? out.intent : "other";
    if (out.action !== "answer") {
      return { action: out.action === "no_answer" ? "no_answer" : "hand_over", intent, reply: "", reason: String(out.reason || "").slice(0, 400), cost };
    }
    problem = answerProblem(out.reply, facts(), row.audience === "brand" ? creatorList(row) : []);
    if (!problem) return { action: "answer", intent, reply: String(out.reply).trim(), reason: String(out.reason || "").slice(0, 400), cost };
  }
  return { action: "hand_over", intent: "other", reply: "", reason: `The answer written for this was refused twice: ${problem}.`, cost };
}

// ---------------------------------------------------------------- acting --

async function resend(payload) {
  if (!process.env.RESEND_API_KEY) return { ok: false, error: "the mail service key is not set" };
  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, id: data.id } : { ok: false, error: data.message || `the mail service answered ${res.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function save(id, fields) {
  const { error } = await supabase.from(TABLE).update({ ...fields, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}

/** The answer as it is handed to the mail service. Pure. */
export function answerMessage(row, reply, at) {
  const theirs = [...(row.conversation || [])].reverse().find((m) => m.from === "them") || {};
  const first = (row.subject || theirs.subject || "").trim();
  const subject = /^re:/i.test(first) ? first : `Re: ${first || "your message"}`;
  const name = String(row.variables?.signature || "").trim();
  const sender = String(row.variables?.senderName || "").trim();
  const messageId = `<${crypto.randomUUID()}@linkable.link>`;
  const target = sandboxRecipient({ to: row.to_email, subject });
  const refs = [...(row.thread || []).map((t) => t.message_id), ...(row.conversation || []).map((m) => m.message_id)].filter(Boolean);
  const headers = { "Message-ID": messageId };
  if (theirs.message_id) headers["In-Reply-To"] = theirs.message_id;
  if (refs.length) headers.References = refs.join(" ");
  const from = MAILBOXES[row.audience];
  return {
    messageId,
    subject,
    payload: {
      from: sender ? `${sender} <${from}>` : from,
      to: [target.to],
      reply_to: replyTo(),
      subject: target.subject,
      text: name ? `${reply}\n\n${name}` : reply,
      headers,
      scheduled_at: new Date(at).toISOString(),
    },
  };
}

/** What the mailbox is sent, so a person can see every exchange and step in. */
function noteToMailbox(row, theirs, decision, at) {
  const head = {
    answer: `Answered automatically (leaves ${new Date(at).toISOString().slice(11, 16)} UTC)`,
    no_answer: "No answer needed",
    hand_over: "Needs you",
  }[decision.action];
  const body = [`From ${row.to_email}`, theirs.text || "(no text)"];
  if (decision.action === "answer") body.push(`--\nWe answered:\n\n${decision.reply}`);
  body.push(`--\n${decision.reason || ""}\n${decision.action === "hand_over" ? "Answer this email to write back to them." : "Answer this email if you want to add something."} Their follow-ups have stopped.`);
  return {
    from: `Linkable replies <${replyTo()}>`,
    to: [MAILBOXES[row.audience]],
    reply_to: row.to_email,
    subject: `${head}: ${theirs.subject || row.subject || "(no subject)"}`,
    text: body.join("\n\n"),
  };
}

/**
 * Deal with one person's latest message: answer it, leave it, or pass it to a
 * person. `row` is the full outbox row, with their message already in its
 * conversation. Everything it does is written back to the row.
 */
export async function answerPerson(row, { ask, send = resend, now = new Date(), random = Math.random } = {}) {
  const theirs = [...(row.conversation || [])].reverse().find((m) => m.from === "them");
  if (!theirs) return { action: "none" };

  // An answer of ours that is timed but has not left is out of date now.
  const stamp = new Date(now).toISOString();
  const stale = (row.conversation || []).filter((m) => m.from === "us" && m.at > stamp && m.resend_id);
  for (const m of stale) {
    await fetch(`${RESEND_API_URL}/${m.resend_id}/cancel`, { method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } }).catch(() => {});
    await supabase.from(EMAILS).update({ cancelled_at: stamp }).eq("resend_id", m.resend_id);
  }
  const kept = (row.conversation || []).filter((m) => !stale.includes(m));
  const current = { ...row, conversation: kept, auto_answers: Math.max(0, (row.auto_answers || 0) - stale.length) };

  const decision = await decide(current, { ask, now });
  const patch = {
    intent: decision.intent,
    answer_pending_since: null,
    answer_cost_usd: Number(row.answer_cost_usd || 0) + decision.cost,
    needs_person: decision.action === "hand_over",
    needs_person_reason: decision.action === "hand_over" ? decision.reason : null,
    conversation: kept,
    auto_answers: current.auto_answers,
  };

  let at = null;
  if (decision.action === "answer") {
    at = answerTime(now, random);
    const message = answerMessage(current, decision.reply, at);
    const sent = await send(message.payload);
    if (!sent.ok) {
      decision.action = "hand_over";
      decision.reason = `An answer was written but could not be sent (${sent.error}).`;
      patch.needs_person = true;
      patch.needs_person_reason = decision.reason;
    } else {
      patch.conversation = [...kept, { from: "us", auto: true, at: at.toISOString(), subject: message.subject, text: message.payload.text, message_id: message.messageId, resend_id: sent.id }];
      patch.auto_answers = current.auto_answers + 1;
      await supabase.from(EMAILS).insert({
        outbox_id: row.id, audience: row.audience, sequence: row.sequence, step: 0, kind: "answer",
        to_email: row.to_email, from_email: MAILBOXES[row.audience], subject: message.subject,
        resend_id: sent.id, scheduled_for: at.toISOString(),
      }).then(({ error }) => error && console.error("recording an answer failed:", error.message));
    }
  }
  await save(row.id, patch);
  const note = await send(noteToMailbox(row, theirs, decision, at || now));
  return { action: decision.action, intent: decision.intent, reason: decision.reason, at: at ? at.toISOString() : null, noted: !!note.ok, cost: decision.cost };
}

/** Messages that were recorded but never dealt with (the run that received
 *  them was cut short). Swept by the send job. */
export async function answerPending({ limit = 5, olderThanMs = 3 * 60000, ...opts } = {}) {
  const before = new Date(Date.now() - olderThanMs).toISOString();
  const { data, error } = await supabase.from(TABLE).select("*").not("answer_pending_since", "is", null)
    .lte("answer_pending_since", before).order("answer_pending_since", { ascending: true }).limit(limit);
  if (error) throw new Error(error.message);
  const out = [];
  for (const row of data || []) out.push({ to: row.to_email, ...(await answerPerson(row, opts)) });
  return out;
}

// SEQUENCES is re-exported so a caller can tell which wording a row is on
// without importing two modules.
export { SEQUENCES };
