// Deep brand scraping: extract brand info + emails from the actual website
// Used to personalize outreach emails with real brand context

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Pages to scrape for brand info
const INFO_PATHS = ["/", "/pages/about", "/about", "/about-us", "/pages/about-us", "/pages/our-story", "/our-story"];

// Pages to scrape for emails
const EMAIL_PATHS = [
  "/pages/contact", "/contact", "/contact-us", "/pages/contact-us",
  "/pages/about", "/about", "/about-us", "/pages/about-us",
  "/pages/our-story", "/our-story",
  "/pages/partnerships", "/partnerships", "/pages/collaborate", "/collaborate",
  "/pages/press", "/press",
  "/", "/pages/faq",
];

// Extract emails from text
function extractEmails(text) {
  const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(re) || [];
  return matches.filter(e => {
    const l = e.toLowerCase();
    return !l.includes("noreply") && !l.includes("no-reply") &&
      !l.includes("unsubscribe") && !l.includes("mailer-daemon") &&
      !l.includes("postmaster") && !l.includes("example.com") &&
      !l.includes("sentry.io") && !l.includes("shopify.com") &&
      !l.includes("klaviyo") && !l.includes("mailchimp") &&
      !l.includes("wix.com") && !l.includes("squarespace") &&
      !l.endsWith(".png") && !l.endsWith(".jpg") && !l.endsWith(".svg");
  });
}

// Score emails — higher = more useful for outreach
function scoreEmail(email, domain) {
  const local = email.split("@")[0].toLowerCase();
  const emailDomain = email.split("@")[1].toLowerCase();
  const brandDomain = domain.replace(/^www\./, "").split(".")[0];
  let score = 0;

  // Must be from brand's own domain
  if (emailDomain.includes(brandDomain)) score += 10;
  else return -10; // third-party domain = not useful

  // Founder/owner/personal patterns (best for cold outreach)
  if (["founder", "ceo", "owner"].some(k => local.includes(k))) score += 8;
  // Named emails (e.g. "sarah@", "james@") — likely a person
  if (/^[a-z]{2,12}$/.test(local) && !["info", "hello", "hi", "contact", "help", "support", "team", "admin", "press", "sales", "order", "orders", "return", "returns", "jobs", "careers", "legal", "billing", "wholesale", "privacy", "noreply"].includes(local)) score += 7;
  // First.last patterns
  if (/^[a-z]+\.[a-z]+$/.test(local)) score += 7;
  // Marketing/partnerships (relevant for our pitch)
  if (["marketing", "partnerships", "collab", "brand", "press", "pr", "growth"].some(k => local.includes(k))) score += 6;
  // Generic but OK
  if (["hello", "hi", "info", "contact"].includes(local)) score += 3;
  // Bad for outreach
  if (["support", "help", "orders", "returns", "billing", "legal", "jobs", "careers", "wholesale", "privacy"].some(k => local.includes(k))) score -= 5;

  return score;
}

// Fetch a page and return text content (stripped of HTML)
async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(10000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    return html;
  } catch {
    return null;
  }
}

// Strip HTML tags and extract readable text
function htmlToText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Extract brand context from page text
function extractBrandInfo(text, domain) {
  const lower = text.toLowerCase();
  const info = {
    hasCreators: false,
    hasAffiliates: false,
    hasInfluencers: false,
    hasSocialCommerce: false,
    founderName: null,
    brandStory: null,
    usp: null,
  };

  // Check for creator/affiliate/influencer mentions
  info.hasCreators = /\bcreator[s]?\b/i.test(text);
  info.hasAffiliates = /\baffiliate[s]?\b/i.test(text);
  info.hasInfluencers = /\binfluencer[s]?\b/i.test(text);
  info.hasSocialCommerce = info.hasCreators || info.hasAffiliates || info.hasInfluencers ||
    /\bambassador[s]?\b/i.test(text) || /\bcollaboration[s]?\b/i.test(text);

  // Try to extract founder name
  const founderMatch = text.match(/(?:founded by|founder[,:]?\s+|created by|started by|co-founded by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (founderMatch) info.founderName = founderMatch[1].trim();

  // Extract brand story snippet (first ~200 chars from about page)
  const storyPatterns = [
    /(?:our story|about us|who we are|our mission)[:\s]*([^.!?]{20,200}[.!?])/i,
    /(?:we believe|we started|we created|we're on a mission|born from)[^.!?]{10,200}[.!?]/i,
  ];
  for (const pattern of storyPatterns) {
    const match = text.match(pattern);
    if (match) {
      info.brandStory = (match[1] || match[0]).trim().slice(0, 250);
      break;
    }
  }

  // Extract USP
  const uspPatterns = [
    /(?:what makes us different|why choose|our promise|we're different)[:\s]*([^.!?]{10,200}[.!?])/i,
    /(?:clean|vegan|cruelty-free|organic|sustainable|natural|science-backed|clinically proven|dermatologist)[^.!?]{5,100}[.!?]/i,
  ];
  for (const pattern of uspPatterns) {
    const match = text.match(pattern);
    if (match) {
      info.usp = (match[1] || match[0]).trim().slice(0, 200);
      break;
    }
  }

  return info;
}

/**
 * Deep scrape a brand's website for emails and brand context
 * Returns { emails, brandInfo }
 */
export async function scrapeBrand(domain) {
  const cleanDomain = domain.replace(/^www\./, "");
  const allEmails = new Set();
  const allText = [];

  // Dedupe paths
  const uniquePaths = [...new Set([...EMAIL_PATHS, ...INFO_PATHS])];
  const aboutText = []; // prioritize about pages for brand context

  // Scrape all pages
  for (const path of uniquePaths) {
    const html = await fetchPage(`https://${cleanDomain}${path}`);
    if (!html) continue;

    // Extract emails from raw HTML (catches mailto: links too)
    extractEmails(html).forEach(e => allEmails.add(e.toLowerCase()));

    // Extract mailto: links
    const mailtoMatches = html.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g) || [];
    mailtoMatches.forEach(m => {
      const email = m.replace("mailto:", "").split("?")[0].toLowerCase();
      allEmails.add(email);
    });

    // Extract text — prioritize about/story pages for brand context
    const text = htmlToText(html);
    if (text.length > 50) {
      const isAboutPage = /about|story|mission/i.test(path);
      if (isAboutPage) {
        aboutText.push(text);
      } else {
        allText.push(text);
      }
    }
  }

  // Score and rank emails
  const scored = [...allEmails]
    .map(e => ({ email: e, score: scoreEmail(e, cleanDomain) }))
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score);

  // Add common guesses if we found nothing
  if (scored.length === 0) {
    const guesses = [`hello@${cleanDomain}`, `info@${cleanDomain}`, `contact@${cleanDomain}`, `hi@${cleanDomain}`];
    for (const g of guesses) {
      scored.push({ email: g, score: 1, guessed: true });
    }
  }

  // Extract brand info — about pages first, then other pages as fallback
  const combinedText = [...aboutText, ...allText].join(" ").slice(0, 10000);
  const brandInfo = extractBrandInfo(combinedText, cleanDomain);

  return {
    domain: cleanDomain,
    emails: scored.map(e => e.email),
    bestEmail: scored[0]?.email || `hello@${cleanDomain}`,
    emailCount: scored.filter(e => !e.guessed).length,
    brandInfo,
  };
}
