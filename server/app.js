import express from "express";
import cors from "cors";
import { tableRoutes } from "./routes/tables.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { opsRoutes } from "./routes/ops.js";
import { adminUsersRoutes } from "./routes/admin-users.js";
import { authRoutes, requireOpsAdmin } from "./routes/auth.js";
import { conversationsRoutes, conversationsWebhookRoutes } from "./routes/conversations.js";
import { cronRoutes } from "./routes/cron.js";
import { prospectingRoutes } from "./routes/prospecting.js";
import { outboundRoutes } from "./routes/outbound.js";
import { outboundCampaignsRoutes } from "./routes/outbound-campaigns.js";
import { outboundAgentsRoutes } from "./routes/outbound-agents.js";
import { insightsRoutes } from "./routes/insights.js";
import { autopilotRoutes } from "./routes/autopilot.js";
import { aiCreatorsRoutes } from "./routes/ai-creators.js";
import { contentRoutes } from "./routes/content.js";
import { blogRoutes } from "./routes/blog.js";
import { costsRoutes } from "./routes/costs.js";
import { dbTargetMiddleware } from "./middleware/dbTarget.js";

// The API, in one place.
//
// There used to be two of these: server/index.js for local development and
// api/index.js for Vercel, each with its own copy of the same twelve mounts.
// They drifted the first time anyone added a route — two were added to the
// local one only, worked perfectly in development, and 404'd in production
// with "Not found", which is the least informative way to discover that a
// deployment has a different idea of what the API is.
//
// Now both entry points import this. server/index.js listens on a port;
// api/index.js exports it as a serverless handler. Neither knows anything the
// other does not.
const app = express();

// The browser origins are local-only; on Vercel the UI is served from the same
// origin, so a permissive default costs nothing and an absent one breaks dev.
app.use(cors({ origin: ["http://localhost:3010", "http://localhost:5173"] }));

// Larger limit for inbound email webhooks (HTML bodies + headers add up).
// `verify` captures the raw body so Svix signatures can be checked — computing
// the HMAC over parsed JSON would re-stringify it and never match.
app.use(
  express.json({
    limit: "5mb",
    verify: (req, _res, buf) => {
      if (buf && buf.length) req.rawBody = buf;
    },
  }),
);

// Vercel rewrites /api/* to this one function and puts the real path in a
// header, so Express has to be told what the caller actually asked for.
// Locally these headers do not exist and this does nothing.
app.use((req, _res, next) => {
  const original =
    req.headers["x-matched-path"] || req.headers["x-invoke-path"] || req.headers["x-forwarded-uri"];
  if (original && typeof original === "string" && original.startsWith("/")) {
    req.url = original;
  }
  next();
});

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

// Each of these handles its own authentication.
app.use("/api/auth", authRoutes());
// Public webhook — secured by its Svix signature, not by an admin session.
app.use("/api/conversations", conversationsWebhookRoutes());
// Cron — secured by the CRON_SECRET bearer token.
app.use("/api/cron", cronRoutes());

// Everything below is admin-only. dbTargetMiddleware reads the x-db-target
// header the ops UI sends and binds it for the request, so cloudSqlQuery picks
// the matching pool. The Supabase-backed routes skip it deliberately: those
// tables only exist in one place.
app.use("/api/tables", dbTargetMiddleware, requireOpsAdmin, tableRoutes());
app.use("/api/analytics", dbTargetMiddleware, requireOpsAdmin, analyticsRoutes());
app.use("/api/ops", dbTargetMiddleware, requireOpsAdmin, opsRoutes());
app.use("/api/insights", dbTargetMiddleware, requireOpsAdmin, insightsRoutes());
app.use("/api/admin-users", dbTargetMiddleware, requireOpsAdmin, adminUsersRoutes());
// Creator recruiting, watched from here now that the brand app does not show it.
app.use("/api/autopilot", dbTargetMiddleware, requireOpsAdmin, autopilotRoutes());
// Casting and rendering spend money, so admin-only like everything else here.
app.use("/api/ai-creators", dbTargetMiddleware, requireOpsAdmin, aiCreatorsRoutes());
// What creators delivered. Read-only, and signed per database target.
app.use("/api/content", dbTargetMiddleware, requireOpsAdmin, contentRoutes());
// GTM outreach as agents: a goal, a budget and a clock — see lib/outbound-agent.js.
app.use("/api/outbound-agents", requireOpsAdmin, outboundAgentsRoutes());
app.use("/api/conversations", requireOpsAdmin, conversationsRoutes());
app.use("/api/prospecting", requireOpsAdmin, prospectingRoutes());
app.use("/api/outbound", requireOpsAdmin, outboundRoutes());
app.use("/api/outbound", requireOpsAdmin, outboundCampaignsRoutes());
app.use("/api/blog", requireOpsAdmin, blogRoutes());
// Provider spend that reads straight from the provider's own billing rather
// than usage × a rate we'd have to keep in sync — no database involved.
app.use("/api/costs", requireOpsAdmin, costsRoutes());

// A 404 that says what Express actually saw. This is the message that finally
// explained the missing routes, so it stays.
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.url, originalUrl: req.originalUrl });
});

export default app;
