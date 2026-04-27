import express from "express";
import cors from "cors";
import { tableRoutes } from "./routes/tables.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { opsRoutes } from "./routes/ops.js";
import { authRoutes, requireOpsAdmin } from "./routes/auth.js";
import {
  conversationsRoutes,
  conversationsWebhookRoutes,
} from "./routes/conversations.js";
import { cronRoutes } from "./routes/cron.js";
import { closeCloudSql } from "./lib/cloudsql.js";

const app = express();
app.use(cors({ origin: ["http://localhost:3010", "http://localhost:5173"] }));
// Larger limit for inbound email webhooks (HTML bodies + headers add up).
// `verify` callback captures raw body so we can verify Svix signatures —
// computing HMAC over the parsed JSON would re-stringify and not match.
app.use(express.json({
  limit: "5mb",
  verify: (req, _res, buf) => {
    if (buf && buf.length) req.rawBody = buf;
  },
}));

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

// Auth routes — mounted without middleware (each route handles its own auth)
app.use("/api/auth", authRoutes());

// Public webhook (no admin auth — secured by Svix signature).
app.use("/api/conversations", conversationsWebhookRoutes());

// Cron routes (no admin auth — secured by CRON_SECRET / x-vercel-cron header).
app.use("/api/cron", cronRoutes());

// Protected routes
app.use("/api/tables", requireOpsAdmin, tableRoutes());
app.use("/api/analytics", requireOpsAdmin, analyticsRoutes());
app.use("/api/ops", requireOpsAdmin, opsRoutes());
app.use("/api/conversations", requireOpsAdmin, conversationsRoutes());

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Linkable Ops server running on port ${PORT}`));

process.on("SIGTERM", async () => {
  await closeCloudSql();
  process.exit(0);
});
