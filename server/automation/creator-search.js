// Web-search backend for creator discovery. Used by the bio-mining
// provider to find Linktree / Beacons / similar bio pages by niche.
//
// Default impl: DuckDuckGo HTML endpoint (no key, no signup, free).
// Fallback: Brave Search API (kept for operators who want it, but Brave's
// "free" tier requires a credit card on file — which is why DDG is now
// the default). The abstraction is intentionally thin so a future
// SerpAPI / Apify / etc backend can drop in without touching the
// bio-mining provider.
//
// Env: BRAVE_SEARCH_API_KEY — required only for `--search-backend brave`.

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const DDG_HTML_URL = "https://html.duckduckgo.com/html/";
const DDG_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

// Public contract:
//   const backend = braveSearchBackend();
//   const { results, hasMore } = await backend.search("site:linktr.ee beauty creator", {
//     count: 20, offset: 0,
//   });
//   results: [{ url, title, description }, ...]
//
// The backend handles its own rate-limiting concerns (Brave free tier is
// 1 query/sec) — callers should sleep ~1.1s between queries to stay safe.

export function braveSearchBackend({ apiKey } = {}) {
  const key = apiKey || process.env.BRAVE_SEARCH_API_KEY;
  return {
    name: "brave",
    available: !!key,

    async search(query, { count = 20, offset = 0 } = {}) {
      if (!key) {
        throw new Error("BRAVE_SEARCH_API_KEY not set — cannot use Brave search backend");
      }

      // Brave's `count` caps at 20; `offset` pages by full result-page (so
      // offset=1 means "skip the first 20 results"). For a deep-search
      // workflow callers iterate offset 0,1,2,... up to ~9 (200 results).
      const url = new URL(BRAVE_SEARCH_URL);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(Math.min(Math.max(count, 1), 20)));
      url.searchParams.set("offset", String(Math.max(offset, 0)));
      // Filter out obvious non-bio pages — videos and discussions rarely
      // host the email we're looking for; web results have the highest yield.
      url.searchParams.set("result_filter", "web");

      const res = await fetch(url, {
        headers: {
          "Accept": "application/json",
          "X-Subscription-Token": key,
        },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Brave search ${res.status}: ${body.slice(0, 200)}`);
      }

      const json = await res.json();
      const items = json?.web?.results || [];
      const results = items.map((r) => ({
        url: r.url,
        title: r.title || "",
        description: r.description || "",
      }));

      // Brave doesn't return a clean "hasMore" — we infer it from a full
      // page (count results). Less than count = end of stream.
      const hasMore = results.length === Math.min(Math.max(count, 1), 20);
      return { results, hasMore };
    },
  };
}

// ---------- DuckDuckGo HTML scraper ----------
//
// No API, no key. Hits the same HTML endpoint a browser would, parses
// the result list with regex (DOM dependency would be overkill for the
// 5 fields we need: title, snippet, url, and the redirect wrapper).
//
// Pagination: the HTML endpoint accepts `s=N` as a start offset (each
// page is ~30 results). We POST the form (as the browser does) so we
// stay on the same code path DDG actively maintains.
//
// Brittleness: this is HTML scraping. If DDG changes their result class
// names, the extractors below break. The regexes below are intentionally
// loose (match the URL inside any href that goes through `/l/?uddg=`)
// so small markup changes don't break us, but a major redesign would.
//
// Rate-limiting: no documented limit, but DDG flags aggressive scrapers.
// The bio-mining provider already sleeps SEARCH_SLEEP_MS between queries;
// that's the right knob to tune if we ever start getting 429s here.

// DDG wraps every result URL in /l/?uddg=<URL-encoded>. We decode it
// inside the extractor so callers see the real URL. Match both the
// protocol-relative form (//duckduckgo.com/l/?uddg=...) and the absolute
// form, since DDG flips between them depending on the rendering path.
const DDG_REDIRECT_RE = /(?:https?:)?\/\/duckduckgo\.com\/l\/\?uddg=([^&"']+)/;
const DDG_RESULT_LINK_RE = /<a[^>]+class="result__a"[^>]+href="([^"]+)"/g;

function decodeDdgUrl(href) {
  const m = href.match(DDG_REDIRECT_RE);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { return null; }
  }
  // Some result rows link directly without the wrapper.
  if (/^https?:\/\//.test(href)) return href;
  return null;
}

export function duckduckgoSearchBackend() {
  return {
    name: "duckduckgo",
    available: true,             // no key required

    async search(query, { count = 30, offset = 0 } = {}) {
      // DDG paginates by character offset — `s=0` is the first page,
      // `s=30` is the second, etc. There's no per-call count parameter;
      // each page is ~30 results. We slice the response to honour `count`.
      const body = new URLSearchParams({
        q: query,
        b: "",
        kl: "us-en",                  // English-language results
        s: String(Math.max(offset, 0) * count),
      });

      const res = await fetch(DDG_HTML_URL, {
        method: "POST",
        headers: {
          "User-Agent": DDG_USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "text/html,application/xhtml+xml",
          // DDG's HTML endpoint expects a referer; without it we get a
          // CAPTCHA page back instead of results.
          "Referer": "https://html.duckduckgo.com/",
        },
        body,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`DuckDuckGo ${res.status}: ${text.slice(0, 200)}`);
      }

      const html = await res.text();
      // CAPTCHA / anomaly page detection — DDG returns 200 with an
      // anti-bot interstitial when it doesn't like our request. Surface
      // it explicitly so the caller can back off rather than silently
      // returning zero results.
      if (/anomaly-detected|We need to make sure you|why_is_this_here/i.test(html)) {
        throw new Error("DuckDuckGo anti-bot challenge — slow down and retry");
      }

      const seen = new Set();
      const results = [];
      DDG_RESULT_LINK_RE.lastIndex = 0;
      let m;
      while ((m = DDG_RESULT_LINK_RE.exec(html)) !== null) {
        const url = decodeDdgUrl(m[1]);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        results.push({ url, title: "", description: "" });
        if (results.length >= count) break;
      }

      // No reliable hasMore signal in the HTML; we infer the same way
      // we do for Brave — a full page back means there's probably more.
      const hasMore = results.length === count;
      return { results, hasMore };
    },
  };
}

// Simple registry — keeps the bio-mining provider source-agnostic so we
// can swap in SerpAPI / Apify / etc later without re-touching it.
export function getSearchBackend(name = "duckduckgo", opts = {}) {
  switch ((name || "duckduckgo").toLowerCase()) {
    case "duckduckgo":
    case "ddg":
      return duckduckgoSearchBackend();
    case "brave":
      return braveSearchBackend(opts);
    default:
      throw new Error(`unknown search backend: ${name}`);
  }
}
