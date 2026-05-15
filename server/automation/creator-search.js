// Web-search backend for creator discovery. Used by the bio-mining
// provider to find Linktree / Beacons / similar bio pages by niche.
//
// Default impl: Brave Search API (free tier 2000 queries/mo). The
// abstraction is intentionally thin so a future Apify / SerpAPI / Bing
// backend can drop in without touching the bio-mining provider.
//
// Env: BRAVE_SEARCH_API_KEY — required to use the Brave backend. Sign up
// at https://brave.com/search/api/ for a free key.

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

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

// Simple registry — keeps the bio-mining provider source-agnostic so we
// can swap in SerpAPI / Apify / etc later without re-touching it.
export function getSearchBackend(name = "brave", opts = {}) {
  switch ((name || "brave").toLowerCase()) {
    case "brave": return braveSearchBackend(opts);
    default:
      throw new Error(`unknown search backend: ${name}`);
  }
}
