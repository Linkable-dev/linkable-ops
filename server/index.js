import express from "express";
import cors from "cors";
import { tableRoutes } from "./routes/tables.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { opsRoutes } from "./routes/ops.js";
import { authRoutes, requireOpsAdmin } from "./routes/auth.js";
import { closeCloudSql } from "./lib/cloudsql.js";

const app = express();
app.use(cors({ origin: ["http://localhost:3010", "http://localhost:5173"] }));
app.use(express.json());

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

// Auth routes — mounted without middleware (each route handles its own auth)
app.use("/api/auth", authRoutes());

// Protected routes
app.use("/api/tables", requireOpsAdmin, tableRoutes());
app.use("/api/analytics", requireOpsAdmin, analyticsRoutes());
app.use("/api/ops", requireOpsAdmin, opsRoutes());

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Linkable Ops server running on port ${PORT}`));

process.on("SIGTERM", async () => {
  await closeCloudSql();
  process.exit(0);
});
