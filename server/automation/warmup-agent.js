// Warmup agent — sends conversational emails from every is_warming inbox
// to the team's warmup_seeds list on a daily ramp.
//
// Flow per inbox per day:
//   1. Compute days_warming = today - warming_started_at
//   2. Look up target sends for that day in RAMP_SCHEDULE
//   3. Count today's warmup sends already done (template_key='warmup')
//   4. Send (target - already_sent) more, picking seeds at random
//   5. Stop entirely once days_warming > RAMP_SCHEDULE max
//
// Idempotent — re-running on the same day just tops up to the day's target.
// Designed to be invoked from the existing /api/cron/auto-discover (which
// fires once daily) so we don't burn a Vercel Hobby cron slot.
//
// The agent does NOT auto-reply to inbound responses — that's the human's
// job (the whole point of warmup is conversational signal from real people).

import { supabase } from "../lib/supabase.js";
import { sendEmail, delaySend } from "./send.js";
import { generateWarmupEmail } from "./warmup-content.js";

// Daily send target per inbox, indexed by days since warming_started_at.
// Day 0 = first day. Beyond the end of the array → agent stops sending and
// the operator should flip is_warming=false to graduate the inbox.
const RAMP_SCHEDULE = [
  3, 3, 4, 5, 5,    // week 1: gentle start
  6, 6,
  7, 7, 8,          // week 2: build conversational volume
  9, 9, 10, 10,
];

// 3s gap between sends *within a single inbox*. Inboxes are processed in
// parallel (see Promise.all below) so the total wall-clock for the daily
// run is ~30s even on Day 14 (10 sends × 3s per inbox, 4 inboxes in
// parallel). Why this matters: Vercel serverless functions cap at 60s,
// and a longer per-send gap would mean the cron gets killed mid-loop and
// most sends never go out. 3s also keeps the per-inbox cadence plausibly
// human — same inbox doesn't fire 10 emails in 5 seconds.
const MIN_SEND_GAP_MS = 3_000;

export async function runWarmup({ teamId, dryRun = false, log = console.log }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    log("[warmup] RESEND_API_KEY not set — skipping");
    return { ran: 0, error: "no resend key" };
  }
  if (!apiKey) {
    log("[warmup] ANTHROPIC_API_KEY not set — will use fallback templates");
  }

  // 1. Active warming inboxes for this team
  const { data: inboxes, error: ibErr } = await supabase
    .from("sender_inboxes")
    .select("id, email, from_name, reply_to, domain, is_warming, warming_started_at")
    .eq("team_id", teamId)
    .eq("is_warming", true);

  if (ibErr) {
    log(`[warmup] failed to fetch inboxes: ${ibErr.message}`);
    return { ran: 0, error: ibErr.message };
  }
  if (!inboxes || inboxes.length === 0) {
    log("[warmup] no warming inboxes — nothing to do");
    return { ran: 0 };
  }

  // 2. Active seeds for this team
  const { data: seeds, error: seedErr } = await supabase
    .from("warmup_seeds")
    .select("id, email, display_name")
    .eq("team_id", teamId)
    .eq("is_active", true);

  if (seedErr) {
    log(`[warmup] failed to fetch seeds: ${seedErr.message}`);
    return { ran: 0, error: seedErr.message };
  }
  if (!seeds || seeds.length === 0) {
    log("[warmup] no active seed addresses — populate warmup_seeds first");
    return { ran: 0, error: "no seeds" };
  }
  if (seeds.length < 3) {
    log(`[warmup] only ${seeds.length} seed(s) — warmup needs at least 3 for plausible recipient diversity, recommend 8+`);
  }

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  // Process inboxes in parallel so the function fits inside Vercel's 60s
  // serverless budget even at Day-14 peak volume. Sends *within* a single
  // inbox stay serial with a small gap so we don't fire 10 emails in 5s
  // from the same sender.
  const results = await Promise.all(inboxes.map((inbox) => processInbox({
    inbox, teamId, seeds, startOfDay, dryRun, apiKey, resendApiKey, log,
  })));

  const totalSent = results.reduce((s, r) => s + (r.sent_this_run || 0), 0);
  const totalFailed = results.reduce((s, r) => s + (r.failed || 0), 0);
  const perInbox = results;

  log(`[warmup] DONE — sent=${totalSent} failed=${totalFailed} across ${inboxes.length} inbox(es)`);
  return { ran: totalSent, failed: totalFailed, perInbox };
}

async function processInbox({ inbox, teamId, seeds, startOfDay, dryRun, apiKey, resendApiKey, log }) {
  const startedAt = inbox.warming_started_at ? new Date(inbox.warming_started_at) : new Date();
  const daysWarming = Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 86_400_000));
  const targetToday = RAMP_SCHEDULE[daysWarming];

  if (targetToday === undefined) {
    log(`[warmup] ${inbox.email}: day ${daysWarming} is past the 2-week ramp — agent stopping for this inbox. Flip is_warming=false to graduate.`);
    return { inbox: inbox.email, day: daysWarming, status: "graduated", sent_this_run: 0, failed: 0 };
  }

  const { count: sentToday, error: countErr } = await supabase
    .from("email_sends")
    .select("id", { count: "exact", head: true })
    .eq("team_id", teamId)
    .eq("sender_email", inbox.email)
    .eq("template_key", "warmup")
    .gte("sent_at", startOfDay.toISOString());

  if (countErr) {
    log(`[warmup] ${inbox.email}: count error ${countErr.message}, skipping`);
    return { inbox: inbox.email, day: daysWarming, error: countErr.message, sent_this_run: 0, failed: 0 };
  }

  const remaining = targetToday - (sentToday || 0);
  if (remaining <= 0) {
    log(`[warmup] ${inbox.email}: day ${daysWarming}, already at target (${sentToday}/${targetToday})`);
    return { inbox: inbox.email, day: daysWarming, already_sent: sentToday, target: targetToday, sent_this_run: 0, failed: 0 };
  }

  const picks = pickRecipients(seeds, remaining);
  if (picks.length < remaining) {
    log(`[warmup] ${inbox.email}: only ${seeds.length} seeds available, capping today's run at ${picks.length} (target was ${remaining})`);
  }

  let inboxSent = 0;
  let inboxFailed = 0;

  for (let i = 0; i < picks.length; i++) {
    const seed = picks[i];

    if (dryRun) {
      log(`[warmup]   DRY: would send from ${inbox.email} → ${seed.email}`);
      inboxSent++;
      continue;
    }

    const { subject, body } = await generateWarmupEmail({
      senderName: inbox.from_name,
      recipientName: seed.display_name,
      apiKey,
    });

    const result = await sendEmail({
      to: seed.email,
      toName: seed.display_name,
      subject,
      body,
      from: `${inbox.from_name} <${inbox.email}>`,
      replyTo: inbox.reply_to || inbox.email,
      resendApiKey,
    });

    await supabase.from("email_sends").insert({
      team_id: teamId,
      sender_email: inbox.email,
      sender_domain: inbox.domain,
      to_email: seed.email.toLowerCase(),
      to_name: seed.display_name || null,
      subject,
      body,
      template_key: "warmup",
      template_variant: "warmup",
      status: result.success ? "sent" : "failed",
      resend_id: result.resendId || null,
      error: result.error || null,
      sent_at: new Date().toISOString(),
    });

    if (result.success) {
      inboxSent++;
      log(`[warmup]   ${inbox.email} → ${seed.email}: OK (${subject})`);
    } else {
      inboxFailed++;
      log(`[warmup]   ${inbox.email} → ${seed.email}: FAIL ${result.error}`);
    }

    // Sleep between sends within this inbox (but not after the last one).
    if (i < picks.length - 1) await sleep(MIN_SEND_GAP_MS);
  }

  return {
    inbox: inbox.email,
    day: daysWarming,
    target: targetToday,
    already_sent: sentToday || 0,
    sent_this_run: inboxSent,
    failed: inboxFailed,
  };
}

function pickRecipients(seeds, count) {
  // Fisher-Yates shuffle, take first N. If count > seeds.length, return all.
  const arr = [...seeds];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.min(count, arr.length));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// CLI entry point so you can dry-run from your terminal:
//   node server/automation/warmup-agent.js --dry-run
//   node server/automation/warmup-agent.js
if (import.meta.url === `file://${process.argv[1]}`) {
  const TEAM_ID = process.env.TEAM_ID || "a0000000-0000-0000-0000-000000000001";
  const dryRun = process.argv.includes("--dry-run");
  runWarmup({ teamId: TEAM_ID, dryRun }).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }).catch((err) => {
    console.error("warmup-agent failed:", err);
    process.exit(1);
  });
}
