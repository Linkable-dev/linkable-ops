import express from "express";
import cors from "cors";
import { tableRoutes } from "../server/routes/tables.js";
import { analyticsRoutes } from "../server/routes/analytics.js";
import { opsRoutes } from "../server/routes/ops.js";
import { authRoutes, requireOpsAdmin } from "../server/routes/auth.js";

const app = express();
app.use(cors());
app.use(express.json());

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
app.use("/api/tables", requireOpsAdmin, tableRoutes());
app.use("/api/analytics", requireOpsAdmin, analyticsRoutes());
app.use("/api/ops", requireOpsAdmin, opsRoutes());

// Generic 404 with the URL Express actually saw, for easier debugging.
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.url, originalUrl: req.originalUrl });
});

export default app;
