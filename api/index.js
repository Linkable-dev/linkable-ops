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

// One-time migration: rewrite all FKs to ON DELETE CASCADE
// Visit this URL in the browser to run it, then remove this route.
app.get("/api/migrate-cascade", async (_req, res) => {
  const { cloudSqlQuery } = await import("../server/lib/cloudsql.js");
  try {
    await cloudSqlQuery(`
      DO $$
      DECLARE
        r RECORD; col_names TEXT; ref_col_names TEXT;
      BEGIN
        FOR r IN
          SELECT con.conname AS constraint_name, cl.relname AS child_table,
                 ref.relname AS parent_table, con.conrelid, con.confrelid,
                 con.conkey, con.confkey
          FROM pg_constraint con
          JOIN pg_class cl ON cl.oid = con.conrelid
          JOIN pg_class ref ON ref.oid = con.confrelid
          JOIN pg_namespace ns ON ns.oid = cl.relnamespace
          WHERE con.contype = 'f' AND ns.nspname = 'public'
            AND con.confdeltype <> 'c'
        LOOP
          SELECT string_agg(quote_ident(att.attname), ', ' ORDER BY ord.n)
            INTO col_names
            FROM unnest(r.conkey) WITH ORDINALITY AS ord(col, n)
            JOIN pg_attribute att ON att.attrelid = r.conrelid AND att.attnum = ord.col;
          SELECT string_agg(quote_ident(att.attname), ', ' ORDER BY ord.n)
            INTO ref_col_names
            FROM unnest(r.confkey) WITH ORDINALITY AS ord(col, n)
            JOIN pg_attribute att ON att.attrelid = r.confrelid AND att.attnum = ord.col;
          EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.child_table, r.constraint_name);
          EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES %I(%s) ON DELETE CASCADE',
            r.child_table, r.constraint_name, col_names, r.parent_table, ref_col_names);
        END LOOP;
      END $$;
    `);
    res.json({ success: true, message: "All FK constraints now use ON DELETE CASCADE" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use("/api/auth", authRoutes());
app.use("/api/tables", requireOpsAdmin, tableRoutes());
app.use("/api/analytics", requireOpsAdmin, analyticsRoutes());
app.use("/api/ops", requireOpsAdmin, opsRoutes());

// Generic 404 with the URL Express actually saw, for easier debugging.
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.url, originalUrl: req.originalUrl });
});

export default app;
