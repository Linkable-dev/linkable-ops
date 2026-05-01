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
