import { Router } from "express";
import { anthropicCostReport } from "../lib/anthropic.js";

// Provider spend that doesn't fit provider_costs' credit/lead shape — no
// quantity to multiply by a rate, because Anthropic hands back a dollar
// figure directly. One endpoint per such provider, each reading straight
// from that provider's own billing rather than an estimate we maintain.
export function costsRoutes() {
  const router = Router();

  router.get("/anthropic", async (_req, res) => {
    try {
      res.json(await anthropicCostReport());
    } catch (e) {
      // A wrong key, an expired one, or Anthropic being briefly down all land
      // here — same as no key at all: this is one line on a reporting page,
      // not something that should ever take the rest of it down with it.
      console.error("[costs/anthropic]", e);
      res.json({ available: false, amount: 0, currency: "USD" });
    }
  });

  return router;
}
