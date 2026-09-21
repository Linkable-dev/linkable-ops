// Creator discovery against Influencers Club.
//
// A deliberately small mirror of the Go runner in
// service-grpc/clients/influencers_club_discovery.go, which stays the
// authority on this API. Everything here matches its vocabulary on purpose -
// the filter names, the policy defaults, the engagement ceiling - because two
// systems talking to the same provider with different rules is how you end up
// with two different definitions of a good creator.
//
// Costs, from the provider's published rates:
//   discovery  0.01 credits per creator RETURNED
//
// So a 50-creator search costs about half a credit. That is cheap enough to
// run often and not cheap enough to run by accident, which is why planning a
// search and running one are two separate calls.

const BASE = "https://api-dashboard.influencers.club";
const DISCOVERY_PATH = "/public/v1/discovery/";
const LOCATIONS_PATH = "/public/v1/discovery/classifier/locations/instagram/";
const CREDITS_PER_CREATOR = 0.01;

// Policy rather than planning, so the model never gets to choose it: a private
// account cannot be worked with, a dormant one will not reply, and the brief is
// creators rather than businesses. Filtering businesses out at search time is
// free; discovering the same from an enriched profile costs 0.2 credits a head
// for somebody we then throw away.
const ACCOUNT_TYPE = "creator";
const LAST_POST_WITHIN_DAYS = "365";

// Engagement above this is not a great creator, it is a bought one. The Go
// runner found UK accounts at 24-30% on 10-24k followers; that does not happen
// organically at that size, and results are ordered by engagement, so without a
// ceiling the least authentic accounts sort to the top of the list.
const ENGAGEMENT_CEILING = 20.0;

export function discoveryKey() {
  // The dedicated sourcing key first, so its credit burn is tracked apart from
  // enrichment's - same precedence as the Go runner.
  return (process.env.INFLUENCERS_CLUB_SOURCING_API_KEY || "").trim()
    || (process.env.INFLUENCERS_CLUB_API_KEY || "").trim();
}

// The planner's vocabulary meets the provider's here and nowhere else.
export function buildFilters(query) {
  const f = {};
  const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);

  if (list(query.bio_keywords).length) f.keywords_in_bio = list(query.bio_keywords);
  if (list(query.caption_keywords).length) f.keywords_in_captions = list(query.caption_keywords);
  if (query.ai_search) f.ai_search = query.ai_search;
  if (list(query.excluded_keywords).length) f.exclude_keywords_in_bio = list(query.excluded_keywords);
  if (list(query.languages).length) f.profile_language = list(query.languages);
  if (query.gender && query.gender !== "any") f.gender = query.gender;
  if (typeof query.promotes_affiliate_links === "boolean") {
    f.promotes_affiliate_links = query.promotes_affiliate_links;
  }
  if (typeof query.has_done_brand_deals === "boolean") {
    f.has_done_brand_deals = query.has_done_brand_deals;
  }

  const followers = {};
  if (query.followers_min > 0) followers.min = query.followers_min;
  if (query.followers_max > 0) followers.max = query.followers_max;
  if (Object.keys(followers).length) f.number_of_followers = followers;

  const engagement = { max: ENGAGEMENT_CEILING };
  if (query.engagement_min > 0) engagement.min = query.engagement_min;
  f.engagement_percent = engagement;

  f.exclude_private_profile = true;
  f.last_post = LAST_POST_WITHIN_DAYS;
  f.type = ACCOUNT_TYPE;

  // The provider's location filter takes plain display names verbatim -
  // "United Kingdom" - with no ids and no ISO codes, so the plan carries names.
  if (list(query.locations).length) f.location = list(query.locations);
  return f;
}

// The provider's location filter takes display names from its own dictionary,
// verbatim. A name that is not in it is not a narrower search, it is a broken
// one - and the model will happily produce "UK", "England" and "Scotland" for a
// brief that said United Kingdom. So names are checked against the dictionary
// and the rejects are reported rather than silently sent.
let locationCache = null;

export async function locationDictionary() {
  if (locationCache) return locationCache;
  const key = discoveryKey();
  if (!key) throw new Error("INFLUENCERS_CLUB_SOURCING_API_KEY is not set");
  const resp = await fetch(BASE + LOCATIONS_PATH, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!resp.ok) throw new Error(`locations returned ${resp.status}`);
  const names = await resp.json();
  // Keyed upper-case so a lookup survives the provider changing its
  // capitalisation; the value is the name exactly as it must be sent.
  locationCache = new Map(
    (Array.isArray(names) ? names : []).map((n) => [String(n).trim().toUpperCase(), String(n).trim()])
  );
  return locationCache;
}

export async function resolveLocations(names) {
  const wanted = (names || []).map((n) => String(n).trim()).filter(Boolean);
  if (!wanted.length) return { locations: [], dropped: [] };
  const dict = await locationDictionary();
  const locations = [];
  const dropped = [];
  for (const name of wanted) {
    const hit = dict.get(name.toUpperCase());
    if (hit && !locations.includes(hit)) locations.push(hit);
    else if (!hit) dropped.push(name);
  }
  return { locations, dropped };
}

export async function discover(query, limit) {
  const key = discoveryKey();
  if (!key) throw new Error("INFLUENCERS_CLUB_SOURCING_API_KEY is not set");

  // Resolved before the search so an unknown name cannot quietly widen it.
  const { locations, dropped } = await resolveLocations(query.locations);
  const filters = buildFilters({ ...query, locations });
  const resp = await fetch(BASE + DISCOVERY_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      platform: "instagram",
      filters,
      // The provider rejects a request without paging, and pages are
      // zero-indexed. Relevancy is its own ranking: paging deeper costs the
      // same per creator, so the best guesses want to be on the first page.
      paging: { limit, page: 0 },
      sort: { sort_by: "relevancy", sort_order: "desc" },
    }),
  });

  const raw = await resp.text();
  if (!resp.ok) {
    throw new Error(`provider returned ${resp.status}: ${raw.slice(0, 300)}`);
  }
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error("provider returned non-JSON"); }

  const rows = payload.accounts || [];
  return {
    filters,
    droppedLocations: dropped,
    creators: rows.map(normalise).filter((c) => c.handle),
    // The provider's own number, not ours. It bills per account RETURNED, and
    // guessing at that from the row count would be wrong the moment it changes
    // its mind about what counts.
    creditsSpent: Number(payload.credits_cost ?? rows.length * CREDITS_PER_CREATOR),
    creditsLeft: payload.credits_left ?? null,
    total: payload.total ?? rows.length,
  };
}

function normalise(account) {
  const p = account.profile || {};
  return {
    handle: String(p.username || "").replace(/^@/, "").trim().toLowerCase(),
    full_name: p.full_name || null,
    followers: p.followers ?? null,
    engagement: p.engagement_percent ?? null,
    picture: p.picture || null,
    // Discovery does not return an email. Getting one is a separate, dearer
    // call (0.2 credits a head) and is not done here: a search is for deciding
    // whether a list is worth enriching at all.
    email: null,
  };
}

export const COSTS = { CREDITS_PER_CREATOR, ENGAGEMENT_CEILING };
