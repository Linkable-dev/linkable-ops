// ICP scoring for creator_prospects. Score range 0-10 — the orchestrator
// gates enrollment at MIN_SEND_SCORE so low-quality creators never make it
// into the daily pull.
//
// Components (max points in parentheses):
//   - followers band (4) — sweet spot is mid-tier (10k-200k); micro and mega
//     both score lower because the cold-email pitch lands worst at extremes
//   - engagement rate (3) — meaningful audience > raw follower count
//   - profile completeness (2) — first_name + handle + niche + country
//     tells us we can render a non-generic email
//   - email quality (1) — non-disposable, real-looking address
//
// Tune from real reply-rate data once we have ≥200 sends — the breakdown
// JSONB column is there so we can correlate `creator_score_breakdown.followers`
// against reply rate per-component.

export const MIN_SEND_SCORE = 6;

// Disposable / suspicious mailbox providers. Best-effort — the goal isn't
// to be exhaustive, just to drop the obvious junk so we don't burn sender
// reputation on @mailinator.com style addresses.
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "trashmail.com",
  "yopmail.com", "tempmail.com", "throwaway.email", "fakeinbox.com",
  "maildrop.cc", "sharklasers.com", "getnada.com", "discard.email",
]);

function scoreFollowers(n) {
  if (!Number.isFinite(n) || n <= 0) return { points: 0, tier: "unknown" };
  // Sweet spot weighting: micro reads as warm but is hard to monetize for
  // brands; mega is press-magnet but low conversion. Mid wins.
  if (n >= 10_000 && n <= 200_000) return { points: 4, tier: "mid" };
  if (n > 200_000 && n <= 1_000_000) return { points: 3, tier: "macro" };
  if (n >= 2_000 && n < 10_000) return { points: 2, tier: "micro" };
  if (n > 1_000_000) return { points: 2, tier: "mega" };
  return { points: 1, tier: "nano" };
}

function scoreEngagement(rate) {
  // Engagement is reported as a fraction in main-app (0.0345 = 3.45%).
  // Industry baseline for IG is ~1-3%; >3% is strong signal.
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  if (rate >= 0.05) return 3;     // 5%+
  if (rate >= 0.03) return 2;     // 3-5%
  if (rate >= 0.01) return 1;     // 1-3%
  return 0;
}

function scoreCompleteness(p) {
  let pts = 0;
  if (p.first_name) pts += 0.5;
  if (p.instagram_username || p.instagram_name) pts += 0.5;
  if (p.niche) pts += 0.5;
  if (p.country) pts += 0.5;
  return pts;   // max 2
}

function scoreEmail(email) {
  if (!email) return 0;
  const e = email.toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return 0;
  const domain = e.split("@")[1] || "";
  if (DISPOSABLE_DOMAINS.has(domain)) return 0;
  return 1;
}

// Returns { score, breakdown } where score is rounded to a SMALLINT and
// breakdown captures the per-component points for downstream tuning.
//
// Source-aware: bio-mined creators (Linktree / Beacons / similar) don't
// carry follower or engagement data, so the standard formula would always
// score them below the gate and the scraper would produce zero enrollable
// rows. We branch on source so bio-mined rows are scored on what we *do*
// have (email validity + bio completeness) and can clear MIN_SEND_SCORE
// when the basics are present. The breakdown JSONB always records which
// path scored the row (`mode: 'standard'|'bio_mined'`) so we can compare
// reply rates per source later.
export function scoreCreator(p) {
  const source = p.source || (p.raw_data && p.raw_data.provider) || null;
  // CSV uploads often carry only email + name + handle. When follower data
  // is missing the standard formula can never clear MIN_SEND_SCORE, so those
  // rows score on the completeness path like bio-mined creators do.
  const isBioMined = source === "bio_mining" ||
    (source === "csv" && !Number.isFinite(Number(p.followers_count)));

  if (isBioMined) {
    return scoreBioMinedCreator(p);
  }

  const followers = scoreFollowers(p.followers_count);
  const engagement = scoreEngagement(p.engagement_rate);
  const completeness = scoreCompleteness(p);
  const email = scoreEmail(p.email);

  const total = followers.points + engagement + completeness + email;
  const score = Math.max(0, Math.min(10, Math.round(total)));

  return {
    score,
    breakdown: {
      mode: "standard",
      followers: followers.points,
      followers_tier: followers.tier,
      engagement,
      completeness,
      email,
    },
  };
}

// Bio-mined scoring: no follower / engagement signal available. Score is
// driven by email validity (gate) + completeness of the data we did extract
// (first_name, niche, IG handle, geo). A complete bio-mined row scores 8;
// the absolute floor is 0 (invalid email = hard reject). 6 is the soft
// floor that just-passes MIN_SEND_SCORE, achieved with valid email +
// first_name + niche.
function scoreBioMinedCreator(p) {
  const email = scoreEmail(p.email);
  if (email === 0) {
    return { score: 0, breakdown: { mode: "bio_mined", email: 0, reason: "invalid_email" } };
  }

  let s = 3;                                  // valid email = baseline 3
  let firstName = 0, niche = 0, handle = 0, geo = 0;
  if (p.first_name)         { firstName = 1.5; s += firstName; }
  if (p.niche)              { niche     = 1.5; s += niche; }
  if (p.instagram_username) { handle    = 1;   s += handle; }
  if (p.country || p.city)  { geo       = 1;   s += geo; }

  const score = Math.max(0, Math.min(10, Math.round(s)));
  return {
    score,
    breakdown: {
      mode: "bio_mined",
      email,
      first_name: firstName,
      niche,
      instagram_handle: handle,
      geo,
    },
  };
}
