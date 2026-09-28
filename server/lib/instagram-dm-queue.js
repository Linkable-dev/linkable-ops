// The Instagram DM queue's shared rules: which brands are waiting, in what
// order, and how a batch of their messages gets written. Used by the page
// (routes/prospecting.js) and by the morning cron that writes the messages
// before anybody opens it (routes/cron.js), so the two cannot disagree about
// who is in the queue.
//
// One brand, one channel. A lead already handed to Lemlist is not offered, and
// a lead marked sent is read back by the pipeline and never emailed.

import { supabase } from "./supabase.js";
import { draftInstagramDm, languageFor } from "./instagram-dm-writer.js";
import { creatorPool } from "./creator-pool.js";

export const TABLE = "prospector_leads";

export const DM_COLUMNS = [
  "handle", "tier", "decision", "status", "brand_name", "domain", "country",
  "contact_email", "affiliate_app", "product_count", "distinct_creators_90d",
  "top_creators", "intent_signal", "intent_post_url", "intent_caption",
  "ig_full_name", "ig_biography", "ig_category", "ig_followers",
  "instagram_url", "pushed_at", "first_seen_at", "creator_activity_score",
  "dm_state", "dm_text", "dm_language", "dm_drafted_at", "dm_sent_at",
  "dm_sent_by", "dm_replied_at",
].join(",");

// --- settings an admin chooses for the whole team ---------------------------

export const SETTINGS = "prospector_settings";
export const SETTING_DEFAULTS = {
  dm_include_non_shopify: false,
  // ISO country codes the queue keeps; empty means every country. "UNKNOWN"
  // stands for a brand with no country, which is most brands not on Shopify.
  dm_countries: [],
};

export const UNKNOWN_COUNTRY = "UNKNOWN";

// Why a value cannot be stored for a setting, or null when it can.
export function settingProblem(key, value) {
  if (!(key in SETTING_DEFAULTS)) return `unknown setting: ${key}`;
  if (key === "dm_countries") {
    if (!Array.isArray(value)) return "dm_countries must be a list of country codes";
    const bad = value.filter((c) => typeof c !== "string" || !(/^[A-Z]{2}$/.test(c) || c === UNKNOWN_COUNTRY));
    return bad.length ? `not a country code: ${bad.join(", ")}` : null;
  }
  if (typeof value !== typeof SETTING_DEFAULTS[key]) {
    return `${key} must be a ${typeof SETTING_DEFAULTS[key]}`;
  }
  return null;
}

export async function readSettings() {
  const { data, error } = await supabase.from(SETTINGS).select("key,value");
  // A missing table reads as the defaults: the queue must keep working in the
  // window between a deploy and the migration.
  if (error) return { ...SETTING_DEFAULTS };
  const out = { ...SETTING_DEFAULTS };
  for (const row of data || []) {
    if (row.key in SETTING_DEFAULTS) out[row.key] = row.value;
  }
  return out;
}

export function optionsFrom(settings) {
  return {
    nonShopify: settings.dm_include_non_shopify === true,
    countries: Array.isArray(settings.dm_countries) ? settings.dm_countries : [],
  };
}

export async function queueOptions() {
  return optionsFrom(await readSettings());
}

// Waiting to be written to on Instagram. The same predicate the counts use, so
// a count and the list it describes cannot disagree. Brands not on Shopify have
// no tier; they are in the queue only when an admin has said so.
export const dmOpen = (qy, { nonShopify, countries = [] }) => {
  let open = qy.in("dm_state", ["none", "drafted"]).is("pushed_at", null).neq("decision", "hide");
  open = nonShopify ? open.or("tier.not.is.null,status.eq.not_shopify") : open.not("tier", "is", null);
  if (!countries.length) return open;
  // Codes are validated on the way in (settingProblem), so they are safe to
  // put in the filter string.
  const codes = countries.filter((c) => c !== UNKNOWN_COUNTRY);
  if (!countries.includes(UNKNOWN_COUNTRY)) return open.in("country", codes.length ? codes : ["--"]);
  return codes.length ? open.or(`country.in.(${codes.join(",")}),country.is.null`) : open.is("country", null);
};

export const countryOf = (r) => (r.country ? String(r.country).toUpperCase() : UNKNOWN_COUNTRY);

export const isDmOpen = (r, { nonShopify, countries = [] }) => ["none", "drafted"].includes(r.dm_state || "none")
  && !r.pushed_at && r.decision !== "hide"
  && Boolean(r.tier || (nonShopify && r.status === "not_shopify"))
  && (!countries.length || countries.includes(countryOf(r)));

// Brands that asked for creators in public first: they have already said the
// thing the message answers. Then the pipeline's own ranking.
export const todoOrder = (qy) => qy
  .order("intent_signal", { ascending: true, nullsFirst: false })
  .order("tier", { ascending: true, nullsFirst: false })
  .order("creator_activity_score", { ascending: false, nullsFirst: false });

// Queued for email but not yet handed over: it goes on the next tick unless it
// is DMed first, which takes it out of the email sequence.
export const emailQueued = (r) => r.decision === "send" && r.status === "routed" && !r.pushed_at
                                  && Boolean(r.contact_email);

export const shapeDm = (r) => ({
  ...r,
  dm_state: r.dm_state || "none",
  email_queued: emailQueued(r),
  default_language: languageFor(r),
});

// Ten at most per batch: each is one model call, and a serverless function has
// sixty seconds.
export const DRAFT_BATCH = 10;
const DRAFT_CONCURRENCY = 4;

// Write the messages for the brands named, or for the next ones in the queue
// that have none. → { drafted, failed, costUsd }
export async function draftBatch({ handles = [], language, limit = DRAFT_BATCH } = {}) {
  const opts = await queueOptions();
  const base = supabase.from(TABLE).select(DM_COLUMNS);
  const query = handles.length
    ? dmOpen(base, opts).in("handle", handles.slice(0, DRAFT_BATCH))
    : todoOrder(dmOpen(base.is("dm_text", null), opts)).limit(Math.min(limit, DRAFT_BATCH));
  const { data: leads, error } = await query;
  if (error) throw error;
  if (!leads?.length) return { drafted: [], failed: [], costUsd: 0 };

  // Counted once per batch: the number every DM in it quotes.
  const pool = await creatorPool();
  const drafted = [];
  const failed = [];
  let costUsd = 0;
  const queue = [...leads];

  async function worker() {
    while (queue.length) {
      const lead = queue.shift();
      try {
        const out = await draftInstagramDm(lead, { language, pool });
        costUsd += out.costUsd;
        const { data: saved, error: saveError } = await supabase
          .from(TABLE)
          .update({
            dm_text: out.message,
            dm_language: out.language,
            dm_state: "drafted",
            dm_drafted_at: new Date().toISOString(),
          })
          .eq("handle", lead.handle)
          // Not over a message somebody sent while this one was being written.
          .in("dm_state", ["none", "drafted"])
          .select(DM_COLUMNS)
          .maybeSingle();
        if (saveError) throw saveError;
        if (saved) drafted.push({ ...shapeDm(saved), style_issues: out.styleIssues });
      } catch (err) {
        const missingKey = /ANTHROPIC_API_KEY/.test(err?.message || "");
        failed.push({
          handle: lead.handle,
          error: missingKey ? "ANTHROPIC_API_KEY is not set on the ops server" : (err?.message || "failed"),
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(DRAFT_CONCURRENCY, leads.length) }, worker));
  return { drafted, failed, costUsd: Math.round(costUsd * 10000) / 10000 };
}

// Every brand in the queue without a message, batch after batch, until the
// time is up. What the morning cron runs, so the queue is ready before anybody
// opens it. A brand whose draft keeps failing is tried once per batch and does
// not loop: a batch that writes nothing ends the run.
export async function draftAllMissing({ budgetMs = 45_000 } = {}) {
  const started = Date.now();
  const totals = { drafted: 0, failed: 0, costUsd: 0, batches: 0 };
  while (Date.now() - started < budgetMs) {
    const out = await draftBatch();
    totals.batches += 1;
    totals.drafted += out.drafted.length;
    totals.failed += out.failed.length;
    totals.costUsd = Math.round((totals.costUsd + out.costUsd) * 10000) / 10000;
    if (!out.drafted.length) break;
  }
  return totals;
}
