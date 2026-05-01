// Fast brand scraping: homepage + contact page only
// Finds emails and basic brand context in ~2-3 seconds per brand

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const JUNK_DOMAINS = ["shopify.com", "klaviyo.com", "mailchimp.com", "sentry.io", "gorgias.com", "zendesk.com", "freshdesk.com"];

function extractEmails(text) {
  return (text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])
    .filter(e => {
      const l = e.toLowerCase();
      return !l.includes("noreply") && !l.includes("unsubscribe") && !l.includes("mailer-daemon") &&
        !l.includes("postmaster") && !l.includes("example.com") &&
        !JUNK_DOMAINS.some(d => l.includes(d)) &&
        !l.endsWith(".png") && !l.endsWith(".jpg") && !l.endsWith(".svg");
    });
}

function scoreEmail(email, domain) {
  const local = email.split("@")[0].toLowerCase();
  const emailDomain = email.split("@")[1].toLowerCase();
  const brandDomain = domain.replace(/^www\./, "").split(".")[0];
  let score = 0;
  if (emailDomain.includes(brandDomain)) score += 10; else return -10;
  if (["founder", "ceo", "owner"].some(k => local.includes(k))) score += 8;
  if (/^[a-z]+\.[a-z]+$/.test(local)) score += 7;
  if (/^[a-z]{2,12}$/.test(local) && !["info", "hello", "hi", "contact", "help", "support", "team", "admin", "press", "sales", "order", "orders", "return", "returns", "jobs", "careers", "legal", "billing", "wholesale", "privacy", "noreply"].includes(local)) score += 7;
  if (["marketing", "partnerships", "collab", "brand", "press", "pr", "growth", "creators"].some(k => local.includes(k))) score += 6;
  if (["hello", "hi", "info", "contact"].includes(local)) score += 3;
  if (["support", "help", "orders", "returns", "billing", "legal", "jobs", "careers", "wholesale", "privacy"].some(k => local.includes(k))) score -= 5;
  return score;
}

async function fetchFast(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(5000), redirect: "follow" });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

function htmlToText(html) {
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

export async function scrapeBrand(domain) {
  const cleanDomain = domain.replace(/^www\./, "");
  const allEmails = new Set();

  // Fetch homepage + contact + about in parallel (3 most likely to have emails)
  const [homepageHtml, contactHtml, aboutHtml] = await Promise.all([
    fetchFast(`https://${cleanDomain}`),
    fetchFast(`https://${cleanDomain}/pages/contact`),
    fetchFast(`https://${cleanDomain}/pages/about`),
  ]);

  // Extract emails from all pages
  for (const html of [homepageHtml, contactHtml, aboutHtml]) {
    if (!html) continue;
    extractEmails(html).forEach(e => allEmails.add(e.toLowerCase()));
    const mailtos = html.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g) || [];
    mailtos.forEach(m => allEmails.add(m.replace("mailto:", "").split("?")[0].toLowerCase()));
  }

  // If nothing found yet, try alternate contact paths
  if (allEmails.size === 0) {
    const extras = await Promise.all([
      fetchFast(`https://${cleanDomain}/contact`),
      fetchFast(`https://${cleanDomain}/about`),
      fetchFast(`https://${cleanDomain}/pages/partnerships`),
    ]);
    for (const html of extras) {
      if (!html) continue;
      extractEmails(html).forEach(e => allEmails.add(e.toLowerCase()));
      const mailtos = html.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g) || [];
      mailtos.forEach(m => allEmails.add(m.replace("mailto:", "").split("?")[0].toLowerCase()));
    }
  }

  // Score ONLY real emails found on site — no guesses
  const scored = [...allEmails]
    .map(e => ({ email: e, score: scoreEmail(e, cleanDomain) }))
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score);

  // Brand info from homepage text
  const text = homepageHtml ? htmlToText(homepageHtml).slice(0, 5000) : "";
  const brandInfo = {
    hasCreators: /\bcreator[s]?\b/i.test(text),
    hasAffiliates: /\baffiliate[s]?\b/i.test(text),
    hasInfluencers: /\binfluencer[s]?\b/i.test(text),
    hasSocialCommerce: /creator|affiliate|influencer|ambassador/i.test(text),
    founderName: (text.match(/(?:founded by|founder[,:]?\s+|created by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/)?.[1] || null),
    brandStory: (text.match(/(?:our story|about us|who we are|our mission|we believe|we started)[:\s]*([^.!?]{20,200}[.!?])/i)?.[1] || null),
    usp: null,
  };

  return {
    domain: cleanDomain,
    emails: scored.map(e => e.email),
    bestEmail: scored.length > 0 ? scored[0].email : null,
    emailCount: scored.length,
    foundOnSite: scored.length > 0,
    brandInfo,
  };
}
