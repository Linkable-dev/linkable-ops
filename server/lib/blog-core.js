// Blog article generator. Runtime agnostic on purpose: it runs both in the ops
// Express server (Node) and in the Supabase Edge Function that writes the daily
// article (Deno), so there is exactly one copy of the prompt, the validator and
// the repair pass. Everything the environment provides is injected through
// initBlogCore, so nothing here reads a file, an env var or a client directly.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

// Set once at startup by whichever adapter is loading this:
//   env            plain object of the variables below
//   style, facts   contents of style.md and facts.md
//   imagePool      contents of images.json
//   db             a supabase-js client for the blog project
//   findHeroPhoto  (query, { exclude }) => hero image object or null
const cfg = { env: {}, style: "", facts: "", imagePool: [], db: null, findHeroPhoto: async () => null };
export function initBlogCore(next) {
  Object.assign(cfg, next);
  bannedCache = null;
  return cfg;
}
const db = () => {
  if (!cfg.db) throw new Error("blog-core: initBlogCore({ db }) was never called");
  return cfg.db;
};

const model = () => cfg.env.BLOG_MODEL || "claude-sonnet-5";
const maxCost = () => Number(cfg.env.BLOG_MAX_COST_USD) || 0.10;
const MAX_READ_MINUTES = 6;
// The function ceiling is 300 s (vercel.json maxDuration). The loop makes at
// most three attempts at roughly 45 s each, plus a repair pass, so 150 s is all
// it can use; the rest is margin for the hero photo, the insert and the rebuild
// trigger. Retries only start while another attempt is expected to fit.
const deadlineMs = () => Number(cfg.env.BLOG_DEADLINE_MS) || 150_000;
// USD per million tokens (input, output, cache write, cache read)
const PRICES = {
  "claude-sonnet-5": { in: 2, out: 10, cw: 2.5, cr: 0.2 },
  "claude-opus-5": { in: 5, out: 25, cw: 6.25, cr: 0.5 },
  "claude-haiku-4-5": { in: 1, out: 5, cw: 1.25, cr: 0.1 },
};
export function usageCost(usage, modelName = model()) {
  const p = PRICES[modelName] || PRICES["claude-sonnet-5"];
  const u = usage || {};
  return ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out + (u.cache_creation_input_tokens || 0) * p.cw + (u.cache_read_input_tokens || 0) * p.cr) / 1e6;
}
// The blog uses its own Anthropic key so its spend is tracked separately from
// the outreach features (falls back to the shared key if not set).
const apiKey = () => cfg.env.BLOG_ANTHROPIC_API_KEY || cfg.env.ANTHROPIC_API_KEY;
const anthropic = () => new Anthropic({ apiKey: apiKey() });
// Parsed out of style.md once per configuration, so the guide stays the single
// source of truth for the list.
let bannedCache = null;
const bannedWords = () => (bannedCache ||= (cfg.style.match(/Never use these words or phrases: (.*)/)?.[1] || "")
  .split(",").map((w) => w.trim().replace(/\.$/, "")).filter((w) => w.length > 2));

export const slugify = (s) => s.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);
// --- similarity guard: keeps the backlog and the articles from repeating ---
const STOP = new Set("a an the and or of to for in on with your you how what why when do does is are be vs versus from into every month first should brand brands ecommerce shopify creator creators marketing".split(" "));
const tokens = (s) => new Set(String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ies)$/, "y").replace(/(s|ing|ed)$/, "")));
export function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size); // overlap relative to the shorter phrase
}
export function tooSimilar(text, others, threshold = 0.6) {
  return others.find((o) => similarity(text, o) >= threshold) || null;
}
const countWords = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).length;
// Body words: paragraphs, headings, quotes and list items (FAQ answers are counted separately by the renderer).
export const wordCount = (blocks) => (blocks || []).reduce((n, b) => n + countWords(b.text) + (b.items || []).reduce((m, it) => m + countWords(it), 0), 0);
// Rules the validator enforces; the messages are built from the same numbers.
export const LIMITS = { words: [600, 1150], title: [40, 65], meta: [110, 158], h2: [3, 6], faqs: [3, 5], lists: 2, wpm: 200 };
export const readMinutes = (words) => Math.max(1, Math.round((words || 0) / LIMITS.wpm));

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
  if (words < LIMITS.words[0] || words > LIMITS.words[1]) problems.push(`body has ${words} words, needs ${LIMITS.words[0]} to ${LIMITS.words[1]} (aim for 700 to 1000)`);
  if (readMinutes(words) > MAX_READ_MINUTES) problems.push(`read time ${readMinutes(words)} min, maximum is ${MAX_READ_MINUTES}`);
  if (a.title.length < LIMITS.title[0] || a.title.length > LIMITS.title[1]) problems.push(`title is ${a.title.length} characters, needs ${LIMITS.title[0]} to ${LIMITS.title[1]} (aim for 45 to 62)`);
  if (a.metaDescription.length < LIMITS.meta[0] || a.metaDescription.length > LIMITS.meta[1]) problems.push(`meta description is ${a.metaDescription.length} characters, needs ${LIMITS.meta[0]} to ${LIMITS.meta[1]} (aim for 120 to 155)`);
  if (/[—–]/.test(text)) problems.push("contains an em dash or en dash");
  if (/!/.test(text)) problems.push("contains an exclamation mark");
  const lists = blocks.filter((b) => b.type === "ul" || b.type === "ol").length;
  if (lists > LIMITS.lists) problems.push(`${lists} lists, maximum is ${LIMITS.lists}`);
  const h2s = blocks.filter((b) => b.type === "h2");
  if (h2s.length < LIMITS.h2[0] || h2s.length > LIMITS.h2[1]) problems.push(`${h2s.length} H2 sections, needs ${LIMITS.h2[0]} to ${LIMITS.h2[1]}`);
  if (h2s.some((h) => /^(introduction|conclusion|final thoughts|wrapping up|summary)$/i.test((h.text || "").trim()))) problems.push("has an Introduction/Conclusion style heading");
  if (faqs.length < LIMITS.faqs[0] || faqs.length > LIMITS.faqs[1]) problems.push(`${faqs.length} FAQs, needs ${LIMITS.faqs[0]} to ${LIMITS.faqs[1]}`);
  const lower = text.toLowerCase();
  const hits = bannedWords().filter((w) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\.\\\.\\\./g, ".*")}([^a-z]|$)`, "i").test(lower));
  if (hits.length) problems.push(`uses banned words: ${hits.join(", ")}`);
  const figures = [...body.matchAll(/(?:[$£€]\s?\d[\d,.]*\w*|\d[\d,.]*\s?(?:%|percent|×|x\b))/gi)].map((m) => m[0]);
  const bad = figures.filter((f) => !cfg.facts.includes(f.replace(/\s/g, "").replace(/percent/i, "%")) && !cfg.facts.includes(f));
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
  const { data, error } = await db().from("blog_posts").select("slug, title, keyword, hero_image_id, hero_image, status").neq("status", "archived");
  if (error) throw new Error(error.message);
  return data || [];
}

export function imageCandidates(posts) {
  const use = {};
  for (const p of posts) if (p.hero_image_id) use[p.hero_image_id] = (use[p.hero_image_id] || 0) + 1;
  return [...cfg.imagePool].sort((a, b) => (use[a.id] || 0) - (use[b.id] || 0)).slice(0, 3);
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
  const { data: topics } = await db().from("blog_topics").select("keyword");
  const TopicSchema = z.object({ topics: z.array(z.object({ keyword: z.string(), angle: z.string(), category: z.string() })) });
  const res = await client.messages.parse({
    model: model(), max_tokens: 4000, thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: zodOutputFormat(TopicSchema) },
    system: cfg.style + "\n\n" + cfg.facts,
    messages: [{ role: "user", content: `Propose ${count} new blog topics for the Linkable blog. Each needs a search keyword phrase a Shopify brand owner would type (lower case, 4 to 8 words), a one-sentence angle that is specific and opinionated, and a category (Sourcing, Strategy, Playbook, Measurement or "By category"). Avoid anything close to these existing titles and keywords:\n${posts.map((p) => `- ${p.title} (${p.keyword || "no keyword"})`).join("\n")}\n${(topics || []).map((t) => `- ${t.keyword}`).join("\n")}` }],
  });
  const existing = [...posts.map((p) => p.title), ...posts.map((p) => p.keyword), ...(topics || []).map((t) => t.keyword)].filter(Boolean);
  const out = [];
  for (const t of res.parsed_output?.topics || []) {
    if (tooSimilar(t.keyword, existing) || tooSimilar(t.keyword, out.map((o) => o.keyword))) continue;
    out.push(t);
  }
  return out;
}

/* --------------------------------------------------------------- article */
// Returns { article, attempts, problems } where article passed validation.
// The checks that reject an article are all countable, so they are stated as a
// contract beside the task instead of being left in the middle of the style
// guide, and the model is asked to count before it answers. Two of the first
// three articles failed here: one invented figures, one wrote seven H2 sections
// and used a banned word inside a hyphenated compound ("highest-leverage").
// The numbers come from LIMITS, so this brief and the validator cannot drift.
const contract = () => `
CHECKED AUTOMATICALLY. Any one of these rejects the article, so count before you answer.

- H2 sections: write exactly 4 or 5. H3 headings do not count towards this. (Rejected outside ${LIMITS.h2[0]} to ${LIMITS.h2[1]}.)
- FAQs: exactly 3 or 4, none repeating a question an H2 already asks. (Rejected outside ${LIMITS.faqs[0]} to ${LIMITS.faqs[1]}.)
- Lists: at most ${LIMITS.lists} ul or ol blocks in the whole article. None at all is fine and usually better.
- Body length: aim for 750 to 950 words. (Rejected outside ${LIMITS.words[0]} to ${LIMITS.words[1]}.)
- Title: aim for 45 to 62 characters. (Rejected outside ${LIMITS.title[0]} to ${LIMITS.title[1]}.)
- Meta description: aim for 120 to 155 characters. (Rejected outside ${LIMITS.meta[0]} to ${LIMITS.meta[1]}.)
- Reading time must stay under ${MAX_READ_MINUTES} minutes, which the body length gives you.

NUMBERS. Every digit, percentage, currency amount and multiplier anywhere in the article must
appear verbatim in the verified facts you were given. You may not estimate, round, illustrate or
invent one, and that applies inside hypothetical examples too. A worked example can say "a skincare
brand doing a few hundred orders a month" but not "doing 300 orders a month". If you want to make a
quantitative point you cannot source, make it qualitatively instead: "most of the sales come from a
handful of creators", not "80% of sales come from 20% of creators".

BANNED WORDS. These are rejected anywhere in the article, including inside hyphenated compounds
and inflections, so "high-leverage", "leveraging" and "leveraged" all break the "leverage" rule:
${bannedWords().join(", ")}.

PUNCTUATION. No em dash or en dash anywhere. No exclamation mark anywhere.

Before you return the article, run this check and fix anything that fails:
1. Count the h2 blocks. Is the total 4 or 5?
2. Count the ul and ol blocks. Is the total 2 or fewer?
3. Count the FAQs. Is it 3 or 4, and does each ask something no H2 asks?
4. Count the characters of the title, then of the meta description.
5. Re-read every digit in the article. Is each one in the verified facts?
6. Search the whole text for each banned word, including as part of a longer word.
7. Search the whole text for the characters em dash, en dash and exclamation mark.
`;

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
Follow every rule in the style guide and only state facts from the facts file.
${contract()}`;

  let feedback = "";
  const log = [];
  let spent = 0;
  let best = null; // { article, problems }
  const started = Date.now();
  for (let attempt = 1; attempt <= 3; attempt++) {
    onProgress(`attempt ${attempt}`);
    const t0 = Date.now();
    const res = await client.messages.parse({
      model: model(),
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: zodOutputFormat(ArticleSchema) },
      system: [{ type: "text", text: cfg.style + "\n\n" + cfg.facts, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: brief + feedback }],
    });
    const cost = usageCost(res.usage);
    const took = Date.now() - t0;
    spent += cost;
    if (res.stop_reason === "refusal") throw new Error("model refused: " + (res.stop_details?.explanation || ""));
    const a = res.parsed_output;
    if (!a) { feedback = "\n\nThe previous output was not valid JSON for the schema. Return the article again."; log.push({ attempt, cost, problems: ["invalid JSON"] }); continue; }
    const problems = validateArticle(a);
    // A title collision alone is fixed with a tiny title-only request (a few
    // hundred tokens) rather than regenerating the whole article.
    const dup = tooSimilar(a.title, posts.map((p) => p.title), 0.75);
    if (dup && !problems.length && Date.now() - started + 8_000 < deadlineMs()) {
      const fixed = await retitle(client, a, posts.map((p) => p.title), dup);
      spent += fixed.cost;
      if (fixed.title) { a.title = fixed.title; a.slug = slugify(fixed.title); log.push({ attempt, note: `title rewritten (${fixed.cost.toFixed(4)} USD)` }); }
      else problems.push(`title too similar to the existing article "${dup}"; take a clearly different angle`);
    } else if (dup) problems.push(`title too similar to the existing article "${dup}"; take a clearly different angle`);
    log.push({ attempt, cost: Number(cost.toFixed(4)), seconds: Math.round(took / 1000), words: wordCount(a.blocks), problems });
    if (!best || problems.length < best.problems.length) best = { article: a, problems };
    if (!problems.length) {
      const heroImageId = candidates.some((c) => c.id === a.heroImageId) ? a.heroImageId : candidates[0].id;
      return { article: { ...a, heroImageId }, attempts: log, model: model(), cost: Number(spent.toFixed(4)), valid: true };
    }
    // A full rewrite needs roughly as long as the attempt just made. When that no
    // longer fits, try the cheap repair pass, which only rewrites what failed.
    const noRoomForRewrite = Date.now() - started + took > deadlineMs() || spent + cost > maxCost();
    if (noRoomForRewrite && Date.now() - started + 12_000 < deadlineMs() && spent + 0.02 < maxCost()) {
      const fixed = await repairArticle(client, a, problems);
      spent += fixed.cost;
      const after = validateArticle(fixed.article);
      log.push({ attempt, note: `repair pass (${fixed.cost.toFixed(4)} USD)`, fixed: problems.filter((x) => !after.includes(x)), remaining: after });
      if (!after.length) {
        const heroImageId = candidates.some((c) => c.id === fixed.article.heroImageId) ? fixed.article.heroImageId : candidates[0].id;
        return { article: { ...fixed.article, heroImageId }, attempts: log, model: model(), cost: Number(spent.toFixed(4)), valid: true };
      }
      if (after.length < best.problems.length) best = { article: fixed.article, problems: after };
    }
    // Stop retrying when another attempt would blow the budget; hand back the
    // best draft so a human can fix it instead of publishing something invalid.
    if (spent + cost > maxCost()) { log.push({ note: `budget ${maxCost()} USD reached after ${attempt} attempt(s)` }); break; }
    if (Date.now() - started + took > deadlineMs()) { log.push({ note: `time budget reached after ${attempt} attempt(s); draft saved for review` }); break; }
    feedback = `\n\nYour previous draft was rejected for these reasons, fix all of them and return the complete article again:\n- ${problems.join("\n- ")}`;
  }
  if (!best) throw new Error("article failed after 3 attempts");
  const heroImageId = candidates.some((c) => c.id === best.article.heroImageId) ? best.article.heroImageId : candidates[0].id;
  return { article: { ...best.article, heroImageId }, attempts: log, model: model(), cost: Number(spent.toFixed(4)), valid: false, problems: best.problems };
}

// Next queued topic: skip anything too close to an existing article and
// prefer categories not used by the most recent posts, so consecutive
// articles vary in subject.
async function pickNextTopic() {
  const { data: queued } = await db().from("blog_topics").select("*").eq("status", "queued").order("position");
  if (!queued?.length) return null;
  const { data: recent } = await db().from("blog_posts").select("title, keyword, category, published_at").neq("status", "archived").order("published_at", { ascending: false, nullsFirst: false }).limit(50);
  const titles = (recent || []).flatMap((p) => [p.title, p.keyword]).filter(Boolean);
  const recentCats = (recent || []).slice(0, 4).map((p) => p.category);
  const candidates = [];
  for (const t of queued) {
    const dup = tooSimilar(t.keyword, titles);
    if (dup) { await db().from("blog_topics").update({ status: "skipped" }).eq("id", t.id); console.log(`topic skipped as too similar: "${t.keyword}" ~ "${dup}"`); continue; }
    candidates.push(t);
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => (recentCats.filter((c) => c === a.category).length - recentCats.filter((c) => c === b.category).length) || (a.position - b.position));
  return candidates[0];
}

// Title-only rewrite: cheap alternative to a full retry when the article is
// fine but its title collides with an existing one.
// Most rejected drafts fail on mechanical rules: a banned word, one H2 too many,
// a title a few characters long. Regenerating the whole article costs another 38
// seconds, so it is still the fallback when a rewrite no longer fits the budget.
// This asks only for the parts that need changing:
// a few hundred output tokens, a few seconds, and it keeps the article that was
// otherwise fine. Returns { article, cost } with the edits applied.
const RepairSchema = z.object({
  title: z.string().nullable(),
  metaDescription: z.string().nullable(),
  excerpt: z.string().nullable(),
  blockEdits: z.array(z.object({
    index: z.number().describe("0-based index of the block to replace"),
    type: z.enum(["p", "h2", "h3", "ul", "ol", "quote"]),
    text: z.string().nullable(),
    items: z.array(z.string()).nullable(),
  })),
  deleteIndexes: z.array(z.number()),
});

export async function repairArticle(client, a, problems) {
  const outline = (a.blocks || [])
    .map((b, i) => `${i}. [${b.type}] ${(b.text || (b.items || []).join(" | ")).slice(0, 240)}`)
    .join("\n");
  const res = await client.messages.parse({
    model: model(), max_tokens: 2000,
    output_config: { effort: "low", format: zodOutputFormat(RepairSchema) },
    system: [{ type: "text", text: cfg.style, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: `This article was rejected by the style checker. Fix ONLY what the problems below require and change nothing else.

Problems:
- ${problems.join("\n- ")}

Title (${a.title.length} chars): ${a.title}
Meta description (${a.metaDescription.length} chars): ${a.metaDescription}
Excerpt: ${a.excerpt}

Blocks:
${outline}

Rules for your reply:
- Set title, metaDescription or excerpt only if that field is named in a problem; otherwise null.
- blockEdits replaces a block in place: give its index and the complete new block. To rewrite a sentence that uses a banned word, return the whole block text with that word replaced by a plain English alternative.
- To reduce the number of H2 sections, change an H2 to type "h3" (keep its text) rather than deleting the section.
- deleteIndexes removes blocks entirely; use it only when a problem needs fewer blocks and nothing else will do.
- Keep the word count roughly the same. British English. No dashes, no exclamation marks, no colons in the title.` }],
  });
  const cost = usageCost(res.usage);
  const out = res.parsed_output;
  if (!out) return { article: a, cost };
  const blocks = (a.blocks || []).map((b) => ({ ...b }));
  for (const e of out.blockEdits || []) {
    if (Number.isInteger(e.index) && e.index >= 0 && e.index < blocks.length) {
      blocks[e.index] = { type: e.type, text: e.text ?? null, items: e.items ?? null };
    }
  }
  const drop = new Set((out.deleteIndexes || []).filter((i) => Number.isInteger(i) && i >= 0 && i < blocks.length));
  const article = {
    ...a,
    title: out.title || a.title,
    metaDescription: out.metaDescription || a.metaDescription,
    excerpt: out.excerpt || a.excerpt,
    blocks: blocks.filter((_, i) => !drop.has(i)),
  };
  if (out.title) article.slug = slugify(out.title);
  return { article, cost };
}

async function retitle(client, a, existingTitles, dup) {
  const Schema = z.object({ titles: z.array(z.string()) });
  const res = await client.messages.parse({
    model: model(), max_tokens: 400,
    output_config: { effort: "low", format: zodOutputFormat(Schema) },
    messages: [{ role: "user", content: `Propose 5 alternative titles (45 to 62 characters, sentence case, no colons, no dashes, no exclamation marks, British English) for an article whose current title is "${a.title}" and whose first paragraph is: ${a.blocks.find((b) => b.type === "p")?.text || ""}\nThe title must read clearly differently from "${dup}" and from these existing titles:\n${existingTitles.map((t) => "- " + t).join("\n")}` }],
  });
  const cost = usageCost(res.usage);
  const pick = (res.parsed_output?.titles || []).find((t) => t.length >= 40 && t.length <= 65 && !/[—–!:]/.test(t) && !tooSimilar(t, existingTitles, 0.75));
  return { title: pick || null, cost };
}

// Full pipeline: pick a topic (or use the given one), write, store as a row.
export async function generatePost({ keyword, angle, category, topicId, publish = false, createdBy = null } = {}) {
  let topic = null;
  publish = Boolean(publish);
  if (topicId) {
    const { data } = await db().from("blog_topics").select("*").eq("id", topicId).single();
    topic = data;
  } else if (keyword) {
    topic = { keyword, angle: angle || "", category: category || "Guide" };
  } else {
    topic = await pickNextTopic();
    if (!topic) {
      const fresh = await proposeTopics(10);
      if (!fresh.length) throw new Error("no topics available");
      const { data: inserted } = await db().from("blog_topics").insert(fresh.map((t, i) => ({ ...t, position: 1000 + i }))).select();
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
  const heroImage = await cfg.findHeroPhoto(article.imageQuery || topic.keyword, { exclude: posts.map((p) => p.hero_image?.id).filter(Boolean) }).catch((e) => { console.warn("hero photo search failed:", e.message); return null; });
  const row = {
    slug, title: article.title, description: article.metaDescription, excerpt: article.excerpt,
    category: article.category, keyword: topic.keyword, status: publish ? "published" : "draft", source: "ai",
    hero_image_id: article.heroImageId, hero_image_alt: heroImage?.alt || article.heroAlt, hero_image: heroImage, blocks: article.blocks, faqs: article.faqs,
    word_count: words, read_minutes: readMinutes(words), published_at: publish ? date : null,
    generation: { model, attempts, cost_usd: cost, valid, problems: problems || [], topic: topic.keyword }, created_by: createdBy,
  };
  const { data: post, error } = await db().from("blog_posts").insert(row).select().single();
  if (error) throw new Error(error.message);
  if (topic.id) await db().from("blog_topics").update({ status: "used", post_id: post.id }).eq("id", topic.id);
  return post;
}

/* ------------------------------------------------- landing-site rebuild */
// Asks the landing-page repo to re-render the blog from the database now.
// Without GITHUB_TOKEN the site still picks changes up on its own schedule.
export async function triggerSiteRebuild(reason = "blog updated") {
  const token = cfg.env.GITHUB_TOKEN;
  const repo = cfg.env.LANDING_REPO || "Linkable-dev/linkable-landing-page";
  if (!token) return { triggered: false, note: "GITHUB_TOKEN not set; the site rebuilds on its schedule" };
  const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ event_type: "blog-publish", client_payload: { reason } }),
  });
  if (res.status !== 204) throw new Error(`GitHub dispatch failed: ${res.status} ${await res.text()}`);
  return { triggered: true };
}
