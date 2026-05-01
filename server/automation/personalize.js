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

  const prompt = `You are writing a 1-2 sentence opening observation for a cold email. We are Linkable — a Shopify app for creator affiliate tracking and payouts.

${context}

Write something specific to this brand that shows you actually know who they are. Reference their products, description, social presence, or the fact they already work with creators. Keep it warm and genuine — this is a professional introduction, not a sales pitch.

Rules:
- Use the actual brand name "${name}"
- Do NOT mention revenue, sales figures, or financial data
- Do NOT be over-the-top complimentary or salesy
- Sound like a real person, not a template
- 1-2 sentences only, nothing else`;

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
    return text || fallbackObservation(brand);
  } catch (err) {
    console.error("Claude API error:", err.message);
    return fallbackObservation(brand);
  }
}

function fallbackObservation(brand) {
  const name = brand.storeName || brand.name || brand.domain;
  const bi = brand.brandInfo || {};
  const types = (brand.sampleTypes || brand.matchedKeywords || []).slice(0, 2).join(" and ");

  // Use scraped brand info for a better fallback
  if (bi.hasCreators || bi.hasAffiliates || bi.hasInfluencers) {
    return `I noticed ${name} already works with creators — have you been able to track which partnerships actually drive sales?`;
  }
  if (bi.brandStory) {
    return `I came across ${name} and loved the story behind the brand — products like yours tend to do really well through creator partnerships.`;
  }
  if (brand.productCount && types) {
    return `I was browsing ${name}'s store and noticed you've built a solid range across ${types} — the kind of products creators love to recommend.`;
  }
  if (types) {
    return `I came across ${name} and noticed your focus on ${types} — products like these tend to perform well through creator-driven sales.`;
  }
  return `I came across ${name} and really liked what you've built — seems like a great fit for creator partnerships.`;
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
