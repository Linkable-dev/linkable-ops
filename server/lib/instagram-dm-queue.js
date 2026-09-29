// The Instagram DM queue's shared rules: which brands are waiting, in what
// order, and how a batch of their messages gets written. Used by the page
// (routes/prospecting.js) and by the morning cron that writes the messages
// before anybody opens it (routes/cron.js), so the two cannot disagree about
// who is in the queue.
//
// One brand, one channel. A lead already handed to Lemlist is not offered, and
// a lead marked sent is read back by the pipeline and never emailed.

import { supabase } from "./supabase.js";
import {
  draftInstagramDm, languageFor, staleCall, FRESH_CALL_DAYS,
} from "./instagram-dm-writer.js";

export const TABLE = "prospector_leads";

export const DM_COLUMNS = [
  "handle", "tier", "decision", "status", "brand_name", "domain", "country",
  "contact_email", "affiliate_app", "product_count", "distinct_creators_90d",
  "top_creators", "intent_signal", "intent_post_url", "intent_caption",
  "ig_full_name", "ig_biography", "ig_category", "ig_followers",
  "instagram_url", "pushed_at", "first_seen_at", "creator_activity_score",
  "dm_state", "dm_text", "dm_language", "dm_drafted_at", "dm_sent_at",
  "dm_sent_by", "dm_replied_at", "vertical", "vertical_ai", "vertical_effective",
  "is_agency", "intent_posted_at", "dm_priority", "dm_variant", "dm_followup_text",
  "dm_followup_sent_at", "converted_at", "converted_match", "dm_reply_text", "ig_user_id",
  "myshopify_domain", "dm_reasons", "linkable_creator_count", "linkable_creators", "source",
].join(",");

// A DM unanswered for this long gets one follow-up.
export const FOLLOWUP_DAYS = 3;
const followupCutoff = () => new Date(Date.now() - FOLLOWUP_DAYS * 86_400_000).toISOString();

import { VERTICALS, NO_VERTICAL } from "./verticals.js";

export { VERTICALS, NO_VERTICAL };

// --- settings an admin chooses for the whole team ---------------------------

export const SETTINGS = "prospector_settings";
export const SETTING_DEFAULTS = {
  dm_include_non_shopify: false,
  // ISO country codes the queue keeps; empty means every country. "UNKNOWN"
  // stands for a brand with no country, which is most brands not on Shopify.
  dm_countries: [],
  // Which verticals the worker searches Instagram for each morning; empty
  // means its generic searches. Read by linkable-prospector's worker.
  search_verticals: [],
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
  if (key === "search_verticals") {
    if (!Array.isArray(value)) return "search_verticals must be a list of verticals";
    const bad = value.filter((v) => !(v in VERTICALS));
    return bad.length ? `not a vertical: ${bad.join(", ")}` : null;
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

// A creator call the brand has already closed ("CLOSED - ALL SPOTS HAVE BEEN
// FILLED", Modern Piggy, 29 Sep 2026): recent, so it sorted to the top, and
// nothing to offer. Phrases that close the call itself, not a bare "closed",
// which brands also write about shops and holidays. POSIX, so the same
// pattern runs in the query (imatch) and in isDmOpen.
export const CLOSED_CALL_RE = "(spots (have been|are|now) (filled|full)|all spots filled|"
  + "(applications|submissions|entries|call|casting|spots) (are |is |now |have |been )*closed|"
  + "closed for (applications|submissions|entries)|no longer accepting)";
const closedCallRe = new RegExp(CLOSED_CALL_RE, "i");
export const closedCall = (r) => Boolean(r.intent_caption && closedCallRe.test(r.intent_caption));

// Waiting to be written to on Instagram. The same predicate the counts use, so
// a count and the list it describes cannot disagree. Brands not on Shopify have
// no tier; they are in the queue only when an admin has said so.
export const dmOpen = (qy, { nonShopify, countries = [] }) => {
  // An agency or a platform posting other brands' calls is not a brand to pitch.
  // A brand whose creator call is weeks old has filled it; one with no dated
  // call (found another way) stays.
  const fresh = new Date(Date.now() - FRESH_CALL_DAYS * 86_400_000).toISOString();
  // A brand the pipeline has since rejected (too big, dead store) is never
  // offered, whatever tier it had when it was first published.
  let open = qy.in("dm_state", ["none", "drafted"]).is("pushed_at", null).neq("decision", "hide")
    .neq("status", "rejected")
    .not("is_agency", "is", true)
    .or(`intent_posted_at.is.null,intent_posted_at.gte."${fresh}"`)
    .or(`intent_caption.is.null,intent_caption.not.imatch."${CLOSED_CALL_RE}"`);
  open = nonShopify ? open.or("tier.not.is.null,status.eq.not_shopify") : open.not("tier", "is", null);
  open = open.or("tier.is.null,tier.neq.reject");
  if (!countries.length) return open;
  // Codes are validated on the way in (settingProblem), so they are safe to
  // put in the filter string.
  const codes = countries.filter((c) => c !== UNKNOWN_COUNTRY);
  if (!countries.includes(UNKNOWN_COUNTRY)) return open.in("country", codes.length ? codes : ["--"]);
  return codes.length ? open.or(`country.in.(${codes.join(",")}),country.is.null`) : open.is("country", null);
};

export const verticalOf = (r) => r.vertical_effective || r.vertical || r.vertical_ai || NO_VERTICAL;

// One person's working filter, not a team setting: "today I am doing beauty".
export function filterVerticals(qy, verticals) {
  const codes = (verticals || []).filter((v) => v in VERTICALS);
  if (!verticals?.length) return qy;
  if (!verticals.includes(NO_VERTICAL)) return qy.in("vertical_effective", codes.length ? codes : ["--"]);
  return codes.length
    ? qy.or(`vertical_effective.in.(${codes.join(",")}),vertical_effective.is.null`)
    : qy.is("vertical_effective", null);
}

// How a brand was found, grouped from linkable-prospector's source names (the
// `name` of each discovery source). An admin filters the queue by path to judge
// each one on its own leads. A source not listed here reads as OTHER_PATH, so a
// new one shows up under "Found another way" instead of vanishing.
export const PATHS = {
  linkable: { label: "Linkable creators post about them", sources: ["linkable_creators"] },
  gifted: { label: "Gifted posts", sources: ["gifted_posts"] },
  programme: { label: "Creator programme page", sources: ["program_pages"] },
  calls: { label: "Asked for creators", sources: ["feed", "creator_calls", "hashtag"] },
  tags: { label: "Tagged by creators", sources: ["creator_posts", "creator_following", "own_audience"] },
};
export const OTHER_PATH = "OTHER";
const KNOWN_SOURCES = Object.values(PATHS).flatMap((p) => p.sources);

export const pathOf = (r) => Object.keys(PATHS).find((k) => PATHS[k].sources.includes(r.source)) || OTHER_PATH;

export function filterPaths(qy, paths) {
  if (!paths?.length) return qy;
  const sources = paths.filter((p) => p in PATHS).flatMap((p) => PATHS[p].sources);
  if (!paths.includes(OTHER_PATH)) return qy.in("source", sources.length ? sources : ["--"]);
  const other = `source.is.null,source.not.in.(${KNOWN_SOURCES.join(",")})`;
  return qy.or(sources.length ? `source.in.(${sources.join(",")}),${other}` : other);
}

// The orders a person can pick. Each ends on handle, so paging through rows
// that tie on everything else neither repeats nor skips a brand.
const desc = { ascending: false, nullsFirst: false };
export const DM_SORTS = {
  score: { label: "Best chance first", apply: (qy) => todoOrder(qy) },
  newest: { label: "Newest found", apply: (qy) => qy.order("first_seen_at", desc) },
  posted: { label: "Most recent post", apply: (qy) => qy.order("intent_posted_at", desc) },
  proof: { label: "Most Linkable creators", apply: (qy) => todoOrder(qy.order("linkable_creator_count", desc)) },
  followers: { label: "Most followers", apply: (qy) => qy.order("ig_followers", desc) },
  small: { label: "Fewest followers", apply: (qy) => qy.order("ig_followers", { ascending: true, nullsFirst: false }) },
};
export const sortDm = (qy, sort) => DM_SORTS[sort].apply(qy).order("handle", { ascending: true });

export const countryOf = (r) => (r.country ? String(r.country).toUpperCase() : UNKNOWN_COUNTRY);

export const isDmOpen = (r, { nonShopify, countries = [] }) => ["none", "drafted"].includes(r.dm_state || "none")
  && !r.pushed_at && r.decision !== "hide" && r.status !== "rejected" && r.tier !== "reject"
  && r.is_agency !== true && !staleCall(r) && !closedCall(r)
  && Boolean(r.tier || (nonShopify && r.status === "not_shopify"))
  && (!countries.length || countries.includes(countryOf(r)));

// Conversion potential first (dm_priority, computed by linkable-prospector from
// who actually launched and paid on Linkable: market, vertical, offer fit,
// store, size, and how fresh the creator call is - see dm_reasons on the card).
// Then the most recent call, and for rows synced before either existed,
// brands that asked for creators in public.
export const todoOrder = (qy) => qy
  .order("dm_priority", { ascending: false, nullsFirst: false })
  .order("intent_posted_at", { ascending: false, nullsFirst: false })
  .order("intent_signal", { ascending: true, nullsFirst: false })
  .order("tier", { ascending: true, nullsFirst: false })
  .order("creator_activity_score", { ascending: false, nullsFirst: false });

// Queued for email but not yet handed over: it goes on the next tick unless it
// is DMed first, which takes it out of the email sequence.
export const emailQueued = (r) => r.decision === "send" && r.status === "routed" && !r.pushed_at
                                  && Boolean(r.contact_email);

// Sent, unanswered, older than FOLLOWUP_DAYS, not followed up yet.
export const followupDue = (qy) => qy.eq("dm_state", "sent").is("dm_followup_sent_at", null)
  .lt("dm_sent_at", followupCutoff());
export const isFollowupDue = (r) => r.dm_state === "sent" && !r.dm_followup_sent_at
  && r.dm_sent_at && r.dm_sent_at < followupCutoff();

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
export async function draftBatch({ handles = [], language, limit = DRAFT_BATCH, followUp = false } = {}) {
  const opts = await queueOptions();
  const base = supabase.from(TABLE).select(DM_COLUMNS);
  const size = Math.min(limit, DRAFT_BATCH);
  const query = followUp
    ? (handles.length
      ? followupDue(base).in("handle", handles.slice(0, DRAFT_BATCH))
      : followupDue(base.is("dm_followup_text", null)).order("dm_sent_at").limit(size))
    : handles.length
      ? dmOpen(base, opts).in("handle", handles.slice(0, DRAFT_BATCH))
      : todoOrder(dmOpen(base.is("dm_text", null), opts)).limit(size);
  const { data: leads, error } = await query;
  if (error) throw error;
  if (!leads?.length) return { drafted: [], failed: [], costUsd: 0 };

  const drafted = [];
  const failed = [];
  let costUsd = 0;
  const queue = [...leads];

  async function worker() {
    while (queue.length) {
      const lead = queue.shift();
      try {
        const out = await draftInstagramDm(lead, { language, followUp });
        costUsd += out.costUsd;
        const update = followUp
          ? { dm_followup_text: out.message }
          : {
            dm_text: out.message,
            dm_language: out.language,
            dm_variant: out.variant,
            dm_state: "drafted",
            dm_drafted_at: new Date().toISOString(),
          };
        const { data: saved, error: saveError } = await supabase
          .from(TABLE)
          .update(update)
          .eq("handle", lead.handle)
          // Not over a message somebody sent while this one was being written.
          .in("dm_state", followUp ? ["sent"] : ["none", "drafted"])
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
export async function draftAllMissing({ budgetMs = 45_000, followUp = false } = {}) {
  const started = Date.now();
  const totals = { drafted: 0, failed: 0, costUsd: 0, batches: 0 };
  while (Date.now() - started < budgetMs) {
    const out = await draftBatch({ followUp });
    totals.batches += 1;
    totals.drafted += out.drafted.length;
    totals.failed += out.failed.length;
    totals.costUsd = Math.round((totals.costUsd + out.costUsd) * 10000) / 10000;
    if (!out.drafted.length) break;
  }
  return totals;
}
