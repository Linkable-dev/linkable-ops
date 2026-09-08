// Blog admin API: articles for www.linkable.link live in Supabase
// (blog_posts / blog_topics, migration 018). Mounted with requireOpsAdmin.
import express from "express";
import { blogDb as supabase } from "../lib/blog-supabase.js";
import { generatePost, proposeTopics, triggerSiteRebuild, validateArticle, wordCount, readMinutes, slugify, IMAGE_POOL } from "../lib/blog-writer.js";
import { searchPhotos } from "../lib/blog-images.js";

const EDITABLE = ["slug", "title", "description", "excerpt", "category", "keyword", "status", "author_name", "hero_image_id", "hero_image_alt", "hero_image", "blocks", "faqs", "published_at"];

function pickEditable(body) {
  const out = {};
  for (const k of EDITABLE) if (body[k] !== undefined) out[k] = body[k];
  if (out.slug) out.slug = slugify(out.slug);
  if (out.blocks) {
    out.word_count = wordCount(out.blocks);
    out.read_minutes = readMinutes(out.word_count);
  }
  return out;
}

export function blogRoutes() {
  const router = express.Router();

  // ---- posts
  // Paginated list: ?status=&limit=&offset= -> { items, total, limit, offset }
  router.get("/posts", async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 100);
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);
      let q = supabase.from("blog_posts")
        .select("id, slug, title, excerpt, category, keyword, status, source, author_name, hero_image_id, hero_image, word_count, read_minutes, published_at, created_at, updated_at, created_by", { count: "exact" })
        .order("published_at", { ascending: false, nullsFirst: true })
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);
      if (req.query.status) q = q.eq("status", req.query.status);
      if (req.query.q) q = q.ilike("title", `%${String(req.query.q).replace(/[%_]/g, "")}%`);
      const { data, error, count } = await q;
      if (error) throw new Error(error.message);
      res.json({ items: data, total: count ?? data.length, limit, offset });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get("/posts/:id", async (req, res) => {
    try {
      const { data, error } = await supabase.from("blog_posts").select("*").eq("id", req.params.id).single();
      if (error) return res.status(404).json({ error: "Not found" });
      res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post("/posts", async (req, res) => {
    try {
      const row = { ...pickEditable(req.body), source: "manual", created_by: req.admin?.email || null };
      if (!row.title) return res.status(400).json({ error: "title is required" });
      row.slug = row.slug || slugify(row.title);
      if (row.status === "published" && !row.published_at) row.published_at = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase.from("blog_posts").insert(row).select().single();
      if (error) throw new Error(error.message);
      res.status(201).json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.put("/posts/:id", async (req, res) => {
    try {
      const patch = pickEditable(req.body);
      if (patch.status === "published" && !patch.published_at) {
        const { data: cur } = await supabase.from("blog_posts").select("published_at").eq("id", req.params.id).single();
        if (!cur?.published_at) patch.published_at = new Date().toISOString().slice(0, 10);
      }
      const { data, error } = await supabase.from("blog_posts").update(patch).eq("id", req.params.id).select().single();
      if (error) throw new Error(error.message);
      res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete("/posts/:id", async (req, res) => {
    try {
      const { data: cur } = await supabase.from("blog_posts").select("source").eq("id", req.params.id).single();
      if (cur?.source === "framer") return res.status(400).json({ error: "This post is published from Framer; unpublish it there." });
      const { error } = await supabase.from("blog_posts").delete().eq("id", req.params.id);
      if (error) throw new Error(error.message);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Quality check without saving (editor "Check" button).
  router.post("/posts/validate", (req, res) => {
    const a = req.body || {};
    res.json({ problems: validateArticle({ title: a.title || "", excerpt: a.excerpt || "", metaDescription: a.description || "", blocks: a.blocks || [], faqs: a.faqs || [] }), words: wordCount(a.blocks || []) });
  });

  // ---- generation
  // body: { topicId?, keyword?, angle?, category?, publish? }
  router.post("/generate", async (req, res) => {
    try {
      const post = await generatePost({ ...req.body, createdBy: req.admin?.email || null });
      let rebuild = null;
      if (post.status === "published") rebuild = await triggerSiteRebuild(`published ${post.slug}`).catch((e) => ({ triggered: false, note: e.message }));
      res.status(201).json({ post, rebuild });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ---- publish to the website (re-render from the database)
  router.post("/deploy", async (req, res) => {
    try { res.json(await triggerSiteRebuild(req.body?.reason || `requested by ${req.admin?.email || "admin"}`)); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ---- topics
  router.get("/topics", async (req, res) => {
    try {
      const { data, error } = await supabase.from("blog_topics").select("*").order("status").order("position");
      if (error) throw new Error(error.message);
      res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  router.post("/topics", async (req, res) => {
    try {
      const { keyword, angle = "", category = "Guide" } = req.body || {};
      if (!keyword) return res.status(400).json({ error: "keyword is required" });
      const { data: last } = await supabase.from("blog_topics").select("position").order("position", { ascending: false }).limit(1);
      const { data, error } = await supabase.from("blog_topics").insert({ keyword: keyword.trim().toLowerCase(), angle, category, position: (last?.[0]?.position || 0) + 1 }).select().single();
      if (error) throw new Error(error.message);
      res.status(201).json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  router.post("/topics/propose", async (req, res) => {
    try {
      const fresh = await proposeTopics(Number(req.body?.count) || 10);
      const { data: last } = await supabase.from("blog_topics").select("position").order("position", { ascending: false }).limit(1);
      const base = (last?.[0]?.position || 0) + 1;
      const { data, error } = await supabase.from("blog_topics").upsert(fresh.map((t, i) => ({ ...t, keyword: t.keyword.toLowerCase(), position: base + i })), { onConflict: "keyword", ignoreDuplicates: true }).select();
      if (error) throw new Error(error.message);
      res.json(data || []);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  router.put("/topics/:id", async (req, res) => {
    try {
      const patch = {};
      for (const k of ["keyword", "angle", "category", "status", "position"]) if (req.body[k] !== undefined) patch[k] = req.body[k];
      const { data, error } = await supabase.from("blog_topics").update(patch).eq("id", req.params.id).select().single();
      if (error) throw new Error(error.message);
      res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  router.delete("/topics/:id", async (req, res) => {
    try {
      const { error } = await supabase.from("blog_topics").delete().eq("id", req.params.id);
      if (error) throw new Error(error.message);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ---- hero images: static pool (served by the landing site) + stock search
  router.get("/images", (req, res) => res.json(IMAGE_POOL));
  router.get("/images/search", async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      if (!q) return res.status(400).json({ error: "q is required" });
      res.json(await searchPhotos(q, { perPage: Math.min(Number(req.query.limit) || 12, 30) }));
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  return router;
}
