// Add calls from the phone (Federico, 16 Nov 2026): ~50 creator calls a day
// show up in his Instagram feed. On the phone he copies the post's link
// (Share, Copy link) and, when our agent never saw the post, adds its
// screenshot. Claude reads the screenshot for what the queues need (the
// brand's handle, the caption, a Google Form, a website, an email), then the
// post goes where the rest of ops already sends it:
//   - a Google Form: Campaigns from calls (lib/externalCalls.js add), which
//     checks the form and drafts the campaign;
//   - anything else: a Pitch signal draft (lib/pitchSignals.js draft).
// Nothing goes live from here: both wait for an Approve, as a manual add
// always has.

import { claudeMessage, tokenStats } from "./anthropic.js";
import { externalCallsClient } from "./externalCalls.js";
import { pitchSignalsClient } from "./pitchSignals.js";

// Haiku reads text off a screenshot well and costs a fraction of a cent.
export const CALL_READER_MODEL = process.env.CALL_INBOX_MODEL || "claude-haiku-5-5";
export const MAX_SCREENSHOTS = 4;
// Base64 characters per screenshot: the page sends JPEGs of about 300 KB.
const MAX_IMAGE_CHARS = 2_500_000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const POST_URL = /^https?:\/\/(www\.)?instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(p|reel|reels|tv)\/[A-Za-z0-9_-]+/i;
const FORM_URL = /(forms\.gle\/|docs\.google\.com\/forms\/)/i;

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const clean = (v, max = 500) => String(v ?? "").trim().slice(0, max);

// The post link as Instagram's "Copy link" gives it, without the tracking.
export function cleanPostUrl(raw) {
  const s = clean(raw, 500);
  const m = s.match(POST_URL);
  if (!m) return "";
  return m[0].replace(/^http:/i, "https:").replace(/\/?$/, "/");
}

const FACTS_TOOL = {
  name: "call_facts",
  description: "What the Instagram screenshots show about the post.",
  input_schema: {
    type: "object",
    properties: {
      is_creator_call: { type: "boolean", description: "The post asks creators, influencers, models or ambassadors to apply, DM, email or sign up to work with the brand." },
      handle: { type: "string", description: "The Instagram handle of the account that posted it, without @. Empty when not visible." },
      brand_name: { type: "string", description: "The brand's name as written. Empty when unsure." },
      caption: { type: "string", description: "The caption text exactly as visible, line breaks kept. Empty when none is visible." },
      google_form_url: { type: "string", description: "A forms.gle or docs.google.com/forms link if one is written out. Empty otherwise." },
      website: { type: "string", description: "The brand's website if written out (not linktr.ee or an Instagram link). Empty otherwise." },
      contact_email: { type: "string", description: "An email address written in the post or bio. Empty otherwise." },
    },
    required: ["is_creator_call", "handle", "brand_name", "caption", "google_form_url", "website", "contact_email"],
  },
};

const READER_PROMPT = `These are screenshots of one Instagram post, taken on a phone. Read what is written, nothing more: never guess a handle, a link or an email that is not on screen. Copy the caption exactly as it reads, joining the parts across screenshots once. Call call_facts.`;

function imageBlocks(images) {
  return images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.media_type, data: img.data },
  }));
}

// readCallScreenshots: the facts Claude reads off the screenshots.
export async function readCallScreenshots(images, { ask = claudeMessage } = {}) {
  const res = await ask({
    model: CALL_READER_MODEL,
    maxTokens: 2000,
    temperature: null,
    thinking: { type: "disabled" },
    tools: [FACTS_TOOL],
    toolChoice: { type: "tool", name: FACTS_TOOL.name },
    messages: [{ role: "user", content: [...imageBlocks(images), { type: "text", text: READER_PROMPT }] }],
  });
  const facts = res.toolCalls?.find((c) => c.name === FACTS_TOOL.name)?.input || {};
  console.log(`[call-inbox] read model=${CALL_READER_MODEL} images=${images.length} tokens=${JSON.stringify(tokenStats(res))}`);
  return {
    is_creator_call: facts.is_creator_call !== false,
    handle: clean(facts.handle, 100).replace(/^@/, ""),
    brand_name: clean(facts.brand_name, 200),
    caption: clean(facts.caption, 5000),
    google_form_url: FORM_URL.test(facts.google_form_url || "") ? clean(facts.google_form_url, 500) : "",
    website: clean(facts.website, 300),
    contact_email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(facts.contact_email || "") ? clean(facts.contact_email, 200).toLowerCase() : "",
  };
}

function checkImages(images) {
  if (!Array.isArray(images)) return [];
  if (images.length > MAX_SCREENSHOTS) throw fail(400, `Add up to ${MAX_SCREENSHOTS} screenshots for one post.`);
  return images.map((img) => {
    const type = String(img?.media_type || "").toLowerCase();
    const data = String(img?.data || "").replace(/^data:[^,]+,/, "");
    if (!IMAGE_TYPES.has(type) || !data) throw fail(400, "Screenshots must be photos (JPEG, PNG or WebP).");
    if (data.length > MAX_IMAGE_CHARS) throw fail(400, "One of the screenshots is too big. Try again with a smaller one.");
    return { media_type: type, data };
  });
}

// addCallFromPhone: one post. The link is required (both queues key on it);
// screenshots and the typed fields are optional, a typed field winning over
// what the screenshot says.
export async function addCallFromPhone(input = {}, { admin } = {}, target, deps = {}) {
  const { calls = externalCallsClient, signals = pitchSignalsClient, read = readCallScreenshots } = deps;
  const postUrl = cleanPostUrl(input.post_url);
  if (!postUrl) throw fail(400, "Paste the link to the Instagram post: in Instagram, tap Share, then Copy link.");
  const images = checkImages(input.images);

  let facts = { is_creator_call: true, handle: "", brand_name: "", caption: "", google_form_url: "", website: "", contact_email: "" };
  if (images.length) {
    try {
      facts = await read(images);
    } catch (e) {
      console.error(`[call-inbox] screenshot not read: ${e.message}`);
      throw fail(502, "We couldn't read the screenshot. Try again, or add the post without it.");
    }
  }
  const typedForm = clean(input.form_url, 500);
  if (typedForm && !FORM_URL.test(typedForm)) throw fail(400, "That Google Form link doesn't look right. It starts with https://forms.gle/ or https://docs.google.com/forms/.");
  const formUrl = typedForm || facts.google_form_url;
  const caption = clean(input.caption, 5000) || facts.caption;
  const handle = clean(input.instagram, 100).replace(/^@/, "") || facts.handle;
  const read_ = {
    handle, brand_name: facts.brand_name, has_caption: Boolean(caption), form_url: formUrl,
    website: facts.website, contact_email: facts.contact_email,
    not_a_call: images.length > 0 && !facts.is_creator_call,
  };

  if (formUrl) {
    const call = await calls.add({ postUrl, formUrl, caption, ownerHandle: handle, admin }, target);
    console.log(`[call-inbox] campaign call admin=${admin?.email} post=${postUrl} id=${call.id}`);
    return { kind: "campaign", id: call.id, status: call.status, post_url: postUrl, read: read_ };
  }
  const signal = await signals.draft({
    post_url: postUrl, caption, instagram: handle, brand_name: facts.brand_name,
    website: facts.website, contact_email: facts.contact_email,
  }, { admin }, target);
  console.log(`[call-inbox] signal admin=${admin?.email} post=${postUrl} id=${signal.id} status=${signal.status}`);
  return { kind: "signal", id: signal.id, status: signal.status, post_url: postUrl, read: read_ };
}
