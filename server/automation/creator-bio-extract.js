// Bio-page extractor. Fetches a public creator bio page (Linktree, Beacons,
// Carrd, etc.) and pulls out the only signals we actually need for cold
// email: a contact email, an Instagram handle, the display name, and a
// best-effort first name.
//
// No headless browser — these pages all server-render the bio content as
// plain HTML, so a single fetch + regex pass is enough. Skipping a JS
// runtime keeps the scraper cheap and parallel-friendly.
//
// Returns null when the page yields no usable email — the bio-mining
// provider drops those rows rather than insert NULL-email creators we
// can't possibly cold-email.

const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 1_000_000;        // 1 MB — bio pages are typically <300 KB
const USER_AGENT = "Mozilla/5.0 (compatible; LinkableOpsBot/1.0; +https://linkable.link)";

// Generic email regex. Tightened to require a 2+ char TLD and no whitespace
// inside the local part. Catches the common cases without false-positiving
// on inline JS object literals.
const EMAIL_RE = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;

// Platform / generic emails to drop — we'd rather discard the row than
// cold-email "support@linktr.ee" or "no-reply@beacons.ai".
const EMAIL_LOCAL_BLOCKLIST = new Set([
  "support", "help", "info", "no-reply", "noreply", "do-not-reply",
  "admin", "team", "hello", "press", "media", "abuse", "legal",
  "privacy", "security", "billing", "sales",
]);
const EMAIL_DOMAIN_BLOCKLIST = new Set([
  "linktr.ee", "beacons.ai", "beacons.page", "bio.link", "lnk.bio",
  "carrd.co", "campsite.bio", "snipfeed.co", "tappy.bio",
  "example.com", "example.org", "example.net",
  "sentry.io", "sentry-next.wixpress.com", "wix.com",
]);

// Heuristic: drop emails that look like a hash / random string (8+ chars
// of mixed alphanumerics, no dots / dashes). These show up in JS bundles
// embedded in the page and are never real contact addresses.
function looksLikeHash(local) {
  return local.length >= 16 && /^[a-z0-9]+$/i.test(local) && !/[._-]/.test(local);
}

function isUsableEmail(email) {
  const lower = email.toLowerCase();
  const [local, domain] = lower.split("@");
  if (!local || !domain) return false;
  if (EMAIL_LOCAL_BLOCKLIST.has(local)) return false;
  if (EMAIL_DOMAIN_BLOCKLIST.has(domain)) return false;
  if (looksLikeHash(local)) return false;
  return true;
}

// Pull the FIRST usable email from a chunk of HTML. We bias toward the
// first match because bio pages typically put the contact email near the
// top (in the "Contact me" / "Booking" link), and footer noise
// (privacy@, support@) lands later.
function extractEmail(html) {
  const matches = html.match(EMAIL_RE) || [];
  for (const m of matches) {
    if (isUsableEmail(m)) return m.toLowerCase();
  }
  return null;
}

// Find the first instagram.com/<handle> link in the page. Strips query
// params and trailing slashes; rejects platform paths (/explore, /reels,
// /accounts, etc) and the empty handle.
const IG_LINK_RE = /instagram\.com\/(?:#!\/)?([A-Za-z0-9_.]+)(?:[/?]|$)/g;
const IG_RESERVED = new Set([
  "explore", "reels", "stories", "tv", "accounts", "p", "directory",
  "developer", "about", "legal", "press", "api", "static",
]);
function extractInstagramUsername(html) {
  IG_LINK_RE.lastIndex = 0;
  let m;
  while ((m = IG_LINK_RE.exec(html)) !== null) {
    const handle = m[1].replace(/\.$/, "").toLowerCase();
    if (!handle || handle.length < 2 || handle.length > 30) continue;
    if (IG_RESERVED.has(handle)) continue;
    return handle;
  }
  return null;
}

// Pull the page title. Linktree / Beacons / Carrd all set the creator's
// display name as the <title>, sometimes with a " | Linktr.ee" suffix.
function extractTitle(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!m) return null;
  return m[1]
    .replace(/\s*[\|·•—-]\s*(linktr\.ee|beacons|carrd|bio\.link|lnk\.bio).*$/i, "")
    .trim() || null;
}

// First name: take the first whitespace-separated token of the title that
// looks like a real name (alphabetic, 2+ chars). Drops the brand-style
// titles like "Studio.Co" or "@beautyhacks".
function extractFirstName(title) {
  if (!title) return null;
  const stripped = title.replace(/^@/, "").trim();
  const first = stripped.split(/[\s.,_/-]+/)[0] || "";
  if (first.length < 2) return null;
  if (!/^[A-Za-zÀ-ÿ'’]+$/.test(first)) return null;
  // Reject obvious non-names (English/Italian common-word filter — keep tight).
  const reserved = new Set(["the", "shop", "store", "bio", "links", "official", "real", "il", "la", "le"]);
  if (reserved.has(first.toLowerCase())) return null;
  return first;
}

// Lightweight HTML → text: strip script/style blocks then drop tags. Used
// for niche-keyword matching against the bio body. Caps output to keep
// the regex pass linear.
function stripHtmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 5000);
}

export async function fetchBioPage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) return { ok: false, status: res.status, html: null };

    // Read up to MAX_HTML_BYTES. node fetch's text() doesn't expose a
    // streaming size cap, so we read the whole body and slice — the
    // FETCH_TIMEOUT_MS keeps pathological responses bounded in time.
    const text = await res.text();
    const html = text.length > MAX_HTML_BYTES ? text.slice(0, MAX_HTML_BYTES) : text;
    return { ok: true, status: res.status, html };
  } catch (err) {
    return { ok: false, status: 0, html: null, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Top-level: fetch URL, extract everything, return a normalised record
// or null if the page yields no usable email.
//
// The `niche` arg is the niche we *searched for* when we found this URL.
// We don't try to re-derive niche from the bio body — the search query
// already says "this person is in <niche>", which is a stronger signal
// than keyword-matching against arbitrary marketing copy.
export async function extractBioRecord(url, { niche = null } = {}) {
  const fetched = await fetchBioPage(url);
  if (!fetched.ok || !fetched.html) {
    return { ok: false, url, reason: `fetch_failed_${fetched.status}` };
  }

  const html = fetched.html;
  const email = extractEmail(html);
  if (!email) {
    return { ok: false, url, reason: "no_usable_email" };
  }

  const title = extractTitle(html);
  const firstName = extractFirstName(title);
  const instagram = extractInstagramUsername(html);

  return {
    ok: true,
    url,
    email,
    first_name: firstName,
    instagram_username: instagram,
    instagram_name: title,
    niche,
    bio_text: stripHtmlToText(html).slice(0, 1000),
  };
}
