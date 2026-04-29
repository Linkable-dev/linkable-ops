import { Connector } from "@google-cloud/cloud-sql-connector";
import pg from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Load .env files for local dev. We check `server/.env` first (the canonical
// server env), then the repo-root `.env` as a fallback so vars like
// MAIN_APP_CLIENT_URL set in the root file still work locally.
const __dirname = dirname(fileURLToPath(import.meta.url));
for (const envPath of [join(__dirname, "..", ".env"), join(__dirname, "..", "..", ".env")]) {
  try {
    const envContent = readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const [key, ...rest] = line.split("=");
      if (key && rest.length && !process.env[key.trim()]) {
        process.env[key.trim()] = rest.join("=").trim();
      }
    }
  } catch {}
}

let pool = null;
let connector = null;

/**
 * Returns a pg Pool connected to Cloud SQL via the IAM-based connector.
 * Bypasses IP whitelisting — works from Vercel serverless functions.
 *
 * Required env vars:
 *   CLOUDSQL_CONNECTION_NAME  – e.g. "my-project:us-central1:my-instance"
 *   CLOUDSQL_DB               – database name
 *   CLOUDSQL_USER             – database user
 *   CLOUDSQL_PASSWORD          – database password (omit if using IAM auth)
 *   GOOGLE_APPLICATION_CREDENTIALS_JSON – service account key JSON (for Vercel)
 */
export async function getCloudSqlPool() {
  if (pool) return pool;

  // On Vercel, we pass the service account key as a JSON string env var
  // because we can't write a file to the filesystem reliably.
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const tmpPath = path.join(os.default.tmpdir(), "gcp-sa-key.json");
    fs.default.writeFileSync(tmpPath, process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpPath;
  }

  connector = new Connector();
  const clientOpts = await connector.getOptions({
    instanceConnectionName: process.env.CLOUDSQL_CONNECTION_NAME,
    ipType: "PUBLIC",
  });

  pool = new pg.Pool({
    ...clientOpts,
    user: process.env.CLOUDSQL_USER,
    password: process.env.CLOUDSQL_PASSWORD,
    database: process.env.CLOUDSQL_DB,
    max: 5,
  });

  return pool;
}

/**
 * Helper to run a single query against Cloud SQL.
 * Usage: const { rows } = await cloudSqlQuery("SELECT * FROM foo WHERE id = $1", [123]);
 */
export async function cloudSqlQuery(text, params) {
  const p = await getCloudSqlPool();
  return p.query(text, params);
}

/**
 * Graceful shutdown — call on process exit.
 */
export async function closeCloudSql() {
  if (pool) await pool.end();
  if (connector) connector.close();
  pool = null;
  connector = null;
}
