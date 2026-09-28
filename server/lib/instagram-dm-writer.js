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
// from facts.md, the list of things about Linkable we are allowed to say.
// Nothing the browser sends reaches the prompt except the choice of language.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeMessage, cachedSystem } from "./anthropic.js";
import { sanitizeStyle, findStyleIssues } from "../automation/conversation-ai.js";

export const DM_MODEL = "claude-sonnet-5";
// Sonnet list price, $/million tokens. Mirrors PRICE in nudge-writer.js.
const PRICE = { in: 2, out: 10 };

// A DM is read on a phone, in a list of requests from strangers. Anything near
// Instagram's own 1,000-character limit reads as a mail-merge. The model is
// asked for TARGET; a draft over MAX is refused and written again.
export const TARGET_DM_CHARS = 400;
export const MAX_DM_CHARS = 550;

export const LANGUAGES = { en: "British English", it: "Italian" };

// Which language a brand is written to in. By the country the pipeline
// resolved for the store, because that is where its customers are; anything
// not listed gets English.
const LANGUAGE_BY_COUNTRY = { IT: "it", SM: "it", VA: "it" };

export function languageFor(lead) {
  return LANGUAGE_BY_COUNTRY[String(lead?.country || "").toUpperCase()] || "en";
}

const FACTS = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "blog", "facts.md"),
  "utf8",
);

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

const SYSTEM = `You write the first Instagram DM from Linkable to an ecommerce brand
that has never heard of us. A person on the Linkable team reads it, pastes it
into Instagram and sends it from their own account, so it must be something
they would put their name to.

Why we are writing: the brand either posted asking for creators (UGC creators,
ambassadors, influencers), or creators are already posting about it, or it is
simply the kind of brand that works with creators. Linkable is where brands get
creators applying to their campaigns and track what those creators sell.

Rules, most important first:
- Under ${TARGET_DM_CHARS} characters. Three short paragraphs at most.
- Open with the specific reason we are writing to THIS brand, taken from the
  facts: what their post asked for, the creators already posting about them,
  or what they sell and where. Never open with a greeting paragraph, "I hope
  you're well", "I came across your page" or a compliment.
- If they posted a creator call, answer that call: say plainly that Linkable
  can bring them creators who apply to exactly that kind of campaign.
- ONE sentence on Linkable, using ONLY the facts about Linkable below: the
  part that answers why we are writing (creators applying to their campaign,
  or tracking what creators sell). Not a feature list. No prices, no plans, no
  numbers that are not in those facts.
- You cannot see their posts, photos or videos. Never compliment their content,
  their aesthetic or their feed.
- End with one easy question the brand can answer in a word, like whether they
  would like to see how it works. Not a meeting request.
- Never write a URL, an email address or a phone number. Never mention a
  handle that is not in the facts.
- Plain sentences, the way a person texts for work. No markdown, no hashtags,
  no em dashes, no exclamation marks. At most one emoji, and only if it does
  work.
- Do not say you are an AI, and do not mention how the brand was found beyond
  what the facts say they posted.
- Write in the language you are told to use. In Italian use "voi" for the brand
  and a natural, direct register, not a translation of English.

Facts about Linkable (the only things you may claim about it):

${FACTS}

Call draft_dm with the finished message.`;

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
export function factSheet(lead, { language, senderName } = {}) {
  const lines = [];
  lines.push(`Brand: ${brandNameFor(lead)} (@${lead.handle} on Instagram)`);
  if (clean(lead.country)) lines.push(`Country of the store: ${lead.country}`);
  if (clean(lead.ig_category)) lines.push(`Instagram category: ${lead.ig_category}`);
  if (clean(lead.ig_biography)) lines.push(`Their Instagram bio: "${clean(lead.ig_biography).slice(0, 400)}"`);
  if (clean(lead.domain)) lines.push(`Store: ${lead.domain} (a Shopify store${lead.product_count ? `, ${lead.product_count} products` : ""})`);

  if (lead.intent_signal === "open_call" && clean(lead.intent_caption)) {
    lines.push("");
    lines.push("They recently posted asking for creators. Their caption:");
    lines.push(`"${clean(lead.intent_caption).slice(0, 900)}"`);
  } else if (lead.intent_signal === "open_call") {
    lines.push("");
    lines.push("They recently posted asking for creators (the caption was not captured).");
  }

  const handles = creatorHandles(lead);
  if (handles.length) {
    const n = Number(lead.distinct_creators_90d) || handles.length;
    lines.push("");
    lines.push(`Creators already posting about them in the last 90 days: ${n}, including ${handles.map((h) => `@${h}`).join(", ")}.`);
  }

  const app = clean(lead.affiliate_app);
  if (app && app !== "none") {
    lines.push(`They already run an affiliate app (${app}), so do not say they have no tracking.`);
  } else {
    lines.push("We could not see an affiliate or creator-tracking app on their store. Do not state this as certain.");
  }

  lines.push("");
  lines.push(`Write in: ${LANGUAGES[language] || LANGUAGES.en}`);
  lines.push(senderName
    ? `The sender is ${senderName} from the Linkable team. Introduce them by first name once.`
    : "The sender is someone on the Linkable team. Do not invent a name for them.");
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

// → { message, language, model, costUsd, styleIssues }
export async function draftInstagramDm(lead, { language, senderName } = {}) {
  const lang = LANGUAGES[language] ? language : languageFor(lead);
  const facts = factSheet(lead, { language: lang, senderName });

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
      messages: [{ role: "user", content: `Facts about the brand:\n\n${facts}\n\nWrite the DM.` }],
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
    message: last.message,
    language: lang,
    model: DM_MODEL,
    costUsd: Math.round(cost * 10000) / 10000,
    styleIssues: last.styleIssues,
  };
}
