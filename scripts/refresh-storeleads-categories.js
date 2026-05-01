#!/usr/bin/env node
// Sample StoreLeads brands across many countries, dedupe their `categories`
// arrays, and write the result to server/data/storeleads-categories.json.
// Re-run when the index seems stale (new categories appearing in real life
// that aren't in the picker).
//
//   node scripts/refresh-storeleads-categories.js [pages]
//
// Default: 40 pages × 50 brands = ~2000 brand sample.

import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const env = readFileSync(join(root, "server/.env"), "utf-8");
const KEY = env.split("\n").find((l) => l.startsWith("STORELEADS_KEY="))?.split("=")[1];
if (!KEY) { console.error("STORELEADS_KEY not in server/.env"); process.exit(1); }

const PAGES = Number(process.argv[2]) || 40;

const counts = new Map();
let cursor = null;
const bq = JSON.stringify({
  must: { conjuncts: [
    { field: "p", operator: "or", analyzer: "advanced", match: "1" },
    { field: "cc", operator: "or", analyzer: "advanced", match: "US GB CA AU DE FR IT ES NL" },
  ]},
});

for (let i = 0; i < PAGES; i++) {
  const url = `https://storeleads.app/json/api/v1/all/domain?bq=${encodeURIComponent(bq)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!res.ok) { console.error("API", res.status, await res.text()); break; }
  const data = await res.json();
  for (const b of data.domains || []) {
    for (const c of b.categories || []) counts.set(c, (counts.get(c) || 0) + 1);
  }
  process.stderr.write(".");
  if (!data.has_next_page) break;
  cursor = data.next_cursor;
}
process.stderr.write("\n");

const list = [...counts.entries()]
  .map(([path, count]) => ({ path, count }))
  .sort((a, b) => b.count - a.count);

const outPath = join(root, "server/data/storeleads-categories.json");
writeFileSync(outPath, JSON.stringify(list, null, 2));
console.log(`Saved ${list.length} categories → ${outPath}`);
