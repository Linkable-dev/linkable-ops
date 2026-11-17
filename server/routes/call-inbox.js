import { Router } from "express";
import { addCallFromPhone, readOneScreenshot, findPostFromScreenshot } from "../lib/callInbox.js";

// Add calls from the phone (lib/callInbox.js): one Instagram post at a time,
// its link and, optionally, screenshots Claude reads.
export function callInboxRoutes({ add = addCallFromPhone, read = readOneScreenshot, find = findPostFromScreenshot } = {}) {
  const router = Router();
  const reply = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.status ? e.message : "Something went wrong on our side. Try again in a minute." });
      if (!e.status) console.error(`[call-inbox] ${e.stack || e.message}`);
    }
  };

  // Batch mode, screenshots only. POST /api/call-inbox/read { images: [one] }
  // → what Claude read; POST /api/call-inbox/find { handle, caption } → the
  // post's link and full caption, or post_url "" when nothing matched. Then
  // POST / adds it as below.
  router.post("/read", reply((req) => read(req.body || {})));
  router.post("/find", reply((req) => find(req.body || {})));

  // POST /api/call-inbox { post_url, images?: [{ media_type, data }], form_url?, caption?, instagram? }
  router.post("/", async (req, res) => {
    try {
      res.json(await add(req.body || {}, { admin: req.admin }, req.dbTarget));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.status ? e.message : "Something went wrong on our side. Try again in a minute." });
      if (!e.status) console.error(`[call-inbox] ${e.stack || e.message}`);
    }
  });

  return router;
}
