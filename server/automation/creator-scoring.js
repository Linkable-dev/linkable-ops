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
export function scoreCreator(p) {
  const followers = scoreFollowers(p.followers_count);
  const engagement = scoreEngagement(p.engagement_rate);
  const completeness = scoreCompleteness(p);
  const email = scoreEmail(p.email);

  const total = followers.points + engagement + completeness + email;
  const score = Math.max(0, Math.min(10, Math.round(total)));

  return {
    score,
    breakdown: {
      followers: followers.points,
      followers_tier: followers.tier,
      engagement,
      completeness,
      email,
    },
  };
}
