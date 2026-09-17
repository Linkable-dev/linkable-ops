import { createClient } from "@supabase/supabase-js";

// Load .env manually for local development (on Vercel, env vars are injected)
if (!process.env.SUPABASE_URL) {
  try {
    const { readFileSync } = await import("fs");
    const { fileURLToPath } = await import("url");
    const { dirname, join } = await import("path");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const envPath = join(__dirname, "..", ".env");
    const envContent = readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const [key, ...rest] = line.split("=");
      const k = key?.trim();
      // Shell-set env vars must win over .env (so `FOO=bar node ...` works).
      if (k && rest.length && process.env[k] === undefined) {
        process.env[k] = rest.join("=").trim();
      }
    }
  } catch {}
}

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Which kind of key this server is holding: "service_role", "anon", or
 * "unknown" for the newer sb_secret_/sb_publishable_ keys, which are not JWTs
 * and carry no role to read.
 *
 * Worth knowing because of how Supabase fails when it is wrong. An anon key is
 * not rejected — it is subject to row-level security, so every query comes back
 * `[]` with no error at all. A page reading that renders "nothing here yet",
 * which is indistinguishable from an empty table and sends whoever is looking
 * at it hunting for a bug in the page. Ask the key what it is instead.
 */
function keyRole(jwt) {
  const raw = String(jwt || "");
  const parts = raw.split(".");
  if (parts.length !== 3) return "unknown"; // sb_secret_… / sb_publishable_…
  try {
    return JSON.parse(Buffer.from(parts[1], "base64").toString("utf8")).role || "unknown";
  } catch {
    return "unknown";
  }
}

export const SUPABASE_KEY_ROLE = keyRole(process.env.SUPABASE_SERVICE_ROLE_KEY);

/** True only when we KNOW the key cannot see past RLS — never for "unknown". */
export const supabaseKeyIsPublic = SUPABASE_KEY_ROLE === "anon";

if (supabaseKeyIsPublic) {
  console.warn(
    "[supabase] SUPABASE_SERVICE_ROLE_KEY holds an ANON key. Row-level security " +
      "will hide rows from every query and they will come back empty with no error."
  );
}
