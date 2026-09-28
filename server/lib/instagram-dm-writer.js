// Drafts the first Instagram DM to a brand we might sell Linkable to.
//
// The manual version of this took about three minutes a message: find the
// brand's post asking for creators, screenshot it, paste the screenshot into a
// chatbot with the category, name and location, copy the answer into
// Instagram. Everything in that loop except the send is here. The send cannot
// be: Instagram's API only lets a business reply inside 24 hours of the other
// side writing first, so a cold DM is sent by a person or not at all.
//
// The draft is built ONLY from the lead row - what the pipeline observed - and
// the live creator count (creator-pool.js). The shape is Federico's own DMs;
// the only claims about Linkable are the ones in that shape. Nothing the
// browser sends reaches the prompt except the choice of language.

import { claudeMessage, cachedSystem } from "./anthropic.js";
import { sanitizeStyle, findStyleIssues } from "../automation/conversation-ai.js";
import { VERTICALS } from "./verticals.js";

export const DM_MODEL = "claude-sonnet-5";
// Sonnet list price, $/million tokens. Mirrors PRICE in nudge-writer.js.
const PRICE = { in: 2, out: 10 };

// A DM is read on a phone, in a list of requests from strangers. These are
// the body, before the signature the code appends. The model is asked for
// TARGET; a draft over MAX is refused and written again.
export const TARGET_DM_CHARS = 380;
export const MAX_DM_CHARS = 520;

// Who the DM is from. Appended by code, not written by the model, so it is the
// same on every message and never a name the model picked.
export function signature() {
  const name = process.env.PROSPECTOR_DM_SENDER_NAME || "Federico";
  const title = process.env.PROSPECTOR_DM_SENDER_TITLE || "Founder @ Linkable";
  return `${name}\n${title}`;
}

export const LANGUAGES = { en: "British English", it: "Italian" };

// Which language a brand is written to in. By the country the pipeline
// resolved for the store, because that is where its customers are; anything
// not listed gets English.
const LANGUAGE_BY_COUNTRY = { IT: "it", SM: "it", VA: "it" };

// Words common in Italian and rare in English. Used only when the store gave
// no country - brands not on Shopify are never enriched, so for them the
// caption and the bio are the only evidence of where they are.
const ITALIAN_WORDS = /\b(il|gli|che|per|con|siamo|cerchiamo|cercasi|della|delle|nostro|nostra|nostri|sono|anche|più|questo|nuova|nuovo|spedizione|scopri|ciao)\b/gi;

export function languageFor(lead) {
  const byCountry = LANGUAGE_BY_COUNTRY[String(lead?.country || "").toUpperCase()];
  if (byCountry || lead?.country) return byCountry || "en";
  const text = `${lead?.intent_caption || ""} ${lead?.ig_biography || ""}`;
  return (text.match(ITALIAN_WORDS) || []).length >= 3 ? "it" : "en";
}

const DRAFT_TOOL = {
  name: "draft_dm",
  description: "Return the finished Instagram message.",
  input_schema: {
    type: "object",
    properties: {
      message: { type: "string", description: "The DM exactly as it will be pasted. Plain text." },
    },
    required: ["message"],
  },
};

// The house style is Federico's own DMs, the ones he sent by hand. Their
// numbers are replaced with [N] here: the examples teach the shape, and the
// number comes from the live creator count in the facts, never from a sample.
const SYSTEM = `You write the first Instagram DM from Linkable to an ecommerce brand
that has never heard of us. It is sent by Federico, Linkable's founder, from his
own account, and it must read like the ones he writes by hand.

His DMs, which are the house style (numbers replaced with [N]):

---
Hey Izzy Rose Skin! Quick question.

We already have [N]+ skincare, beauty and wellness creators interested in creating content around clean skincare brands like Izzy Rose Skin and promoting their products on a commission basis.

Brands typically start receiving creator applications within 24 hours.

Would you be open to giving it a try?
---
Hey ddg!

Just came across your post looking for new brand ambassadors.

We have [N]+ beauty and skincare creators on Linkable who can apply to collaborate with ddg, create content around your products and promote them to their audiences. Brands typically start receiving creator applications within 24 hours.

Would you be open to giving it a try?
---
Hey Still Skin!

Quick question.

We already have [N]+ beauty, skincare and lifestyle creators interested in creating content around Still Skin and promoting your products on a commission basis.

Brands typically start receiving creator applications within 24 hours.

Would you be open to giving it a try?
---

The shape, every time:
1. "Hey {brand}!" with the brand's name as the brand itself writes it (keep
   their casing, drop taglines after | or -). Then "Quick question." when
   there is no post to mention.
2. When the facts include a post where they asked for creators, ambassadors or
   UGC: "Just came across your post looking for ..." naming what the post
   actually asked for, in a few words. Never claim a post the facts do not give.
3. The creator line: we have [N]+ {niche} creators on Linkable who can apply to
   collaborate with {brand}, create content around their products and promote
   them on a commission basis. [N] and the niche words come ONLY from the
   "Creators on Linkable" facts, copied exactly. Pick the niche line that fits
   this brand; if none fits, use the all-niches number and just say
   "creators". If the facts give no number, write the sentence without one.
4. "Brands typically start receiving creator applications within 24 hours."
5. "Would you be open to giving it a try?"

Rules:
- Body under ${TARGET_DM_CHARS} characters. Do NOT sign it: the signature is
  added after you.
- No other claims about Linkable: no prices, no free trial, no "free to get
  started", no features, no numbers except the one from the facts.
- You cannot see their posts, photos or videos. Never compliment their content.
- Never write a URL, an email address or a phone number, and never mention a
  handle.
- No markdown, no hashtags, no em dashes. The only exclamation mark is the one
  after the greeting.
- Write in the language you are told to use. In Italian keep the same shape in
  natural Italian ("Ciao {brand}!", "voi" for the brand), not a word-for-word
  translation.

Call draft_dm with the finished body.`;

const clean = (value) => {
  const text = String(value ?? "").trim();
  return text && text !== "None" ? text : "";
};

export function brandNameFor(lead) {
  const name = clean(lead.brand_name) || clean(lead.ig_full_name) || clean(lead.domain) || lead.handle;
  // og:site_name is often all lower case; a name its owner shouts is left alone.
  return name === name.toLowerCase() ? name.replace(/\b\w/g, (c) => c.toUpperCase()) : name;
}

function creatorHandles(lead) {
  return String(lead.top_creators || "")
    .split(",")
    .map((h) => h.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean)
    .slice(0, 3);
}

// Every line is something the operator could have read off the lead.
export function factSheet(lead, { language, pool } = {}) {
  const lines = [];
  lines.push(`Brand: ${brandNameFor(lead)} (@${lead.handle} on Instagram)`);
  // How the brand names itself on Instagram, which is what the greeting uses.
  if (clean(lead.ig_full_name)) lines.push(`Their Instagram display name: ${clean(lead.ig_full_name)}`);
  if (VERTICALS[lead.vertical]) {
    lines.push(`Their vertical: ${VERTICALS[lead.vertical]} (pick the creator niche line that matches it)`);
  }
  if (clean(lead.country)) lines.push(`Country of the store: ${lead.country}`);
  if (clean(lead.ig_category)) lines.push(`Instagram category: ${lead.ig_category}`);
  if (clean(lead.ig_biography)) lines.push(`Their Instagram bio: "${clean(lead.ig_biography).slice(0, 400)}"`);
  const onShopify = lead.status !== "not_shopify";
  if (onShopify && clean(lead.domain)) {
    lines.push(`Store: ${lead.domain} (a Shopify store${lead.product_count ? `, ${lead.product_count} products` : ""})`);
  } else if (!onShopify) {
    lines.push(`Their store${clean(lead.domain) ? ` (${lead.domain})` : ""} is NOT on Shopify. Do not mention Shopify, and do not claim Linkable connects to their store, syncs their catalogue or tracks their sales.`);
  }

  // A call from months ago is not "your post" any more - keyword search finds
  // them years old - so an old one is left out and the DM opens without it.
  const callAgeDays = lead.intent_posted_at
    ? (Date.now() - new Date(lead.intent_posted_at).getTime()) / 86_400_000 : 0;
  if (lead.intent_signal === "open_call" && callAgeDays > 90) {
    // Nothing: as if we had not seen it.
  } else if (lead.intent_signal === "open_call" && clean(lead.intent_caption)) {
    lines.push("");
    lines.push("They recently posted asking for creators. Their caption:");
    lines.push(`"${clean(lead.intent_caption).slice(0, 900)}"`);
  } else if (lead.intent_signal === "open_call") {
    lines.push("");
    lines.push("They recently posted asking for creators (the caption was not captured).");
  }

  lines.push("");
  if (pool?.total) {
    lines.push("Creators on Linkable (the ONLY numbers you may use, exactly as written):");
    lines.push(`- all niches: ${pool.total.toLocaleString("en-GB")}+`);
    for (const niche of pool.niches || []) {
      lines.push(`- ${niche.label}: ${niche.count.toLocaleString("en-GB")}+`);
    }
  } else {
    lines.push("Creators on Linkable: no count available. Do not state any number of creators.");
  }

  lines.push("");
  lines.push(`Write in: ${LANGUAGES[language] || LANGUAGES.en}`);
  return lines.join("\n");
}

// A bare domain counts as a link. An Instagram handle that happens to end in
// ".shop" does not, hence the lookbehind.
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|(?<![@\w.-])[\w-][\w.-]*\.(?:com|co\.uk|link|io|it|shop|store)\b\S*/gi;

// What the model returned, checked before anybody pastes it. A link is refused
// rather than cut out: one it invents sends a brand to a dead page from our
// account, and cutting it leaves "more at ." in the sentence. A handle it was
// not given is refused too, since "@someone posted about you" is a claim, and
// a false one ends the conversation.
export function finishDraft(raw, lead) {
  let message = sanitizeStyle(String(raw || "").replace(/[ \t]+\n/g, "\n"));
  message = message.replace(/\n{3,}/g, "\n\n").trim();
  // A signature the model wrote anyway comes off; the real one goes on after.
  const [sender] = signature().split("\n");
  message = message.replace(new RegExp(`\\n+${sender}\\b[\\s\\S]*$`), "").trim();

  const problems = [];
  if (!message) problems.push("empty message");
  const links = message.match(URL_RE);
  if (links) problems.push(`wrote a link: ${links.join(", ")}`);
  if (message.length > MAX_DM_CHARS) problems.push(`too long (${message.length} characters)`);

  const allowed = new Set([String(lead.handle).toLowerCase(), ...creatorHandles(lead)]);
  const mentioned = [...message.matchAll(/@([A-Za-z0-9._]+)/g)].map((m) => m[1].replace(/\.$/, "").toLowerCase());
  const invented = mentioned.filter((h) => !allowed.has(h));
  if (invented.length) problems.push(`mentions handles it was not given: ${invented.join(", ")}`);

  return { message, problems, styleIssues: findStyleIssues(message) };
}

// Two ways of writing the first message, so reply rates can be compared. A is
// Federico's own shape, unchanged. B is the same claims in three lines, the
// question first: the bet is that a shorter message reads less like outreach.
export const VARIANTS = {
  A: "",
  B: [
    "Variant B for this one: the same greeting, then at most three short lines",
    "in total. Line 1: the post they made, or what they sell. Line 2: the creator",
    "line and the 24 hours in one sentence. Line 3: \"Worth a try?\" (or the",
    "natural equivalent in the language you are told to use). No \"Quick question\".",
  ].join(" "),
};
export const pickVariant = () => (Math.random() < 0.5 ? "A" : "B");

// The one follow-up, for a brand that did not answer the first DM.
const FOLLOWUP_INSTRUCTION = [
  "This is a FOLLOW-UP to the first message below, which got no answer.",
  "Write at most three short lines, with no greeting paragraph: open with",
  "\"Hey {brand}\", then bring the first message back in one line from a",
  "different angle (for example that setting up a campaign takes a few minutes,",
  "or that they only choose the creators they like), then an easy yes/no",
  "question. Make no claim that is not in the first message or the facts. Do",
  "not apologise for following up and do not say \"just checking in\".",
].join(" ");

// → { message, language, model, costUsd, styleIssues, variant }
export async function draftInstagramDm(lead, { language, pool, variant = "A", followUp = false } = {}) {
  const lang = LANGUAGES[language] ? language : languageFor(lead);
  const facts = factSheet(lead, { language: lang, pool });
  const extra = followUp
    ? `${FOLLOWUP_INSTRUCTION}\n\nThe first message:\n"""${String(lead.dm_text || "").trim()}"""`
    : VARIANTS[variant] || "";

  // Two attempts: the second only when the first broke a rule we check in
  // code, which is rare and cheaper than a person catching it.
  let last;
  let cost = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await claudeMessage({
      model: DM_MODEL,
      system: cachedSystem(SYSTEM),
      maxTokens: 600,
      temperature: null, // rejected by claude-sonnet-5
      tools: [DRAFT_TOOL],
      toolChoice: { type: "tool", name: "draft_dm" },
      messages: [{
        role: "user",
        content: `Facts about the brand:\n\n${facts}\n\n${extra ? `${extra}\n\n` : ""}Write the DM.`,
      }],
    });
    const u = res.usage || {};
    cost += ((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25
             + (u.cache_read_input_tokens || 0) * 0.1) / 1e6 * PRICE.in
          + (u.output_tokens || 0) / 1e6 * PRICE.out;

    const call = res.toolCalls.find((t) => t.name === "draft_dm");
    last = finishDraft(call?.input?.message, lead);
    if (!last.problems.length) break;
  }

  if (last.problems.length) {
    throw new Error(`the draft broke a rule: ${last.problems.join("; ")}`);
  }
  return {
    // A follow-up is a reply in the same conversation: no second signature.
    message: followUp ? last.message : `${last.message}\n\n${signature()}`,
    variant: followUp ? null : variant,
    language: lang,
    model: DM_MODEL,
    costUsd: Math.round(cost * 10000) / 10000,
    styleIssues: last.styleIssues,
  };
}
