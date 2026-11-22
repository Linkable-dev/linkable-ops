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
// One row per email, with what happened to it. Kept for analysis.
const EMAILS = "prospector_outbox_emails";
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

// Italian and Spanish, for brands and creators in Italy and Spain. The worker
// writes the evidence blocks, the subject and the greeting in the same
// language (outreach/local_copy.py there) and says which with `language`.
// Same steps and the same days apart as the English above.
const SITE = "{{signature}}\nlinkable.link";
const DEMO_URL = "https://calendly.com/federico-linkable/linkable-demo";

function localSequences(t) {
  const last = { afterDays: 7, body: ["{{greeting}}", t.lastOne, "{{closingOffer}}", t.noHardFeelings, SITE] };
  const proof = { afterDays: 4, body: ["{{greeting}}", t.nineteen, "{{socialProof}}", `${t.demo}\n${DEMO_URL}`, SITE] };
  const creatorFollowUps = [
    { afterDays: 4, body: ["{{greeting}}", t.creatorQuick, t.creatorChoose, SITE] },
    { afterDays: 6, body: ["{{greeting}}", t.creatorLast, t.creatorLuck, SITE] },
  ];
  return {
    brand_a: {
      audience: "brand",
      steps: [
        { afterDays: 0, subject: "{{subjectLine}}", body: ["{{greeting}}", "{{proofBlock}}", "{{listOffer}}", t.tracking, SITE] },
        { afterDays: 3, body: ["{{greeting}}", "{{followUpHook}}", t.mostSayNo, t.listStands, SITE] },
        proof,
        last,
      ],
    },
    brand_b: {
      audience: "brand",
      steps: [
        { afterDays: 0, subject: "{{subjectLine}}", body: ["{{greeting}}", "{{proofBlock}}", "{{listOffer}}", SITE] },
        { afterDays: 3, body: ["{{greeting}}", "{{followUpHook}}", t.noNumber, SITE] },
        proof,
        last,
      ],
    },
    creator: {
      audience: "creator",
      steps: [
        { afterDays: 0, subject: t.creatorSubject, body: ["{{greeting}}", `${t.sawPost}\n{{examplePost}}`, t.whatItIs, t.free, t.sendLink, SITE] },
        ...creatorFollowUps,
      ],
    },
    creator_cold: {
      audience: "creator",
      steps: [
        { afterDays: 0, subject: t.coldSubject, body: ["{{greeting}}", t.coldOpen, t.whatItIs, t.free, t.sendLink, SITE] },
        ...creatorFollowUps,
      ],
    },
  };
}

export const LOCAL_SEQUENCES = {
  it: localSequences({
    tracking: "Il tracciamento è la parte che facciamo noi, se mai vi servisse. Ogni creator ha il suo link e le commissioni si calcolano da sole. È un'app Shopify e si installa in una decina di minuti.",
    mostSayNo: "Per quel che vale, quasi tutti quelli a cui lo chiedo mi rispondono di no. È una cosa normalissima.",
    listStands: "In ogni caso, la lista ve la mando volentieri.",
    noNumber: "Per quel che vale, quasi nessuno di quelli a cui lo chiedo ha un numero preciso.",
    nineteen: "Uno dei negozi con cui lavoriamo ha ricevuto 19 candidature di creator nel primo mese. Tutte a commissione, niente pagato in anticipo.",
    demo: "È più facile da mostrare che da spiegare, se avete 15 minuti:",
    lastOne: "Questa è l'ultima, non insisto oltre.",
    noHardFeelings: "Altrimenti nessun problema, in bocca al lupo.",
    creatorSubject: "il tuo post su {{exampleBrand}}",
    sawPost: "Ho visto il tuo post su {{exampleBrand}}.",
    coldSubject: "creator {{niche}} e collaborazioni con i brand",
    coldOpen: "Cercavo creator {{niche}} e ho trovato il tuo profilo.",
    whatItIs: "Lavoro per Linkable. Ti permette di proporti a qualsiasi brand con cui vorresti collaborare. Scegli il brand, noi ti aiutiamo a scrivere la proposta, la mandiamo alla persona giusta e seguiamo noi le risposte.",
    free: "Dieci proposte al mese sono gratis.",
    sendLink: "Ti mando il link?",
    creatorQuick: "Una cosa al volo. La parte lenta, quando ti proponi a un brand, è capire a chi scrivere e poi rincorrere una risposta. Linkable fa entrambe le cose per te.",
    creatorChoose: "Scegli tu il brand e cosa vuoi in cambio: un prodotto in regalo, un compenso, una commissione, oppure lasciare tutto da concordare.",
    creatorLast: "Questa è l'ultima. Se c'è un brand con cui vorresti lavorare, su Linkable puoi proporti in pochi minuti, e fino a dieci proposte al mese è gratis.",
    creatorLuck: "In ogni caso, in bocca al lupo.",
  }),
  es: localSequences({
    tracking: "El seguimiento es la parte que hacemos nosotros, por si algún día os hace falta. Cada creador tiene su propio enlace y las comisiones se calculan solas. Es una app de Shopify y se instala en unos diez minutos.",
    mostSayNo: "Por si sirve de algo, casi todos a los que pregunto me dicen que no. No es nada raro.",
    listStands: "La lista sigue siendo vuestra de todos modos.",
    noNumber: "Por si sirve de algo, casi nadie a quien pregunto tiene esa cifra.",
    nineteen: "Una de las tiendas con las que trabajamos recibió 19 solicitudes de creadores en su primer mes. Todas a comisión, nada por adelantado.",
    demo: "Es más fácil enseñarlo que explicarlo, si tenéis 15 minutos:",
    lastOne: "Este es el último, no insisto más.",
    noHardFeelings: "Si no, sin problema, mucha suerte.",
    creatorSubject: "tu publicación sobre {{exampleBrand}}",
    sawPost: "He visto tu publicación sobre {{exampleBrand}}.",
    coldSubject: "creadores de {{niche}} y colaboraciones con marcas",
    coldOpen: "Estaba buscando creadores de {{niche}} y encontré tu perfil.",
    whatItIs: "Trabajo en Linkable. Te permite proponer una colaboración a cualquier marca con la que te gustaría trabajar. Tú eliges la marca, nosotros te ayudamos a escribir la propuesta, se la enviamos a la persona adecuada y hacemos el seguimiento por ti.",
    free: "Tienes diez propuestas gratis al mes.",
    sendLink: "¿Te envío el enlace?",
    creatorQuick: "Te cuento algo rápido. Lo que lleva tiempo al proponer una colaboración a una marca es saber a quién escribir y luego conseguir que te contesten. Linkable hace las dos cosas por ti.",
    creatorChoose: "Tú eliges la marca y qué quieres a cambio: un producto de regalo, un pago, una comisión o lo que acordéis.",
    creatorLast: "Este es el último. Si hay una marca con la que te gustaría trabajar, en Linkable puedes proponerle una colaboración en unos minutos, y es gratis hasta diez propuestas al mes.",
    creatorLuck: "En cualquier caso, mucha suerte.",
  }),
};

/** The wording for one person: their language's when it has one, else English. */
export function sequenceFor(row) {
  const lang = String(row.variables?.language || "en").toLowerCase();
  return LOCAL_SEQUENCES[lang]?.[row.sequence] || SEQUENCES[row.sequence];
}

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
  const sequence = sequenceFor(row);
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
    // The record of this one email. A failure here must not undo a send.
    await supabase.from(EMAILS).insert({
      outbox_id: row.id, audience: row.audience, sequence: row.sequence, step: row.step + 1,
      to_email: row.to_email, from_email: MAILBOXES[row.audience], subject: composed.subject,
      resend_id: result.id, scheduled_for: at.toISOString(),
    }).then(({ error: e }) => e && console.error("recording an email failed:", e.message));
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
    await supabase.from(EMAILS).update({ cancelled_at: new Date().toISOString() }).eq("resend_id", t.resend_id);
  }
  return pending.length;
}

// ------------------------------------------------------------ what comes back --

/**
 * Somebody wrote back. Their sequence stops, their words are kept, and the
 * message is passed on to the mailbox it was sent from so a person can answer
 * it there. Returns null when the sender is not one of ours.
 */
export async function onReply({ fromEmail, subject, text, messageId = null, optOut = false, send = deliver, answer = null }) {
  if (!fromEmail) return null;
  const { data } = await supabase.from(TABLE).select("*").ilike("to_email", fromEmail).limit(1);
  const row = data?.[0];
  if (!row) return null;
  // The mail service delivers a webhook again when it is slow to be answered.
  // The same message twice is one message.
  if (messageId && (row.conversation || []).some((m) => m.from === "them" && m.message_id === messageId)) {
    return { id: row.id, status: row.status, duplicate: true };
  }
  await callBack(row);
  const now = new Date().toISOString();
  const stopped = ["unsubscribed", "bounced"].includes(row.status);
  const conversation = [...(row.conversation || []), { from: "them", at: now, subject: subject || "", text: String(text || "").slice(0, 8000), message_id: messageId }];
  const willAnswer = !!answer && !optOut && !stopped;
  await update(row.id, {
    conversation,
    ...(stopped ? {} : {
      status: optOut ? "unsubscribed" : "replied",
      stop_reason: optOut ? "opt_out" : "replied",
      reply_at: row.reply_at || now,
      reply_text: String(text || "").slice(0, 8000),
      // The last email that had left when they first answered.
      replied_step: row.replied_step || (row.thread || []).filter((t) => t.at <= now).length || row.step || null,
    }),
    // Recorded before anything slow happens, so a run that is cut short
    // leaves the message waiting rather than lost.
    answer_pending_since: willAnswer ? now : null,
    needs_person: !willAnswer && !optOut,
  });
  if (willAnswer) {
    // Answered, left alone or passed to a person, by lib/outreach-answers.js,
    // which also tells the mailbox what it did.
    const done = await answer({ ...row, conversation, status: "replied" });
    return { id: row.id, status: "replied", answered: done.action, intent: done.intent, forwarded: !!done.noted };
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

/**
 * What the mail service says happened to one email (delivered, bounced,
 * marked as spam), written onto that email's record. Returns null when the
 * email is not one of ours. Opens and clicks are not tracked: the emails are
 * plain text on purpose, and the tracking that would count them is the kind
 * spam filters look for.
 */
export async function onEmailEvent({ resendId, type, data = {}, at = new Date() }) {
  if (!resendId) return null;
  const stamp = new Date(at).toISOString();
  const patch = {
    "email.delivered": { delivered_at: stamp },
    "email.bounced": { bounced_at: stamp, bounce_reason: String(data?.bounce?.message || data?.reason || "bounced").slice(0, 500) },
    "email.complained": { complained_at: stamp },
  }[type];
  if (!patch) return null;
  const { data: rows, error } = await supabase.from(EMAILS).update(patch).eq("resend_id", resendId).select("id,outbox_id");
  if (error) throw new Error(error.message);
  return rows?.[0] || null;
}

// Addresses anybody can have. A sign-up from the same one of these is the same
// person; a sign-up from the same *domain* is not the same business.
const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "yahoo.com", "yahoo.co.uk", "icloud.com", "live.com", "me.com", "aol.com", "proton.me", "protonmail.com"]);
const domainOf = (value) => String(value || "").toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0].split("@").pop().trim();

/** Which sign-up, if any, is this person. Pure. */
export function matchSignup(row, users) {
  const email = String(row.to_email || "").toLowerCase();
  const handle = String(row.handle || "").toLowerCase().replace(/^@/, "");
  const site = domainOf(row.variables?.companyDomain);
  const mailDomain = domainOf(email);
  const after = new Date(row.first_sent_at).getTime();
  return users.find((u) => {
    if (new Date(u.created).getTime() < after) return false;
    if (u.email && u.email === email) return true;
    if (row.audience === "creator") return !!handle && u.handle === handle;
    const store = domainOf(u.store_website);
    if (!store) return false;
    return store === site || (!FREE_MAIL.has(mailDomain) && store === mailDomain);
  }) || null;
}

/**
 * Did the people we wrote to join Linkable, and did they then use it? Read
 * from the product database (production, always) and written onto each
 * person: signed_up_at, and activated_at for a creator's first pitch sent or
 * a brand's first campaign live. Run daily.
 */
export async function trackOutcomes({ query } = {}) {
  const run = query || (await import("./cloudsql.js")).cloudSqlQuery;
  const { data: rows, error } = await supabase
    .from(TABLE)
    .select("id,audience,to_email,handle,variables,first_sent_at,signed_up_at,signed_up_user_id,activated_at")
    .not("first_sent_at", "is", null)
    .is("activated_at", null)
    .limit(5000);
  if (error) throw new Error(error.message);
  const out = { checked: rows.length, signed_up: 0, activated: 0 };
  if (!rows.length) return out;
  const earliest = rows.map((r) => r.first_sent_at).sort()[0];
  const { rows: users } = await run(
    `SELECT u.id::text AS id, u.created, LOWER(u.email) AS email,
            LOWER(COALESCE(NULLIF(i.instagram_username, ''), i.username)) AS handle,
            b.store_website,
            (SELECT MIN(p.sent_at) FROM pitches p WHERE p.creator_user_id = u.id AND p.sent_at IS NOT NULL) AS first_pitch_at,
            (SELECT MIN(pr.activated_at) FROM products pr WHERE pr.user_id = u.id) AS first_campaign_at
       FROM users u
       LEFT JOIN influencers i ON i.user_id = u.id
       LEFT JOIN brands b ON b.user_id = u.id
      WHERE u.created >= $1`,
    [earliest], "prod");
  const now = new Date().toISOString();
  for (const row of rows) {
    const user = row.signed_up_user_id ? users.find((u) => u.id === row.signed_up_user_id) : matchSignup(row, users);
    if (!user) continue;
    const used = row.audience === "creator" ? user.first_pitch_at : user.first_campaign_at;
    const patch = { outcomes_checked_at: now };
    if (!row.signed_up_at) {
      patch.signed_up_at = new Date(user.created).toISOString();
      patch.signed_up_user_id = user.id;
      out.signed_up += 1;
    }
    if (used) {
      patch.activated_at = new Date(used).toISOString();
      out.activated += 1;
    }
    await update(row.id, patch);
  }
  return out;
}

/** The funnel by week and wording, for the ops card and for analysis. */
export async function results() {
  const { data, error } = await supabase.from("prospector_outbox_results").select("*").order("week", { ascending: false }).limit(200);
  if (error) throw new Error(error.message);
  return data || [];
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
