// Ranks the creator base against one campaign.
//
// "No applications" is one of the three quick filters on Campaign Operations,
// which means it is a known, common way for a campaign to die — and the only
// one the console could find but do nothing about. A brand that launches,
// waits and gets nobody churns at the end of the trial.
//
// Scoring runs in JS rather than SQL: the candidate set is the creator base
// (hundreds, not millions), and the weights are the part most likely to be
// argued about, so they are worth being able to read and test directly.

import { cloudSqlQuery } from "./cloudsql.js";

// Points available per signal. They sum to 100 so a score reads as a
// percentage of the best a creator could plausibly do for this campaign.
export const WEIGHTS = {
  niche: 35,       // brands and creators pick from the same vocabulary
  trackRecord: 25, // has this creator ever accepted, and ever sold
  audience: 20,    // reach, discounted for the dead-follower end of the range
  reachable: 10,   // can a sample physically get to them
  active: 10,      // have they opened the app recently
};

// brands.location is not a country — it is the pipe-separated list of ISO-2
// codes the brand ships to, sometimes hundreds long, with "*" for everywhere.
// Creators store a full country name. Comparing the two directly silently
// awards nothing on the 12 of 13 active campaigns that ship a sample.
export function parseShippingCountries(location) {
  const raw = String(location || "").toUpperCase();
  if (!raw.trim()) return null; // unknown, not "ships nowhere"
  if (raw.includes("*")) return "everywhere";
  const codes = new Set(raw.split(/[^A-Z]+/).filter((t) => t.length === 2));
  return codes.size ? codes : null;
}

// Covers every country present in the creator base, plus the markets the
// brands ship to most. An unmapped name scores as unknown rather than as a
// mismatch, so new data never quietly penalises a creator.
const ISO2 = {
  "UNITED KINGDOM": "GB", "GREAT BRITAIN": "GB", "ENGLAND": "GB", "SCOTLAND": "GB", "WALES": "GB",
  "UNITED STATES": "US", "UNITED STATES OF AMERICA": "US", "USA": "US",
  "UNITED ARAB EMIRATES": "AE", "AUSTRALIA": "AU", "CANADA": "CA", "IRELAND": "IE",
  "FRANCE": "FR", "GERMANY": "DE", "SPAIN": "ES", "ITALY": "IT", "PORTUGAL": "PT",
  "NETHERLANDS": "NL", "BELGIUM": "BE", "SWEDEN": "SE", "NORWAY": "NO", "DENMARK": "DK",
  "FINLAND": "FI", "POLAND": "PL", "AUSTRIA": "AT", "SWITZERLAND": "CH", "GREECE": "GR",
  "INDIA": "IN", "BANGLADESH": "BD", "PAKISTAN": "PK", "PHILIPPINES": "PH", "BRAZIL": "BR",
  "AFGHANISTAN": "AF", "MEXICO": "MX", "JAPAN": "JP", "SINGAPORE": "SG", "NEW ZEALAND": "NZ",
  "SOUTH AFRICA": "ZA", "NIGERIA": "NG", "ISRAEL": "IL", "TURKEY": "TR",
};

export function countryToIso(name) {
  const v = String(name || "").trim().toUpperCase();
  if (!v) return null;
  if (/^[A-Z]{2}$/.test(v)) return v; // some rows already hold the code
  return ISO2[v] || null;
}

const num = (v) => {
  const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

// Mid-tier creators convert best: big enough to matter, small enough to reply.
// Full marks from 5k to 250k, tapering either side rather than cutting off.
export function audienceScore(followers, engagementRate) {
  const f = num(followers);
  if (!f) return 0;
  let reach;
  if (f < 1000) reach = 0.2;
  else if (f < 5000) reach = 0.6;
  else if (f <= 250_000) reach = 1;
  else if (f <= 1_000_000) reach = 0.7;
  else reach = 0.45; // huge accounts rarely take a sample-for-commission deal
  // Engagement is the honesty check on reach. Missing data is treated as
  // average rather than as zero, or every creator without an analytics record
  // would be buried regardless of fit.
  const er = num(engagementRate);
  const engagement = er <= 0 ? 0.75 : er >= 6 ? 1 : 0.5 + (er / 6) * 0.5;
  return WEIGHTS.audience * reach * engagement;
}

export function scoreCreator(c, campaign) {
  const reasons = [];
  let score = 0;

  const creatorNiche = (c.niche || "").trim().toUpperCase();
  const brandNiche = (campaign.brandNiche || "").trim().toUpperCase();
  if (creatorNiche && brandNiche && creatorNiche === brandNiche) {
    score += WEIGHTS.niche;
    reasons.push(`Same niche as the brand (${creatorNiche.toLowerCase().replace(/_/g, " ")})`);
  } else if (creatorNiche && !brandNiche) {
    // The brand never set a niche, so this signal cannot be judged either way.
    // Award the midpoint instead of punishing every creator for it.
    score += WEIGHTS.niche / 2;
    reasons.push("Brand has no niche set, so niche fit is unknown");
  }

  const accepted = num(c.accepted_campaigns);
  const sales = num(c.sales);
  if (sales > 0) {
    score += WEIGHTS.trackRecord;
    reasons.push(`Has driven ${sales} sale${sales === 1 ? "" : "s"} on Linkable`);
  } else if (accepted > 0) {
    score += WEIGHTS.trackRecord * 0.5;
    reasons.push(`Accepted ${accepted} campaign${accepted === 1 ? "" : "s"} before`);
  }

  const aud = audienceScore(c.followers, c.engagement_rate);
  score += aud;
  if (num(c.followers)) {
    reasons.push(`${Math.round(num(c.followers)).toLocaleString()} followers${num(c.engagement_rate) ? ` at ${num(c.engagement_rate).toFixed(1)}% engagement` : ""}`);
  }

  // Only worth scoring when there is a physical sample to post.
  if (campaign.shipping) {
    const iso = countryToIso(c.country);
    const ships = campaign.shipsTo;
    if (!ships || !iso) {
      // Either the brand never set a shipping list or we cannot place the
      // creator. Unknown, so award the midpoint rather than guessing.
      score += WEIGHTS.reachable / 2;
    } else if (ships === "everywhere" || ships.has(iso)) {
      score += WEIGHTS.reachable;
      reasons.push(`The brand ships to ${c.country}`);
    } else {
      reasons.push(`The brand does not ship to ${c.country} — they cannot receive a sample`);
    }
  } else {
    // Nothing to post, so nobody is unreachable.
    score += WEIGHTS.reachable;
  }

  const days = c.last_sign_in ? (Date.now() - new Date(c.last_sign_in).getTime()) / 86_400_000 : null;
  if (days == null) {
    reasons.push("Has never signed in");
  } else if (days <= 30) {
    score += WEIGHTS.active;
    reasons.push(days < 1 ? "Signed in today" : `Signed in ${Math.round(days)} days ago`);
  } else if (days <= 90) {
    score += WEIGHTS.active * 0.5;
    reasons.push(`Last signed in ${Math.round(days)} days ago`);
  } else {
    reasons.push(`Dormant — last signed in ${Math.round(days)} days ago`);
  }

  return { score: Math.round(score), reasons };
}

const ND = (a) => `${a}.deleted = '-infinity'::timestamptz`;

// Everything the scorer needs, in two queries: the campaign and its brand, then
// every creator not already attached to that campaign.
export async function creatorMatches(productId, { limit = 25 } = {}) {
  const { rows: campaigns } = await cloudSqlQuery(`
    SELECT p.id, p.title, p.status, p.shipping, p.sale_commission,
           u.id AS brand_user_id, b.store_name, b.niche AS brand_niche,
           COALESCE(NULLIF(TRIM(b.location), ''), '') AS brand_location
    FROM products p
    JOIN users u ON u.id = p.user_id
    JOIN brands b ON b.user_id = u.id
    WHERE p.id = $1 AND ${ND("p")}`, [productId]);
  const campaign = campaigns[0];
  if (!campaign) return null;

  const { rows: creators } = await cloudSqlQuery(`
    SELECT i.user_id,
           COALESCE(NULLIF(TRIM(COALESCE(i.first_name,'') || ' ' || COALESCE(i.last_name,'')), ''),
                    i.instagram_name, i.instagram_username, 'Unknown creator') AS name,
           i.instagram_username AS handle,
           i.instagram_followers_count AS followers,
           i.instagram_engagement_rate AS engagement_rate,
           NULLIF(TRIM(i.niche), '') AS niche,
           COALESCE(NULLIF(TRIM(i.country), ''), NULLIF(TRIM(i.location_country), '')) AS country,
           sig.last_sign_in,
           COALESCE(hist.accepted_campaigns, 0) AS accepted_campaigns,
           COALESCE(hist.sales, 0) AS sales
    FROM influencers i
    LEFT JOIN LATERAL (
      SELECT MAX(t.created) AS last_sign_in FROM tokens t
      WHERE t.email = (SELECT email FROM users WHERE id = i.user_id)
        AND (t.state IS NULL OR t.state NOT LIKE 'admin_impersonation:%')
    ) sig ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT l.product_id) FILTER (WHERE l.status = 3) AS accepted_campaigns,
             (SELECT COUNT(*) FROM orders o
                JOIN links l2 ON l2.id = o.link_id
               WHERE l2.influencer_user_id = i.user_id AND ${ND("o")} AND ${ND("l2")}) AS sales
      FROM links l WHERE l.influencer_user_id = i.user_id AND ${ND("l")}
    ) hist ON true
    WHERE ${ND("i")}
      -- Never suggest somebody already on this campaign, whatever came of it.
      AND NOT EXISTS (
        SELECT 1 FROM links l WHERE l.product_id = $1
          AND l.influencer_user_id = i.user_id AND ${ND("l")})`, [productId]);

  const ctx = {
    shipping: campaign.shipping === true,
    brandNiche: campaign.brand_niche,
    shipsTo: parseShippingCountries(campaign.brand_location),
  };

  const ranked = creators
    .map((c) => ({ ...c, ...scoreCreator(c, ctx) }))
    .sort((a, b) => b.score - a.score || num(b.followers) - num(a.followers))
    .slice(0, limit)
    .map((c) => ({
      user_id: c.user_id,
      name: c.name,
      handle: c.handle,
      followers: num(c.followers),
      engagement_rate: num(c.engagement_rate) || null,
      niche: c.niche,
      country: c.country,
      accepted_campaigns: num(c.accepted_campaigns),
      sales: num(c.sales),
      last_sign_in: c.last_sign_in,
      score: c.score,
      reasons: c.reasons,
    }));

  return {
    campaign: {
      id: campaign.id,
      title: campaign.title,
      shipping: campaign.shipping === true,
      brand: { user_id: campaign.brand_user_id, store_name: campaign.store_name },
      brand_niche: campaign.brand_niche || null,
      // The raw field is a several-thousand-character code list; the client
      // only needs to know how wide the brand's shipping reach is.
      ships_to: (() => {
        const p2 = parseShippingCountries(campaign.brand_location);
        return p2 === "everywhere" ? "everywhere" : p2 ? p2.size : null;
      })(),
    },
    pool: creators.length,
    matches: ranked,
  };
}
