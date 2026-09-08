// Writes blog articles for www.linkable.link with Claude and validates them
// against the voice rules (data/blog/style.md) and the verified facts
// (data/blog/facts.md). Used by the admin "Generate" action and the daily cron.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { blogDb as supabase } from "./blog-supabase.js";
import { findHeroPhoto } from "./blog-images.js";

// Sonnet 5 keeps a full article (with retries) inside the per-article budget;
// Opus 5 costs roughly 2.5x more per attempt.
const MODEL = process.env.BLOG_MODEL || "claude-sonnet-5";
const MAX_COST_USD = Number(process.env.BLOG_MAX_COST_USD) || 0.10;
const MAX_READ_MINUTES = 6;
// USD per million tokens (input, output, cache write, cache read)
const PRICES = {
  "claude-sonnet-5": { in: 2, out: 10, cw: 2.5, cr: 0.2 },
  "claude-opus-5": { in: 5, out: 25, cw: 6.25, cr: 0.5 },
  "claude-haiku-4-5": { in: 1, out: 5, cw: 1.25, cr: 0.1 },
};
export function usageCost(usage, model = MODEL) {
  const p = PRICES[model] || PRICES["claude-sonnet-5"];
  const u = usage || {};
  return ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out + (u.cache_creation_input_tokens || 0) * p.cw + (u.cache_read_input_tokens || 0) * p.cr) / 1e6;
}
// The blog uses its own Anthropic key so its spend is tracked separately from
// the outreach features (falls back to the shared key if not set).
const apiKey = () => process.env.BLOG_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
const anthropic = () => new Anthropic({ apiKey: apiKey() });
const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "blog");
const style = fs.readFileSync(path.join(DATA, "style.md"), "utf8");
const facts = fs.readFileSync(path.join(DATA, "facts.md"), "utf8");
export const IMAGE_POOL = JSON.parse(fs.readFileSync(path.join(DATA, "images.json"), "utf8"));
const banned = (style.match(/Never use these words or phrases: (.*)/)?.[1] || "")
  .split(",").map((s) => s.trim().replace(/\.$/, "")).filter((s) => s.length > 2);

export const slugify = (s) => s.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);
export const wordCount = (blocks) => (blocks || []).reduce((n, b) => n + (b.text ? b.text.split(/\s+/).length : 0) + (b.items ? b.items.join(" ").split(/\s+/).length : 0), 0);

const ArticleSchema = z.object({
  title: z.string(),
  slug: z.string(),
  metaDescription: z.string(),
  excerpt: z.string(),
  category: z.enum(["Sourcing", "Strategy", "Playbook", "Measurement", "By category", "Guide"]),
  heroImageId: z.string(),
  heroAlt: z.string(),
  imageQuery: z.string(),
  blocks: z.array(z.object({
    type: z.enum(["p", "h2", "h3", "ul", "ol", "quote"]),
    text: z.string().nullable(),
    items: z.array(z.string()).nullable(),
  })),
  faqs: z.array(z.object({ q: z.string(), a: z.string() })),
});

/* ------------------------------------------------------------- validate */
export function validateArticle(a) {
  const problems = [];
  const blocks = a.blocks || [];
  const faqs = a.faqs || [];
  const text = [a.title, a.excerpt, a.metaDescription, ...blocks.flatMap((b) => [b.text || "", ...(b.items || [])]), ...faqs.flatMap((f) => [f.q, f.a])].join("\n");
  const body = blocks.flatMap((b) => [b.text || "", ...(b.items || [])]).join(" ");
  const words = wordCount(blocks);
  if (words < 600 || words > 1150) problems.push(`body has ${words} words, needs 700 to 1000`);
  if (Math.round(words / 200) > MAX_READ_MINUTES) problems.push(`read time ${Math.round(words / 200)} min, maximum is ${MAX_READ_MINUTES}`);
  if (a.title.length < 40 || a.title.length > 65) problems.push(`title is ${a.title.length} characters, needs 45 to 62`);
  if (a.metaDescription.length < 110 || a.metaDescription.length > 158) problems.push(`meta description is ${a.metaDescription.length} characters, needs 120 to 155`);
  if (/[—–]/.test(text)) problems.push("contains an em dash or en dash");
  if (/!/.test(text)) problems.push("contains an exclamation mark");
  const lists = blocks.filter((b) => b.type === "ul" || b.type === "ol").length;
  if (lists > 2) problems.push(`${lists} lists, maximum is 2`);
  const h2s = blocks.filter((b) => b.type === "h2");
  if (h2s.length < 3 || h2s.length > 6) problems.push(`${h2s.length} H2 sections, needs 3 to 5`);
  if (h2s.some((h) => /^(introduction|conclusion|final thoughts|wrapping up|summary)$/i.test((h.text || "").trim()))) problems.push("has an Introduction/Conclusion style heading");
  if (faqs.length < 3 || faqs.length > 5) problems.push(`${faqs.length} FAQs, needs 3 or 4`);
  const lower = text.toLowerCase();
  const hits = banned.filter((w) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\.\\\.\\\./g, ".*")}([^a-z]|$)`, "i").test(lower));
  if (hits.length) problems.push(`uses banned words: ${hits.join(", ")}`);
  const figures = [...body.matchAll(/(?:[$£€]\s?\d[\d,.]*\w*|\d[\d,.]*\s?(?:%|percent|×|x\b))/gi)].map((m) => m[0]);
  const bad = figures.filter((f) => !facts.includes(f.replace(/\s/g, "").replace(/percent/i, "%")) && !facts.includes(f));
  if (bad.length) problems.push(`figures not in facts.md: ${[...new Set(bad)].join(", ")}`);
  // Glued sentences ("…both.aid arrangements") and doubled words are model slips.
  const glued = [...text.matchAll(/[a-z]\.([a-z]{2,})/g)].filter((m) => !/^(com|link|co|io|net|org|shop|uk)\b/.test(m[1]));
  if (glued.length) problems.push(`missing space after a full stop near: ${glued.slice(0, 3).map((m) => m[0]).join(", ")}`);
  if (/\b(\w+) \1\b/i.test(body)) problems.push("a word is repeated twice in a row");
  for (const b of blocks) {
    if ((b.type === "ul" || b.type === "ol") && !(b.items?.length)) problems.push("a list block has no items");
    if (b.type !== "ul" && b.type !== "ol" && !b.text) problems.push(`a ${b.type} block has no text`);
  }
  return problems;
}

/* --------------------------------------------------------------- helpers */
export async function listExistingPosts() {
  const { data, error } = await supabase.from("blog_posts").select("slug, title, keyword, hero_image_id, hero_image, status").neq("status", "archived");
  if (error) throw new Error(error.message);
  return data || [];
}

export function imageCandidates(posts) {
  const use = {};
  for (const p of posts) if (p.hero_image_id) use[p.hero_image_id] = (use[p.hero_image_id] || 0) + 1;
  return [...IMAGE_POOL].sort((a, b) => (use[a.id] || 0) - (use[b.id] || 0)).slice(0, 3);
}

export async function uniqueSlug(base, posts) {
  let slug = slugify(base) || "article";
  const taken = new Set(posts.map((p) => p.slug));
  while (taken.has(slug)) slug += "-2";
  return slug;
}

/* ---------------------------------------------------------------- topics */
export async function proposeTopics(count = 10) {
  const client = anthropic();
  const posts = await listExistingPosts();
  const { data: topics } = await supabase.from("blog_topics").select("keyword");
  const TopicSchema = z.object({ topics: z.array(z.object({ keyword: z.string(), angle: z.string(), category: z.string() })) });
  const res = await client.messages.parse({
    model: MODEL, max_tokens: 4000, thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: zodOutputFormat(TopicSchema) },
    system: style + "\n\n" + facts,
    messages: [{ role: "user", content: `Propose ${count} new blog topics for the Linkable blog. Each needs a search keyword phrase a Shopify brand owner would type (lower case, 4 to 8 words), a one-sentence angle that is specific and opinionated, and a category (Sourcing, Strategy, Playbook, Measurement or "By category"). Avoid anything close to these existing titles and keywords:\n${posts.map((p) => `- ${p.title} (${p.keyword || "no keyword"})`).join("\n")}\n${(topics || []).map((t) => `- ${t.keyword}`).join("\n")}` }],
  });
  return res.parsed_output?.topics || [];
}

/* --------------------------------------------------------------- article */
// Returns { article, attempts, problems } where article passed validation.
export async function writeArticle({ keyword, angle = "", category = "Guide", date = new Date().toISOString().slice(0, 10), onProgress = () => {} }) {
  if (!apiKey()) throw new Error("BLOG_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY) not set");
  const client = anthropic();
  const posts = await listExistingPosts();
  const candidates = imageCandidates(posts);
  const brief = `Write today's article for the Linkable blog.

Date: ${date}
Target keyword: ${keyword}
Angle: ${angle || "your call, but specific and opinionated"}
Category: ${category}

Existing posts (do not repeat them; link to one or two where genuinely useful, as /blog/<slug>):
${posts.map((p) => `- /blog/${p.slug}: ${p.title}`).join("\n")}

Hero image: choose one of these ids and write a plain descriptive alt text for it.
${candidates.map((c) => `- ${c.id}: ${c.alt}`).join("\n")}

Output format:
- "blocks" is the article body in order. Types: p, h2, h3, ul, ol, quote. For p/h2/h3/quote fill "text" and set "items" to null. For ul/ol fill "items" (each item one sentence or a short phrase) and set "text" to null.
- Inline formatting inside text and items: **bold**, *italic*, and links as [words](/pricing), [words](/creators), [words](/contact), [words](/blog/some-existing-slug) or [words](https://apps.shopify.com/linkable-1). No other links. No raw HTML.
- "faqs": 3 or 4 question/answer pairs that do not repeat the H2s.
- "imageQuery": 2 to 4 words describing a concrete photo scene for this article (stock-photo search).
- "slug": lower case words joined by hyphens, 3 to 7 words, containing the keyword's main words.
Follow every rule in the style guide and only state facts from the facts file.`;

  let feedback = "";
  const log = [];
  let spent = 0;
  let best = null; // { article, problems }
  for (let attempt = 1; attempt <= 3; attempt++) {
    onProgress(`attempt ${attempt}`);
    const res = await client.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: zodOutputFormat(ArticleSchema) },
      system: [{ type: "text", text: style + "\n\n" + facts, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: brief + feedback }],
    });
    const cost = usageCost(res.usage);
    spent += cost;
    if (res.stop_reason === "refusal") throw new Error("model refused: " + (res.stop_details?.explanation || ""));
    const a = res.parsed_output;
    if (!a) { feedback = "\n\nThe previous output was not valid JSON for the schema. Return the article again."; log.push({ attempt, cost, problems: ["invalid JSON"] }); continue; }
    const problems = validateArticle(a);
    log.push({ attempt, cost: Number(cost.toFixed(4)), words: wordCount(a.blocks), problems });
    if (!best || problems.length < best.problems.length) best = { article: a, problems };
    if (!problems.length) {
      const heroImageId = candidates.some((c) => c.id === a.heroImageId) ? a.heroImageId : candidates[0].id;
      return { article: { ...a, heroImageId }, attempts: log, model: MODEL, cost: Number(spent.toFixed(4)), valid: true };
    }
    // Stop retrying when another attempt would blow the budget; hand back the
    // best draft so a human can fix it instead of publishing something invalid.
    if (spent + cost > MAX_COST_USD) { log.push({ note: `budget ${MAX_COST_USD} USD reached after ${attempt} attempt(s)` }); break; }
    feedback = `\n\nYour previous draft was rejected for these reasons, fix all of them and return the complete article again:\n- ${problems.join("\n- ")}`;
  }
  if (!best) throw new Error("article failed after 3 attempts");
  const heroImageId = candidates.some((c) => c.id === best.article.heroImageId) ? best.article.heroImageId : candidates[0].id;
  return { article: { ...best.article, heroImageId }, attempts: log, model: MODEL, cost: Number(spent.toFixed(4)), valid: false, problems: best.problems };
}

// Full pipeline: pick a topic (or use the given one), write, store as a row.
export async function generatePost({ keyword, angle, category, topicId, publish = false, createdBy = null } = {}) {
  let topic = null;
  publish = Boolean(publish);
  if (topicId) {
    const { data } = await supabase.from("blog_topics").select("*").eq("id", topicId).single();
    topic = data;
  } else if (keyword) {
    topic = { keyword, angle: angle || "", category: category || "Guide" };
  } else {
    const { data } = await supabase.from("blog_topics").select("*").eq("status", "queued").order("position").limit(1);
    topic = data?.[0] || null;
    if (!topic) {
      const fresh = await proposeTopics(10);
      if (!fresh.length) throw new Error("no topics available");
      const { data: inserted } = await supabase.from("blog_topics").insert(fresh.map((t, i) => ({ ...t, position: 1000 + i }))).select();
      topic = inserted?.[0] || fresh[0];
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  const { article, attempts, model, cost, valid, problems } = await writeArticle({ keyword: topic.keyword, angle: topic.angle, category: topic.category, date });
  if (!valid) publish = false; // needs a human look first
  const posts = await listExistingPosts();
  const slug = await uniqueSlug(article.slug || article.title, posts);
  const words = wordCount(article.blocks);
  // Per-article photo from the stock library (falls back to the pool image).
  const heroImage = await findHeroPhoto(article.imageQuery || topic.keyword, { exclude: posts.map((p) => p.hero_image?.id).filter(Boolean) }).catch((e) => { console.warn("hero photo search failed:", e.message); return null; });
  const row = {
    slug, title: article.title, description: article.metaDescription, excerpt: article.excerpt,
    category: article.category, keyword: topic.keyword, status: publish ? "published" : "draft", source: "ai",
    hero_image_id: article.heroImageId, hero_image_alt: heroImage?.alt || article.heroAlt, hero_image: heroImage, blocks: article.blocks, faqs: article.faqs,
    word_count: words, read_minutes: Math.max(3, Math.round(words / 200)), published_at: publish ? date : null,
    generation: { model, attempts, cost_usd: cost, valid, problems: problems || [], topic: topic.keyword }, created_by: createdBy,
  };
  const { data: post, error } = await supabase.from("blog_posts").insert(row).select().single();
  if (error) throw new Error(error.message);
  if (topic.id) await supabase.from("blog_topics").update({ status: "used", post_id: post.id }).eq("id", topic.id);
  return post;
}

/* ------------------------------------------------- landing-site rebuild */
// Asks the landing-page repo to re-render the blog from the database now.
// Without GITHUB_TOKEN the site still picks changes up on its own schedule.
export async function triggerSiteRebuild(reason = "blog updated") {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.LANDING_REPO || "Linkable-dev/linkable-landing-page";
  if (!token) return { triggered: false, note: "GITHUB_TOKEN not set; the site rebuilds on its schedule" };
  const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ event_type: "blog-publish", client_payload: { reason } }),
  });
  if (res.status !== 204) throw new Error(`GitHub dispatch failed: ${res.status} ${await res.text()}`);
  return { triggered: true };
}
