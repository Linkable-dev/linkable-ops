// Daily blog article, generated on Supabase instead of Vercel.
//
// Vercel's Hobby plan caps a function at 60 seconds, and writing an article
// takes 30 to 60, so a slow one timed out before anything was saved and a near
// miss could never be retried. This Edge Function has a much larger budget, so
// the writer can use its full three attempts plus the repair pass.
//
// It imports server/lib/blog-core.js, the same module the ops Express server
// uses, so the prompt, the validator and the repair pass exist in one copy only.
// Everything runtime-specific is injected through initBlogCore.
//
// Auth: send `Authorization: Bearer <BLOG_CRON_SECRET>`. The scheduled pg_cron
// job and the ops "Generate with AI" button both use that secret.
//
// Body (all optional):
//   { "publish": true, "keyword": "...", "angle": "...", "category": "...", "topicId": "..." }
// With no keyword or topicId it takes the next queued topic, which is what the
// daily schedule does.
import { createClient } from "npm:@supabase/supabase-js@2";
// blog-core.js and blog-images.js are the same modules the Node server uses, so
// the prompt, validator and repair pass exist once. They are plain JavaScript,
// so their option bags are typed at this boundary rather than inferred.
import {
  initBlogCore,
  generatePost as generatePostJs,
  triggerSiteRebuild,
} from "../../../server/lib/blog-core.js";
import { findHeroPhoto as findHeroPhotoJs } from "../../../server/lib/blog-images.js";

type HeroOptions = { exclude?: string[]; apiKey?: string };
type GenerateOptions = {
  keyword?: string; angle?: string; category?: string; topicId?: string;
  publish?: boolean; createdBy?: string | null;
};
type GeneratedPost = {
  id: string; title: string; slug: string; status: string; word_count: number;
  generation?: { valid?: boolean; problems?: string[]; cost_usd?: number; attempts?: unknown[] };
};
const findHeroPhoto = findHeroPhotoJs as (q: string, o: HeroOptions) => Promise<unknown>;
const generatePost = generatePostJs as (o: GenerateOptions) => Promise<GeneratedPost | null>;
// Generated from server/data/blog by scripts/build-edge-blog-data.mjs, because
// Deno only ships files that something imports. A test fails if it has drifted.
import promptData from "../_shared/prompt-data.json" with { type: "json" };

const env = Deno.env.toObject();
const SUPABASE_URL = env.BLOG_SUPABASE_URL ?? env.SUPABASE_URL ?? "";
const SERVICE_KEY = env.BLOG_SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

initBlogCore({
  env,
  style: promptData.style,
  facts: promptData.facts,
  imagePool: promptData.imagePool,
  db: createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } }),
  findHeroPhoto: (query: string, opts: { exclude?: string[] }) =>
    findHeroPhoto(query, { exclude: opts.exclude, apiKey: env.PEXELS_API_KEY }),
});

Deno.serve(async (req: Request) => {
  const secret = env.BLOG_CRON_SECRET;
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!secret || bearer !== secret) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* an empty body means "take the next queued topic" */ }

  const started = Date.now();
  try {
    const post = await generatePost({
      keyword: body.keyword as string | undefined,
      angle: body.angle as string | undefined,
      category: body.category as string | undefined,
      topicId: body.topicId as string | undefined,
      publish: body.publish !== false, // the daily run publishes unless told not to
      createdBy: (body.createdBy as string | undefined) ?? "supabase-cron",
    });

    // Ask the landing repo to re-render, but never fail the run over it: the
    // sync workflow polls every ten minutes anyway.
    let rebuild: unknown = "skipped";
    if (post?.status === "published") {
      rebuild = await triggerSiteRebuild("blog article published").catch((e: Error) => ({ error: e.message }));
    }

    return json({
      ok: true,
      seconds: Math.round((Date.now() - started) / 1000),
      post: post && {
        id: post.id, title: post.title, slug: post.slug, status: post.status,
        word_count: post.word_count, valid: post.generation?.valid,
        problems: post.generation?.problems ?? [], cost_usd: post.generation?.cost_usd,
        attempts: post.generation?.attempts?.length ?? 0,
      },
      rebuild,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[blog-daily]", message);
    return json({ ok: false, seconds: Math.round((Date.now() - started) / 1000), error: message }, 500);
  }
});
