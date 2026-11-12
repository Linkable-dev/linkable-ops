import { Router } from "express";
import { externalCallsClient } from "../lib/externalCalls.js";

// Campaigns from calls (main app QA 171): brands' Instagram calls with a
// Google Form, drafted by the main app's agent or added here by hand,
// approved here, then live as normal campaigns. All through the main app
// (lib/externalCalls.js); errors are its own sentences.

const pageOf = (q, def = 25) => ({
  limit: Math.min(Math.max(parseInt(q.limit) || def, 1), 100),
  offset: Math.max(parseInt(q.offset) || 0, 0),
});

export function externalCallsRoutes({ calls = externalCallsClient } = {}) {
  const router = Router();
  const reply = (res, e) => res.status(e.status || 500).json({ error: e.message });
  const run = (fn) => async (req, res) => {
    try { res.json(await fn(req)); } catch (e) { reply(res, e); }
  };

  // GET /api/external-calls?status=draft|live|closed|rejected|failed|reading&source=agent|manual&limit=&offset=
  router.get("/", run((req) => calls.list({
    status: String(req.query.status || ""), source: String(req.query.source || ""), ...pageOf(req.query),
  }, req.dbTarget)));

  // GET /api/external-calls/submissions?status=held&call_id=&brand=&limit=&offset=
  router.get("/submissions", run((req) => calls.submissions({
    status: String(req.query.status || ""), callId: String(req.query.call_id || ""),
    brandHandle: String(req.query.brand || ""), ...pageOf(req.query),
  }, req.dbTarget)));

  // POST /api/external-calls/submissions/:id { action: retry|dismiss }
  router.post("/submissions/:id", run((req) => calls.act(req.params.id, { action: req.body?.action, admin: req.admin }, req.dbTarget)));

  // GET /api/external-calls/brands?limit=&offset= — applicants per brand (step 12).
  router.get("/brands", run((req) => calls.brands(pageOf(req.query), req.dbTarget)));

  // POST /api/external-calls { post_url, form_url, caption?, owner_handle? } — Manual add.
  router.post("/", run((req) => calls.add({
    postUrl: req.body?.post_url, formUrl: req.body?.form_url, caption: req.body?.caption,
    ownerHandle: req.body?.owner_handle, admin: req.admin,
  }, req.dbTarget)));

  // GET /api/external-calls/:id — one call with its draft and its form.
  router.get("/:id", run((req) => calls.get(req.params.id, req.dbTarget)));

  // PUT /api/external-calls/:id { draft } — ops' edits to the draft.
  router.put("/:id", run((req) => calls.update(req.params.id, { draft: req.body?.draft, admin: req.admin }, req.dbTarget)));

  // POST /api/external-calls/:id/read { caption? } — Read again (one AI read).
  router.post("/:id/read", run((req) => calls.reread(req.params.id, { caption: req.body?.caption, admin: req.admin }, req.dbTarget)));

  // POST /api/external-calls/:id/image { image_url } — swap the photo ("" for none).
  router.post("/:id/image", run((req) => calls.image(req.params.id, { imageUrl: req.body?.image_url, admin: req.admin }, req.dbTarget)));

  // POST /api/external-calls/:id/decide { decision: approve|reject|close, reason? }
  router.post("/:id/decide", run((req) => calls.decide(req.params.id, {
    decision: req.body?.decision, reason: req.body?.reason, admin: req.admin,
  }, req.dbTarget)));

  return router;
}
