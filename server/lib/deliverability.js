// Per-inbox deliverability, and the automatic brake on a burning one.
//
// The runbook says: watch bounce rate per inbox with a GROUP BY sender_email,
// and above 5% take that inbox offline. That is a human remembering to run a
// query, and it is the only thing between a bad list and a burned domain — a
// burned domain stops ALL outbound at once, after weeks of warmup that cannot
// be bought back.
//
// So it runs on the cron instead. The asymmetry is deliberate: this can pause
// an inbox on its own, and never resumes one. Pausing costs a fraction of a
// day's send capacity; resuming into a reputation problem costs the domain.

import { supabase } from "./supabase.js";

// Above these, over the window, an inbox stops sending.
// Mailbox providers start filtering around 0.3% complaints, well before the
// bounce rate looks alarming, so the complaint gate is the tighter of the two.
export const THRESHOLDS = {
  bounceRate: 0.05,
  complaintRate: 0.003,
  // Below this many sends in the window the rates are noise: 1 bounce out of 3
  // is 33% and means nothing. Never pause an inbox on that.
  minSends: 25,
  windowDays: 14,
};

async function pageAll(table, columns, tweak = (q) => q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await tweak(supabase.from(table).select(columns).range(from, from + 999));
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}

const pct = (n, d) => (d ? n / d : 0);

// The whole decision, as a pure function, because its safety properties are
// the point: never judge on too little volume, never pause an inbox that is
// already out of the pool, and never — under any input — decide to resume one.
export function verdictFor({ sent = 0, bounced = 0, complained = 0, isActive = false } = {}) {
  const n = Math.max(0, Number(sent) || 0);
  const bounceRate = pct(Math.max(0, Number(bounced) || 0), n);
  const complaintRate = pct(Math.max(0, Number(complained) || 0), n);
  const judged = n >= THRESHOLDS.minSends;

  const breaches = [];
  if (judged && bounceRate > THRESHOLDS.bounceRate) {
    breaches.push(`bounce rate ${(bounceRate * 100).toFixed(1)}% is over ${(THRESHOLDS.bounceRate * 100).toFixed(0)}%`);
  }
  if (judged && complaintRate > THRESHOLDS.complaintRate) {
    breaches.push(`complaint rate ${(complaintRate * 100).toFixed(2)}% is over ${(THRESHOLDS.complaintRate * 100).toFixed(1)}%`);
  }
  return {
    bounceRate: Math.round(bounceRate * 10000) / 10000,
    complaintRate: Math.round(complaintRate * 10000) / 10000,
    judged,
    breaches,
    shouldPause: breaches.length > 0 && isActive === true,
  };
}

// Per-inbox rates over the window, with the verdict for each.
export async function inboxHealth({ windowDays = THRESHOLDS.windowDays } = {}) {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const [sends, inboxes] = await Promise.all([
    pageAll("email_sends", "sender_email, sent_at, bounced_at, complained_at, delivered_at",
      (q) => q.not("sent_at", "is", null).gte("sent_at", since)),
    pageAll("sender_inboxes", "id, email, domain, is_active, is_warming, daily_cap, notes"),
  ]);

  const stats = new Map();
  for (const s of sends) {
    const key = (s.sender_email || "").toLowerCase();
    if (!key) continue; // legacy sends carry no sender_email; nothing to pause
    if (!stats.has(key)) stats.set(key, { sent: 0, bounced: 0, complained: 0, delivered: 0 });
    const r = stats.get(key);
    r.sent += 1;
    if (s.bounced_at) r.bounced += 1;
    if (s.complained_at) r.complained += 1;
    if (s.delivered_at) r.delivered += 1;
  }

  return inboxes.map((box) => {
    const r = stats.get((box.email || "").toLowerCase()) || { sent: 0, bounced: 0, complained: 0, delivered: 0 };
    const v = verdictFor({ ...r, isActive: box.is_active === true });

    return {
      id: box.id,
      email: box.email,
      domain: box.domain,
      is_active: box.is_active === true,
      is_warming: box.is_warming === true,
      daily_cap: box.daily_cap,
      notes: box.notes,
      window_days: windowDays,
      ...r,
      bounce_rate: v.bounceRate,
      complaint_rate: v.complaintRate,
      judged: v.judged,
      breaches: v.breaches,
      // Only an inbox that is actually sending can be taken out of service.
      should_pause: v.shouldPause,
    };
  }).sort((a, b) => b.bounce_rate - a.bounce_rate || b.sent - a.sent);
}

// Pauses every inbox over threshold. Returns what it did, for the cron log.
// Deliberately one-way: nothing here ever sets is_active back to true.
export async function enforceInboxHealth({ dryRun = false } = {}) {
  const boxes = await inboxHealth();
  const paused = [];

  for (const box of boxes.filter((b) => b.should_pause)) {
    const reason = `auto-paused ${new Date().toISOString().slice(0, 10)}: ${box.breaches.join("; ")}`;
    if (!dryRun) {
      const { error } = await supabase
        .from("sender_inboxes")
        .update({
          is_active: false,
          notes: box.notes ? `${box.notes}\n${reason}` : reason,
        })
        .eq("id", box.id);
      if (error) throw new Error(`pausing ${box.email}: ${error.message}`);
    }
    paused.push({ email: box.email, reason, sent: box.sent, bounce_rate: box.bounce_rate, complaint_rate: box.complaint_rate });
  }

  return { checked: boxes.length, paused, dryRun };
}
