// What the Outreach page shows: one read of everything our own sender
// (lib/direct-outreach.js) and the reply agent (lib/outreach-answers.js) have
// done and are about to do. Nothing here sends or changes anything.

import { supabase } from "./supabase.js";
import { readSettings } from "./instagram-dm-queue.js";
import { MAILBOXES, RUN_HOURS, WINDOW_MINUTES, standing, results, compose } from "./direct-outreach.js";
import { exchange } from "./outreach-answers.js";

const TABLE = "prospector_outbox";
const EMAILS = "prospector_outbox_emails";
const DAYS = 14;

const dayOf = (iso) => String(iso || "").slice(0, 10);

/** The next time the send job runs: the next run hour on a working day. Pure. */
export function nextRun(now = new Date()) {
  const at = new Date(now);
  for (let i = 0; i < 8; i++) {
    const day = at.getUTCDay();
    if (day !== 0 && day !== 6) {
      for (const hour of RUN_HOURS) {
        const slot = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), hour, 10));
        if (slot > now) return slot;
      }
    }
    at.setUTCDate(at.getUTCDate() + 1);
    at.setUTCHours(0, 0, 0, 0);
  }
  return null;
}

/** Where one person is, in the words the page uses. Pure. */
export function stage(row) {
  if (row.status === "bounced") return "bounced";
  if (row.status === "unsubscribed") return row.stop_reason === "complaint" ? "marked_spam" : "unsubscribed";
  if (row.status === "failed") return "failed";
  if (row.status === "skipped") return "skipped";
  if (row.status === "replied") return row.needs_person ? "needs_person" : "replied";
  if (row.status === "done") return "finished";
  return row.step > 0 ? "in_progress" : "waiting";
}

const emptyBox = (mailbox) => ({
  mailbox, total: 0, waiting: 0, in_progress: 0, finished: 0, replied: 0, needs_person: 0, interested: 0,
  answered_by_itself: 0, unsubscribed: 0, marked_spam: 0, bounced: 0, failed: 0, skipped: 0, signed_up: 0, activated: 0,
  opened: 0, clicked: 0,
  emails_sent: 0, emails_timed: 0, emails_delivered: 0, emails_bounced: 0, answers_sent: 0, people_emailed: 0,
});

/** Everything counted, from the rows. Pure, so the arithmetic has a test. */
export function tally(people, emails, now = new Date()) {
  const stamp = new Date(now).toISOString();
  const boxes = Object.fromEntries(Object.entries(MAILBOXES).map(([a, m]) => [a, emptyBox(m)]));
  const days = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    days.push({ day: dayOf(d.toISOString()), brand_sent: 0, creator_sent: 0, replies: 0 });
  }
  const byDay = Object.fromEntries(days.map((d) => [d.day, d]));
  let cost = 0;

  for (const p of people) {
    const b = boxes[p.audience];
    if (!b) continue;
    b.total += 1;
    b[stage(p)] += 1;
    if (p.status === "replied") b.replied += p.needs_person ? 1 : 0; // needs_person is also a reply
    if (p.first_sent_at && p.first_sent_at <= stamp) b.people_emailed += 1;
    if (p.opened_at) b.opened += 1;
    if (p.clicked_at) b.clicked += 1;
    if (p.intent === "interested") b.interested += 1;
    if ((p.auto_answers || 0) > 0) b.answered_by_itself += 1;
    if (p.signed_up_at) b.signed_up += 1;
    if (p.activated_at) b.activated += 1;
    cost += Number(p.answer_cost_usd || 0);
    if (p.reply_at && byDay[dayOf(p.reply_at)]) byDay[dayOf(p.reply_at)].replies += 1;
  }
  for (const e of emails) {
    const b = boxes[e.audience];
    if (!b || e.cancelled_at) continue;
    if (e.scheduled_for > stamp) {
      b.emails_timed += 1;
      continue;
    }
    if (e.kind === "answer") b.answers_sent += 1;
    else b.emails_sent += 1;
    if (e.delivered_at) b.emails_delivered += 1;
    if (e.bounced_at) b.emails_bounced += 1;
    const d = byDay[dayOf(e.scheduled_for)];
    if (d) d[`${e.audience}_sent`] += 1;
  }
  return { boxes, days, answer_cost_usd: Math.round(cost * 100) / 100 };
}

const PEOPLE_COLUMNS =
  "id,audience,sequence,to_email,handle,auto,status,stop_reason,step,next_at,first_sent_at,last_sent_at,reply_at,replied_step,intent,auto_answers,needs_person,needs_person_reason,opened_at,clicked_at,signed_up_at,activated_at,answer_cost_usd,created_at,updated_at";

async function all(table, columns, tweak = (q) => q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await tweak(supabase.from(table).select(columns)).range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}

export async function overview(now = new Date()) {
  const [settings, stored, people, emails, state, byWeek] = await Promise.all([
    readSettings(),
    supabase.from("prospector_settings").select("key,value,updated_at").in("key", ["email_send_status", "direct_send_health", "gtm_balance"]),
    all(TABLE, PEOPLE_COLUMNS),
    all(EMAILS, "outbox_id,audience,kind,step,to_email,subject,scheduled_for,delivered_at,bounced_at,cancelled_at"),
    standing(now),
    results().catch(() => []),
  ]);
  const kept = Object.fromEntries((stored.data || []).map((r) => [r.key, r.value]));
  const counted = tally(people, emails, now);
  const stamp = new Date(now).toISOString();
  for (const audience of Object.keys(MAILBOXES)) {
    Object.assign(counted.boxes[audience], {
      sent_today: state[audience].sent_today, started_today: state[audience].started_today,
      allowed_new: state[audience].allowed_new, week_people: state[audience].people,
      week_bounced: state[audience].bounced, week_complaints: state[audience].complaints, trouble: state[audience].trouble,
    });
  }
  return {
    at: stamp,
    switches: {
      brands: settings.email_auto_send === true, creators: settings.creator_auto_send === true,
      answers: settings.reply_auto === true, paused: settings.direct_send_paused === true,
      brand_cap: settings.email_auto_send_daily_cap, creator_cap: settings.creator_auto_send_daily_cap,
    },
    health: kept.direct_send_health || null,
    worker: kept.email_send_status || null,
    short_side: kept.gtm_balance?.short_side || null,
    next_run: nextRun(now)?.toISOString() || null,
    window_minutes: WINDOW_MINUTES,
    ...counted,
    // What leaves next: emails already timed, soonest first.
    upcoming: emails.filter((e) => !e.cancelled_at && e.scheduled_for > stamp)
      .sort((a, b) => (a.scheduled_for < b.scheduled_for ? -1 : 1)).slice(0, 12)
      .map((e) => ({ at: e.scheduled_for, audience: e.audience, to: e.to_email, subject: e.subject, step: e.step, kind: e.kind })),
    needs_person: people.filter((p) => p.needs_person && p.status === "replied")
      .sort((a, b) => (a.reply_at > b.reply_at ? -1 : 1)).slice(0, 20)
      .map((p) => ({ id: p.id, audience: p.audience, to: p.to_email, handle: p.handle, reason: p.needs_person_reason, at: p.reply_at })),
    results: byWeek,
  };
}

// Stage filters, as the query that selects them.
const STAGE_FILTERS = {
  waiting: (q) => q.eq("status", "active").eq("step", 0),
  in_progress: (q) => q.eq("status", "active").gt("step", 0),
  finished: (q) => q.eq("status", "done"),
  replied: (q) => q.eq("status", "replied"),
  needs_person: (q) => q.eq("status", "replied").eq("needs_person", true),
  opened: (q) => q.not("opened_at", "is", null),
  interested: (q) => q.eq("intent", "interested"),
  unsubscribed: (q) => q.eq("status", "unsubscribed"),
  bounced: (q) => q.eq("status", "bounced"),
  skipped: (q) => q.eq("status", "skipped"),
  signed_up: (q) => q.not("signed_up_at", "is", null),
};
export const STAGES = Object.keys(STAGE_FILTERS);

/** One page of people, newest activity first. Paged and filtered by the database. */
export async function people({ audience, stage: wanted, q, limit = 25, offset = 0 } = {}) {
  let query = supabase.from(TABLE).select(PEOPLE_COLUMNS, { count: "exact" });
  if (audience === "brand" || audience === "creator") query = query.eq("audience", audience);
  if (wanted && STAGE_FILTERS[wanted]) query = STAGE_FILTERS[wanted](query);
  // Letters, digits and the few marks an address or a handle has; nothing
  // that means something to the filter syntax.
  const term = String(q || "").replace(/[^A-Za-z0-9@._+-]/g, "").slice(0, 80);
  if (term) query = query.or(`to_email.ilike.%${term}%,handle.ilike.%${term}%`);
  const size = Math.max(1, Math.min(Number(limit) || 25, 100));
  const from = Math.max(0, Number(offset) || 0);
  const { data, error, count } = await query.order("updated_at", { ascending: false }).range(from, from + size - 1);
  if (error) throw new Error(error.message);
  return { rows: (data || []).map((r) => ({ ...r, stage: stage(r) })), total: count || 0, limit: size, offset: from };
}

/** One person: where they are, every message in order, and every email's record. */
export async function person(id, now = new Date()) {
  const { data, error } = await supabase.from(TABLE).select("*").eq("id", id).limit(1);
  if (error) throw new Error(error.message);
  const row = data?.[0];
  if (!row) return null;
  const { data: emails } = await supabase.from(EMAILS).select("kind,step,subject,scheduled_for,delivered_at,opened_at,opens,clicked_at,clicks,bounced_at,bounce_reason,complained_at,cancelled_at")
    .eq("outbox_id", id).order("scheduled_for", { ascending: true });
  const { variables, conversation, thread, unsub_token, ...rest } = row;
  void conversation; void thread; void unsub_token;
  return {
    ...rest,
    stage: stage(row),
    language: variables?.language || "en",
    // Our emails that have left, their messages and the answers, oldest first.
    messages: exchange(row, now).map((m) => ({ ...m, auto: (row.conversation || []).some((c) => c.from === "us" && c.auto && c.at === m.at) })),
    emails: emails || [],
    // What they will be sent next, as it will read, while there is a next one.
    next_email: row.status === "active" ? (({ subject, text, problem }) => (problem ? { problem } : { subject, text, due: row.next_at }))(compose(row, row.step)) : null,
  };
}
