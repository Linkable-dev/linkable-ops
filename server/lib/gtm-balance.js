import { cloudSqlQuery } from "./cloudsql.js";
import { supabase } from "./supabase.js";
import { VERTICALS } from "./verticals.js";

// The balance between the two sides of the marketplace, from the product's
// own database: creators who finished signing up against campaigns that are
// live, and how many of those campaigns are still short of creators. It
// decides where automatic first contact goes: to brands while creators are
// plentiful, and it pauses the brand emails when campaigns start running
// short, because bringing in more brands then would only add campaigns
// nobody applies to. Stored once a day (cron) for linkable-prospector's
// worker, which reads prospector_settings at every tick.

export const BALANCE_KEY = "gtm_balance";
// A live campaign has enough creators at this many applied or accepted.
export const ENOUGH_CREATORS = 5;
// Creators are the short side when more than this share of the live
// campaigns (three days old or more) is still below ENOUGH_CREATORS.
export const SHORT_SHARE = 0.5;

const TOTALS_SQL = `
  WITH creators AS (
    SELECT i.user_id, i.niche FROM influencers i JOIN users u ON u.id = i.user_id
     WHERE i.deleted = '-infinity' AND u.deleted = 'infinity' AND u.role = 3 AND u.status = 7
       AND i.disqualified_at IS NULL),
  live AS (
    SELECT p.id, p.created, b.niche,
           (SELECT count(*) FROM links l WHERE l.product_id = p.id AND l.deleted = '-infinity' AND l.status IN (2, 3)) AS taken,
           (SELECT count(*) FROM links l WHERE l.product_id = p.id AND l.deleted = '-infinity' AND l.status = 2) AS waiting
      FROM products p
      JOIN brands b ON b.id = p.brand_id AND b.deleted = '-infinity'
      JOIN users bu ON bu.id = b.user_id AND bu.deleted = 'infinity'
     WHERE p.deleted = '-infinity' AND p.status = 2 AND p.external_call_id IS NULL),
  by_creator AS (
    SELECT trim(n) AS niche, count(*)::int AS creators
      FROM creators c, unnest(string_to_array(coalesce(c.niche, ''), '|')) AS n
     WHERE trim(n) <> '' GROUP BY 1),
  by_campaign AS (
    SELECT trim(n) AS niche, count(*)::int AS campaigns,
           count(*) FILTER (WHERE taken < $1 AND created < now() - interval '3 days')::int AS short,
           coalesce(sum(waiting), 0)::int AS waiting
      FROM live l, unnest(string_to_array(coalesce(l.niche, ''), '|')) AS n
     WHERE trim(n) <> '' GROUP BY 1)
  SELECT
    (SELECT count(*)::int FROM creators) AS creators,
    (SELECT count(*)::int FROM live) AS campaigns,
    (SELECT count(*)::int FROM live WHERE created < now() - interval '3 days') AS settled,
    (SELECT count(*)::int FROM live WHERE taken < $1 AND created < now() - interval '3 days') AS short,
    (SELECT coalesce(sum(waiting), 0)::int FROM live) AS waiting,
    (SELECT coalesce(json_agg(json_build_object(
              'niche', coalesce(c.niche, k.niche), 'creators', coalesce(c.creators, 0),
              'campaigns', coalesce(k.campaigns, 0), 'short', coalesce(k.short, 0),
              'waiting', coalesce(k.waiting, 0))
            ORDER BY coalesce(c.creators, 0) DESC), '[]'::json)
       FROM by_creator c FULL JOIN by_campaign k ON k.niche = c.niche) AS niches`;

// Which side is short, and the sentence the ops page shows. Pure.
export function balanceVerdict({ creators = 0, campaigns = 0, settled = 0, short = 0 } = {}) {
  if (settled > 0 && short / settled > SHORT_SHARE) {
    return {
      short_side: "creators",
      line: `${short} of ${settled} live campaigns have fewer than ${ENOUGH_CREATORS} creators, so creators are the short side. Automatic brand emails pause; Autopilot keeps finding creators for each campaign.`,
    };
  }
  return {
    short_side: "brands",
    line: campaigns > 0
      ? `${creators.toLocaleString("en-GB")} creators for ${campaigns} live ${campaigns === 1 ? "campaign" : "campaigns"}, so brands are the short side. Automatic first contact goes to brands.`
      : `${creators.toLocaleString("en-GB")} creators and no live campaign, so brands are the short side. Automatic first contact goes to brands.`,
  };
}

// The categories where creators wait and no campaign is live: the brands to
// reach first. Largest three, and only a category with a real pool. Pure.
export function openCategories(niches, { minCreators = 50, limit = 3 } = {}) {
  return (niches || [])
    .filter((n) => n.campaigns === 0 && n.creators >= minCreators)
    .sort((a, b) => b.creators - a.creators)
    .slice(0, limit)
    .map((n) => ({ niche: n.niche, label: n.label || n.niche, creators: n.creators }));
}

// Always production: the balance of the real marketplace, whatever database
// the header is on.
export async function computeBalance({ query = cloudSqlQuery } = {}) {
  const { rows } = await query(TOTALS_SQL, [ENOUGH_CREATORS], "prod");
  const r = rows[0] || {};
  const totals = {
    creators: r.creators || 0, campaigns: r.campaigns || 0, settled: r.settled || 0,
    short: r.short || 0, waiting: r.waiting || 0,
  };
  const niches = (r.niches || []).slice(0, 12).map((n) => ({ ...n, label: VERTICALS[n.niche] || n.niche }));
  return { ...totals, ...balanceVerdict(totals), niches, open: openCategories(niches), at: new Date().toISOString() };
}

// Computes it and keeps it where the worker reads. Returns what was stored.
export async function refreshBalance(deps = {}) {
  const balance = await computeBalance(deps);
  const db = deps.supabase || supabase;
  const { error } = await db.from("prospector_settings").upsert(
    { key: BALANCE_KEY, value: balance, updated_at: balance.at, updated_by: "balance" },
    { onConflict: "key" },
  );
  return { ...balance, stored: !error, ...(error ? { store_error: error.message } : {}) };
}
