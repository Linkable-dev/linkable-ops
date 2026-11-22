// Our own sender for the people linkable-prospector hands over: brands from
// brand@linkable.link, creators from influencer@linkable.link.
//
// The worker inserts one row per person into prospector_outbox, with the values
// the wording interpolates. Everything after that happens here, with nobody
// pressing anything: each step goes out when it is due, and the sequence stops
// at a reply, an unsubscribe, a bounce or a spam complaint.
//
// The brand wording below is the wording that was in the Lemlist campaigns,
// moved here as it stood. The creator wording is about Pitch (22 Nov 2026). Change a sentence here and it changes for everyone
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
// How many NEW people start is RAMP, below; this is the ceiling over both.
export const MAILBOX_DAILY_CEILING = 90;
const MAX_ATTEMPTS = 3;

const SIGN_OFF = "{{signature}}\nlinkable.link";
const DEMO = "Easier to show than explain, if you've got 15 minutes:\nhttps://calendly.com/federico-linkable/linkable-demo";
const NINETEEN = "One store we work with had 19 creators apply in their first month. All on commission, nothing up front.";
// Creators hear about Pitch, and nothing else: it is what a creator can use
// the day they join, whichever brands are on Linkable that week.
const WHAT_IT_IS =
  "I work on Linkable. It lets you pitch any brand you'd like to work with. You pick the brand, we help you write the proposal, send it to the right person there, and follow up for you.";
const FREE = "Ten pitches a month are free.";
const CREATOR_FOLLOW_UPS = [
  {
    afterDays: 4,
    body: [
      "{{greeting}}",
      "Quick one. The slow part of pitching a brand is finding who to write to and chasing an answer. Linkable does both for you.",
      "You choose the brand and what you want in return: a gift, a fee, commission, or open to discuss.",
      SIGN_OFF,
    ],
  },
  {
    afterDays: 6,
    body: [
      "{{greeting}}",
      "Last one from me. If there's a brand you've wanted to work with, you can pitch them on Linkable in a few minutes, and it's free for ten a month.",
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
        body: ["{{greeting}}", "Saw your post about {{exampleBrand}}.\n{{examplePost}}", WHAT_IT_IS, FREE, "Want me to send you the link?", SIGN_OFF],
      },
      ...CREATOR_FOLLOW_UPS,
    ],
  },
  creator_cold: {
    audience: "creator",
    steps: [
      {
        afterDays: 0,
        subject: "pitching {{niche}} brands",
        body: [
          "{{greeting}}",
          "I was looking for {{niche}} creators and you came up.",
          WHAT_IT_IS,
          FREE,
          "Want me to send you the link?",
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

// ------------------------------------------------- not getting blocked --
//
// Three habits keep a mailbox out of the spam folder, and all three are here
// rather than left to whoever switches the sending on.
//
// 1. Start slowly. New people a day, per mailbox, by week since its first
//    email: mail providers judge a sender on its history, and an address with
//    none that writes to a hundred strangers looks like what it would be.
export const RAMP = [5, 10, 15, 20];

/** How many new people one mailbox may start today. */
export function newPeopleAllowed(firstEverSentAt, now = new Date()) {
  if (!firstEverSentAt) return RAMP[0];
  const weeks = Math.floor((startOfDay(now) - startOfDay(firstEverSentAt)) / (7 * 86400000));
  return RAMP[Math.max(0, Math.min(weeks, RAMP.length - 1))];
}

// 2. Never in a burst. The job runs at these hours (UTC, vercel.json); each
//    run takes its share of what is left for the day and times every email
//    to leave on its own somewhere in the next WINDOW_MINUTES.
export const RUN_HOURS = [9, 11, 13, 15];
export const WINDOW_MINUTES = 105;

export function runsLeft(now = new Date()) {
  const hour = new Date(now).getUTCHours();
  return Math.max(1, RUN_HOURS.filter((h) => h >= hour).length);
}

export const share = (left, runs) => (left <= 0 ? 0 : Math.ceil(left / Math.max(1, runs)));

/** `n` moments spread over the window after `start`: evenly, each nudged by
 *  chance so no two days look alike. The first is at least two minutes out. */
export function spread(n, start = new Date(), random = Math.random) {
  const slot = (WINDOW_MINUTES * 60000) / Math.max(1, n);
  const from = new Date(start).getTime() + 2 * 60000;
  return Array.from({ length: n }, (_, i) => new Date(from + i * slot + random() * slot * 0.8));
}

// 3. Stop at the first sign of trouble. Over the last seven days, per mailbox:
//    more than 4 in 100 bounced, or two people pressed "spam". Either is how
//    a mail service decides to close an account, and this one also carries
//    the app's own log-in codes, so the sending pauses itself well before.
export const HEALTH = { days: 7, minPeople: 25, maxBounceRate: 0.04, maxComplaints: 2 };

/** Why sending must pause, in a sentence; null when it need not. */
export function trouble({ mailbox, people = 0, bounced = 0, complaints = 0 }) {
  if (complaints >= HEALTH.maxComplaints) {
    return `${complaints} people marked emails from ${mailbox} as spam in the last ${HEALTH.days} days.`;
  }
  if (people >= HEALTH.minPeople && bounced / people > HEALTH.maxBounceRate) {
    return `${bounced} of the last ${people} emails from ${mailbox} bounced, more than 4 in 100.`;
  }
  return null;
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

/** Where each mailbox stands: today's numbers, the week's, and its first email ever. */
export async function standing(now = new Date()) {
  const since = new Date(startOfDay(now).getTime() - HEALTH.days * 86400000).toISOString();
  const today = startOfDay(now).toISOString();
  const { data, error } = await supabase
    .from(TABLE)
    .select("audience,status,stop_reason,first_sent_at,last_sent_at,updated_at")
    .or(`last_sent_at.gte.${since},updated_at.gte.${since}`)
    .limit(20000);
  if (error) throw new Error(error.message);
  const out = {};
  for (const audience of Object.keys(MAILBOXES)) {
    const { data: first } = await supabase.from(TABLE).select("first_sent_at").eq("audience", audience)
      .not("first_sent_at", "is", null).order("first_sent_at", { ascending: true }).limit(1);
    out[audience] = {
      mailbox: MAILBOXES[audience], first_ever: first?.[0]?.first_sent_at || null,
      sent_today: 0, started_today: 0, people: 0, bounced: 0, complaints: 0,
    };
  }
  for (const row of data || []) {
    const a = out[row.audience];
    if (!a) continue;
    if (row.last_sent_at >= today) a.sent_today += 1;
    if (row.first_sent_at >= today) a.started_today += 1;
    if (row.last_sent_at >= since) a.people += 1;
    if (row.status === "bounced" && row.updated_at >= since) a.bounced += 1;
    if (row.stop_reason === "complaint" && row.updated_at >= since) a.complaints += 1;
  }
  for (const a of Object.values(out)) {
    a.allowed_new = newPeopleAllowed(a.first_ever, now);
    a.trouble = trouble(a);
  }
  return out;
}

async function pauseItself(reason) {
  const at = new Date().toISOString();
  await supabase.from("prospector_settings").upsert(
    [{ key: "direct_send_paused", value: true, updated_at: at },
     { key: "direct_send_health", value: { paused_at: at, reason }, updated_at: at }],
    { onConflict: "key" },
  );
}

/**
 * Who goes in this run, from everyone who is due. Per mailbox: follow-ups
 * first, so a day that runs out of room has finished conversations rather
 * than opened new ones; then new people, up to this run's share of today's
 * allowance. Pure, so the arithmetic can be read in a test.
 */
export function choose(rows, state, now = new Date(), limit = 40) {
  const runs = runsLeft(now);
  const chosen = [];
  let held = 0;
  for (const audience of Object.keys(MAILBOXES)) {
    const s = state[audience] || {};
    const mine = rows.filter((r) => r.audience === audience);
    const room = share(MAILBOX_DAILY_CEILING - (s.sent_today || 0), runs);
    const fresh = share((s.allowed_new ?? RAMP[0]) - (s.started_today || 0), runs);
    const followUps = mine.filter((r) => r.step > 0).slice(0, room);
    const starts = mine.filter((r) => r.step === 0).slice(0, Math.max(0, Math.min(fresh, room - followUps.length)));
    chosen.push(...followUps, ...starts);
    held += mine.length - followUps.length - starts.length;
  }
  return { chosen: chosen.slice(0, limit), held: held + Math.max(0, chosen.length - limit) };
}

/**
 * Send what is due, a run's share of it, each email timed to leave by itself
 * over the next hour and three quarters.
 *
 * `send` is injectable for tests; `paused` comes from the team setting
 * (direct_send_paused), which this also switches on when a mailbox is in
 * trouble.
 */
export async function sendDue({ limit = 40, now = new Date(), dryRun = false, paused = false, send = deliver, gapMs = 600, random = Math.random, anyDay = false } = {}) {
  const out = { due: 0, sent: 0, stopped: 0, failed: 0, held: 0, dry_run: dryRun, log: [] };
  if (paused) return { ...out, paused: true };
  const day = new Date(now).getUTCDay();
  if (!anyDay && (day === 0 || day === 6)) return { ...out, weekend: true };

  const state = await standing(now);
  const reason = Object.values(state).map((s) => s.trouble).find(Boolean);
  if (reason) {
    if (!dryRun) await pauseItself(reason);
    return { ...out, paused: true, reason };
  }

  const { data: rows, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("status", "active")
    .lte("next_at", new Date(now).toISOString())
    .order("step", { ascending: false })
    .order("next_at", { ascending: true })
    .limit(400);
  if (error) throw new Error(error.message);
  out.due = rows.length;

  const picked = choose(rows, state, now, limit);
  out.held = picked.held;

  // Times per mailbox, so each one's emails are evenly apart whatever the
  // other is doing.
  const when = new Map();
  for (const audience of Object.keys(MAILBOXES)) {
    const mine = picked.chosen.filter((r) => r.audience === audience);
    spread(mine.length, now, random).forEach((at, i) => when.set(mine[i].id, at));
  }

  for (const row of picked.chosen) {
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
    const at = when.get(row.id);
    if (dryRun) {
      out.log.push(`${row.to_email}: step ${row.step + 1} "${composed.subject}" from ${payload.from} at ${at.toISOString().slice(11, 16)}`);
      out.sent += 1;
      continue;
    }
    const result = await send({ ...payload, scheduled_at: at.toISOString() });
    if (!result.ok) {
      const attempts = (row.attempts || 0) + 1;
      await update(row.id, attempts >= MAX_ATTEMPTS
        ? { attempts, status: "failed", stop_reason: result.error }
        : { attempts });
      out.failed += 1;
      out.log.push(`${row.to_email}: ${result.error}`);
      continue;
    }
    const due = nextDue(row.sequence, row.step, at);
    await update(row.id, {
      step: row.step + 1,
      attempts: 0,
      subject: row.step === 0 ? composed.subject : row.subject,
      thread: [...(row.thread || []), { step: row.step + 1, at: at.toISOString(), resend_id: result.id, message_id: messageId }],
      last_sent_at: at.toISOString(),
      ...(row.step === 0 ? { first_sent_at: at.toISOString() } : {}),
      ...(due ? { next_at: due.toISOString() } : { status: "done" }),
    });
    out.sent += 1;
    if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
  }
  return out;
}

/** An email that is timed but has not left yet is called back: nobody who
 *  has just answered or unsubscribed should get the next one anyway. */
async function callBack(row) {
  const pending = (row.thread || []).filter((t) => t.resend_id && t.at > new Date().toISOString());
  for (const t of pending) {
    await fetch(`${RESEND_API_URL}/${t.resend_id}/cancel`, {
      method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    }).catch((e) => console.error("calling back a timed email failed:", e.message));
  }
  return pending.length;
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
    .select("id,audience,status,subject,to_email,thread")
    .ilike("to_email", fromEmail)
    .limit(1);
  const row = data?.[0];
  if (!row) return null;
  await callBack(row);
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
  const { data } = await supabase.from(TABLE).select("id,thread").ilike("to_email", email).limit(1);
  const row = data?.[0];
  if (!row) return null;
  await callBack(row);
  await update(row.id, { status: STOP_FOR[reason] || "unsubscribed", stop_reason: reason });
  return { id: row.id };
}

/** The link in the unsubscribe header. Always answers the same, found or not. */
export async function unsubscribe(token) {
  if (!/^[a-f0-9]{32}$/.test(String(token || ""))) return { found: false };
  const { data } = await supabase.from(TABLE).select("id,to_email,thread").eq("unsub_token", token).limit(1);
  const row = data?.[0];
  if (!row) return { found: false };
  await callBack(row);
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

/** Numbers for the ops card: per mailbox, how many are where, how many new
 *  people it may start today, and why it paused itself if it did. */
export async function summary(now = new Date()) {
  const { data, error } = await supabase.from(TABLE).select("audience,status").limit(20000);
  if (error) return { ready: false };
  const state = await standing(now);
  const { data: health } = await supabase.from("prospector_settings").select("value").eq("key", "direct_send_health").limit(1);
  const out = { ready: true, health: health?.[0]?.value || null };
  for (const audience of Object.keys(MAILBOXES)) {
    const s = state[audience];
    out[audience] = {
      mailbox: s.mailbox, total: 0, active: 0, replied: 0, stopped: 0,
      sent_today: s.sent_today, started_today: s.started_today, allowed_new: s.allowed_new, trouble: s.trouble,
    };
  }
  for (const row of data || []) {
    const a = out[row.audience];
    if (!a) continue;
    a.total += 1;
    if (row.status === "active") a.active += 1;
    if (row.status === "replied") a.replied += 1;
    if (["unsubscribed", "bounced", "failed"].includes(row.status)) a.stopped += 1;
  }
  return out;
}
