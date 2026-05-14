import { Connector } from "@google-cloud/cloud-sql-connector";
import pg from "pg";
import { AsyncLocalStorage } from "async_hooks";
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

// Per-request target ("prod" | "dev") propagated via the x-db-target header
// (see server/middleware/dbTarget.js). Routes that must always hit prod —
// e.g. the ops_admins auth check — pass an explicit target to bypass this.
const targetStore = new AsyncLocalStorage();

export function runWithDbTarget(target, fn) {
  return targetStore.run(target === "dev" ? "dev" : "prod", fn);
}

export function currentDbTarget() {
  return targetStore.getStore() || "prod";
}

// Pools keyed by target so we keep one pool per Cloud SQL instance.
const pools = { prod: null, dev: null };
let connector = null;

async function buildProdPool() {
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

  if (!connector) connector = new Connector();
  const clientOpts = await connector.getOptions({
    instanceConnectionName: process.env.CLOUDSQL_CONNECTION_NAME,
    ipType: "PUBLIC",
  });

  return new pg.Pool({
    ...clientOpts,
    user: process.env.CLOUDSQL_USER,
    password: process.env.CLOUDSQL_PASSWORD,
    database: process.env.CLOUDSQL_DB,
    max: 5,
  });
}

function buildDevPool() {
  // Dev DB is exposed via direct public-IP Postgres rather than the Cloud SQL
  // connector. From Vercel this only works if the dev instance whitelists the
  // egress range; locally any laptop with the password can connect.
  const url = process.env.DATABASE_URL_DEV;
  if (!url) {
    throw new Error("DATABASE_URL_DEV is not set — cannot target dev DB");
  }
  return new pg.Pool({ connectionString: url, max: 5 });
}

/**
 * Returns a pg Pool for the requested target ("prod" or "dev"). Defaults to
 * the AsyncLocalStorage-scoped target, falling back to "prod".
 */
export async function getCloudSqlPool(target = currentDbTarget()) {
  if (target !== "prod" && target !== "dev") target = "prod";
  if (pools[target]) return pools[target];
  pools[target] = target === "dev" ? buildDevPool() : await buildProdPool();
  return pools[target];
}

/**
 * Helper to run a single query against the active target's DB.
 * Pass `target` to override the per-request selection (e.g. auth pins to prod).
 */
export async function cloudSqlQuery(text, params, target) {
  const p = await getCloudSqlPool(target);
  return p.query(text, params);
}

/**
 * Graceful shutdown — call on process exit.
 */
export async function closeCloudSql() {
  for (const key of Object.keys(pools)) {
    if (pools[key]) await pools[key].end();
    pools[key] = null;
  }
  if (connector) connector.close();
  connector = null;
}
