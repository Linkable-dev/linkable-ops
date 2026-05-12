// Sender pool: rotates outbound across multiple inboxes on lookalike domains.
//
// Reads sender_inboxes for the team, counts today's sent rows per inbox via
// email_sends.sender_email, and returns the least-used inbox still under its
// daily cap. Returns { hasPool: false } when no inbox rows exist — callers
// then fall back to the campaign's sender_from for legacy single-sender mode.
//
// Cap semantics:
//   - is_warming = true  → cap is warming_cap (default 10/day)
//   - is_warming = false → cap is daily_cap   (default 40/day)
// "Today" is UTC-day-start to avoid timezone drift across cron runs.

import { supabase } from "../lib/supabase.js";

// Public shape returned by getNextInbox:
//   { hasPool: false, inbox: null }                 — no inboxes configured, use legacy sender
//   { hasPool: true,  inbox: null }                 — all configured inboxes hit cap today, defer
//   { hasPool: true,  inbox: { id, email, from, replyTo, domain, isWarming } } — send via this
//
// Options:
//   pinnedEmail — restrict selection to this specific inbox (used by sendDueRow
//     to preserve thread continuity: every touch in a sequence sends from the
//     same inbox the enrollment picked). When pinned, hasPool=true and
//     inbox=null means that single inbox is at cap → defer the row.
export async function getNextInbox(teamId, options = {}) {
  const { pinnedEmail = null } = options;

  let query = supabase
    .from("sender_inboxes")
    .select("id, email, from_name, reply_to, domain, daily_cap, warming_cap, is_warming")
    .eq("team_id", teamId)
    .eq("is_active", true);

  if (pinnedEmail) {
    query = query.ilike("email", pinnedEmail);
  }

  const { data: inboxes, error: ibErr } = await query;

  if (ibErr) {
    console.error("sender-pool: fetch inboxes failed:", ibErr.message);
    return { hasPool: false, inbox: null };
  }
  if (!inboxes || inboxes.length === 0) {
    return { hasPool: false, inbox: null };
  }

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const { data: sends, error: sendErr } = await supabase
    .from("email_sends")
    .select("sender_email")
    .eq("team_id", teamId)
    .eq("status", "sent")
    .gte("sent_at", startOfDay.toISOString())
    .not("sender_email", "is", null);

  if (sendErr) {
    console.error("sender-pool: fetch today's sends failed:", sendErr.message);
    return { hasPool: true, inbox: null };
  }

  const countByInbox = {};
  for (const s of sends || []) {
    const key = (s.sender_email || "").toLowerCase();
    if (!key) continue;
    countByInbox[key] = (countByInbox[key] || 0) + 1;
  }

  // Compute remaining capacity per inbox, drop full ones, sort by most remaining
  // so we burn the lowest-utilised inbox first. Tiebreak by email alphabetically
  // to keep the rotation deterministic across cron runs (so the same inbox isn't
  // accidentally favoured every morning when all are at 0).
  const available = inboxes
    .map((ib) => {
      const cap = ib.is_warming ? ib.warming_cap : ib.daily_cap;
      const used = countByInbox[ib.email.toLowerCase()] || 0;
      return { ...ib, cap, used, remaining: cap - used };
    })
    .filter((ib) => ib.remaining > 0)
    .sort((a, b) => {
      if (b.remaining !== a.remaining) return b.remaining - a.remaining;
      return a.email.localeCompare(b.email);
    });

  if (available.length === 0) {
    return { hasPool: true, inbox: null };
  }

  const pick = available[0];
  return {
    hasPool: true,
    inbox: {
      id: pick.id,
      email: pick.email,
      from: `${pick.from_name} <${pick.email}>`,
      replyTo: pick.reply_to || pick.email,
      domain: pick.domain,
      isWarming: pick.is_warming,
    },
  };
}

// Diagnostic helper for ops scripts — returns per-inbox usage today.
// Not used by the orchestrator; intended for CLI / dashboard reads.
export async function getInboxUsage(teamId) {
  const { data: inboxes } = await supabase
    .from("sender_inboxes")
    .select("id, email, from_name, domain, daily_cap, warming_cap, is_active, is_warming")
    .eq("team_id", teamId);
  if (!inboxes) return [];

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { data: sends } = await supabase
    .from("email_sends")
    .select("sender_email")
    .eq("team_id", teamId)
    .eq("status", "sent")
    .gte("sent_at", startOfDay.toISOString())
    .not("sender_email", "is", null);

  const countByInbox = {};
  for (const s of sends || []) {
    const key = (s.sender_email || "").toLowerCase();
    if (!key) continue;
    countByInbox[key] = (countByInbox[key] || 0) + 1;
  }

  return inboxes.map((ib) => {
    const cap = ib.is_warming ? ib.warming_cap : ib.daily_cap;
    const used = countByInbox[ib.email.toLowerCase()] || 0;
    return {
      email: ib.email,
      from_name: ib.from_name,
      domain: ib.domain,
      is_active: ib.is_active,
      is_warming: ib.is_warming,
      cap,
      used,
      remaining: cap - used,
    };
  });
}
