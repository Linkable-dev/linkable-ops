// Our own sender for the people linkable-prospector hands over: brands from
// brand@linkable.link, creators from influencer@linkable.link.
//
// The worker inserts one row per person into prospector_outbox, with the values
// the wording interpolates. Everything after that happens here, with nobody
// pressing anything: each step goes out when it is due, and the sequence stops
// at a reply, an unsubscribe, a bounce or a spam complaint.
//
// The wording below is the wording that was in the four Lemlist campaigns,
// moved here as it stood. Change a sentence here and it changes for everyone
// who has not had that step yet.

import crypto from "node:crypto";
import { supabase } from "./supabase.js";
import { sandboxRecipient } from "./outbound-sandbox.js";

const TABLE = "prospector_outbox";
const RESEND_API_URL = "https://api.resend.com/emails";

export const MAILBOXES = {
  brand: "brand@linkable.link",
  creator: "influencer@linkable.link",
};

// The most one mailbox sends in a day, first emails and follow-ups together.
// The worker's daily numbers decide how many people start; this is the ceiling
// that holds if something upstream goes wrong.
export const MAILBOX_DAILY_CEILING = 90;
const MAX_ATTEMPTS = 3;

const SIGN_OFF = "{{signature}}\nlinkable.link";
const DEMO = "Easier to show than explain, if you've got 15 minutes:\nhttps://calendly.com/federico-linkable/linkable-demo";
const NINETEEN = "One store we work with had 19 creators apply in their first month. All on commission, nothing up front.";
const WHAT_IT_IS =
  "I work on Linkable. Brands post campaigns there and creators apply. You see the reward before you apply: free product, a fixed fee, commission on what you sell, or a mix.";
const FREE = "It's free for creators, and you can pitch any brand you like from it too.";
const CREATOR_FOLLOW_UPS = [
  {
    afterDays: 4,
    body: [
      "{{greeting}}",
      "Quick one. On Linkable you see what a campaign offers before you apply, so there's no back and forth about rates.",
      "The product is shipped to you, and your payments are tracked in one place.",
      SIGN_OFF,
    ],
  },
  {
    afterDays: 6,
    body: [
      "{{greeting}}",
      "Last one from me. If you'd rather apply to brands that are already looking for creators than message them one by one, that's what Linkable is for.",
      "Either way, good luck with it.",
      SIGN_OFF,
    ],
  },
];
const LAST_BRAND_STEP = {
  afterDays: 7,
  body: ["{{greeting}}", "Last one from me, I won't keep going.", "{{closingOffer}}", "Otherwise no hard feelings, good luck with it.", SIGN_OFF],
};

// afterDays counts from the step before it, in days, as it did in Lemlist. A
// step with no subject is a follow-up in the same conversation.
export const SEQUENCES = {
  brand_a: {
    audience: "brand",
    steps: [
      {
        afterDays: 0,
        subject: "{{subjectLine}}",
        body: [
          "{{greeting}}",
          "{{proofBlock}}",
          "{{listOffer}}",
          "Tracking it is the part we build, if you ever get round to it. Each creator gets their own link and the commission sorts itself out. Shopify app, about ten minutes.",
          SIGN_OFF,
        ],
      },
      {
        afterDays: 3,
        body: [
          "{{greeting}}",
          "{{followUpHook}}",
          "Most people I ask say no, for what it's worth. It's not an unusual gap.",
          "Offer of the list still stands either way.",
          SIGN_OFF,
        ],
      },
      { afterDays: 4, body: ["{{greeting}}", NINETEEN, "{{socialProof}}", DEMO, SIGN_OFF] },
      LAST_BRAND_STEP,
    ],
  },
  brand_b: {
    audience: "brand",
    steps: [
      { afterDays: 0, subject: "{{subjectLine}}", body: ["{{greeting}}", "{{proofBlock}}", "{{listOffer}}", SIGN_OFF] },
      {
        afterDays: 3,
        body: ["{{greeting}}", "{{followUpHook}}", "Most people I ask haven't got a number for it, for what it's worth.", SIGN_OFF],
      },
      { afterDays: 4, body: ["{{greeting}}", NINETEEN, "{{socialProof}}", DEMO, SIGN_OFF] },
      LAST_BRAND_STEP,
    ],
  },
  creator: {
    audience: "creator",
    steps: [
      {
        afterDays: 0,
        subject: "your {{exampleBrand}} post",
        body: ["{{greeting}}", "Saw your post about {{exampleBrand}}.\n{{examplePost}}", WHAT_IT_IS, FREE, "Want me to send you the sign-up?", SIGN_OFF],
      },
      ...CREATOR_FOLLOW_UPS,
    ],
  },
  creator_cold: {
    audience: "creator",
    steps: [
      {
        afterDays: 0,
        subject: "{{niche}} creators + paid brand work",
        body: [
          "{{greeting}}",
          "I was looking for {{niche}} creators for brands on Linkable and you came up.",
          WHAT_IT_IS,
          FREE,
          "Want me to send you the sign-up?",
          SIGN_OFF,
        ],
      },
      ...CREATOR_FOLLOW_UPS,
    ],
  },
};

// ------------------------------------------------------------------ wording --

/** Fill {{names}} from `variables`. Returns the names that had no value: a
 *  blank in a sentence somebody reads is not an email worth sending. */
export function fill(template, variables) {
  const missing = [];
  const text = template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, name) => {
    const value = variables?.[name];
    const shown = value === null || value === undefined ? "" : String(value).trim();
    if (!shown) missing.push(name);
    return shown;
  });
  return { text, missing };
}

/** The subject and text of one step for one person, or why it cannot be written. */
export function compose(row, stepIndex) {
  const sequence = SEQUENCES[row.sequence];
  if (!sequence) return { problem: `no wording called "${row.sequence}"` };
  const step = sequence.steps[stepIndex];
  if (!step) return { problem: `"${row.sequence}" has no step ${stepIndex + 1}` };

  const variables = row.variables || {};
  const body = fill(step.body.join("\n\n"), variables);
  let subject;
  let missing = body.missing;
  if (step.subject) {
    const filled = fill(step.subject, variables);
    subject = filled.text.replace(/\s+/g, " ").trim();
    missing = missing.concat(filled.missing);
  } else {
    // A follow-up sits under the first email.
    const first = (row.subject || "").trim();
    if (!first) return { problem: "the first email's subject was not kept" };
    subject = /^re:/i.test(first) ? first : `Re: ${first}`;
  }
  if (missing.length) return { problem: `nothing to put in ${[...new Set(missing)].join(", ")}` };

  // Who is writing and how to stop it, under the sign-off. Supplied by the
  // worker, which knows the company details; optional.
  const footer = String(variables.footer || "").trim();
  return { subject, text: footer ? `${body.text}\n\n${footer}` : body.text };
}

// Emails go out on working days. A step that would land on a weekend waits
// for Monday.
export function onWorkingDay(date) {
  const d = new Date(date);
  const day = d.getUTCDay();
  if (day === 6) d.setUTCDate(d.getUTCDate() + 2);
  if (day === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/** When the step after `sentIndex` is due, or null when that was the last. */
export function nextDue(sequenceKey, sentIndex, sentAt) {
  const next = SEQUENCES[sequenceKey]?.steps[sentIndex + 1];
  if (!next) return null;
  const due = new Date(sentAt);
  due.setUTCDate(due.getUTCDate() + next.afterDays);
  return onWorkingDay(due);
}

// ------------------------------------------------------------------ sending --

export function publicBase() {
  return (process.env.OPS_PUBLIC_URL || "https://linkable-ops.vercel.app").replace(/\/+$/, "");
}

function replyTo() {
  return process.env.LINKABLE_REPLY_ADDRESS || "replies@reply.linkable.link";
}

/** What is handed to the mail provider for one step. Pure, so it can be read in a test. */
export function buildMessage(row, stepIndex, composed) {
  const from = MAILBOXES[row.audience];
  const name = String(row.variables?.senderName || "").trim();
  const messageId = `<${crypto.randomUUID()}@linkable.link>`;
  const earlier = (row.thread || []).map((t) => t.message_id).filter(Boolean);
  const target = sandboxRecipient({ to: row.to_email, subject: composed.subject });
  const unsubscribe = `${publicBase()}/api/out/unsubscribe?t=${row.unsub_token}`;
  const headers = {
    "Message-ID": messageId,
    "List-Unsubscribe": `<${unsubscribe}>, <mailto:unsubscribe@linkable.link?subject=Unsubscribe>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
  if (stepIndex > 0 && earlier.length) {
    headers["In-Reply-To"] = earlier[earlier.length - 1];
    headers.References = earlier.join(" ");
  }
  return {
    messageId,
    payload: {
      from: name ? `${name} <${from}>` : from,
      to: [target.to],
      reply_to: replyTo(),
      subject: target.subject,
      // Text only: one person writing to another, in the reader's own font.
      text: composed.text,
      headers,
    },
  };
}

async function deliver(payload) {
  if (!process.env.RESEND_API_KEY) return { ok: false, error: "the mail service key is not set" };
  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.message || `the mail service answered ${res.status}` };
    return { ok: true, id: data.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const startOfDay = (now) => {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

async function sentToday(audience, now) {
  const { count, error } = await supabase
    .from(TABLE)
    .select("id", { count: "exact", head: true })
    .eq("audience", audience)
    .gte("last_sent_at", startOfDay(now).toISOString());
  if (error) throw new Error(error.message);
  return count || 0;
}

async function suppressed(email) {
  const { data } = await supabase.from("ai_suppressions").select("reason").ilike("email", email).limit(1);
  return data?.[0]?.reason || null;
}

const STOP_FOR = { opt_out: "unsubscribed", bounce: "bounced", complaint: "unsubscribed" };

async function update(id, fields) {
  const { error } = await supabase.from(TABLE).update({ ...fields, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}

/**
 * Send what is due. Follow-ups first, so a day that hits the ceiling has
 * finished conversations it started rather than opened new ones.
 *
 * `send` and `pause` are injectable for tests; `paused` comes from the team
 * setting (direct_send_paused).
 */
export async function sendDue({ limit = 25, now = new Date(), dryRun = false, paused = false, send = deliver, gapMs = 700 } = {}) {
  const out = { due: 0, sent: 0, stopped: 0, failed: 0, held: 0, dry_run: dryRun, log: [] };
  if (paused) return { ...out, paused: true };
  const day = new Date(now).getUTCDay();
  if (day === 0 || day === 6) return { ...out, weekend: true };

  const { data: rows, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("status", "active")
    .lte("next_at", new Date(now).toISOString())
    .order("step", { ascending: false })
    .order("next_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  out.due = rows.length;

  const room = {};
  for (const audience of Object.keys(MAILBOXES)) {
    room[audience] = MAILBOX_DAILY_CEILING - (await sentToday(audience, now));
  }

  for (const row of rows) {
    if (room[row.audience] <= 0) {
      out.held += 1;
      continue;
    }
    const why = await suppressed(row.to_email);
    if (why) {
      if (!dryRun) await update(row.id, { status: STOP_FOR[why] || "unsubscribed", stop_reason: why });
      out.stopped += 1;
      continue;
    }
    const composed = compose(row, row.step);
    if (composed.problem) {
      if (!dryRun) await update(row.id, { status: "failed", stop_reason: composed.problem });
      out.failed += 1;
      out.log.push(`${row.to_email}: ${composed.problem}`);
      continue;
    }
    const { messageId, payload } = buildMessage(row, row.step, composed);
    if (dryRun) {
      out.log.push(`${row.to_email}: step ${row.step + 1} "${composed.subject}" from ${payload.from}`);
      out.sent += 1;
      continue;
    }
    const result = await send(payload);
    if (!result.ok) {
      const attempts = (row.attempts || 0) + 1;
      await update(row.id, attempts >= MAX_ATTEMPTS
        ? { attempts, status: "failed", stop_reason: result.error }
        : { attempts });
      out.failed += 1;
      out.log.push(`${row.to_email}: ${result.error}`);
      continue;
    }
    const sentAt = new Date();
    const due = nextDue(row.sequence, row.step, sentAt);
    await update(row.id, {
      step: row.step + 1,
      attempts: 0,
      subject: row.step === 0 ? composed.subject : row.subject,
      thread: [...(row.thread || []), { step: row.step + 1, at: sentAt.toISOString(), resend_id: result.id, message_id: messageId }],
      last_sent_at: sentAt.toISOString(),
      ...(due ? { next_at: due.toISOString() } : { status: "done" }),
    });
    room[row.audience] -= 1;
    out.sent += 1;
    if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
  }
  return out;
}

// ------------------------------------------------------------ what comes back --

/**
 * Somebody wrote back. Their sequence stops, their words are kept, and the
 * message is passed on to the mailbox it was sent from so a person can answer
 * it there. Returns null when the sender is not one of ours.
 */
export async function onReply({ fromEmail, subject, text, optOut = false, send = deliver }) {
  if (!fromEmail) return null;
  const { data } = await supabase
    .from(TABLE)
    .select("id,audience,status,subject,to_email")
    .ilike("to_email", fromEmail)
    .limit(1);
  const row = data?.[0];
  if (!row) return null;
  if (!["unsubscribed", "bounced"].includes(row.status)) {
    await update(row.id, {
      status: optOut ? "unsubscribed" : "replied",
      stop_reason: optOut ? "opt_out" : "replied",
      reply_at: new Date().toISOString(),
      reply_text: String(text || "").slice(0, 8000),
    });
  }
  const mailbox = MAILBOXES[row.audience];
  const forwarded = await send({
    from: `Linkable replies <${replyTo()}>`,
    to: [mailbox],
    reply_to: fromEmail,
    subject: `${optOut ? "Unsubscribed" : "Reply"}: ${subject || row.subject || "(no subject)"}`,
    text: `From ${fromEmail}\n\n${text || "(no text)"}\n\n--\nAnswer this email to write back to them. Their follow-ups have stopped.`,
  });
  return { id: row.id, status: optOut ? "unsubscribed" : "replied", forwarded: !!forwarded.ok };
}

/** A bounce or a spam complaint for one of ours: no more to that address. */
export async function onStop({ email, reason }) {
  if (!email) return null;
  const { data } = await supabase.from(TABLE).select("id").ilike("to_email", email).limit(1);
  const row = data?.[0];
  if (!row) return null;
  await update(row.id, { status: STOP_FOR[reason] || "unsubscribed", stop_reason: reason });
  return { id: row.id };
}

/** The link in the unsubscribe header. Always answers the same, found or not. */
export async function unsubscribe(token) {
  if (!/^[a-f0-9]{32}$/.test(String(token || ""))) return { found: false };
  const { data } = await supabase.from(TABLE).select("id,to_email").eq("unsub_token", token).limit(1);
  const row = data?.[0];
  if (!row) return { found: false };
  await update(row.id, { status: "unsubscribed", stop_reason: "opt_out" });
  const { data: team } = await supabase.from("teams").select("id").limit(1);
  if (team?.[0]?.id) {
    await supabase.from("ai_suppressions").upsert(
      { team_id: team[0].id, email: row.to_email.toLowerCase(), reason: "opt_out", detail: "unsubscribe link" },
      { onConflict: "team_id,email" },
    );
  }
  return { found: true };
}

/** Numbers for the ops card: per audience, how many are where. */
export async function summary(now = new Date()) {
  const { data, error } = await supabase.from(TABLE).select("audience,status,last_sent_at").limit(20000);
  if (error) return { ready: false };
  const today = startOfDay(now).toISOString();
  const out = { ready: true };
  for (const audience of Object.keys(MAILBOXES)) {
    out[audience] = { mailbox: MAILBOXES[audience], total: 0, active: 0, replied: 0, stopped: 0, sent_today: 0 };
  }
  for (const row of data || []) {
    const a = out[row.audience];
    if (!a) continue;
    a.total += 1;
    if (row.status === "active") a.active += 1;
    if (row.status === "replied") a.replied += 1;
    if (["unsubscribed", "bounced", "failed"].includes(row.status)) a.stopped += 1;
    if (row.last_sent_at && row.last_sent_at >= today) a.sent_today += 1;
  }
  return out;
}
