// Drafts the email an operator sends to a brand about one alert.
//
// The whole point of the feature is that the operator does not retype context
// that the console already holds, so the draft is built ONLY from server-side
// facts: the alert as buildAlerts() produced it, plus a small slice of Brand
// 360. Nothing the browser sends reaches the prompt — a client-supplied
// "detail" string would be a straight path to writing arbitrary email from a
// linkable.link address.

import { claudeMessage } from "./anthropic.js";

const NUDGE_MODEL = "claude-sonnet-5";

// Alert kinds it is appropriate to write to a customer about unprompted.
// Deliberately an allow-list: a brand purge ("you deleted your account, the
// data goes on schedule") or a stale-blog alert must never reach a customer
// because somebody clicked "nudge all" on a brand that happened to have one.
export const EMAILABLE_KINDS = new Set(["shipping", "applications", "sales", "billing"]);
export const isEmailable = (alert) => EMAILABLE_KINDS.has(alert?.kind);
// Sonnet list price, $/million tokens. Mirrors ASK_PRICES in insights.js.
const PRICE = { in: 2, out: 10 };

const DRAFT_TOOL = {
  name: "draft_nudge",
  description: "Return the finished email to the brand.",
  input_schema: {
    type: "object",
    properties: {
      subject: { type: "string", description: "Plain subject line, under 60 characters, no emoji." },
      body: { type: "string", description: "Plain-text email body including the greeting and sign-off. No markdown." },
    },
    required: ["subject", "body"],
  },
};

const SYSTEM = `You write short emails for the Linkable operations team.

Linkable is a marketplace where Shopify brands run campaigns and creators apply
to promote their products, get sent a sample, and earn commission on the sales
their link drives. You are writing to a BRAND — an existing customer, not a
prospect. Somebody on their side has left something hanging and a creator, or
their own money, is waiting on it.

Voice
- Write as one person to another. Warm, brief, and useful.
- 60 to 120 words in the body. Shorter is better than complete.
- Open with the specific situation, not a pleasantry. Never "I hope this finds
  you well", "I wanted to reach out", "Just checking in", or "quick question".
- One ask when there is one thing stuck. When several are listed, cover them
  all in a single short email — group them naturally rather than writing a
  list of unrelated paragraphs, and still close with one clear next step.
- Plain sentences. No marketing language, no exclamation marks, no emoji, no
  markdown, no bullet symbols, no headings.
- British English.
- If the brand's first name is given, greet them by it; otherwise use "Hi there".
- Sign off with the sender's first name on its own line.

Hard rules
- Use ONLY the facts given below. Do not invent numbers, dates, creator names,
  product names, features, or anything about their account you were not told.
- Never promise a refund, a discount, a trial extension, a credit, or a call
  unless the facts explicitly say it is on offer.
- Never apologise for a problem Linkable did not cause.
- Do not mention that this message was generated, automated, or triggered by an
  internal alert.
- No links unless one is given in the facts. Write the URL bare if you use it.

Call draft_nudge with the finished subject and body.`;

const days = (iso) => {
  if (!iso) return null;
  const n = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return Number.isFinite(n) ? n : null;
};

// A compact, plain-language fact sheet. Every line is something the operator
// could have read off the console themselves.
//
// `alerts` may hold several things the same brand has left hanging. They go in
// one email: a brand with five open alerts receiving five separate emails in
// the same minute is worse than not writing at all.
function factSheet({ alerts, brand, sender }) {
  const [alert] = alerts;
  const lines = [];
  const p = brand?.profile || {};
  const name = alert.brand?.store_name || p.store_name;

  lines.push(`Brand: ${name || alert.brand?.email || "unknown"}`);
  if (p.first_name) lines.push(`Contact first name: ${p.first_name}`);
  if (p.niche) lines.push(`Their niche: ${p.niche}`);
  if (p.user_created) {
    const d = days(p.user_created);
    if (d !== null) lines.push(`Customer for: ${d} days`);
  }
  if (p.last_sign_in) {
    const d = days(p.last_sign_in);
    if (d !== null) lines.push(`Last signed in: ${d === 0 ? "today" : `${d} days ago`}`);
  } else if (brand) {
    lines.push("Last signed in: never");
  }
  if (brand?.subscription?.name) {
    lines.push(`Plan: ${brand.subscription.name}${brand.subscription.status ? ` (${brand.subscription.status})` : ""}`);
  }
  if (alert.campaign?.title) lines.push(`Campaign this is about: "${alert.campaign.title}"`);

  // The alerts themselves, verbatim from buildAlerts().
  lines.push("");
  lines.push(alerts.length === 1
    ? "What is stuck:"
    : `What is stuck (${alerts.length} things, all for this same brand — write ONE email covering them):`);
  for (const a of alerts) {
    lines.push("");
    lines.push(`- ${a.title}`);
    lines.push(`  Detail: ${a.detail}`);
    if (a.action) lines.push(`  What we want them to do: ${a.action}`);
    const waiting = days(a.since);
    if (waiting !== null && waiting >= 0) {
      lines.push(`  Waiting ${waiting} day${waiting === 1 ? "" : "s"}.`);
    }
    const c = (brand?.campaigns || []).find((x) => x.id === a.campaign?.id);
    if (c) {
      lines.push(`  On "${c.title}" so far: ${c.accepted || 0} creator(s) accepted, ${c.shipped || 0} sample(s) shipped, ${c.sales || 0} sale(s).`);
    }
  }

  lines.push("");
  lines.push(`Sender: ${sender.name}, Linkable`);
  return lines.join("\n");
}

// → { subject, body, model, costUsd }
export async function draftNudge({ alerts, brand, sender }) {
  const list = [].concat(alerts).filter(Boolean);
  if (!list.length) throw new Error("nothing to write about");
  const facts = factSheet({ alerts: list, brand, sender });

  const res = await claudeMessage({
    model: NUDGE_MODEL,
    system: SYSTEM,
    maxTokens: 700,
    temperature: null, // rejected by claude-sonnet-5
    tools: [DRAFT_TOOL],
    toolChoice: { type: "tool", name: "draft_nudge" },
    messages: [{ role: "user", content: `Facts:\n\n${facts}\n\nWrite the email.` }],
  });

  const call = res.toolCalls.find((t) => t.name === "draft_nudge");
  if (!call?.input?.subject || !call?.input?.body) {
    throw new Error("The model did not return a usable draft");
  }

  const u = res.usage || {};
  const costUsd = ((u.input_tokens || 0) / 1e6) * PRICE.in + ((u.output_tokens || 0) / 1e6) * PRICE.out;

  return {
    subject: String(call.input.subject).trim().slice(0, 200),
    body: String(call.input.body).trim(),
    model: NUDGE_MODEL,
    costUsd: Math.round(costUsd * 10000) / 10000,
  };
}
