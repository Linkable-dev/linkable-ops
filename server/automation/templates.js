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
    subject_template: "idea for {{brandName}}",
    body_template: `Hi {{firstName}},

Been looking at {{brandName}} — love the {{productType}} range. Quick thought: do you know which of your creators actually drive sales?

We made something for this. Linkable plugs into Shopify and shows you exactly which creator brings in revenue, in real time. Payouts happen automatically too.

Might be useful for you: https://www.linkable.link

Best Regards,

Federico,
Founder at Linkable`,
  },
  {
    variant: "B",
    name: "Pain point — no link",
    subject_template: "quick one for {{brandName}}",
    body_template: `Hi {{firstName}},

Genuinely curious — how are you guys keeping track of which creators actually sell for {{brandName}}? Every {{productType}} brand I talk to says the same thing: spreadsheets, DMs, and a lot of guessing.

We made a Shopify app that fixes this. One brand went from "we think creators help" to "32% of our sales come from creators" — all tracked automatically.

Happy to show you if it's relevant?

Best Regards,

Federico,
Founder at Linkable`,
  },
  {
    variant: "C",
    name: "Social proof — with link",
    subject_template: "this worked really well for a {{productType}} brand",
    body_template: `Hi {{firstName}},

Thought this might be interesting — one of the brands on Linkable now tracks 32% of their total sales back to specific creators, all inside Shopify.

Before that they were doing what most brands do: posting, hoping, and manually chasing commissions. Now they see exactly who drives what.

If {{brandName}} works with creators, worth a peek: https://www.linkable.link

Best Regards,

Federico,
Founder at Linkable`,
  },
  {
    variant: "D",
    name: "Observation — no link",
    subject_template: "thought about {{brandName}}",
    body_template: `Hi {{firstName}},

{{observation}}

We made a Shopify app called Linkable that lets you see exactly which creators bring in revenue — and pays them automatically. Basically takes the guesswork out of creator partnerships.

Would love to show you how it works if you're up for it.

Best Regards,

Federico,
Founder at Linkable`,
  },
  {
    variant: "E",
    name: "Casual / founder — with link",
    subject_template: "{{brandName}} + creators",
    body_template: `Hi {{firstName}},

I'm Federico — I started Linkable because every {{productType}} brand I spoke to had the same frustration: creators posting about their products, but no real way to know if it actually drives sales.

So we built a Shopify app that connects the dots. You see which creators sell, how much, and payouts happen on their own.

If that sounds useful: https://www.linkable.link

Best Regards,

Federico,
Founder at Linkable`,
  },
];

// Determine the primary product type from matched keywords
export function getPrimaryProductType(matchedKeywords = [], sampleTypes = []) {
  const categories = {
    skincare: ["skincare", "skin care", "serum", "moisturizer", "moisturiser", "cleanser", "toner", "mask", "facial", "eye cream", "sunscreen", "spf", "retinol", "hyaluronic", "exfoliant", "anti-aging", "anti-ageing"],
    haircare: ["haircare", "hair care", "shampoo", "conditioner", "hair oil", "scalp"],
    makeup: ["makeup", "make-up", "cosmetics", "foundation", "concealer", "blush", "bronzer", "mascara", "eyeliner", "eyeshadow", "lipstick", "lip gloss", "primer", "setting spray"],
    fragrance: ["fragrance", "perfume", "aromatherapy", "essential oil"],
    wellness: ["wellness", "supplement", "vitamin", "collagen", "probiotic"],
    bodycare: ["body care", "bodycare", "bath", "shower", "self-tan"],
    grooming: ["beard", "men's grooming"],
    beauty: ["beauty", "natural beauty", "vegan beauty", "cruelty-free", "organic"],
    nail: ["nail"],
  };

  const all = [...matchedKeywords, ...sampleTypes].map(k => k.toLowerCase());

  let best = "beauty";
  let bestCount = 0;
  for (const [category, keywords] of Object.entries(categories)) {
    const count = keywords.filter(kw => all.some(a => a.includes(kw))).length;
    if (count > bestCount) { best = category; bestCount = count; }
  }

  return best;
}

// Pick a template variant using round-robin for even A/B distribution
export function pickTemplate(contactIndex, activeTemplates = TEMPLATES) {
  return activeTemplates[contactIndex % activeTemplates.length];
}
