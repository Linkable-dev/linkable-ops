// 6 templates — optimized for REPLY and CONVERSION
// 18% open rate = subjects work. Fix: body must trigger action.
//
// Each template uses a different psychological angle:
// A = Curiosity gap (make them NEED to know)
// B = FOMO (others are doing it, you're not)
// C = Mirror their pain (feel understood → trust → action)
// D = Give value first (observation shows you did homework)
// E = Direct ask (respect their time, make it easy)
// F = Risk reversal (nothing to lose)

export const TEMPLATES = [
  {
    variant: "A",
    name: "Curiosity gap",
    subject_template: "{{brandName}} — one question",
    body_template: `Hi {{firstName}},

What percentage of {{brandName}}'s sales come from creators?

If you don't know the exact number, that's the problem we solve. Linkable plugs into Shopify and shows you in real time.

Takes 2 minutes to set up: https://linkable.link

Federico`,
  },
  {
    variant: "B",
    name: "FOMO",
    subject_template: "Your competitors are tracking this",
    body_template: `Hi {{firstName}},

Other {{productType}} brands are using Linkable to see exactly which creators drive sales — and cutting the ones that don't.

{{brandName}} could be doing the same. It takes 2 minutes to connect to Shopify.

https://linkable.link

Federico`,
  },
  {
    variant: "C",
    name: "Mirror pain",
    subject_template: "The creator problem at {{brandName}}",
    body_template: `Hi {{firstName}},

You send products to creators. They post. You see likes and comments. But when it comes to actual sales — you have no idea who's driving what.

Sound familiar? That's exactly why I built Linkable. It connects to Shopify and gives you the answer.

2-minute setup, free to try: https://linkable.link

Federico`,
  },
  {
    variant: "D",
    name: "Personalized observation",
    subject_template: "{{brandName}} + Linkable",
    body_template: `Hi {{firstName}},

{{observation}}

I built Linkable to help brands like {{brandName}} see exactly which creators drive revenue. It connects to Shopify in 2 minutes.

Worth a look? https://linkable.link

Or I can show you in 15 min: https://calendly.com/federico-linkable/linkable-demo?utm_source=outreach

Federico`,
  },
  {
    variant: "E",
    name: "Respectful direct ask",
    subject_template: "15 minutes — Linkable for {{brandName}}",
    body_template: `Hi {{firstName}},

I'll keep this short. Linkable is a Shopify app that shows you which creators drive sales and automates their payouts.

I'd love 15 minutes to show you how it works for {{brandName}}:

https://calendly.com/federico-linkable/linkable-demo?utm_source=outreach

If now's not the right time, no worries at all.

Federico`,
  },
  {
    variant: "F",
    name: "Risk reversal",
    subject_template: "Free to try, nothing to install — {{brandName}}",
    body_template: `Hi {{firstName}},

Linkable connects to your Shopify store in 2 minutes. You'll immediately see which creators drive actual sales — not just engagement.

No contract. No credit card. 30-day money-back guarantee.

https://linkable.link

If it's not useful, just disconnect. But most brands are surprised by what they find.

Federico`,
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

// ---------- 3-touch sequence templates (G1/G2/G3 × T1/T2/T3) ----------
//
// These drive the new multi-touch sequencer. Each row has a stable key
// `{group}-T{touch}` so the orchestrator can pick the right body for
// (brand_group, touch_number).
//
// All bodies use the existing placeholder set: {{brandName}}, {{firstName}},
// {{productType}}, {{observation}}. ROI argument is conditional on the
// power-law premise (defensible without internal data).

export const SEQUENCE_TEMPLATES = [
  // ----- G1 · Creator-active -----
  {
    key: "G1-T1",
    group: "G1",
    touch: 1,
    name: "G1 · Free creator audit",
    subject_template: "which {{brandName}} creators actually convert?",
    body_template: `Hi {{firstName}},

You're paying creators — in product, fees, or commissions — based on engagement metrics that have zero correlation with sales. If you're like most brands, ~5% of your creators drive ~80% of your creator-attributed revenue. The rest is noise you're paying for.

Send me your top 3 creator handles. I'll come back with their actual conversion numbers. Free, no call.

Federico`,
  },
  {
    key: "G1-T2",
    group: "G1",
    touch: 2,
    name: "G1 · Trial with ROI math",
    subject_template: "2-min Shopify install — {{brandName}}",
    body_template: `Hi {{firstName}},

Quick math: if {{brandName}} gifts 50 creators a month and only 5 drive most of the revenue, you're spending 90% of your creator budget on the wrong people.

Linkable plugs into Shopify in 2 minutes and tells you exactly which is which. Cut the dead weight, double down on the winners.

No card, 30-day money-back: https://linkable.link

Federico`,
  },
  {
    key: "G1-T3",
    group: "G1",
    touch: 3,
    name: "G1 · Reply ask",
    subject_template: "last note — {{brandName}}",
    body_template: `Hi {{firstName}},

15 minutes to see exactly which {{brandName}} creators are converting and which you should stop paying.

Reply yes and I'll send a calendar link.

Federico`,
  },

  // ----- G2 · Summer-seasonal -----
  {
    key: "G2-T1",
    group: "G2",
    touch: 1,
    name: "G2 · Summer window + trial",
    subject_template: "{{brandName}}'s summer creator window",
    body_template: `Hi {{firstName}},

The next 8 weeks are your peak revenue window for {{productType}}. If you're using creators to drive summer sales, most of that budget will go to partners who don't actually convert — that's just how creator performance distributes.

Linkable shows you in real time which creators move Shopify revenue. Cut the dead weight before peak, double down on the winners.

2-min install, free: https://linkable.link

Federico`,
  },
  {
    key: "G2-T2",
    group: "G2",
    touch: 2,
    name: "G2 · Power law + trial",
    subject_template: "most of your creator spend is wasted",
    body_template: `Hi {{firstName}},

Creator-driven revenue follows a brutal power law — a small handful of partners drive most of the sales, and the rest are dead weight you're paying for in product, time, and commission.

For a {{productType}} brand at peak summer, that waste compounds week by week. Linkable shows you who's converting, on Shopify, in real time.

2-min install, free: https://linkable.link

Federico`,
  },
  {
    key: "G2-T3",
    group: "G2",
    touch: 3,
    name: "G2 · Summer deadline reply ask",
    subject_template: "summer's almost here — {{brandName}}",
    body_template: `Hi {{firstName}},

Every week before peak that you don't know which creators convert is a week of wasted spend on the ones that don't.

Reply and I'll set you up in 15 minutes — by next week you'll know exactly who's worth paying.

Federico`,
  },

  // ----- G3 · Cold catch-all -----
  {
    key: "G3-T1",
    group: "G3",
    touch: 1,
    name: "G3 · Observation + trial",
    subject_template: "{{brandName}} + Linkable",
    body_template: `Hi {{firstName}},

{{observation}}

If {{brandName}} works with creators or affiliates, you're almost certainly overpaying — most brands have no idea which partners actually drive Shopify revenue, so the budget gets spread across people who do nothing.

Linkable plugs into Shopify in 2 minutes and shows you who's actually converting. 30-day money-back guarantee: https://linkable.link

Federico`,
  },
  {
    key: "G3-T2",
    group: "G3",
    touch: 2,
    name: "G3 · Demo with power-law ROI",
    subject_template: "15 min on creator attribution — {{brandName}}",
    body_template: `Hi {{firstName}},

If creator performance follows a power law at {{brandName}} — as it does for most brands — you're paying for 70–90% of partners who drive almost nothing.

15 min and I'll show you what {{brandName}}'s creator data would look like inside Linkable: https://calendly.com/federico-linkable/linkable-demo?utm_source=outreach

Federico`,
  },
  {
    key: "G3-T3",
    group: "G3",
    touch: 3,
    name: "G3 · Reply ask",
    subject_template: "final note — {{brandName}}",
    body_template: `Hi {{firstName}},

Is "are we overpaying creators?" a question {{brandName}} cares about?

Yes or no. I'll stop reaching out either way.

Federico`,
  },

  // ----- T4 · Breakup touch (T+12) -----
  //
  // Sent ~5 days after T3. Pure pressure-removal: acknowledges silence,
  // closes the loop, leaves a low-cost door open. Historically the highest
  // reply-rate-per-send touch in a sequence because it costs nothing to
  // answer and the buyer no longer feels chased. Same body for all groups
  // would work, but a one-line group-specific hook before the breakup keeps
  // it consistent with the angle the prospect saw in T1-T3.
  {
    key: "G1-T4",
    group: "G1",
    touch: 4,
    name: "G1 · Breakup",
    subject_template: "closing this out — {{brandName}}",
    body_template: `Hi {{firstName}},

I'll stop here — clearly creator attribution isn't a priority right now, and that's fine.

If it ever becomes a question — which creators at {{brandName}} are actually driving Shopify revenue versus the ones just posting — just reply "later" and I'll circle back next quarter. No follow-up otherwise.

Federico`,
  },
  {
    key: "G2-T4",
    group: "G2",
    touch: 4,
    name: "G2 · Breakup",
    subject_template: "closing this out — {{brandName}}",
    body_template: `Hi {{firstName}},

I'll stop here — peak summer is busy and this clearly isn't the priority.

If knowing which creators converted during peak ever becomes useful — for next year's planning, budget review, anything — reply "later" and I'll circle back. No follow-up otherwise.

Federico`,
  },
  {
    key: "G3-T4",
    group: "G3",
    touch: 4,
    name: "G3 · Breakup",
    subject_template: "closing this out — {{brandName}}",
    body_template: `Hi {{firstName}},

I'll stop here — if creator-led revenue isn't on the roadmap for {{brandName}} right now, no problem.

If it ever becomes a priority — even six months out — just reply "later" and I'll circle back. No follow-up otherwise.

Federico`,
  },
];

// Look up the template for a (group, touch) pair. Returns null if missing —
// caller should treat that as a config error, not a fallback opportunity.
export function getSequenceTemplate(group, touch) {
  return SEQUENCE_TEMPLATES.find((t) => t.group === group && t.touch === touch) || null;
}
