// AI-powered observation + variable rendering for creator (influencer)
// outbound. Mirrors personalize.js (brand) but the prompt and fallbacks are
// shaped for creators — references niche / handle / scale instead of a
// product line, and signs off in the same Federico voice.
//
// Reuses renderTemplate / validateRenderedEmail from personalize.js so
// validation stays consistent across audiences.

import { isGenericLocal } from "./lead-discovery.js";
import { formatFollowersBand } from "./creator-groups.js";
export { renderTemplate, validateRenderedEmail } from "./personalize.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

// Greeting safety. Same belt-and-suspenders as the brand sequencer — a
// junk first_name should never land in the email body.
export function safeFirstName(name) {
  if (!name) return "there";
  const first = name.trim().split(/\s+/)[0] || "";
  if (first.length < 2) return "there";
  if (isGenericLocal(first.toLowerCase())) return "there";
  return first;
}

// Build the {{handle}} placeholder. Prefer @username, fall back to display
// name, then first name, then "there". An @ prefix only attaches to a
// real handle so the email never reads "@there".
export function resolveHandle(creator, firstName) {
  if (creator?.instagram_username) return `@${creator.instagram_username}`;
  if (creator?.instagram_name) return creator.instagram_name;
  if (firstName && firstName !== "there") return firstName;
  return "there";
}

// Build the {{niche}} placeholder. Falls back to "your niche" so the
// rendered sentence reads naturally even when the source row is sparse.
export function resolveNiche(creator) {
  const n = (creator?.niche || "").trim();
  return n || "your niche";
}

// Variables shipped to renderTemplate per creator. Pinned at enrollment
// time so all 4 touches use the same values — drift would change subject
// lines mid-thread.
export function buildCreatorVariables(creator, observation) {
  const firstName = safeFirstName(creator?.first_name);
  return {
    firstName,
    handle: resolveHandle(creator, firstName),
    niche: resolveNiche(creator),
    followersBand: formatFollowersBand(creator?.followers_count),
    observation: observation || "",
  };
}

// Generate a per-creator observation via Claude Haiku. Mirrors the brand
// version's contract: 15-30 words, single sentence, references one concrete
// thing from context. Falls back to a niche-aware sentence when context is
// thin or the API is unreachable — never returns "NEEDS_REVIEW".
export async function generateCreatorObservation(creator, apiKey) {
  if (!apiKey) return fallbackObservation(creator);

  const handle = creator.instagram_username
    ? `@${creator.instagram_username}`
    : (creator.instagram_name || creator.first_name || "creator");
  const followers = formatFollowersBand(creator.followers_count);
  const engagement = Number.isFinite(Number(creator.engagement_rate))
    ? `${(Number(creator.engagement_rate) * 100).toFixed(1)}%`
    : "unknown";

  const context = `Creator handle: ${handle}
Display name: ${creator.instagram_name || "unknown"}
Niche: ${creator.niche || "unknown"}
Followers: ${followers}
Engagement rate: ${engagement}
Country: ${creator.country || "unknown"}
City: ${creator.city || "unknown"}`;

  const prompt = `You are writing the 1-sentence opener of a cold email to a creator. We are Linkable — a platform where brands find and pay creators based on conversion performance instead of follower count.

${context}

The opener has one job: prove a human looked at this creator's profile for 30 seconds. Reference ONE specific thing from the context — their niche, their scale (mid/macro/micro), their geography, or the engagement-vs-followers ratio. Generic warmth reads as automation and kills reply rates.

Hard rules:
- 15-30 words, ONE sentence
- Never start with: "I came across", "I noticed", "I was browsing", "I saw", "I just found", "Just stumbled on", "Hope this finds you well", "Hope you're well"
- Never use the words: "amazing", "incredible", "awesome", "love your content", "love what you're doing", "great work", "really impressive"
- Never compliment vaguely ("your profile is great") — only reference concrete details from the context
- Do NOT pitch the platform — that comes later in the email
- Do NOT mention the exact follower count — refer to scale (mid-tier, macro, micro) instead
- If the context above contains nothing specific enough to reference (no niche, no engagement rate, no geography), output exactly: NEEDS_REVIEW

Output the one sentence and nothing else. No preamble. No quotes.`;

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 150,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      console.error("Claude API error (creator):", res.status, await res.text());
      return fallbackObservation(creator);
    }

    const data = await res.json();
    const text = data.content?.[0]?.text?.trim();
    if (!text || /^NEEDS_REVIEW\b/i.test(text)) return fallbackObservation(creator);
    return text;
  } catch (err) {
    console.error("Claude API error (creator):", err.message);
    return fallbackObservation(creator);
  }
}

// Fallback when context is too thin or Claude is unreachable. Lead with a
// niche- or scale-aware framing — never a generic compliment.
function fallbackObservation(creator) {
  const niche = (creator?.niche || "").trim();
  const followers = Number(creator?.followers_count) || 0;
  const engagement = Number(creator?.engagement_rate) || 0;

  if (engagement >= 0.05 && niche) {
    return `Your engagement rate in ${niche} is well above the platform median, which is exactly the signal brands pay extra for on Linkable.`;
  }
  if (niche && followers > 0) {
    return `Mid-to-macro creators in ${niche} are the sweet spot for the brands actively hiring on Linkable right now.`;
  }
  if (niche) {
    return `Brands in ${niche} consistently undervalue creators who actually convert — Linkable surfaces that signal directly.`;
  }
  if (followers >= 200_000) {
    return `Macro creators usually get pitched on follower count alone — Linkable matches you on conversion data instead, which usually pays better.`;
  }
  if (followers >= 10_000) {
    return `Mid-tier creators tend to outperform macros on conversion — that's the gap Linkable surfaces to brands so the offer reflects what you actually deliver.`;
  }
  return `Brands on Linkable often pay micro creators more than macros because the conversion math actually works — happy to show you how it lands for your account.`;
}
