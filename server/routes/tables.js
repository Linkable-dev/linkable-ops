import express from "express";
import { cloudSqlQuery } from "../lib/cloudsql.js";

export function tableRoutes() {
  const router = express.Router();

  // One-time (well, on-demand): rewrite all non-cascade FK constraints to ON DELETE CASCADE.
  // Tables added directly in Supabase/psql (bypassing tracked migrations) can end up with
  // FKs that don't cascade, which breaks deletes on their parent tables. This can be re-run
  // any time — it's idempotent, it only touches constraints that aren't already CASCADE.
  router.post("/migrate-cascade", async (req, res) => {
    try {
      await ensureAllFksCascade();
      res.json({ success: true, message: "All FK constraints now use ON DELETE CASCADE" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // List all tables
  router.get("/", async (req, res) => {
    try {
      const { rows } = await cloudSqlQuery(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);
      res.json(rows.map((r) => r.table_name));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get table schema + FK relationships
  router.get("/:table/schema", async (req, res) => {
    const { table } = req.params;
    try {
      const [colResult, fkResult] = await Promise.all([
        cloudSqlQuery(
          `SELECT
            c.column_name,
            c.data_type,
            c.is_nullable,
            c.column_default,
            c.character_maximum_length,
            CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_primary_key
          FROM information_schema.columns c
          LEFT JOIN (
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
            WHERE tc.table_name = $1
              AND tc.constraint_type = 'PRIMARY KEY'
              AND tc.table_schema = 'public'
          ) pk ON pk.column_name = c.column_name
          WHERE c.table_name = $1 AND c.table_schema = 'public'
          ORDER BY c.ordinal_position`,
          [table]
        ),
        cloudSqlQuery(
          `SELECT
            kcu.column_name AS fk_column,
            ccu.table_name AS ref_table,
            ccu.column_name AS ref_column
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage ccu
            ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_name = $1
            AND tc.table_schema = 'public'`,
          [table]
        ),
      ]);

      // Build FK map
      const fkMap = {};
      for (const fk of fkResult.rows) {
        fkMap[fk.fk_column] = { refTable: fk.ref_table, refColumn: fk.ref_column };
      }

      // Attach FK info to columns
      const columns = colResult.rows.map((col) => ({
        ...col,
        fk: fkMap[col.column_name] || null,
      }));

      res.json(columns);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get FK lookup options for a referenced table (id → label)
  router.get("/:table/fk-options", async (req, res) => {
    const { table } = req.params;
    try {
      const pk = await getPrimaryKey(table);
      if (!pk) return res.json([]);

      // Find best label column: prefer name, title, username, email, label, then first text col
      const { rows: cols } = await cloudSqlQuery(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name = $1 AND table_schema = 'public' ORDER BY ordinal_position`,
        [table]
      );

      const labelPrefs = ["name", "title", "full_name", "username", "email", "label", "display_name", "slug"];
      let labelCol = null;
      for (const pref of labelPrefs) {
        const found = cols.find((c) => c.column_name === pref || c.column_name.endsWith(`_${pref}`) || c.column_name.endsWith(`_name`));
        if (found) { labelCol = found.column_name; break; }
      }
      if (!labelCol) {
        const textCol = cols.find(
          (c) => ["text", "character varying", "varchar"].includes(c.data_type) && c.column_name !== pk
        );
        labelCol = textCol?.column_name || pk;
      }

      const { rows } = await cloudSqlQuery(
        `SELECT "${pk}" AS id, "${labelCol}" AS label FROM "${table}" ORDER BY "${labelCol}" LIMIT 500`
      );

      res.json({ pk, labelCol, options: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Resolve FK labels for a set of IDs
  router.post("/:table/resolve-fks", async (req, res) => {
    const { table } = req.params;
    const { ids } = req.body; // array of IDs
    if (!ids || !Array.isArray(ids) || ids.length === 0) return res.json({});

    try {
      const pk = await getPrimaryKey(table);
      if (!pk) return res.json({});

      const { rows: cols } = await cloudSqlQuery(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name = $1 AND table_schema = 'public' ORDER BY ordinal_position`,
        [table]
      );

      const labelPrefs = ["name", "title", "full_name", "username", "email", "label", "display_name", "slug"];
      let labelCol = null;
      for (const pref of labelPrefs) {
        const found = cols.find((c) => c.column_name === pref || c.column_name.endsWith(`_${pref}`) || c.column_name.endsWith(`_name`));
        if (found) { labelCol = found.column_name; break; }
      }
      if (!labelCol) {
        const textCol = cols.find(
          (c) => ["text", "character varying", "varchar"].includes(c.data_type) && c.column_name !== pk
        );
        labelCol = textCol?.column_name || pk;
      }

      const uniqueIds = [...new Set(ids.filter(Boolean))];
      if (uniqueIds.length === 0) return res.json({});

      const placeholders = uniqueIds.map((_, i) => `$${i + 1}`);
      const { rows } = await cloudSqlQuery(
        `SELECT "${pk}" AS id, "${labelCol}" AS label FROM "${table}" WHERE "${pk}" IN (${placeholders.join(",")})`,
        uniqueIds
      );

      const map = {};
      rows.forEach((r) => { map[String(r.id)] = r.label; });
      res.json(map);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get distinct values for a column (for filter dropdowns)
  router.get("/:table/distinct/:column", async (req, res) => {
    const { table, column } = req.params;
    try {
      const colCheck = await cloudSqlQuery(
        `SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = $2 AND table_schema = 'public'`,
        [table, column]
      );
      if (colCheck.rows.length === 0) return res.status(404).json({ error: "Column not found" });

      const { rows } = await cloudSqlQuery(
        `SELECT DISTINCT "${column}" AS value, COUNT(*) AS count FROM "${table}" WHERE "${column}" IS NOT NULL GROUP BY "${column}" ORDER BY count DESC LIMIT 100`,
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Date range for a column (for date filter)
  router.get("/:table/date-range/:column", async (req, res) => {
    const { table, column } = req.params;
    try {
      const { rows } = await cloudSqlQuery(
        `SELECT MIN("${column}") AS min_date, MAX("${column}") AS max_date FROM "${table}" WHERE "${column}" IS NOT NULL`
      );
      res.json(rows[0] || {});
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // List rows with pagination, sorting, column filters
  router.get("/:table/rows", async (req, res) => {
    const { table } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = (page - 1) * limit;
    const sortBy = req.query.sortBy || null;
    const sortDir = req.query.sortDir === "desc" ? "DESC" : "ASC";
    const search = req.query.search || null;
    // Column-level filters: filter[column_name]=value
    const filters = {};
    for (const key of Object.keys(req.query)) {
      const m = key.match(/^filter\[(.+)\]$/);
      if (m) filters[m[1]] = req.query[key];
    }

    try {
      const tableCheck = await cloudSqlQuery(
        `SELECT 1 FROM information_schema.tables WHERE table_name = $1 AND table_schema = 'public'`,
        [table]
      );
      if (tableCheck.rows.length === 0) {
        return res.status(404).json({ error: "Table not found" });
      }

      const conditions = [];
      const params = [];
      let paramIdx = 1;

      // Global text search
      if (search) {
        const { rows: textCols } = await cloudSqlQuery(
          `SELECT column_name FROM information_schema.columns
           WHERE table_name = $1 AND table_schema = 'public'
           AND data_type IN ('text', 'character varying', 'character', 'varchar')`,
          [table]
        );
        if (textCols.length > 0) {
          const searchConds = textCols.map((c) => {
            params.push(`%${search}%`);
            return `"${c.column_name}"::text ILIKE $${paramIdx++}`;
          });
          conditions.push(`(${searchConds.join(" OR ")})`);
        }
      }

      // Column-level filters (supports _from/_to suffixes for date ranges)
      for (const [rawKey, val] of Object.entries(filters)) {
        if (!val) continue;

        // Date range: filter[col_from] / filter[col_to]
        const fromMatch = rawKey.match(/^(.+)_from$/);
        const toMatch = rawKey.match(/^(.+)_to$/);
        const col = fromMatch ? fromMatch[1] : toMatch ? toMatch[1] : rawKey;

        const colCheck = await cloudSqlQuery(
          `SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = $2 AND table_schema = 'public'`,
          [table, col]
        );
        if (colCheck.rows.length === 0) continue;
        const dtype = colCheck.rows[0].data_type;

        if (fromMatch && (dtype.includes("timestamp") || dtype === "date")) {
          params.push(val);
          conditions.push(`"${col}" >= $${paramIdx++}`);
        } else if (toMatch && (dtype.includes("timestamp") || dtype === "date")) {
          params.push(val);
          conditions.push(`"${col}" <= $${paramIdx++}`);
        } else if (["integer", "bigint", "smallint", "numeric", "real", "double precision"].includes(dtype)) {
          params.push(val);
          conditions.push(`"${col}" = $${paramIdx++}`);
        } else if (dtype === "boolean") {
          params.push(val === "true");
          conditions.push(`"${col}" = $${paramIdx++}`);
        } else {
          params.push(`%${val}%`);
          conditions.push(`"${col}"::text ILIKE $${paramIdx++}`);
        }
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const countResult = await cloudSqlQuery(
        `SELECT COUNT(*) as total FROM "${table}" ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].total);

      const orderClause = sortBy ? `ORDER BY "${sortBy}" ${sortDir} NULLS LAST` : `ORDER BY 1`;
      const dataParams = [...params, limit, offset];
      const { rows } = await cloudSqlQuery(
        `SELECT * FROM "${table}" ${whereClause} ${orderClause} LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        dataParams
      );

      res.json({ rows, total, page, limit, totalPages: Math.ceil(total / limit) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get single row
  router.get("/:table/rows/:id", async (req, res) => {
    const { table, id } = req.params;
    try {
      const pk = await getPrimaryKey(table);
      if (!pk) return res.status(400).json({ error: "No primary key found" });
      const { rows } = await cloudSqlQuery(
        `SELECT * FROM "${table}" WHERE "${pk}" = $1 LIMIT 1`,
        [id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Row not found" });
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create row
  router.post("/:table/rows", async (req, res) => {
    const { table } = req.params;
    const data = req.body;
    try {
      const keys = Object.keys(data);
      const values = Object.values(data);
      const placeholders = keys.map((_, i) => `$${i + 1}`);
      const columns = keys.map((k) => `"${k}"`);
      const { rows } = await cloudSqlQuery(
        `INSERT INTO "${table}" (${columns.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`,
        values
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update row
  router.put("/:table/rows/:id", async (req, res) => {
    const { table, id } = req.params;
    const data = req.body;
    try {
      const pk = await getPrimaryKey(table);
      if (!pk) return res.status(400).json({ error: "No primary key found" });
      const keys = Object.keys(data);
      const values = Object.values(data);
      const setClauses = keys.map((k, i) => `"${k}" = $${i + 1}`);
      values.push(id);
      const { rows } = await cloudSqlQuery(
        `UPDATE "${table}" SET ${setClauses.join(", ")} WHERE "${pk}" = $${values.length} RETURNING *`,
        values
      );
      if (rows.length === 0) return res.status(404).json({ error: "Row not found" });
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete row
  router.delete("/:table/rows/:id", async (req, res) => {
    const { table, id } = req.params;
    try {
      const pk = await getPrimaryKey(table);
      if (!pk) return res.status(400).json({ error: "No primary key found" });
      const result = await deleteWithCascadeRetry(
        `DELETE FROM "${table}" WHERE "${pk}" = $1`,
        [id]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: "Row not found" });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Bulk delete rows
  router.delete("/:table/rows", async (req, res) => {
    const { table } = req.params;
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids must be a non-empty array" });
    }
    try {
      const pk = await getPrimaryKey(table);
      if (!pk) return res.status(400).json({ error: "No primary key found" });
      const uniqueIds = [...new Set(ids)];
      const result = await deleteWithCascadeRetry(
        `DELETE FROM "${table}" WHERE "${pk}" = ANY($1)`,
        [uniqueIds]
      );
      res.json({ success: true, deleted: result.rowCount });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

// Runs a DELETE query; if it fails on a missing ON DELETE CASCADE (FK violation),
// fixes every non-cascading FK in the schema and retries once. This means deletes
// keep working even for tables/relationships created outside tracked migrations.
async function deleteWithCascadeRetry(sql, params) {
  try {
    return await cloudSqlQuery(sql, params);
  } catch (err) {
    if (err.code !== "23503") throw err; // not a foreign_key_violation
    await ensureAllFksCascade();
    return await cloudSqlQuery(sql, params);
  }
}

async function ensureAllFksCascade() {
  await cloudSqlQuery(`
    DO $$
    DECLARE
      r RECORD;
      col_names TEXT;
      ref_col_names TEXT;
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
}

async function getPrimaryKey(table) {
  const { rows } = await cloudSqlQuery(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
     WHERE tc.table_name = $1
       AND tc.constraint_type = 'PRIMARY KEY'
       AND tc.table_schema = 'public'
     LIMIT 1`,
    [table]
  );
  return rows[0]?.column_name || null;
}

