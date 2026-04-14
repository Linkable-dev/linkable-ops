#!/usr/bin/env node
// Setup script: creates email outreach tables via Supabase service role
// Usage: node server/automation/setup.js [--db-password YOUR_DB_PASSWORD]
//
// If no password provided, prints the SQL to paste into Supabase Dashboard SQL Editor.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load server .env
const envPath = join(__dirname, "..", ".env");
try {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const [key, ...rest] = line.split("=");
    if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
  }
} catch {}

const migrationPath = join(__dirname, "..", "..", "supabase", "migrations", "002_email_outreach.sql");
const sql = readFileSync(migrationPath, "utf-8");

const dbPassword = process.argv.find((a, i) => process.argv[i - 1] === "--db-password");

if (dbPassword) {
  // Run via psql
  const projectRef = (process.env.SUPABASE_URL || "").match(/https:\/\/([^.]+)/)?.[1];
  if (!projectRef) {
    console.error("Could not extract project ref from SUPABASE_URL");
    process.exit(1);
  }

  const connStr = `postgresql://postgres.${projectRef}:${dbPassword}@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`;

  const { execSync } = await import("child_process");
  try {
    execSync(`psql "${connStr}" -f "${migrationPath}"`, { stdio: "inherit" });
    console.log("\nMigration complete!");
  } catch (err) {
    console.error("\nFailed to run migration. Try pasting the SQL into Supabase Dashboard instead.");
    process.exit(1);
  }
} else {
  console.log(`
=====================================================
  Linkable Email Outreach — Database Setup
=====================================================

Option 1: Run with DB password
  node server/automation/setup.js --db-password YOUR_PASSWORD

  (Find your DB password in Supabase Dashboard → Settings → Database)

Option 2: Paste this SQL into Supabase Dashboard → SQL Editor → New Query → Run

=====================================================
`);
  console.log(sql);
  console.log(`
=====================================================
  Copy the SQL above and run it in your Supabase SQL Editor:
  https://supabase.com/dashboard/project/jbttnldubkvgnafljqxa/sql
=====================================================
`);
}
