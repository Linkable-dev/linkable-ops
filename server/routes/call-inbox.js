import { Router } from "express";
import { addCallFromPhone } from "../lib/callInbox.js";

// Add calls from the phone (lib/callInbox.js): one Instagram post at a time,
// its link and, optionally, screenshots Claude reads.
export function callInboxRoutes({ add = addCallFromPhone } = {}) {
  const router = Router();

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
