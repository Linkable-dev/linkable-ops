import { Router } from "express";
import { listFeatureSwitches, setFeatureSwitch } from "../lib/featureSwitches.js";

// Switches: whole features of the main app turned off or on by the team
// (lib/featureSwitches.js), on the database picked in the header.
export function switchesRoutes({ list = listFeatureSwitches, set = setFeatureSwitch } = {}) {
  const router = Router();
  const run = (fn) => async (req, res) => {
    try { res.json(await fn(req)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  };

  // GET /api/switches
  router.get("/", run((req) => list(req.dbTarget)));

  // POST /api/switches/:key { enabled }
  router.post("/:key", run((req) => set(req.params.key, req.body?.enabled, req.admin, req.dbTarget)));

  return router;
}
