import { Router } from "express";

// The synthetic creator roster, run from here.
//
// It used to live in the main app at /admin/ai-creators, which is gone. The
// work is ops work and always was: both buttons spend — one model call to
// write an identity sheet, then three GPU renders — and the person they invent
// goes into a roster EVERY brand generates with, so it was never a per-brand
// decision.
//
// The split between casting and rendering is a review window. Casting is cheap
// and produces a face on paper; nothing is photographed until somebody has read
// the sheet and decided this is a person worth paying for. Re-rendering is the
// sharp one: it silently changes the face on everything generated afterwards.
//
// Everything here goes through the gateway's /content proxy rather than at the
// content service directly, because that seam is where the shared secret and
// the route whitelist already live.

// The gateway, per database target — the dev roster belongs to the dev content
// service, exactly like every other read on this panel.
const GATEWAY_URL = {
  prod: process.env.CONTENT_GATEWAY_URL || "https://http-injxm4ogfq-nw.a.run.app",
  dev: process.env.CONTENT_GATEWAY_URL_DEV || "https://http-dev-injxm4ogfq-nw.a.run.app",
};

// The gateway refuses /content without this (it 403s), so an ops deployment
// that has not been given the secret can do nothing here — which the page says
// in as many words rather than showing an empty roster that looks like "nobody
// has been cast yet".
function secretFor(target) {
  return target === "dev"
    ? process.env.CONTENT_GATEWAY_SECRET_DEV || process.env.CONTENT_GATEWAY_SECRET || ""
    : process.env.CONTENT_GATEWAY_SECRET || "";
}

async function callGateway(target, method, path, body) {
  const secret = secretFor(target);
  if (!secret) {
    const e = new Error("not configured");
    e.unconfigured = true;
    throw e;
  }
  const res = await fetch(`${GATEWAY_URL[target] || GATEWAY_URL.prod}/content${path}`, {
    method,
    headers: {
      "x-internal-secret": secret,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    // The gateway's own ceiling is two minutes; a page load must not wait it
    // out. Casting is a model call, so it gets longer than a list.
    signal: AbortSignal.timeout(body !== undefined ? 60_000 : 20_000),
  });
  return res;
}

export function aiCreatorsRoutes() {
  const router = Router();

  // GET /api/ai-creators — the roster, and the archetypes one can be cast from.
  router.get("/", async (req, res) => {
    const target = req.dbTarget || "prod";
    try {
      // Both fail to an empty page rather than a 500: an operator who cannot
      // reach the content service should see that, not a stack trace.
      const [roster, casting] = await Promise.all([
        callGateway(target, "GET", "/avatars").catch((e) => e),
        callGateway(target, "GET", "/casting").catch((e) => e),
      ]);
      if (roster?.unconfigured) {
        return res.json({
          configured: false, reachable: false, avatars: [], archetypes: [],
        });
      }
      const rosterJson = roster?.ok ? await roster.json() : { avatars: [] };
      const castingJson = casting?.ok ? await casting.json() : { archetypes: [] };
      res.json({
        configured: true,
        reachable: Boolean(roster?.ok),
        // Only the invented ones. A real creator's trained likeness lives in
        // the same table and is not ours to re-render.
        avatars: (rosterJson.avatars || []).filter((a) => a.kind === "synthetic"),
        archetypes: castingJson.archetypes || [],
      });
    } catch (e) {
      console.error("[ai-creators/list]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/ai-creators/cast — writes one identity sheet. One model call,
  // nothing rendered.
  router.post("/cast", async (req, res) => {
    const target = req.dbTarget || "prod";
    try {
      const body = {
        archetype_id: String(req.body?.archetype_id || ""),
        gender: String(req.body?.gender || ""),
        // The roster slot. Two avatars cast for the same archetype with the
        // same salt are the same person — which is the point of the sheet — so
        // a new one needs a slot nothing else has used.
        salt: String(req.body?.salt || "") || `slot-${Date.now()}`,
      };
      const r = await callGateway(target, "POST", "/avatars/cast", body);
      if (!r.ok) {
        return res.status(r.status).json({
          error: r.status === 422
            ? "That creator couldn't be written — try again in a moment"
            : "Casting failed",
        });
      }
      const avatar = await r.json();
      console.log(
        `[ai-creators] admin=${req.admin?.email || "?"} target=${target} cast=${avatar.id} ` +
        `archetype=${body.archetype_id || "auto"} name=${JSON.stringify(avatar.name || "")}`,
      );
      res.json({ avatar });
    } catch (e) {
      if (e.unconfigured) return res.status(409).json({ error: "The content gateway secret is not set on this deployment" });
      console.error("[ai-creators/cast]", e);
      res.status(502).json({ error: "The content service isn't answering right now" });
    }
  });

  // POST /api/ai-creators/:id/plates — three GPU renders. 202 and then minutes
  // of work, so there is nothing to wait for here.
  router.post("/:id/plates", async (req, res) => {
    const target = req.dbTarget || "prod";
    try {
      const id = String(req.params.id || "");
      if (!id) return res.status(400).json({ error: "Which creator?" });
      const r = await callGateway(target, "POST", `/avatars/${encodeURIComponent(id)}/plates`, {});
      if (r.status === 409) return res.status(409).json({ error: "Already rendering — give it a minute" });
      if (!r.ok) return res.status(r.status).json({ error: "Couldn't start the render" });
      console.log(
        `[ai-creators] admin=${req.admin?.email || "?"} target=${target} render=${id}`,
      );
      res.json({ rendering: true });
    } catch (e) {
      if (e.unconfigured) return res.status(409).json({ error: "The content gateway secret is not set on this deployment" });
      console.error("[ai-creators/plates]", e);
      res.status(502).json({ error: "The content service isn't answering right now" });
    }
  });

  return router;
}
