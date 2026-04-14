const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Many curated sources that list Shopify beauty stores
const DISCOVERY_SOURCES = [
  "https://www.shopify.com/blog/beauty-brand-examples",
  "https://www.shopify.com/blog/skincare-brands",
  "https://www.shopify.com/blog/best-online-stores",
  "https://www.shopify.com/blog/cosmetics-business",
  "https://www.shopify.com/blog/hair-business",
  "https://www.pagefly.io/blogs/shopify/top-shopify-beauty-stores",
];

function extractDomains(html) {
  const domains = new Set();
  // Match href and src URLs
  const urlRegex = /(?:href|src)=["'](https?:\/\/([a-zA-Z0-9.-]+\.[a-z]{2,}))[^"']*/gi;
  let match;
  while ((match = urlRegex.exec(html)) !== null) {
    const domain = match[2].toLowerCase().replace(/^www\./, "");
    if (
      !domain.includes("shopify.com") && !domain.includes("google.") &&
      !domain.includes("facebook.") && !domain.includes("twitter.") &&
      !domain.includes("instagram.") && !domain.includes("youtube.") &&
      !domain.includes("linkedin.") && !domain.includes("pinterest.") &&
      !domain.includes("tiktok.") && !domain.includes("amazon.") &&
      !domain.includes("wikipedia.") && !domain.includes("github.") &&
      !domain.includes("wp.com") && !domain.includes("cdn.") &&
      !domain.includes("cloudfront.") && !domain.includes("googleapis.") &&
      !domain.includes("gstatic.") && !domain.includes("reddit.") &&
      !domain.includes("medium.com") && !domain.includes("substack.") &&
      !domain.endsWith(".gov") && !domain.endsWith(".edu") &&
      domain.split(".").length <= 3 && domain.length > 4
    ) {
      domains.add(domain);
    }
  }
  // Also extract plain domain patterns from text
  const textDomainRegex = /\b([a-z0-9][-a-z0-9]*\.(com|co\.uk|us|io|co|store|shop|beauty))\b/gi;
  while ((match = textDomainRegex.exec(html)) !== null) {
    const d = match[1].toLowerCase();
    if (d.length > 5 && !d.includes("google") && !d.includes("shopify")) {
      domains.add(d);
    }
  }
  return [...domains];
}

function pickRandom(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

export async function discoverFromSources() {
  const allDomains = new Set();
  for (const url of DISCOVERY_SOURCES) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const html = await res.text();
      extractDomains(html).forEach(d => allDomains.add(d));
    } catch {}
  }
  return [...allDomains];
}

export async function discoverFromSearch(queries) {
  const allDomains = new Set();

  for (const query of queries) {
    // Try DuckDuckGo
    try {
      const encoded = encodeURIComponent(query);
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
        headers: { "User-Agent": UA, "Accept": "text/html" },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const html = await res.text();
        const urlRegex = /uddg=(https?[^&"]+)/gi;
        let match;
        while ((match = urlRegex.exec(html)) !== null) {
          try {
            const decoded = decodeURIComponent(match[1]);
            const url = new URL(decoded);
            const domain = url.hostname.replace(/^www\./, "");
            if (
              !domain.includes("duckduckgo") && !domain.includes("google.") &&
              !domain.includes("bing.") && !domain.includes("amazon.") &&
              !domain.includes("facebook.") && !domain.includes("instagram.") &&
              !domain.includes("youtube.") && !domain.includes("reddit.") &&
              !domain.includes("wikipedia.") && !domain.includes("twitter.") &&
              !domain.includes("tiktok.") && !domain.includes("pinterest.") &&
              !domain.includes("shopify.com") && !domain.endsWith(".gov")
            ) {
              allDomains.add(domain);
            }
          } catch {}
        }
      }
    } catch {}

    // Also try Bing
    try {
      const encoded = encodeURIComponent(query);
      const res = await fetch(`https://www.bing.com/search?q=${encoded}&count=20`, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const html = await res.text();
        const hrefRegex = /href="(https?:\/\/[^"]+)"/gi;
        let match;
        while ((match = hrefRegex.exec(html)) !== null) {
          try {
            const url = new URL(match[1]);
            const domain = url.hostname.replace(/^www\./, "");
            if (
              !domain.includes("bing.") && !domain.includes("microsoft.") &&
              !domain.includes("google.") && !domain.includes("amazon.") &&
              !domain.includes("facebook.") && !domain.includes("instagram.") &&
              !domain.includes("youtube.") && !domain.includes("reddit.") &&
              !domain.includes("wikipedia.") && !domain.includes("twitter.") &&
              !domain.includes("shopify.com") && !domain.endsWith(".gov") &&
              !domain.includes("pinterest.") && !domain.includes("tiktok.")
            ) {
              allDomains.add(domain);
            }
          } catch {}
        }
      }
    } catch {}

    await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));
  }

  return [...allDomains];
}

export async function runFullDiscovery() {
  const defaultQueries = pickRandom([
    "shopify beauty brand skincare",
    "shopify wellness store UK",
    "shopify cosmetics brand US",
    "indie beauty brand online store",
    "shopify skincare small business",
    "natural beauty shopify",
    "clean beauty brand online",
    "vegan skincare store",
    "organic beauty shop",
    "shopify hair care brand",
    "shopify fragrance brand",
    "DTC beauty brand",
    "new beauty brands 2025",
    "emerging skincare brands",
    "shopify beauty UK",
    "cruelty free beauty store",
    "shopify self care wellness",
    "shopify supplement vitamin store",
    "K-beauty online store",
    "shopify nail care brand",
    "shopify bath body store",
    "shopify sunscreen brand",
    "shopify essential oils",
    "shopify collagen supplement",
    "indie makeup online store",
    "shopify eyebrow lash brand",
    "shopify lip care store",
    "shopify scalp treatment",
    "clean skincare brand USA",
    "british beauty brand online",
  ], 10);

  const [sourceDomains, searchDomains] = await Promise.all([
    discoverFromSources(),
    discoverFromSearch(defaultQueries),
  ]);
  return [...new Set([...sourceDomains, ...searchDomains])];
}
