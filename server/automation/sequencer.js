// Multi-touch sequencer for the daily-200 outbound agent.
// Owns: scheduling 3 touches per prospect (T+0 / T+3 / T+7), picking due rows
// up to a daily cap, and cancelling pending touches when a reply lands.
//
// Storage model: each touch is one `email_sends` row. Rows for the same
// prospect share `sequence_id`, with `touch_number` ∈ {1,2,3} and
// `scheduled_at` driving when each fires.

import crypto from "node:crypto";
import { supabase } from "../lib/supabase.js";
import { sendEmail } from "./send.js";
import { generateObservation, renderTemplate, validateRenderedEmail } from "./personalize.js";
import { isGenericLocal } from "./lead-discovery.js";

// Belt-and-suspenders: even if a junk first_name slips into the DB, never
// inject it into a customer-facing email greeting. Falls back to "there"
// when name is empty, generic, or suspiciously short.
function safeFirstName(name) {
  if (!name) return "there";
  const first = name.trim().split(/\s+/)[0] || "";
  if (first.length < 2) return "there";
  if (isGenericLocal(first.toLowerCase())) return "there";
  return first;
}
import { getSequenceTemplate, getPrimaryProductType } from "./templates.js";
import { classifyBrand } from "./brand-groups.js";

// Default fallbacks. When a campaign row is loaded, its sender_from / reply_to
// override these. Used by legacy callers (CLI scripts) that don't pass a campaign.
export const SENDER_FROM = "Federico from Linkable <brand@linkable.link>";
export const REPLY_TO    = process.env.LINKABLE_DAILY_REPLY_TO || "brand@linkable.link";
export const SENDER_DOMAIN = "linkable.link";

// ---------- TEMPLATE LOADING (campaign-scoped, weighted A/B) ----------

// Load active, non-draft templates for a campaign and bucket them by
// (group, touch). Each bucket holds variants picked weighted-randomly.
// Returns { "G1-T1": [tpl, tpl, ...], ... }.
async function loadCampaignTemplateBuckets(teamId, campaignId) {
  if (!campaignId) return {};
  const { data, error } = await supabase
    .from("email_templates")
    .select("id, brand_group, touch_number, template_key, subject_template, body_template, weight, is_active, is_draft")
    .eq("team_id", teamId)
    .eq("campaign_id", campaignId)
    .eq("is_active", true)
    .eq("is_draft", false);
  if (error) {
    console.error("loadCampaignTemplateBuckets:", error.message);
    return {};
  }
  const buckets = {};
  for (const t of data || []) {
    if (!t.brand_group || !t.touch_number) continue;
    const key = `${t.brand_group}-T${t.touch_number}`;
    (buckets[key] ||= []).push(t);
  }
  return buckets;
}

// Pick one template from a bucket, weighted by `weight` (default 100). If
// the bucket is empty, fall back to the hardcoded SEQUENCE_TEMPLATES default
// so the orchestrator never crashes on a missing slot.
function pickWeightedTemplate(bucket, fallbackGroup, fallbackTouch) {
  if (!bucket || bucket.length === 0) {
    return getSequenceTemplate(fallbackGroup, fallbackTouch);
  }
  const total = bucket.reduce((s, t) => s + Math.max(0, t.weight || 0), 0);
  if (total <= 0) return bucket[0];
  let r = Math.random() * total;
  for (const t of bucket) {
    r -= Math.max(0, t.weight || 0);
    if (r <= 0) return t;
  }
  return bucket[bucket.length - 1];
}

// Touch offsets in calendar days (skip-weekend logic applies on top).
const TOUCH_OFFSETS_DAYS = { 1: 0, 2: 3, 3: 7 };

// Push to Mon if a Sat/Sun lands. We don't send on weekends.
function nextWeekday(date) {
  const d = new Date(date);
  const day = d.getUTCDay();   // 0=Sun, 6=Sat
  if (day === 6) d.setUTCDate(d.getUTCDate() + 2);
  if (day === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

function touchScheduledAt(t1Date, touch) {
  const offset = TOUCH_OFFSETS_DAYS[touch];
  const d = new Date(t1Date);
  d.setUTCDate(d.getUTCDate() + offset);
  return nextWeekday(d).toISOString();
}

// ---------- SCHEDULING ----------

// Insert 3 email_sends rows for one prospect. Touch 1 is due immediately
// (scheduled_at = now); touches 2 and 3 are future-dated.
//
// Returns { sequence_id, group, productType, touches: [...] } or
// { skipped: 'reason' } when the prospect can't be enrolled.
//
// When `campaignId` is provided, templates are loaded from email_templates
// scoped to that campaign (with weighted A/B selection per slot). Otherwise
// falls back to the hardcoded SEQUENCE_TEMPLATES defaults.
export async function enrollProspect({
  teamId,
  campaignId,
  contactId,
  toEmail,
  toName,
  brand,                 // shape: storeName/brandInfo/matchedKeywords/sampleTypes/...
  apiKey,                // Anthropic key (for observation gen)
  startAt = new Date(),  // when T+1 fires
  group,                 // optional override; else classifier picks
  templateBuckets,       // optional pre-loaded buckets; else loaded per campaign
}) {
  if (!toEmail) return { skipped: "no email" };

  // Suppression check — global opt-outs / bounces / complaints.
  const { data: suppression } = await supabase
    .from("ai_suppressions")
    .select("id")
    .eq("team_id", teamId)
    .ilike("email", toEmail)
    .maybeSingle();
  if (suppression) return { skipped: "suppressed" };

  // Don't double-enroll the same email.
  const { data: existing } = await supabase
    .from("email_sends")
    .select("id, sequence_id, status")
    .eq("team_id", teamId)
    .ilike("to_email", toEmail)
    .not("sequence_id", "is", null)
    .limit(1);
  if (existing?.length) return { skipped: "already enrolled", sequence_id: existing[0].sequence_id };

  const grp = group || classifyBrand(brand);
  const productType = getPrimaryProductType(
    brand?.matchedKeywords || [],
    brand?.sampleTypes || [],
    [brand?.storeName, brand?.name, brand?.merchant_name, brand?.title, brand?.description].filter(Boolean).join(" ")
  );

  // Generate the personalized observation once — reused across touches that need it.
  let observation = "";
  if (apiKey) {
    try {
      observation = await generateObservation(brand, apiKey);
    } catch (err) {
      console.error(`observation gen failed for ${toEmail}:`, err.message);
    }
  }

  const sequenceId = crypto.randomUUID();
  const t1Date = nextWeekday(new Date(startAt));
  const variables = {
    brandName: brand?.storeName || brand?.name || brand?.merchant_name || brand?.domain || "your brand",
    firstName: safeFirstName(toName),
    productType,
    observation,
  };

  // Resolve templates once per prospect: load campaign buckets if not pre-loaded,
  // then weighted-pick per (group, touch). Same prospect always gets one variant
  // per touch (deterministic within a sequence — picked at enrollment time).
  const buckets = templateBuckets || (campaignId ? await loadCampaignTemplateBuckets(teamId, campaignId) : {});

  const rows = [];
  for (const touch of [1, 2, 3]) {
    const key = `${grp}-T${touch}`;
    const tpl = pickWeightedTemplate(buckets[key], grp, touch);
    if (!tpl) {
      console.error(`no template for ${key}`);
      return { skipped: `template missing: ${key}` };
    }
    const subject = renderTemplate(tpl.subject_template, variables);
    const body = renderTemplate(tpl.body_template, variables);
    const v = validateRenderedEmail(subject, body);
    if (!v.valid) {
      console.warn(`render issues for ${toEmail} ${key}:`, v.issues);
      if (touch === 1) return { skipped: `render: ${v.issues.join("; ")}` };
    }

    rows.push({
      campaign_id: campaignId,
      team_id: teamId,
      contact_id: contactId,
      template_id: tpl.id || null,             // links to email_templates row when DB-sourced
      template_key: tpl.template_key || key,
      sequence_id: sequenceId,
      touch_number: touch,
      brand_group: grp,
      sender_domain: SENDER_DOMAIN,
      template_variant: tpl.template_key || key,
      to_email: toEmail.toLowerCase(),
      to_name: toName || null,
      subject,
      body,
      status: touch === 1 ? "pending" : "scheduled",
      scheduled_at: touch === 1 ? t1Date.toISOString() : touchScheduledAt(t1Date, touch),
    });
  }

  const { data: inserted, error } = await supabase
    .from("email_sends")
    .insert(rows)
    .select("id, touch_number, scheduled_at");

  if (error) {
    console.error("enroll insert failed:", error.message);
    return { skipped: `insert error: ${error.message}` };
  }

  return {
    sequence_id: sequenceId,
    group: grp,
    productType,
    touches: inserted,
  };
}

// ---------- CAMPAIGN HELPERS ----------

// Public version so the orchestrator can preload once per run and avoid
// the per-prospect template query.
export async function loadTemplateBucketsForCampaign(teamId, campaignId) {
  return await loadCampaignTemplateBuckets(teamId, campaignId);
}

// Find the campaign the daily-200 orchestrator should use.
//   1. By id (if explicit)
//   2. By the most recently-active 'daily-200' campaign
//   3. null when none exists (orchestrator falls back to legacy hardcoded mode)
export async function resolveActiveCampaign(teamId, explicitId) {
  if (explicitId) {
    const { data } = await supabase.from("email_campaigns").select("*")
      .eq("team_id", teamId).eq("id", explicitId).maybeSingle();
    return data || null;
  }
  const { data } = await supabase.from("email_campaigns").select("*")
    .eq("team_id", teamId).eq("status", "active").eq("source", "daily-200")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  return data || null;
}

// ---------- DUE-NOW QUERY ----------

// Fetch up to `limit` rows that are due to send right now, prioritizing
// later touches (so we finish sequences before starting new ones).
export async function fetchDueRows({ teamId, limit }) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("email_sends")
    .select("*")
    .eq("team_id", teamId)
    .in("status", ["pending", "scheduled"])
    .lte("scheduled_at", now)
    .order("touch_number", { ascending: false })   // T+7 > T+3 > T+0
    .order("scheduled_at", { ascending: true })    // oldest-due first within a touch
    .limit(limit);
  if (error) throw new Error(`fetchDueRows: ${error.message}`);
  return data || [];
}

// ---------- SEND ONE ROW ----------

export async function sendDueRow(row, { resendApiKey, senderFrom, replyTo }) {
  // Last-mile suppression check — caught between enrollment and send.
  const { data: suppressed } = await supabase
    .from("ai_suppressions")
    .select("id")
    .eq("team_id", row.team_id)
    .ilike("email", row.to_email)
    .maybeSingle();
  if (suppressed) {
    await supabase
      .from("email_sends")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancel_reason: "opted_out" })
      .eq("id", row.id);
    return { sent: false, cancelled: true, reason: "suppressed" };
  }

  const result = await sendEmail({
    to: row.to_email,
    toName: row.to_name,
    subject: row.subject,
    body: row.body,
    from: senderFrom || SENDER_FROM,
    replyTo: replyTo || REPLY_TO,
    resendApiKey,
  });

  if (result.success) {
    await supabase
      .from("email_sends")
      .update({ status: "sent", resend_id: result.resendId, sent_at: new Date().toISOString() })
      .eq("id", row.id);
    return { sent: true, resendId: result.resendId };
  }

  await supabase
    .from("email_sends")
    .update({ status: "failed", error: result.error, sent_at: new Date().toISOString() })
    .eq("id", row.id);
  return { sent: false, error: result.error };
}

// ---------- CANCEL ON REPLY / OPT-OUT ----------

// Called from conversation-runner when an inbound reply lands. Cancels every
// pending/scheduled touch for this contact's email so we stop spamming after
// they've engaged.
export async function cancelPendingTouches({ teamId, email, reason = "replied" }) {
  if (!email) return { cancelled: 0 };
  const { data, error } = await supabase
    .from("email_sends")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      cancel_reason: reason,
    })
    .eq("team_id", teamId)
    .ilike("to_email", email)
    .in("status", ["pending", "scheduled"])
    .select("id, sequence_id, touch_number");
  if (error) {
    console.error("cancelPendingTouches failed:", error.message);
    return { cancelled: 0, error: error.message };
  }
  return { cancelled: (data || []).length, rows: data || [] };
}
