import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { supabase } from "./supabase.js";
import { blogDb } from "./blog-supabase.js";
import { claudeMessage, cachedSystem } from "./anthropic.js";
import { DM_MODEL } from "./instagram-dm-writer.js";

// The outside agents: reaching brands, creators and partners outside the app.
//
//   Listening  public posts where a brand asks for creators or a creator asks
//              for brands, found by linkable-prospector's worker.
//   Partners   people who already have the audience, found by the same worker.
//   Posts      posts for Linkable's own accounts, written here from the day's
//              blog article.
//
// For each, Claude writes a draft from the verified facts and nothing else,
// and a person posts or sends it: copy, open, done. No machine here posts,
// comments, messages or emails. The platforms forbid automated messages to
// strangers, and the account they would restrict is Linkable's own.

export const TABLE = "prospector_outside_items";
export const KINDS = ["signal", "partner", "post"];
export const STATES = ["new", "done", "dismissed"];
export const POST_PLATFORMS = ["linkedin", "instagram", "tiktok"];
const BLOG_URL = "https://www.linkable.link/blog";
// Sonnet list price, $/million tokens (mirrors instagram-dm-writer.js).
const PRICE = { in: 2, out: 10 };

const here = dirname(fileURLToPath(import.meta.url));
let factsCache = null;
export function facts() {
  if (factsCache == null) factsCache = readFileSync(join(here, "..", "data", "blog", "facts.md"), "utf-8");
  return factsCache;
}

const RULES = `You write for Linkable, a platform where ecommerce brands and creators work together.

Rules, all of them:
- State only what the verified facts below say. No other number, claim, promise or price.
- Plain, warm, short. Write as one person to another, never as an advert. No exclamation marks, no emoji, no hashtags unless asked, no "game changer", "revolutionary", "excited".
- British spelling.
- When you write to someone (a reply or an email), say plainly that you work at Linkable. Never pretend to be a customer or a creator.
- When you write to someone, be useful before you mention Linkable: answer what the person asked.
- A post for Linkable's own account is written as Linkable ("we"), and does not say "I work at Linkable".
- One link at most: https://www.linkable.link

Verified facts:

`;

const DRAFT_TOOL = {
  name: "draft",
  description: "The finished text.",
  input_schema: {
    type: "object",
    properties: {
      subject: { type: "string", description: "Email subject. Empty for anything that is not an email." },
      text: { type: "string", description: "The reply, email body or post, ready to paste." },
    },
    required: ["text"],
  },
};

const PLATFORM_NAMES = {
  linkedin: "LinkedIn", reddit: "Reddit", tiktok: "TikTok", x: "X", facebook: "Facebook",
  threads: "Threads", youtube: "YouTube", instagram: "Instagram",
};

// What Claude is asked for, per kind of item. Pure.
export function briefFor(item) {
  const where = PLATFORM_NAMES[item.platform] || item.platform || "the web";
  const post = `Title: ${item.title || "(none)"}\nText: ${item.snippet || "(none)"}`;
  if (item.kind === "signal" && item.side === "creator") {
    return `A creator posted this on ${where}, asking how to find brands to work with:\n\n${post}\n\n`
      + `Write a public reply of at most 70 words. First give one piece of practical advice that helps whether or not they use Linkable. `
      + `Then say you work at Linkable, that joining and applying to brand campaigns is free for creators, and that they can pitch brands from it. `
      + (item.platform === "reddit" ? "This is Reddit: no link, and no sales tone at all. " : "")
      + `Leave subject empty.`;
  }
  if (item.kind === "signal") {
    return `A brand posted this on ${where}, asking for creators:\n\n${post}\n\n`
      + `Write a public reply of at most 60 words. Open by answering what they asked for, not with a compliment. Say you work at Linkable, that creators apply to a brand's campaign there and the brand chooses the ones it likes, `
      + `and that a paid plan starts with a free trial of 30 days. Offer to help them set up their first campaign. `
      + (item.platform === "reddit" ? "This is Reddit: no link, and no sales tone at all. " : "")
      + `Leave subject empty.`;
  }
  if (item.kind === "partner") {
    const what = { community: "runs a community for creators", newsletter: "writes a newsletter", agency: "runs an agency", coach: "teaches creators" }[item.platform] || "has an audience we would like to reach";
    return `This person or company ${what}:\n\nSite: ${item.url}\nTitle: ${item.title || "(none)"}\nAbout: ${item.snippet || "(none)"}\n\n`
      + `Write a first email of at most 110 words and a subject of at most 7 words. Say what you noticed about them in one sentence, what Linkable is in one sentence, `
      + `and ask whether they would be open to a short call about working together. Do not offer a commission, a price or any terms: those are agreed on the call. `
      + `No greeting line with a name you do not know: start with "Hi,". No signature: the sender adds their own.`;
  }
  // A post for Linkable's own account, from a blog article.
  const link = item.meta?.article_url || BLOG_URL;
  const article = `Title: ${item.title}\nSummary: ${item.snippet}\nLink: ${link}`;
  if (item.platform === "linkedin") {
    return `Write a LinkedIn post for Linkable's company page from this article:\n\n${article}\n\n`
      + `At most 120 words: one useful idea from the article in short lines, then the link on its own line. No hashtags. Leave subject empty.`;
  }
  if (item.platform === "tiktok") {
    return `Write a script for a 20 second TikTok for Linkable's account from this article:\n\n${article}\n\n`
      + `Three short spoken lines someone can say to camera, each on its own line with no label or number in front, then a blank line, then a caption of at most 15 words with two hashtags, also with no label. Leave subject empty.`;
  }
  return `Write an Instagram caption for Linkable's account from this article:\n\n${article}\n\n`
    + `At most 80 words: one useful idea from the article, then "Link in bio." and three hashtags on the last line. Leave subject empty.`;
}

// Why a draft may not be kept; "" when it may. Pure.
export function draftProblem(item, draft) {
  const text = String(draft?.text || "").trim();
  if (text.length < 20) return "the draft came back empty";
  if (/guarantee|#1|best in the world/i.test(text)) return "the draft makes a promise the facts do not";
  if (item.kind === "partner" && !String(draft.subject || "").trim()) return "the email has no subject";
  if (item.kind === "partner" && /\b\d+\s?%|commission of|we pay\b/i.test(text)) return "the email offers terms, which are for the call";
  if (item.platform === "reddit" && /https?:\/\//i.test(text)) return "a link in a Reddit reply reads as an advert";
  if (item.kind === "post" && /\b(I|we) work at Linkable\b/i.test(text)) return "a post on Linkable's own account does not say who works there";
  if (item.kind === "post" && /^\s*(line \d|caption)\s*:/im.test(text)) return "the post has labels in front of its lines";
  return "";
}

async function writeDraft(item, { ask = claudeMessage } = {}) {
  let cost = 0;
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await ask({
      model: DM_MODEL,
      system: cachedSystem(RULES + facts()),
      maxTokens: 700,
      temperature: null, // rejected by claude-sonnet-5
      tools: [DRAFT_TOOL],
      toolChoice: { type: "tool", name: "draft" },
      messages: [{ role: "user", content: briefFor(item) + (problem ? `\n\nYour last draft was refused: ${problem}. Fix that.` : "") }],
    });
    const u = res.usage || {};
    cost += ((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1) / 1e6 * PRICE.in
      + (u.output_tokens || 0) / 1e6 * PRICE.out;
    const draft = res.toolCalls?.find((t) => t.name === "draft")?.input || {};
    problem = draftProblem(item, draft);
    if (!problem) return { subject: String(draft.subject || "").trim(), text: String(draft.text).trim(), cost };
  }
  return { problem, cost };
}

// Drafts for items that have none, newest first, until the time or the number
// runs out. A draft that is refused twice is left for the next run.
export async function draftMissing({ limit = 20, budgetMs = 40_000, db = supabase, ask } = {}) {
  const started = Date.now();
  const { data, error } = await db.from(TABLE).select("*").eq("state", "new").is("draft_text", null)
    .order("found_at", { ascending: false }).limit(limit);
  if (error) return { drafted: 0, error: error.message };
  let drafted = 0;
  let refused = 0;
  let cost = 0;
  for (const item of data || []) {
    if (Date.now() - started > budgetMs) break;
    const out = await writeDraft(item, { ask }).catch((e) => ({ problem: e.message, cost: 0 }));
    cost += out.cost || 0;
    if (out.problem) { refused += 1; continue; }
    await db.from(TABLE).update({
      draft_subject: out.subject || null, draft_text: out.text,
      drafted_at: new Date().toISOString(), draft_cost_usd: Number(out.cost.toFixed(5)),
    }).eq("id", item.id);
    drafted += 1;
  }
  return { drafted, refused, cost_usd: Number(cost.toFixed(4)) };
}

// The rows for the newest published article nothing was made from yet: one
// per platform, waiting for a draft. Returns how many were added.
export async function queueDailyPosts({ db = supabase, blog = blogDb } = {}) {
  const { data: posts, error } = await blog.from("blog_posts").select("slug, title, excerpt, description, category, published_at")
    .eq("status", "published").order("published_at", { ascending: false, nullsFirst: false }).limit(1);
  if (error) return { added: 0, error: error.message };
  const article = posts?.[0];
  if (!article) return { added: 0 };
  const articleUrl = `${BLOG_URL}/${article.slug}`;
  const rows = POST_PLATFORMS.map((platform) => ({
    url: `${articleUrl}#${platform}`, kind: "post", side: "own", platform,
    title: article.title, snippet: article.excerpt || article.description || "",
    meta: { article_url: articleUrl, category: article.category },
  }));
  const { data, error: insertError } = await db.from(TABLE)
    .upsert(rows, { onConflict: "url", ignoreDuplicates: true }).select("id");
  if (insertError) return { added: 0, error: insertError.message };
  return { added: (data || []).length, article: article.slug };
}

// One page of a queue, server paged, with the count of each state.
export async function listItems({ kind = "signal", state = "new", limit = 20, offset = 0, db = supabase } = {}) {
  if (!KINDS.includes(kind) || !STATES.includes(state)) {
    const e = new Error("Choose a list to show."); e.status = 400; throw e;
  }
  const { data, error, count } = await db.from(TABLE).select("*", { count: "exact" })
    .eq("kind", kind).eq("state", state)
    .order("found_at", { ascending: false }).order("id", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    if (/prospector_outside_items/.test(error.message || "")) return { items: [], total: 0, ready: false };
    throw error;
  }
  return { items: data || [], total: count || 0, ready: true };
}

// How many wait in each list.
export async function countsByKind({ db = supabase } = {}) {
  const out = {};
  for (const kind of KINDS) {
    const { count, error } = await db.from(TABLE).select("id", { count: "exact", head: true }).eq("kind", kind).eq("state", "new");
    out[kind] = error ? 0 : count || 0;
  }
  return out;
}

// A person's decision on one item, or their edit of its draft.
export async function actOnItem(id, { action, text, subject, admin } = {}, { db = supabase } = {}) {
  const key = Number(id);
  if (!Number.isInteger(key) || key <= 0) { const e = new Error("That item doesn't exist."); e.status = 404; throw e; }
  let patch;
  if (action === "save") {
    const body = String(text || "").trim();
    if (!body) { const e = new Error("Write something before saving."); e.status = 400; throw e; }
    patch = { draft_text: body, ...(subject !== undefined ? { draft_subject: String(subject).trim() || null } : {}) };
  } else if (action === "done" || action === "dismiss" || action === "reopen") {
    patch = {
      state: action === "done" ? "done" : action === "dismiss" ? "dismissed" : "new",
      acted_at: action === "reopen" ? null : new Date().toISOString(),
      acted_by: action === "reopen" ? null : admin?.name || admin?.email || null,
    };
  } else {
    const e = new Error("Choose what to do with it."); e.status = 400; throw e;
  }
  const { data, error } = await db.from(TABLE).update(patch).eq("id", key).select("*");
  if (error) throw error;
  if (!data?.length) { const e = new Error("That item doesn't exist."); e.status = 404; throw e; }
  return data[0];
}
