import express from "express";
import cors from "cors";
import { tableRoutes } from "../server/routes/tables.js";
import { analyticsRoutes } from "../server/routes/analytics.js";
import { opsRoutes } from "../server/routes/ops.js";
import { adminUsersRoutes } from "../server/routes/admin-users.js";
import { authRoutes, requireOpsAdmin } from "../server/routes/auth.js";
import {
  conversationsRoutes,
  conversationsWebhookRoutes,
} from "../server/routes/conversations.js";
import { cronRoutes } from "../server/routes/cron.js";
import { blogRoutes } from "../server/routes/blog.js";
import { outboundRoutes } from "../server/routes/outbound.js";
import { outboundCampaignsRoutes } from "../server/routes/outbound-campaigns.js";
import { insightsRoutes } from "../server/routes/insights.js";
import { dbTargetMiddleware } from "../server/middleware/dbTarget.js";

const app = express();
app.use(cors());
// `verify` callback captures raw body for Svix HMAC verification —
// computing HMAC over parsed JSON would re-stringify and not match.
app.use(express.json({
  limit: "5mb",
  verify: (req, _res, buf) => {
    if (buf && buf.length) req.rawBody = buf;
  },
}));

// Vercel rewrites /api/* → /api and sets the original URL in a header.
// Reassign req.url so Express routers match the client's actual path.
app.use((req, _res, next) => {
  const original =
    req.headers["x-matched-path"] ||
    req.headers["x-invoke-path"] ||
    req.headers["x-forwarded-uri"];
  if (original && typeof original === "string" && original.startsWith("/")) {
    req.url = original;
  }
  next();
});

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

app.use("/api/auth", authRoutes());

// Public webhook (no admin auth — secured by Svix signature).
app.use("/api/conversations", conversationsWebhookRoutes());

// Cron routes (no admin auth — secured by the CRON_SECRET bearer token).
app.use("/api/cron", cronRoutes());

// dbTargetMiddleware reads the x-db-target header from the ops UI and binds
// the per-request target to AsyncLocalStorage so cloudSqlQuery() inside route
// handlers picks the matching pool. Conversations/outbound and auth/cron
// intentionally bypass it — those always hit prod (ops-internal tables only
// exist there).
app.use("/api/tables", dbTargetMiddleware, requireOpsAdmin, tableRoutes());
app.use("/api/analytics", dbTargetMiddleware, requireOpsAdmin, analyticsRoutes());
app.use("/api/ops", dbTargetMiddleware, requireOpsAdmin, opsRoutes());
app.use("/api/insights", dbTargetMiddleware, requireOpsAdmin, insightsRoutes());
app.use("/api/admin-users", dbTargetMiddleware, requireOpsAdmin, adminUsersRoutes());
app.use("/api/conversations", requireOpsAdmin, conversationsRoutes());
// Blog articles for www.linkable.link (Supabase-backed, see migration 018).
app.use("/api/blog", requireOpsAdmin, blogRoutes());
app.use("/api/outbound", requireOpsAdmin, outboundRoutes());
app.use("/api/outbound", requireOpsAdmin, outboundCampaignsRoutes());

// Generic 404 with the URL Express actually saw, for easier debugging.
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.url, originalUrl: req.originalUrl });
});

export default app;
