// The Outreach page's data: everything our own sender and the reply agent
// have done and are about to do. Read only.
//
//   GET /api/outreach-monitor              the whole picture
//   GET /api/outreach-monitor/people       one page of people (limit, offset, audience, stage, q)
//   GET /api/outreach-monitor/people/:id   one person, with every message

import { Router } from "express";
import { overview, people, person } from "../lib/outreach-monitor.js";

export function outreachMonitorRoutes() {
  const router = Router();
  const fail = (res, err, doing) => {
    console.error(`outreach monitor, ${doing}:`, err);
    res.status(500).json({ error: `We couldn't finish ${doing}. Try again in a moment.` });
  };

  router.get("/", async (_req, res) => {
    try { res.json(await overview()); } catch (err) { fail(res, err, "reading the outreach numbers"); }
  });

  router.get("/people", async (req, res) => {
    try {
      const { audience, stage, q, limit, offset } = req.query;
      res.json(await people({ audience, stage, q, limit, offset }));
    } catch (err) { fail(res, err, "reading the list of people"); }
  });

  router.get("/people/:id", async (req, res) => {
    try {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).json({ error: "We couldn't find that person." });
      const one = await person(req.params.id);
      if (!one) return res.status(404).json({ error: "We couldn't find that person." });
      res.json(one);
    } catch (err) { fail(res, err, "reading that conversation"); }
  });

  return router;
}
