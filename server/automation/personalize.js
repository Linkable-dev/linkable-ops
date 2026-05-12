// AI-powered email personalization using Claude API
// Uses scraped brand context for truly personalized observations

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

export async function generateObservation(brand, apiKey) {
  const name = brand.storeName || brand.name || brand.domain;
  const bi = brand.brandInfo || {};

  // Build context from all available brand data
  let context = `Brand: ${name}
Domain: ${brand.domain}
Product types: ${(brand.sampleTypes || brand.matchedKeywords || []).join(", ") || "unknown"}
Product count: ${brand.productCount || "unknown"}
Country: ${brand.country || "unknown"}`;

  if (bi.brandStory) context += `\nDescription: ${bi.brandStory}`;
  if (bi.usp) context += `\nUSP: ${bi.usp}`;
  if (bi.founderName) context += `\nFounder: ${bi.founderName}`;
  if (bi.socialFollowing) context += `\nSocial following: ${bi.socialFollowing}`;
  if (bi.hasCreators) context += `\nAlready works with creators.`;
  if (bi.hasAffiliates) context += `\nHas an affiliate program.`;
  if (bi.hasInfluencers) context += `\nWorks with influencers.`;

  const prompt = `You are writing the 1-sentence opener of a cold email. We are Linkable — a Shopify app for creator affiliate tracking and payouts. The recipient runs the brand below.

${context}

The opener has one job: prove a human looked at this brand for 30 seconds. Reference ONE specific thing from the context — a product line, the brand's positioning, the fact they already work with creators, or their geography. Generic warmth reads as automation and kills reply rates.

Hard rules:
- 15-30 words, ONE sentence
- Never start with: "I came across", "I noticed", "I was browsing", "I saw", "I just found", "Just stumbled on", "Hope this finds you well", "Hope you're well"
- Never use the words: "amazing", "incredible", "awesome", "love what you've built", "love what you're doing", "great work", "really impressive"
- Never compliment vaguely ("your brand is great") — only reference concrete details from the context
- Do NOT mention revenue, sales figures, or financial data
- Do NOT pitch the product — that comes later in the email
- Use the actual brand name "${name}" verbatim
- If the context above contains nothing specific enough to reference (no description, no products, no creator signal, no founder info), output exactly: NEEDS_REVIEW

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
      console.error("Claude API error:", res.status, await res.text());
      return fallbackObservation(brand);
    }

    const data = await res.json();
    const text = data.content?.[0]?.text?.trim();
    // Claude returns "NEEDS_REVIEW" when the brand context is too thin to
    // personalise honestly. Don't inject that string into the email body —
    // fall through to the fallback, which leads with a generic-but-not-fake
    // question rather than a fabricated observation.
    if (!text || /^NEEDS_REVIEW\b/i.test(text)) return fallbackObservation(brand);
    return text;
  } catch (err) {
    console.error("Claude API error:", err.message);
    return fallbackObservation(brand);
  }
}

// Fallbacks for when Claude is unavailable or context is too thin.
// Lead with a question or a concrete reference — never "I came across" /
// "I noticed" / "I love what you've built", which are the three phrases
// recipients flag as automated within two seconds.
function fallbackObservation(brand) {
  const name = brand.storeName || brand.name || brand.domain;
  const bi = brand.brandInfo || {};
  const types = (brand.sampleTypes || brand.matchedKeywords || []).slice(0, 2).join(" and ");

  if (bi.hasCreators || bi.hasAffiliates || bi.hasInfluencers) {
    return `Quick one — when ${name}'s creators post, do you actually know which ones drove sales versus which just drove likes?`;
  }
  if (types) {
    return `For ${types} brands like ${name}, creator-led revenue almost always follows a power law — a few partners do most of the work, the rest is dead weight.`;
  }
  if (bi.brandStory) {
    return `Curious how ${name} thinks about creator partnerships — most brands in your space track engagement, but not actual conversion.`;
  }
  return `Quick question for ${name} — if you work with creators, do you know which ones actually drive Shopify revenue versus the ones that just look active?`;
}

// Render a template by replacing all placeholders
export function renderTemplate(template, variables) {
  let text = template;
  for (const [key, value] of Object.entries(variables)) {
    text = text.replaceAll(`{{${key}}}`, value || "");
  }
  return text;
}

// Validate that a rendered email looks correct (no leftover placeholders, reasonable length)
export function validateRenderedEmail(subject, body) {
  const issues = [];

  // Check for unrendered placeholders
  const placeholderRe = /\{\{[a-zA-Z]+\}\}/g;
  const subjectPlaceholders = subject.match(placeholderRe);
  const bodyPlaceholders = body.match(placeholderRe);
  if (subjectPlaceholders) issues.push(`Subject has unrendered placeholders: ${subjectPlaceholders.join(", ")}`);
  if (bodyPlaceholders) issues.push(`Body has unrendered placeholders: ${bodyPlaceholders.join(", ")}`);

  // Check reasonable lengths
  if (subject.length < 5) issues.push("Subject too short");
  if (subject.length > 120) issues.push("Subject too long (>120 chars)");
  if (body.length < 100) issues.push("Body too short");
  if (body.length > 3000) issues.push("Body too long (>3000 chars)");

  // Check for spam trigger words in subject
  const spamWords = ["guaranteed", "act now", "limited time", "buy now", "click here", "urgent", "winner", "congratulations", "$$", "!!!"];
  const lowerSubject = subject.toLowerCase();
  const foundSpam = spamWords.filter(w => lowerSubject.includes(w));
  if (foundSpam.length) issues.push(`Subject contains spam triggers: ${foundSpam.join(", ")}`);

  return { valid: issues.length === 0, issues };
}
