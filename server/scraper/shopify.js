import { enqueue } from "./queue.js";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const BEAUTY_KEYWORDS = [
  "beauty", "skincare", "skin care", "haircare", "hair care", "makeup", "make-up",
  "cosmetics", "wellness", "fragrance", "perfume", "body care", "bodycare",
  "serum", "moisturizer", "moisturiser", "cleanser", "toner", "mask", "facial",
  "lip", "eye cream", "sunscreen", "spf", "self-tan", "bath", "shower",
  "essential oil", "aromatherapy", "supplement", "vitamin", "collagen",
  "probiotic", "nail", "spa", "organic", "natural beauty", "vegan beauty",
  "cruelty-free", "anti-aging", "anti-ageing", "retinol", "hyaluronic",
  "exfoliant", "foundation", "concealer", "blush", "bronzer", "mascara",
  "eyeliner", "eyeshadow", "lipstick", "lip gloss", "primer", "setting spray",
  "shampoo", "conditioner", "hair oil", "scalp", "beard", "men's grooming",
];

export async function isShopifyStore(domain) {
  return enqueue(async () => {
    try {
      const res = await fetch(`https://${domain}/products.json?limit=1`, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = await res.json();
        return Array.isArray(data.products);
      }
      return false;
    } catch {
      // Fallback: check HTML for Shopify signatures
      try {
        const html = await fetch(`https://${domain}`, {
          headers: { "User-Agent": UA },
          signal: AbortSignal.timeout(8000),
        }).then(r => r.text());
        return html.includes("cdn.shopify.com") || html.includes("Shopify.shop") || html.includes("shopify-section");
      } catch {
        return false;
      }
    }
  });
}

export async function fetchProducts(domain) {
  const allProducts = [];
  let page = 1;
  const maxPages = 10; // cap to avoid huge stores

  while (page <= maxPages) {
    const products = await enqueue(async () => {
      try {
        const res = await fetch(`https://${domain}/products.json?limit=250&page=${page}`, {
          headers: { "User-Agent": UA },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return [];
        const data = await res.json();
        return data.products || [];
      } catch {
        return [];
      }
    });

    if (products.length === 0) break;
    allProducts.push(...products);
    page++;
  }

  return allProducts;
}

export function classifyBeautyWellness(products) {
  if (!products.length) return { score: 0, matchedKeywords: [], sampleTypes: [] };

  const typeSet = new Set();
  const tagSet = new Set();
  let matchCount = 0;

  for (const p of products) {
    const pType = (p.product_type || "").toLowerCase();
    const pTags = (p.tags || []).map(t => (typeof t === "string" ? t : "").toLowerCase());
    const pTitle = (p.title || "").toLowerCase();
    const pBody = (p.body_html || "").toLowerCase().slice(0, 500); // limit body scan

    if (pType) typeSet.add(pType);
    pTags.forEach(t => tagSet.add(t));

    const combined = `${pType} ${pTags.join(" ")} ${pTitle} ${pBody}`;
    const matched = BEAUTY_KEYWORDS.some(kw => combined.includes(kw));
    if (matched) matchCount++;
  }

  const score = matchCount / products.length;
  const matchedKeywords = BEAUTY_KEYWORDS.filter(kw => {
    const allText = [...typeSet, ...tagSet].join(" ");
    return allText.includes(kw);
  });

  return {
    score: Math.round(score * 100) / 100,
    matchedKeywords: matchedKeywords.slice(0, 10),
    sampleTypes: [...typeSet].slice(0, 10),
  };
}

export function estimateRevenue(products) {
  if (!products.length) return { estimated: 0, aov: 0, productCount: 0, method: "none" };

  // Calculate AOV from variant prices
  const prices = [];
  for (const p of products) {
    for (const v of (p.variants || [])) {
      const price = parseFloat(v.price);
      if (price > 0 && price < 1000) prices.push(price);
    }
  }

  if (!prices.length) return { estimated: 0, aov: 0, productCount: products.length, method: "no_prices" };

  // Sort prices to get median (more stable than mean for beauty with wide ranges)
  prices.sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  // Cart AOV is typically 1.5-2.5x individual product price in beauty
  const cartAOV = Math.max(median, mean) * 1.8;
  const productCount = products.length;

  // Revenue estimation based on store maturity signals:
  // - Product count is the strongest free signal for store size
  // - Beauty DTC brands with ~50k/mo revenue typically have 30-150 products
  // - Estimated daily orders based on catalog size (beauty DTC benchmarks):
  //   <15 products:  5-15 orders/day   (just launched or very niche)
  //   15-50 products: 10-30 orders/day  (growing brand)
  //   50-150 products: 20-50 orders/day (established mid-tier)
  //   150-500 products: 40-100 orders/day (mature brand)
  //   500+ products: 80-300+ orders/day (major brand)
  let dailyOrders;
  if (productCount <= 15) dailyOrders = 8;
  else if (productCount <= 50) dailyOrders = 20;
  else if (productCount <= 150) dailyOrders = 35;
  else if (productCount <= 500) dailyOrders = 70;
  else dailyOrders = 150;

  const estimated = Math.round(cartAOV * dailyOrders * 30);

  return {
    estimated,
    aov: Math.round(cartAOV * 100) / 100,
    productPrice: Math.round(median * 100) / 100,
    productCount,
    dailyOrdersEst: dailyOrders,
    method: "catalog_size_heuristic",
  };
}

export function detectGeo(domain, products) {
  // Check domain TLD
  const isUK = domain.endsWith(".co.uk") || domain.endsWith(".uk");
  const isUSdomain = domain.endsWith(".com") || domain.endsWith(".us");

  // Check currency from product variants
  const currencies = new Set();
  for (const p of products.slice(0, 20)) {
    for (const v of (p.variants || [])) {
      if (v.presentment_prices) {
        for (const pp of v.presentment_prices) {
          if (pp.price?.currency_code) currencies.add(pp.price.currency_code);
        }
      }
    }
  }

  const hasGBP = currencies.has("GBP");
  const hasUSD = currencies.has("USD");

  // Determine country
  let country = "Unknown";
  let confidence = 0.3;

  if (isUK || hasGBP) {
    country = "UK";
    confidence = isUK && hasGBP ? 0.95 : 0.7;
  } else if (isUSdomain || hasUSD) {
    country = "US";
    confidence = hasUSD ? 0.8 : 0.5;
  }

  // Check product body for shipping/location hints
  const sampleText = products.slice(0, 5).map(p => (p.body_html || "").toLowerCase()).join(" ");
  if (sampleText.includes("united kingdom") || sampleText.includes("uk shipping")) {
    country = "UK"; confidence = Math.max(confidence, 0.8);
  }
  if (sampleText.includes("united states") || sampleText.includes("us shipping") || sampleText.includes("free shipping usa")) {
    country = "US"; confidence = Math.max(confidence, 0.8);
  }

  return {
    country,
    confidence: Math.round(confidence * 100) / 100,
    currencies: [...currencies],
    tld: domain.split(".").slice(-1)[0],
  };
}

export async function analyzeDomain(domain) {
  const cleanDomain = domain.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");

  const shopify = await isShopifyStore(cleanDomain);
  if (!shopify) return { domain: cleanDomain, shopify: false, skip: true, reason: "Not a Shopify store" };

  const products = await fetchProducts(cleanDomain);
  if (!products.length) return { domain: cleanDomain, shopify: true, skip: true, reason: "No products found" };

  const beauty = classifyBeautyWellness(products);
  const revenue = estimateRevenue(products);
  const geo = detectGeo(cleanDomain, products);

  // Extract store name from first product vendor or domain
  const storeName = products[0]?.vendor || cleanDomain.split(".")[0].replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());

  return {
    domain: cleanDomain,
    shopify: true,
    skip: false,
    storeName,
    productCount: products.length,
    beautyScore: beauty.score,
    matchedKeywords: beauty.matchedKeywords,
    sampleTypes: beauty.sampleTypes,
    estimatedRevenue: revenue.estimated,
    aov: revenue.aov,
    revenueMethod: revenue.method,
    country: geo.country,
    geoConfidence: geo.confidence,
    currencies: geo.currencies,
    scrapedAt: new Date().toISOString(),
  };
}
