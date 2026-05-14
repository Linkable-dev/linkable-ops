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

// Both targets prefer the Cloud SQL connector so they work from Vercel
// without IP whitelisting. The dev pool falls back to DATABASE_URL_DEV
// (direct public-IP Postgres) when CLOUDSQL_CONNECTION_NAME_DEV is unset —
// handy if the connector ever has issues during local development.
const TARGET_VARS = {
  prod: {
    connectionName: "CLOUDSQL_CONNECTION_NAME",
    db: "CLOUDSQL_DB",
    user: "CLOUDSQL_USER",
    password: "CLOUDSQL_PASSWORD",
    fallbackUrl: null,
  },
  dev: {
    connectionName: "CLOUDSQL_CONNECTION_NAME_DEV",
    db: "CLOUDSQL_DB_DEV",
    user: "CLOUDSQL_USER_DEV",
    password: "CLOUDSQL_PASSWORD_DEV",
    fallbackUrl: "DATABASE_URL_DEV",
  },
};

async function ensureCredentialsFile() {
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
}

async function buildConnectorPool(vars) {
  await ensureCredentialsFile();
  if (!connector) connector = new Connector();
  const clientOpts = await connector.getOptions({
    instanceConnectionName: process.env[vars.connectionName],
    ipType: "PUBLIC",
  });
  return new pg.Pool({
    ...clientOpts,
    user: process.env[vars.user],
    password: process.env[vars.password],
    database: process.env[vars.db],
    max: 5,
  });
}

async function buildPool(target) {
  const vars = TARGET_VARS[target];
  if (process.env[vars.connectionName]) {
    return buildConnectorPool(vars);
  }
  if (vars.fallbackUrl && process.env[vars.fallbackUrl]) {
    return new pg.Pool({ connectionString: process.env[vars.fallbackUrl], max: 5 });
  }
  throw new Error(
    `No connection config for target=${target}: set ${vars.connectionName}` +
    (vars.fallbackUrl ? ` or ${vars.fallbackUrl}` : ""),
  );
}

/**
 * Returns a pg Pool for the requested target ("prod" or "dev"). Defaults to
 * the AsyncLocalStorage-scoped target, falling back to "prod".
 */
export async function getCloudSqlPool(target = currentDbTarget()) {
  if (target !== "prod" && target !== "dev") target = "prod";
  if (pools[target]) return pools[target];
  pools[target] = await buildPool(target);
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
