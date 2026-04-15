import express from "express";
import cors from "cors";
import { tableRoutes } from "../server/routes/tables.js";
import { analyticsRoutes } from "../server/routes/analytics.js";
import { opsRoutes } from "../server/routes/ops.js";
import { authRoutes } from "../server/routes/auth.js";
import { cloudSqlQuery } from "../server/lib/cloudsql.js";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/auth", authRoutes());

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    const { rows } = await cloudSqlQuery(
      `SELECT a.id, a.email, a.role FROM ops_sessions s JOIN ops_admins a ON s.admin_id = a.id WHERE s.token = $1 AND s.expires > NOW()`,
      [token]
    );
    if (rows.length === 0) return res.status(401).json({ error: "Session expired" });
    req.admin = rows[0];
    next();
  } catch { res.status(500).json({ error: "Auth check failed" }); }
}

app.get("/api/health", (req, res) => res.json({ status: "ok" }));
app.use("/api/tables", requireAuth, tableRoutes());
app.use("/api/analytics", requireAuth, analyticsRoutes());
app.use("/api/ops", requireAuth, opsRoutes());

export default app;
