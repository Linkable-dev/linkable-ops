import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { readSettings } from "../lib/instagram-dm-queue.js";
import { actOnItem, countsByKind, draftMissing, listItems, queueDailyPosts } from "../lib/outside-agents.js";

// Outside agents: the three queues (lib/outside-agents.js) and a person's
// decisions on them. Errors are sentences.
export function outsideRoutes({
  list = listItems, counts = countsByKind, act = actOnItem, draft = draftMissing, posts = queueDailyPosts,
} = {}) {
  const router = Router();
  const run = (fn) => async (req, res) => {
    try { res.json(await fn(req)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  };
  const page = (q) => ({
    limit: Math.min(Math.max(parseInt(q.limit) || 20, 1), 50),
    offset: Math.max(parseInt(q.offset) || 0, 0),
  });

  // GET /api/outside?kind=signal|partner|post&state=new|done|dismissed&limit=&offset=
  router.get("/", run((req) => list({
    kind: String(req.query.kind || "signal"), state: String(req.query.state || "new"), ...page(req.query),
  })));

  // GET /api/outside/summary: how many wait in each list, the switch, the last search.
  router.get("/summary", run(async () => {
    const settings = await readSettings();
    const { data } = await supabase.from("prospector_settings").select("value").eq("key", "outside_last_run").maybeSingle();
    return { counts: await counts(), on: settings.outside_agents !== false, last_run: data?.value || null };
  }));

  // POST /api/outside/draft: write the drafts that are missing now, and today's posts.
  router.post("/draft", run(async () => ({ posts: await posts(), ...(await draft({ limit: 10, budgetMs: 35_000 })) })));

  // POST /api/outside/:id { action: save|done|dismiss|reopen, text?, subject? }
  router.post("/:id", run((req) => act(req.params.id, {
    action: req.body?.action, text: req.body?.text, subject: req.body?.subject, admin: req.admin,
  })));

  return router;
}
