// Live brand discovery — finds Shopify stores via multiple search engines
// Uses targeted queries that return actual store URLs with emails visible

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const SKIP = new Set([
  "shopify.com", "myshopify.com", "amazon.com", "ebay.com", "etsy.com",
  "facebook.com", "instagram.com", "tiktok.com", "youtube.com", "twitter.com", "x.com",
  "linkedin.com", "pinterest.com", "reddit.com", "google.com", "bing.com", "duckduckgo.com",
  "wikipedia.org", "medium.com", "forbes.com", "vogue.com", "allure.com", "byrdie.com",
  "sephora.com", "ulta.com", "nordstrom.com", "target.com", "walmart.com",
  "apple.com", "microsoft.com", "github.com", "stackoverflow.com", "quora.com",
  "yahoo.com", "yelp.com", "trustpilot.com", "bbb.org", "crunchbase.com",
  "producthunt.com", "techcrunch.com", "businessinsider.com",
]);

function extractDomain(url) {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch { return null; }
}

async function searchGoogle(query) {
  try {
    // Use Google's regular search
    const res = await fetch(`https://www.google.com/search?q=${encodeURIComponent(query)}&num=30`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    const domains = new Set();
    // Extract URLs from search results
    const matches = html.match(/https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    for (const url of matches) {
      const d = extractDomain(url);
      if (d && !SKIP.has(d) && !d.includes("google") && !d.includes("gstatic") && d.length > 4) {
        domains.add(d);
      }
    }
    return [...domains];
  } catch { return []; }
}

async function searchBing(query) {
  try {
    const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=50`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    const domains = new Set();
    const matches = html.match(/https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    for (const url of matches) {
      const d = extractDomain(url);
      if (d && !SKIP.has(d) && !d.includes("bing") && !d.includes("microsoft") && d.length > 4) {
        domains.add(d);
      }
    }
    return [...domains];
  } catch { return []; }
}

// Queries designed to find ecommerce brands with contact emails
const QUERIES = [
  // Direct email searches — these return pages that actually have emails
  'site:*.com "contact us" "email" shopify store',
  'site:*.com "hello@" OR "info@" shopify beauty brand',
  'site:*.com "partnerships@" OR "collab@" shopify brand',
  'site:*.com "press@" OR "pr@" shopify DTC brand',
  'site:*.com "creators@" OR "influencers@" shopify',
  '"mailto:" shopify beauty brand contact',
  '"mailto:" shopify skincare brand',
  '"mailto:" shopify fashion brand DTC',
  '"mailto:" shopify wellness brand',
  '"mailto:" shopify food brand DTC',
  '"mailto:" shopify jewelry brand',
  '"mailto:" shopify haircare brand',
  '"mailto:" shopify supplement brand',
  '"mailto:" shopify home brand DTC',
  '"mailto:" shopify pet brand',
  '"mailto:" shopify coffee brand',
  '"mailto:" shopify activewear brand',

  // Shopify store directories and lists
  "best shopify stores 2025 list",
  "top DTC brands 2025 shopify",
  "fastest growing shopify stores 2025",
  "new shopify brands to watch 2025",
  "best ecommerce stores shopify 2025",
  "indie beauty brands shopify 2025",
  "sustainable fashion brands shopify 2025",
  "best wellness brands shopify 2025",
  "best food brands shopify 2025",
  "best pet brands DTC shopify 2025",

  // Category-specific with contact
  "contact email skincare brand shopify store",
  "contact email fashion brand DTC store",
  "contact email wellness supplement shopify",
  "contact email jewelry brand shopify",
  "contact email home decor brand shopify",
  "contact email food beverage brand shopify",
  "contact email pet brand DTC",
  "contact email fitness brand shopify",
  "contact email baby brand DTC shopify",

  // myshopify discovery
  "site:myshopify.com beauty",
  "site:myshopify.com skincare",
  "site:myshopify.com fashion",
  "site:myshopify.com wellness",
  "site:myshopify.com food",
  "site:myshopify.com jewelry",
  "site:myshopify.com pets",

  // Shopify app store — brands listed there are confirmed Shopify
  "shopify app store reviews beauty brand",
  "shopify app store reviews fashion brand",
  "shopify success story DTC brand 2025",
];

/**
 * Discover fresh brand domains via live search
 * @param {Set} alreadyProcessed - domains to skip
 * @param {number} target - how many to find
 */
export async function discoverLive(alreadyProcessed, target = 500) {
  const discovered = new Set();
  const shuffled = [...QUERIES].sort(() => Math.random() - 0.5);

  for (const query of shuffled) {
    if (discovered.size >= target) break;

    // Alternate between Google and Bing
    const results = Math.random() > 0.5
      ? await searchGoogle(query)
      : await searchBing(query);

    let added = 0;
    for (const d of results) {
      const root = d.split(".")[0];
      // Skip if domain or root already processed
      let isDupe = alreadyProcessed.has(d);
      if (!isDupe) {
        for (const existing of alreadyProcessed) {
          if (existing.split(".")[0] === root) { isDupe = true; break; }
        }
      }
      if (!isDupe && !discovered.has(d)) {
        discovered.add(d);
        added++;
      }
    }

    if (added > 0) console.log(`  "${query.slice(0, 50)}..." → ${added} new (total: ${discovered.size})`);

    // 3s delay between searches to avoid rate limiting
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log(`\nDiscovered ${discovered.size} new domains\n`);
  return [...discovered];
}
