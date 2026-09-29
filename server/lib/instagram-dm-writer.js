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
// the one creator number Federico chose to quote (CREATOR_CLAIM). The shape is
// Federico's own DMs; the only claims about Linkable are the ones in that
// shape. Nothing the browser sends reaches the prompt except the choice of
// language.

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

// The creator number every DM quotes, whatever the brand's category. Federico's
// call (28 Sep 2026): one figure for all niches, set here and never by the model.
export const CREATOR_CLAIM = "10,000+";

// The house style is Federico's own template. It says "introduce the brand to
// their audiences", not "promote them on a commission basis": the pitch is not
// only affiliate.
const SYSTEM = `You write the first Instagram DM from Linkable to an ecommerce brand
that has never heard of us. It is sent by Federico, Linkable's founder, from his
own account, and it must read like the ones he writes by hand.

His template, which is the house style:

---
Hey DDG!

Just came across your post looking for new brand ambassadors.
We have ${CREATOR_CLAIM} creators on Linkable who can apply to collaborate with DDG, create content around your products and introduce the brand to their audiences.

Brands typically start receiving creator applications within 24 hours.

Would you be open to giving it a try?
---

The shape, every time:
1. "Hey {brand}!" with the brand's name as the brand itself writes it (keep
   their casing, drop taglines after | or -), alone on the first line, then a
   blank line. When there is no post to mention, add "Quick question." after
   the greeting.
2. When the facts include a post where they asked for creators, ambassadors or
   UGC: "Just came across your post looking for ..." naming what the post
   actually asked for, in a few words (new brand ambassadors, UGC creators,
   influencers...). Never claim a post the facts do not give.
2a. No "your post" line when the facts give no post. Instead: when they have
   recently gifted products to creators, "Saw you've been gifting to creators
   lately."; when they run a creator or ambassador programme on their site,
   "Just came across your ambassador programme." naming it as their page does
   (ambassador programme, creator programme, affiliate programme). Never name
   the creator who posted about them.
2b. When the facts say creators already on Linkable have posted about them:
   one line of its own, straight after the post line (or after the greeting
   when there is no post): "{N} creators on Linkable already post about
   {brand}, including @a and @b." with N and the handles exactly as the facts
   give them ("1 creator ... posts", and no "including" when no handle is
   given). This is the strongest line in the message; never inflate it.
3. The creator line, word for word apart from the brand name: "We have
   ${CREATOR_CLAIM} creators on Linkable who can apply to collaborate with
   {brand}, create content around your products and introduce the brand to
   their audiences." Always ${CREATOR_CLAIM}, never another number, and no
   niche words: the same line for every category. Never say "commission" or
   "affiliate".
4. A blank line, then "Brands typically start receiving creator applications
   within 24 hours."
5. A blank line, then "Would you be open to giving it a try?"

Rules:
- Body under ${TARGET_DM_CHARS} characters. Do NOT sign it: the signature is
  added after you.
- No other claims about Linkable: no prices, no free trial, no "free to get
  started", no features, no numbers except ${CREATOR_CLAIM}.
- You cannot see their posts, photos or videos. Never compliment their content.
- Never write a URL, an email address or a phone number, and never mention a
  handle.
- No markdown, no hashtags, no em dashes. The only exclamation mark is the one
  after the greeting.
- Write in the language you are told to use. In Italian keep the same shape in
  natural Italian ("Ciao {brand}!", "voi" for the brand, "10.000+"), not a
  word-for-word translation.

Call draft_dm with the finished body.`;

// A creator call older than this has usually been filled: the DM queue drops
// the brand and the DM does not mention the post. Mirrors OLD_CALL_DAYS in
// linkable-prospector's ops_sync.py.
export const FRESH_CALL_DAYS = 14;

export const staleCall = (lead) => Boolean(lead?.intent_posted_at)
  && (Date.now() - new Date(lead.intent_posted_at).getTime()) / 86_400_000 > FRESH_CALL_DAYS;

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
  return [...String(lead.top_creators || "").split(","), ...linkableCreatorHandles(lead)]
    .map((h) => h.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
}

// Creators already on Linkable who tagged this brand (linkable-prospector's
// linkable_creators source). The first two can be named in the DM.
function linkableCreatorHandles(lead) {
  return String(lead.linkable_creators || "")
    .split(",")
    .map((h) => h.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean)
    .slice(0, 2);
}

// Every line is something the operator could have read off the lead.
export function factSheet(lead, { language } = {}) {
  const lines = [];
  lines.push(`Brand: ${brandNameFor(lead)} (@${lead.handle} on Instagram)`);
  // How the brand names itself on Instagram, which is what the greeting uses.
  if (clean(lead.ig_full_name)) lines.push(`Their Instagram display name: ${clean(lead.ig_full_name)}`);
  if (VERTICALS[lead.vertical]) lines.push(`Their vertical: ${VERTICALS[lead.vertical]}`);
  if (clean(lead.country)) lines.push(`Country of the store: ${lead.country}`);
  if (clean(lead.ig_category)) lines.push(`Instagram category: ${lead.ig_category}`);
  if (clean(lead.ig_biography)) lines.push(`Their Instagram bio: "${clean(lead.ig_biography).slice(0, 400)}"`);
  const onShopify = lead.status !== "not_shopify";
  if (onShopify && clean(lead.domain)) {
    lines.push(`Store: ${lead.domain} (a Shopify store${lead.product_count ? `, ${lead.product_count} products` : ""})`);
  } else if (!onShopify) {
    lines.push(`Their store${clean(lead.domain) ? ` (${lead.domain})` : ""} is NOT on Shopify. Do not mention Shopify, and do not claim Linkable connects to their store, syncs their catalogue or tracks their sales.`);
  }

  // A call from weeks ago is not "your post" any more - keyword search finds
  // them years old - so an old one is left out and the DM opens without it.
  if (lead.intent_signal === "open_call" && staleCall(lead)) {
    // Nothing: as if we had not seen it.
  } else if (lead.intent_signal === "open_call" && clean(lead.intent_caption)) {
    lines.push("");
    lines.push("They recently posted asking for creators. Their caption:");
    lines.push(`"${clean(lead.intent_caption).slice(0, 900)}"`);
  } else if (lead.intent_signal === "open_call") {
    lines.push("");
    lines.push("They recently posted asking for creators (the caption was not captured).");
  } else if (lead.intent_signal === "gifting" && !staleCall(lead)) {
    lines.push("");
    lines.push("They have recently gifted products to creators (a creator tagged them in a gifted post).");
  } else if (lead.intent_signal === "program_page") {
    lines.push("");
    lines.push("They run a creator / ambassador programme on their own site. Its page:");
    lines.push(`"${clean(lead.intent_caption || "").slice(0, 400)}"`);
  }

  const proof = Number(lead.linkable_creator_count) || 0;
  if (proof > 0) {
    const named = linkableCreatorHandles(lead).map((h) => `@${h}`);
    lines.push("");
    lines.push(`Creators already on Linkable who have posted about them: ${proof}`
      + (named.length ? ` (you may name: ${named.join(" and ")})` : ""));
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
  // The pitch is not only affiliate, and the one creator number is ours.
  const affiliate = message.match(/\b(commission\w*|affiliat\w*|provvigion\w*|commission[ei])\b/gi);
  if (affiliate) problems.push(`pitched it as affiliate: ${affiliate.join(", ")}`);
  // A number in their own name, bio or post ("Studio 54", "9ct gold", "5 UGC
  // creators") is theirs.
  const theirs = [brandNameFor(lead), lead.ig_full_name, lead.handle, lead.ig_biography, lead.intent_caption,
    // The Linkable-creator count is ours to state, exactly as the facts give it.
    lead.linkable_creator_count ? String(lead.linkable_creator_count) : null]
    .filter(Boolean).join(" ");
  const numbers = (message.match(/\d[\d.,]*\+?/g) || [])
    .filter((n) => !/^10[.,]000\+?$/.test(n) && n !== "24" && !theirs.includes(n.replace(/[.,+]+$/, "")));
  if (numbers.length) problems.push(`quoted a number other than ${CREATOR_CLAIM}: ${numbers.join(", ")}`);

  const allowed = new Set([String(lead.handle).toLowerCase(), ...creatorHandles(lead)]);
  const mentioned = [...message.matchAll(/@([A-Za-z0-9._]+)/g)].map((m) => m[1].replace(/\.$/, "").toLowerCase());
  const invented = mentioned.filter((h) => !allowed.has(h));
  if (invented.length) problems.push(`mentions handles it was not given: ${invented.join(", ")}`);

  return { message, problems, styleIssues: findStyleIssues(message) };
}

// The greeting stands on its own line with a blank line under it, as in
// Federico's template. Enforced here rather than trusted to the model, which
// ran the greeting straight into the next line (Boutique England, 28 Sep
// 2026). Follow-ups are three short lines and keep their shape.
export function withGreetingGap(message) {
  const text = String(message || "").trim();
  const i = text.indexOf("\n");
  if (i < 0) return text;
  const rest = text.slice(i + 1).replace(/^\s*\n/, "").replace(/^\n+/, "");
  return rest ? `${text.slice(0, i).trimEnd()}\n\n${rest}` : text.slice(0, i).trimEnd();
}

// Every first message is Federico's template (variant "A"). Variant B, the
// same claims in three lines, was switched off on 28 Sep 2026 at his request;
// sent rows still carry "B" so the Results tab can compare the two.
export const DM_VARIANT = "A";

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
export async function draftInstagramDm(lead, { language, followUp = false } = {}) {
  const lang = LANGUAGES[language] ? language : languageFor(lead);
  const facts = factSheet(lead, { language: lang });
  const extra = followUp
    ? `${FOLLOWUP_INSTRUCTION}\n\nThe first message:\n"""${String(lead.dm_text || "").trim()}"""`
    : "";

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
    message: followUp ? last.message : `${withGreetingGap(last.message)}\n\n${signature()}`,
    variant: followUp ? null : DM_VARIANT,
    language: lang,
    model: DM_MODEL,
    costUsd: Math.round(cost * 10000) / 10000,
    styleIssues: last.styleIssues,
  };
}
