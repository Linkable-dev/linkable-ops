// Node adapter for the blog generator.
//
// The generator itself lives in blog-core.js, which the Supabase Edge Function
// that writes the daily article imports too, so there is exactly one copy of the
// prompt, the validator and the repair pass. This file supplies the parts that
// differ per runtime: the data files from disk, process.env, the Supabase client
// and the Pexels lookup. Everything the routes used to import from here is
// re-exported, so callers did not change.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { blogDb } from "./blog-supabase.js";
import { findHeroPhoto } from "./blog-images.js";
import { initBlogCore } from "./blog-core.js";

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "blog");
const read = (name) => fs.readFileSync(path.join(DATA, name), "utf8");

export const IMAGE_POOL = JSON.parse(read("images.json"));

initBlogCore({
  env: process.env,
  style: read("style.md"),
  facts: read("facts.md"),
  imagePool: IMAGE_POOL,
  db: blogDb,
  findHeroPhoto,
});

// Once BLOG_EDGE_URL and BLOG_CRON_SECRET are set, generation runs on Supabase
// instead of here. Vercel's Hobby plan caps a function at 60 seconds and an
// article takes 30 to 60, so the work has to happen somewhere with more room;
// this process just triggers it. Unset either variable and it runs locally
// again, which is what the tests and local development do.
export const edgeEnabled = () => Boolean(process.env.BLOG_EDGE_URL && process.env.BLOG_CRON_SECRET);

export async function generateViaEdge(body = {}, { timeoutMs = 50_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(process.env.BLOG_EDGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.BLOG_CRON_SECRET}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `blog edge function returned ${res.status}`);
    return data;
  } catch (e) {
    // Losing patience here does not lose the article: Supabase carries on and
    // the row appears when it is done.
    if (e.name === "AbortError") return { ok: true, running: true, note: "still generating on Supabase, the article will appear shortly" };
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export {
  initBlogCore,
  usageCost,
  slugify,
  similarity,
  tooSimilar,
  wordCount,
  readMinutes,
  LIMITS,
  validateArticle,
  listExistingPosts,
  imageCandidates,
  uniqueSlug,
  proposeTopics,
  writeArticle,
  repairArticle,
  generatePost,
  triggerSiteRebuild,
} from "./blog-core.js";
