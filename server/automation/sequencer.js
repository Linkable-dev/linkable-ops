// Multi-touch sequencer for the daily outbound agent.
// Owns: scheduling 4 touches per prospect (T+0 / T+3 / T+7 / T+12), picking
// due rows up to a daily cap, and cancelling pending touches when a reply
// lands. T+12 is the breakup touch — pure pressure-removal, historically
// the highest reply-rate-per-send slot in the sequence.
//
// Storage model: each touch is one `email_sends` row. Rows for the same
// prospect share `sequence_id`, with `touch_number` ∈ {1,2,3,4} and
// `scheduled_at` driving when each fires.
//
// Audience: the brand path uses enrollProspect() with classifyBrand groups
// (G1/G2/G3). The influencer path uses enrollCreator() with classifyCreator
// tiers (C1/C2/C3). Both share fetchDueRows / sendDueRow / cancelPendingTouches —
// those operate on email_sends rows and are audience-agnostic. The
// audience_type column on email_sends is set at enrollment so analytics
// (and the inbound parser, eventually) can split brand vs creator metrics.

import crypto from "node:crypto";
import { supabase } from "../lib/supabase.js";
import { sendEmail } from "./send.js";
import { generateObservation, renderTemplate, validateRenderedEmail } from "./personalize.js";
import { isGenericLocal } from "./lead-discovery.js";
import { getNextInbox } from "./sender-pool.js";

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

// StoreLeads frequently sets brand.merchant_name and brand.name to the URL
// (e.g. "www.zingorganics.co.uk") instead of a real brand name, which rendered
// awful subject lines like "www.zingorganics.co.uk + Linkable". This walks the
// candidate fields, rejects URL-shaped values, and falls back to extracting
// from the page title or humanising the domain.
function looksLikeUrl(s) {
  if (!s) return false;
  const t = s.toString().trim().toLowerCase();
  if (t.startsWith("http") || t.startsWith("www.")) return true;
  // Bare domain heuristic: any single-token value with a dot and a TLD.
  if (!/\s/.test(t) && /\.[a-z]{2,}(\.[a-z]{2,})?$/.test(t)) return true;
  return false;
}
// Try to pull a brand name out of a Shopify-style <title>. The convention is
// "<page description> <separator> <Brand Name>" where the brand sits at the
// END after an em-dash, pipe, or bullet. Examples:
//   "Artisan Apothecary Workshop – Zing Organics" → "Zing Organics"
//   "All Natural Beard Products – Beard Balm"     → "Beard Balm"
// Returns null if there's no separator or the last segment is implausible.
function brandNameFromTitle(title) {
  if (!title) return null;
  const parts = title.split(/[–|·•—]|\s-\s/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  // Reject the segment if it's too long (marketing copy, not a brand name)
  // or too short (probably noise like an emoji or single char).
  if (last.length < 2 || last.length > 60) return null;
  return last;
}
function humanizeDomain(domain) {
  if (!domain) return null;
  // strip protocol/www, take registrable-ish part, title-case
  const stem = domain.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/.]/)[0];
  if (!stem) return null;
  return stem.replace(/[-_]+/g, " ")
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
function resolveBrandName(brand) {
  const candidates = [brand?.storeName, brand?.name, brand?.merchant_name];
  for (const c of candidates) {
    if (c && !looksLikeUrl(c)) return c;
  }
  // Fall back: try to mine the page title (StoreLeads-set), then humanise the
  // domain. Last-ditch returns "your brand" so subject still reads cleanly.
  return brandNameFromTitle(brand?.title)
    || humanizeDomain(brand?.domain)
    || humanizeDomain(brand?.name)   // brand.name is often the URL — humanise it
    || "your brand";
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
// T4 (breakup) lands ~5 days after T3 so the buyer has time to forget the
// pressure of T3's "reply yes" ask; the breakup reads less like a follow-up
// and more like a clean close.
const TOUCH_OFFSETS_DAYS = { 1: 0, 2: 3, 3: 7, 4: 12 };

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

// Insert 4 email_sends rows for one prospect. Touch 1 is due immediately
// (scheduled_at = now); touches 2, 3, and 4 are future-dated.
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
  senderPoolTag = null,  // restrict sender selection to a tagged inbox subset
  audienceType = "brand",
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

  // Pick the sender inbox ONCE for the whole sequence and pin it on every
  // touch row. Without this, sendDueRow would re-pick via getNextInbox at
  // each send, and a 4-touch sequence over 12 days would land on 4 different
  // inboxes — Gmail breaks threading and the prospect sees 4 strangers
  // following up. hasPool=false means no pool configured at all (legacy
  // single-sender path stays active). hasPool=true with inbox=null means
  // every inbox is at cap today — defer the whole enrollment to tomorrow.
  const { hasPool: poolConfigured, inbox: pickedInbox } = await getNextInbox(teamId, { poolTag: senderPoolTag });
  if (poolConfigured && !pickedInbox) {
    return { skipped: "all inboxes at daily cap" };
  }

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
    brandName: resolveBrandName(brand),
    firstName: safeFirstName(toName),
    productType,
    observation,
  };

  // Resolve templates once per prospect: load campaign buckets if not pre-loaded,
  // then weighted-pick per (group, touch). Same prospect always gets one variant
  // per touch (deterministic within a sequence — picked at enrollment time).
  const buckets = templateBuckets || (campaignId ? await loadCampaignTemplateBuckets(teamId, campaignId) : {});

  const rows = [];
  for (const touch of [1, 2, 3, 4]) {
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
      audience_type: audienceType,
      template_id: tpl.id || null,             // links to email_templates row when DB-sourced
      template_key: tpl.template_key || key,
      sequence_id: sequenceId,
      touch_number: touch,
      brand_group: grp,
      // Pin the inbox on every row so all 4 touches send from the same sender.
      // sendDueRow reads sender_email from the row and looks up the inbox via
      // getNextInbox(..., {pinnedEmail}). Falls back to legacy SENDER_DOMAIN
      // when the pool isn't configured.
      sender_email: pickedInbox?.email || null,
      sender_domain: pickedInbox?.domain || SENDER_DOMAIN,
      template_variant: tpl.template_key || key,
      to_email: toEmail.toLowerCase(),
      to_name: toName || null,
      subject,
      body,
      observation: observation || null,        // stored on every touch so analytics can skip the T1 join
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

  // Flip the lead-pool flag so the Leads tab counters and the auto-discovery
  // scheduler don't count this brand as uncontacted. The dedupe in
  // email_sends above is what actually prevents double-enrolment; this is
  // for accurate downstream signals.
  await supabase
    .from("storeleads_brands")
    .update({ emailed: true, emailed_at: new Date().toISOString() })
    .eq("team_id", teamId)
    .ilike("email", toEmail.toLowerCase());

  return {
    sequence_id: sequenceId,
    group: grp,
    productType,
    touches: inserted,
  };
}

// ---------- CREATOR (INFLUENCER) ENROLLMENT ----------
//
// Mirror of enrollProspect for the influencer audience. Same shape on email_sends
// (4 rows, shared sequence_id, pinned sender), but the per-creator variables come
// from buildCreatorVariables and the lifecycle flag flip targets creator_prospects
// instead of storeleads_brands.
import {
  generateCreatorObservation,
  buildCreatorVariables,
  renderTemplate as renderCreatorTemplate,
  validateRenderedEmail as validateCreatorEmail,
} from "./personalize-creator.js";
import { classifyCreator } from "./creator-groups.js";
import { getCreatorSequenceTemplate } from "./creator-templates.js";

export async function enrollCreator({
  teamId,
  campaignId,
  contactId = null,
  toEmail,
  toName,
  creator,               // creator_prospects row shape
  apiKey,
  startAt = new Date(),
  group,                 // optional override; else classifyCreator picks
  templateBuckets,       // pre-loaded buckets for this campaign
  senderPoolTag = null,
}) {
  if (!toEmail) return { skipped: "no email" };

  const { data: suppression } = await supabase
    .from("ai_suppressions")
    .select("id")
    .eq("team_id", teamId)
    .ilike("email", toEmail)
    .maybeSingle();
  if (suppression) return { skipped: "suppressed" };

  const { data: existing } = await supabase
    .from("email_sends")
    .select("id, sequence_id, status")
    .eq("team_id", teamId)
    .ilike("to_email", toEmail)
    .not("sequence_id", "is", null)
    .limit(1);
  if (existing?.length) return { skipped: "already enrolled", sequence_id: existing[0].sequence_id };

  const grp = group || classifyCreator(creator);

  const { hasPool: poolConfigured, inbox: pickedInbox } = await getNextInbox(teamId, { poolTag: senderPoolTag });
  if (poolConfigured && !pickedInbox) {
    return { skipped: "all inboxes at daily cap" };
  }

  let observation = "";
  if (apiKey) {
    try {
      observation = await generateCreatorObservation(creator, apiKey);
    } catch (err) {
      console.error(`creator observation gen failed for ${toEmail}:`, err.message);
    }
  }

  const sequenceId = crypto.randomUUID();
  const t1Date = nextWeekday(new Date(startAt));
  const variables = buildCreatorVariables(creator, observation);
  const buckets = templateBuckets || (campaignId ? await loadCampaignTemplateBuckets(teamId, campaignId) : {});

  const rows = [];
  for (const touch of [1, 2, 3, 4]) {
    const key = `${grp}-T${touch}`;
    const bucket = buckets[key];
    let tpl = pickWeightedTemplate(bucket, grp, touch);
    if (!tpl || (!tpl.subject_template && !tpl.body_template)) {
      // Fall back to the creator-specific seed template when the campaign
      // has no row for this slot (e.g. operator deleted it).
      tpl = getCreatorSequenceTemplate(grp, touch);
    }
    if (!tpl) {
      console.error(`no creator template for ${key}`);
      return { skipped: `template missing: ${key}` };
    }
    const subject = renderCreatorTemplate(tpl.subject_template, variables);
    const body = renderCreatorTemplate(tpl.body_template, variables);
    const v = validateCreatorEmail(subject, body);
    if (!v.valid) {
      console.warn(`creator render issues for ${toEmail} ${key}:`, v.issues);
      if (touch === 1) return { skipped: `render: ${v.issues.join("; ")}` };
    }

    rows.push({
      campaign_id: campaignId,
      team_id: teamId,
      contact_id: contactId,
      audience_type: "influencer",
      template_id: tpl.id || null,
      template_key: tpl.template_key || key,
      sequence_id: sequenceId,
      touch_number: touch,
      brand_group: grp,                          // reuse the column for tier (C1/C2/C3)
      sender_email: pickedInbox?.email || null,
      sender_domain: pickedInbox?.domain || SENDER_DOMAIN,
      template_variant: tpl.template_key || key,
      to_email: toEmail.toLowerCase(),
      to_name: toName || null,
      subject,
      body,
      observation: observation || null,
      status: touch === 1 ? "pending" : "scheduled",
      scheduled_at: touch === 1 ? t1Date.toISOString() : touchScheduledAt(t1Date, touch),
    });
  }

  const { data: inserted, error } = await supabase
    .from("email_sends")
    .insert(rows)
    .select("id, touch_number, scheduled_at");

  if (error) {
    console.error("enrollCreator insert failed:", error.message);
    return { skipped: `insert error: ${error.message}` };
  }

  await supabase
    .from("creator_prospects")
    .update({ emailed: true, emailed_at: new Date().toISOString() })
    .eq("team_id", teamId)
    .ilike("email", toEmail.toLowerCase());

  return {
    sequence_id: sequenceId,
    group: grp,
    touches: inserted,
  };
}

// ---------- CAMPAIGN HELPERS ----------

// Public version so the orchestrator can preload once per run and avoid
// the per-prospect template query.
export async function loadTemplateBucketsForCampaign(teamId, campaignId) {
  return await loadCampaignTemplateBuckets(teamId, campaignId);
}

// Find the campaign the daily orchestrator should use.
//   1. By id (if explicit)
//   2. By the most recently-active 'daily-200' campaign for this audience
//   3. null when none exists (orchestrator falls back to legacy hardcoded mode)
//
// audienceType filters between brand and influencer auto-pick when no explicit
// id is passed. Defaults to "brand" so existing brand-only callers stay
// behaviour-compatible.
export async function resolveActiveCampaign(teamId, explicitId, audienceType = "brand") {
  if (explicitId) {
    const { data } = await supabase.from("email_campaigns").select("*")
      .eq("team_id", teamId).eq("id", explicitId).maybeSingle();
    return data || null;
  }
  const { data } = await supabase.from("email_campaigns").select("*")
    .eq("team_id", teamId).eq("status", "active").eq("source", "daily-200")
    .eq("audience_type", audienceType)
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

export async function sendDueRow(row, { resendApiKey, senderFrom, replyTo, senderPoolTag = null }) {
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

  // Sender selection — pinned-first for thread continuity:
  //
  // If row.sender_email is set, the inbox was pinned at enrollment time.
  // Honor it: every touch in the sequence sends from the same address so
  // the prospect sees one coherent thread. If that inbox is at cap today,
  // defer (don't fall back to a different inbox — that breaks threading).
  //
  // If row.sender_email is NULL (legacy enrollments pre-fix, or pool wasn't
  // configured at enrollment time), fall through to free rotation across
  // the pool.
  //
  // hasPool=false in either case means no pool exists at all — use the
  // campaign's sender_from (legacy single-sender path).
  const { hasPool, inbox } = row.sender_email
    ? await getNextInbox(row.team_id, { pinnedEmail: row.sender_email })
    : await getNextInbox(row.team_id, { poolTag: senderPoolTag });

  if (hasPool && !inbox) {
    const reason = row.sender_email
      ? `pinned inbox ${row.sender_email} at daily cap`
      : "all inboxes at daily cap";
    return { sent: false, deferred: true, reason };
  }

  const finalFrom = inbox?.from || senderFrom || SENDER_FROM;
  const finalReplyTo = inbox?.replyTo || replyTo || REPLY_TO;

  const result = await sendEmail({
    to: row.to_email,
    toName: row.to_name,
    subject: row.subject,
    body: row.body,
    from: finalFrom,
    replyTo: finalReplyTo,
    resendApiKey,
  });

  if (result.success) {
    await supabase
      .from("email_sends")
      .update({
        status: "sent",
        resend_id: result.resendId,
        sent_at: new Date().toISOString(),
        sender_email: inbox?.email || null,
        sender_domain: inbox?.domain || row.sender_domain || SENDER_DOMAIN,
      })
      .eq("id", row.id);
    return { sent: true, resendId: result.resendId, senderEmail: inbox?.email || null };
  }

  await supabase
    .from("email_sends")
    .update({
      status: "failed",
      error: result.error,
      sent_at: new Date().toISOString(),
      sender_email: inbox?.email || null,
    })
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
