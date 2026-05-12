#!/usr/bin/env node
// One-time backfill: insert G1-T4 / G2-T4 / G3-T4 template rows into every
// existing email_campaigns that was seeded before T4 existed.
//
// Idempotent — skips campaigns that already have the T4 keys. Mirrors the
// row shape used by seedDefaultTemplates() in routes/outbound-campaigns.js
// so the UI treats backfilled rows identically to fresh-seeded ones.
//
// Usage:
//   node server/automation/backfill-t4-templates.js
//   node server/automation/backfill-t4-templates.js --team <uuid>
//   node server/automation/backfill-t4-templates.js --dry-run

import { supabase } from "../lib/supabase.js";
import { SEQUENCE_TEMPLATES } from "./templates.js";

const T4_KEYS = ["G1-T4", "G2-T4", "G3-T4"];

function parseArgs() {
  const out = { teamId: null, dryRun: false };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--team") out.teamId = process.argv[++i];
    else if (a === "--dry-run") out.dryRun = true;
  }
  return out;
}

async function fetchCampaigns(teamId) {
  let q = supabase.from("email_campaigns").select("id, team_id, name");
  if (teamId) q = q.eq("team_id", teamId);
  const { data, error } = await q;
  if (error) throw new Error(`fetchCampaigns: ${error.message}`);
  return data || [];
}

async function fetchExistingKeys(teamId, campaignId) {
  const { data, error } = await supabase
    .from("email_templates")
    .select("template_key")
    .eq("team_id", teamId)
    .eq("campaign_id", campaignId);
  if (error) throw new Error(`fetchExistingKeys: ${error.message}`);
  return new Set((data || []).map((r) => r.template_key));
}

function buildT4Rows(teamId, campaignId, existingKeys) {
  const rows = [];
  for (const t of SEQUENCE_TEMPLATES) {
    if (t.touch !== 4) continue;
    if (existingKeys.has(t.key)) continue;
    rows.push({
      team_id: teamId,
      campaign_id: campaignId,
      name: t.name,
      variant: t.group.charAt(1) || "A",   // 'G1' → '1', matches seedDefaultTemplates
      brand_group: t.group,
      touch_number: t.touch,
      template_key: t.key,
      subject_template: t.subject_template,
      body_template: t.body_template,
      weight: 100,
      is_active: true,
      is_draft: false,
      generated_by_ai: false,
    });
  }
  return rows;
}

async function main() {
  const args = parseArgs();
  const campaigns = await fetchCampaigns(args.teamId);
  console.log(`Found ${campaigns.length} campaign(s)${args.teamId ? ` for team ${args.teamId}` : ""}`);

  let totalCampaignsTouched = 0;
  let totalRowsInserted = 0;

  for (const c of campaigns) {
    const existing = await fetchExistingKeys(c.team_id, c.id);
    const rows = buildT4Rows(c.team_id, c.id, existing);
    if (rows.length === 0) {
      console.log(`  ${c.name || c.id}: already has all T4 keys, skipping`);
      continue;
    }

    if (args.dryRun) {
      console.log(`  ${c.name || c.id}: would insert ${rows.length} rows (${rows.map((r) => r.template_key).join(", ")})`);
    } else {
      const { error } = await supabase.from("email_templates").insert(rows);
      if (error) {
        console.error(`  ${c.name || c.id}: insert failed — ${error.message}`);
        continue;
      }
      console.log(`  ${c.name || c.id}: inserted ${rows.length} T4 rows`);
    }

    totalCampaignsTouched++;
    totalRowsInserted += rows.length;
  }

  console.log(`\n${args.dryRun ? "[dry-run] " : ""}Campaigns touched: ${totalCampaignsTouched}, rows inserted: ${totalRowsInserted}`);
}

main().catch((err) => {
  console.error("backfill-t4-templates failed:", err);
  process.exit(1);
});
