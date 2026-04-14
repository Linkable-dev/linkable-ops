// Email enrichment: try to find founder/marketing contact emails from a domain
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Common pages where contact info lives
const CONTACT_PATHS = ["/pages/contact", "/pages/about", "/contact", "/about", "/pages/contact-us", "/about-us"];

// Extract emails from text
function extractEmails(text) {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(emailRegex) || [];
  // Filter out common non-contact emails
  return matches.filter(e => {
    const lower = e.toLowerCase();
    return !lower.includes("noreply") && !lower.includes("no-reply") &&
      !lower.includes("unsubscribe") && !lower.includes("mailer-daemon") &&
      !lower.includes("postmaster") && !lower.includes("example.com") &&
      !lower.includes("sentry.io") && !lower.includes("shopify.com") &&
      !lower.includes("klaviyo") && !lower.includes("mailchimp") &&
      !lower.endsWith(".png") && !lower.endsWith(".jpg");
  });
}

// Score an email — higher = more likely a useful contact
function scoreEmail(email, domain) {
  const local = email.split("@")[0].toLowerCase();
  const emailDomain = email.split("@")[1].toLowerCase();
  let score = 0;

  // Email from the brand's own domain is best
  if (domain && emailDomain.includes(domain.replace(/^www\./, "").split(".")[0])) score += 10;

  // Founder/owner patterns
  if (["founder", "ceo", "owner", "hello", "hi", "info", "contact"].some(k => local.includes(k))) score += 5;
  // Marketing patterns
  if (["marketing", "press", "pr", "partnerships", "collab", "brand"].some(k => local.includes(k))) score += 4;
  // First name patterns (short, no dots = likely personal)
  if (local.length <= 12 && !local.includes("support") && !local.includes("help") && !local.includes("order")) score += 3;

  // Penalize generic/support
  if (["support", "help", "orders", "returns", "billing", "legal", "jobs", "careers", "wholesale"].some(k => local.includes(k))) score -= 5;

  return score;
}

export async function findContactEmails(domain) {
  const cleanDomain = domain.replace(/^www\./, "");
  const allEmails = new Set();

  // 1. Check contact/about pages
  for (const path of CONTACT_PATHS) {
    try {
      const res = await fetch(`https://${cleanDomain}${path}`, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(8000),
        redirect: "follow",
      });
      if (!res.ok) continue;
      const html = await res.text();
      extractEmails(html).forEach(e => allEmails.add(e.toLowerCase()));
    } catch {}
  }

  // 2. Check homepage
  try {
    const res = await fetch(`https://${cleanDomain}`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const html = await res.text();
      extractEmails(html).forEach(e => allEmails.add(e.toLowerCase()));
    }
  } catch {}

  // 3. Try common email patterns
  const brandName = cleanDomain.split(".")[0];
  const guessedEmails = [
    `hello@${cleanDomain}`, `info@${cleanDomain}`, `contact@${cleanDomain}`,
    `hi@${cleanDomain}`, `marketing@${cleanDomain}`, `press@${cleanDomain}`,
    `partnerships@${cleanDomain}`, `collab@${cleanDomain}`,
  ];

  // Score and rank found emails
  const scored = [...allEmails].map(e => ({ email: e, score: scoreEmail(e, cleanDomain) }));
  // Add guessed emails with lower score
  for (const e of guessedEmails) {
    if (!allEmails.has(e)) scored.push({ email: e, score: -1, guessed: true });
  }

  scored.sort((a, b) => b.score - a.score);

  return {
    found: scored.filter(e => e.score > 0).map(e => e.email),
    guessed: scored.filter(e => e.score <= 0 && !e.guessed).map(e => e.email),
    common: guessedEmails.slice(0, 3),
    best: scored[0]?.score > 0 ? scored[0].email : `hello@${cleanDomain}`,
  };
}
