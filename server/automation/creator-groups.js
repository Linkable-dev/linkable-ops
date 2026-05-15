// Creator-tier classifier for the influencer outbound sequencer.
// Three tiers, deterministic from follower count:
//   C1 — Macro    (200k+)        formal / respect their time / business pitch
//   C2 — Mid      (10k–200k)     warm / specific value / collab framing
//   C3 — Micro    (<10k)         community / hands-on / partnership framing
//
// The pitch *type* (creator-acquisition / brand-collab / re-activation) is
// owned per-campaign — a campaign defines which pitch its templates use,
// and the tier scales the language register inside that pitch. So one
// campaign's C1-T1 differs from another campaign's C1-T1, but both speak
// macro-creator language.

import { scoreCreator } from "./creator-scoring.js";

export const TIERS = {
  C1: "C1",   // Macro
  C2: "C2",   // Mid
  C3: "C3",   // Micro
};

// Daily volume mix. Most outbound value lives in mid-tier — they convert
// best for brand-side outcomes and reply rate is highest there. Macro
// gets a small slice (high effort per reply, but high LTV when it lands)
// and micro fills the long tail.
export const DAILY_MIX = {
  C2: 0.55,
  C3: 0.30,
  C1: 0.15,
};

const FOLLOWER_THRESHOLDS = {
  MACRO: 200_000,
  MID: 10_000,
};

// Classify a creator into C1/C2/C3 by follower count. Falls through to
// the scoring tier when followers_count is missing (sparse main-app row).
export function classifyCreator(creator) {
  if (!creator) return TIERS.C3;
  const n = Number(creator.followers_count);
  if (Number.isFinite(n) && n > 0) {
    if (n >= FOLLOWER_THRESHOLDS.MACRO) return TIERS.C1;
    if (n >= FOLLOWER_THRESHOLDS.MID) return TIERS.C2;
    return TIERS.C3;
  }
  // Fall back to the scoring tier label (mid/macro/micro/...) so we still
  // return *some* group rather than dumping every unknown into C3.
  const { breakdown } = scoreCreator(creator);
  if (breakdown.followers_tier === "macro" || breakdown.followers_tier === "mega") return TIERS.C1;
  if (breakdown.followers_tier === "mid") return TIERS.C2;
  return TIERS.C3;
}

// Allocate a daily quota to each tier given a total daily cap.
// Returns { C1, C2, C3 } summing to total.
export function allocateDailyQuota(total) {
  const c2 = Math.floor(total * DAILY_MIX.C2);
  const c3 = Math.floor(total * DAILY_MIX.C3);
  const c1 = total - c2 - c3;
  return { C1: c1, C2: c2, C3: c3 };
}

// Format follower count for the {{followersBand}} placeholder. e.g.
// 12340 → "12K", 1_240_000 → "1.2M". Used in templates so we can name the
// creator's scale without revealing the exact number (which would feel
// like surveillance).
export function formatFollowersBand(n) {
  if (!Number.isFinite(Number(n))) return "growing";
  const v = Number(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}K`;
  return `${v}`;
}
