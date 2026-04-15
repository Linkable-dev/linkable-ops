// 5 A/B test email templates for cold outreach
// Linkable = creator affiliate platform for Shopify ecommerce brands
// Turn creator partnerships into a measurable, trackable sales channel
//
// A/B mix: A, C have link — B, D, E are no-link (reply-driven)
//
// Available placeholders:
//   {{brandName}}      - The brand/store name
//   {{firstName}}      - Contact's first name (or "there" fallback)
//   {{domain}}         - Brand's website domain
//   {{productType}}    - Main product category (e.g. "skincare", "haircare")
//   {{country}}        - US or UK
//   {{observation}}    - AI-generated specific observation about the brand

export const TEMPLATES = [
  {
    variant: "A",
    name: "Direct — with link",
    subject_template: "A thought for the {{brandName}} team",
    body_template: `Hi {{firstName}},

I hope this finds you well. I came across {{brandName}} recently and was genuinely impressed by what you're building in the {{productType}} space.

I wanted to reach out because I think something we've built might be useful to you. Linkable is a Shopify app that helps brands understand which of their creator partnerships actually drive sales, with attribution, reporting, and automated payouts all in one place.

If you'd like to take a look, you can find us here: https://www.linkable.link

Thank you for your time.

Best Regards,

Federico,
Founder at Linkable`,
  },
  {
    variant: "B",
    name: "Pain point — no link",
    subject_template: "A question about creator attribution at {{brandName}}",
    body_template: `Hi {{firstName}},

I hope you're doing well. I wanted to reach out with a question I've been asking a lot of {{productType}} founders lately: how do you currently track which of your creator partnerships actually drive sales?

Most teams I speak with tell me the same thing — it's a mix of spreadsheets, DMs, and educated guesses. It's something we've been working to solve with Linkable, a Shopify app that gives brands clear visibility into creator-driven revenue and handles payouts automatically.

If this is something you're thinking about, I'd be happy to share more.

Best Regards,

Federico,
Founder at Linkable`,
  },
  {
    variant: "C",
    name: "Social proof — with link",
    subject_template: "A {{productType}} brand attributed 32% of sales to creators",
    body_template: `Hi {{firstName}},

I wanted to share a quick story that made me think of {{brandName}}. One of the founders we work with recently told me that 32% of their sales now come directly through creator partnerships — and for the first time, they can see exactly which creators are driving revenue.

We built Linkable to make this possible for Shopify brands: clear attribution, real reporting, and automated payouts for creators.

If you'd like to see how it works: https://www.linkable.link

Best Regards,

Federico,
Founder at Linkable`,
  },
  {
    variant: "D",
    name: "Observation — no link",
    subject_template: "A note about {{brandName}}",
    body_template: `Hi {{firstName}},

{{observation}}

I'm the founder of Linkable, a Shopify app built to help brands like yours turn creator partnerships into a measurable sales channel, with attribution, reporting, and payouts all handled in one place.

If it sounds relevant, I'd love to show you how it could work for {{brandName}}.

Best Regards,

Federico,
Founder at Linkable`,
  },
  {
    variant: "E",
    name: "Casual / founder — with link",
    subject_template: "Introducing Linkable to the {{brandName}} team",
    body_template: `Hi {{firstName}},

My name is Federico, and I'm the founder of Linkable. I started this company after speaking with dozens of DTC founders who all shared the same frustration: creators were posting about their products, but there was no reliable way to know if those partnerships were actually driving sales.

Linkable solves exactly that. It's a Shopify app that gives brands full visibility into creator-driven revenue and automates the payout process.

If this is something {{brandName}} might benefit from, you can learn more here: https://www.linkable.link

Thank you for your time.

Best Regards,

Federico,
Founder at Linkable`,
  },
];

// Determine the primary product type from keywords, sample types, and brand text
export function getPrimaryProductType(matchedKeywords = [], sampleTypes = [], brandText = "") {
  const categories = {
    skincare: ["skincare", "skin care", "serum", "moisturizer", "moisturiser", "cleanser", "toner", "mask", "facial", "eye cream", "sunscreen", "spf", "retinol", "hyaluronic", "exfoliant", "anti-aging", "anti-ageing"],
    haircare: ["haircare", "hair care", "shampoo", "conditioner", "hair oil", "scalp", "curl", "hair growth"],
    makeup: ["makeup", "make-up", "cosmetics", "foundation", "concealer", "blush", "bronzer", "mascara", "eyeliner", "eyeshadow", "lipstick", "lip gloss", "primer", "setting spray"],
    fragrance: ["fragrance", "perfume", "aromatherapy", "essential oil", "cologne", "scent"],
    wellness: ["wellness", "supplement", "vitamin", "collagen", "probiotic", "adaptogen", "mushroom", "gut health"],
    bodycare: ["body care", "bodycare", "bath", "shower", "self-tan", "deodorant", "lotion"],
    grooming: ["beard", "men's grooming", "shave", "razor", "aftershave"],
    beauty: ["beauty", "natural beauty", "vegan beauty", "cruelty-free"],
    nail: ["nail", "manicure", "polish"],
    fashion: ["clothing", "apparel", "dress", "shirt", "pants", "jeans", "jacket", "hoodie", "tee", "activewear", "athleisure", "swimwear", "loungewear", "streetwear"],
    jewelry: ["jewelry", "jewellery", "ring", "necklace", "bracelet", "earring", "gold", "silver", "diamond", "gemstone"],
    food: ["food", "snack", "chocolate", "candy", "sauce", "spice", "meal", "protein bar", "granola", "chips"],
    beverage: ["coffee", "tea", "drink", "juice", "water", "soda", "kombucha", "matcha", "latte", "espresso", "brew"],
    fitness: ["fitness", "gym", "workout", "exercise", "recovery", "muscle", "training", "yoga"],
    pet: ["pet", "dog", "cat", "puppy", "kitten", "pet food", "treats"],
    baby: ["baby", "toddler", "infant", "kids", "children", "nursery"],
    home: ["home", "candle", "bedding", "kitchen", "cookware", "decor", "furniture", "pillow", "blanket", "towel"],
    travel: ["luggage", "travel", "suitcase", "backpack", "bag"],
    outdoor: ["outdoor", "camping", "hiking", "adventure", "water bottle"],
    sleep: ["sleep", "mattress", "pillow", "bedding", "rest"],
  };

  const all = [...matchedKeywords, ...sampleTypes, ...brandText.toLowerCase().split(/\s+/)].map(k => k.toLowerCase());

  let best = null;
  let bestCount = 0;
  for (const [category, keywords] of Object.entries(categories)) {
    const count = keywords.filter(kw => all.some(a => a.includes(kw))).length;
    if (count > bestCount) { best = category; bestCount = count; }
  }

  return best || "ecommerce";
}

// Pick a template variant using round-robin for even A/B distribution
export function pickTemplate(contactIndex, activeTemplates = TEMPLATES) {
  return activeTemplates[contactIndex % activeTemplates.length];
}
