#!/usr/bin/env node
// Standalone outreach runner — run directly from CLI
// Usage:
//   node server/automation/run.js                     # default: 50 contacts, all sources
//   node server/automation/run.js --limit 10          # limit to 10 contacts
//   node server/automation/run.js --source scraper    # only scraper contacts
//   node server/automation/run.js --source crm        # only existing CRM leads
//   node server/automation/run.js --country US        # filter by country
//   node server/automation/run.js --dry-run           # generate emails without sending
//   node server/automation/run.js --variants A,C,E    # only use these template variants
//   node server/automation/run.js --team-id <uuid>    # specify team (required)

import { runOutreach } from "./outreach.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--limit":
        config.limit = parseInt(args[++i], 10);
        break;
      case "--source":
        config.source = args[++i]; // "crm", "scraper", or "all"
        break;
      case "--country":
        config.country = args[++i];
        break;
      case "--dry-run":
        config.dryRun = true;
        break;
      case "--variants":
        config.templateVariants = args[++i].split(",").map(v => v.trim().toUpperCase());
        break;
      case "--team-id":
        config.teamId = args[++i];
        break;
      case "--sender-name":
        config.senderName = args[++i];
        break;
      case "--sender-title":
        config.senderTitle = args[++i];
        break;
      case "--from":
        config.fromEmail = args[++i];
        break;
      case "--help":
        printHelp();
        process.exit(0);
      default:
        console.error(`Unknown argument: ${args[i]}`);
        printHelp();
        process.exit(1);
    }
  }

  return config;
}

function printHelp() {
  console.log(`
Linkable Outreach Automation
=============================

Usage: node server/automation/run.js [options]

Options:
  --team-id <uuid>     Team ID (required)
  --limit <n>          Max contacts to process (default: 50)
  --source <type>      Contact source: "crm", "scraper", or "all" (default: "all")
  --country <code>     Filter by country: "US", "UK"
  --dry-run            Generate emails without sending (preview mode)
  --variants <list>    Comma-separated template variants: A,B,C,D,E
  --sender-name <n>    Sender first name (default: "Luca")
  --sender-title <t>   Sender title (default: "Founder")
  --from <email>       From email address (default: "Luca from Linkable <luca@linkable.link>")
  --help               Show this help message

Environment variables (in server/.env):
  RESEND_API_KEY              Required for sending (not needed with --dry-run)
  ANTHROPIC_API_KEY           Required for AI-personalized observations (Template D)
  SUPABASE_URL                Supabase project URL
  SUPABASE_SERVICE_ROLE_KEY   Supabase service role key

Examples:
  # Dry run with 10 contacts from scraper
  node server/automation/run.js --team-id abc123 --limit 10 --source scraper --dry-run

  # Send to US leads using only templates A and C
  node server/automation/run.js --team-id abc123 --country US --variants A,C

  # Full run with all defaults
  node server/automation/run.js --team-id abc123
`);
}

async function main() {
  const config = parseArgs();

  if (!config.teamId) {
    console.error("Error: --team-id is required");
    printHelp();
    process.exit(1);
  }

  // Check env
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in server/.env");
    process.exit(1);
  }

  if (!config.dryRun && !process.env.RESEND_API_KEY) {
    console.error("Error: RESEND_API_KEY is required for sending. Use --dry-run to preview without sending.");
    process.exit(1);
  }

  const teamId = config.teamId;
  delete config.teamId;

  // Build sender config
  const sender = {
    name: config.senderName || "Luca",
    title: config.senderTitle || "Founder",
    from: config.fromEmail || "Luca from Linkable <luca@linkable.link>",
    replyTo: config.fromEmail?.match(/<(.+)>/)?.[1] || config.fromEmail || "luca@linkable.link",
  };
  delete config.senderName;
  delete config.senderTitle;
  delete config.fromEmail;

  console.log("\n🚀 Starting Linkable Outreach Automation");
  console.log("=========================================");
  console.log(`Team:       ${teamId}`);
  console.log(`Source:     ${config.source || "all"}`);
  console.log(`Limit:      ${config.limit || 50}`);
  console.log(`Country:    ${config.country || "all"}`);
  console.log(`Templates:  ${config.templateVariants?.join(", ") || "A, B, C, D, E (all)"}`);
  console.log(`Dry run:    ${config.dryRun ? "YES (no emails will be sent)" : "NO (emails will be sent!)"}`);
  console.log(`Sender:     ${sender.name}, ${sender.title}`);
  console.log(`From:       ${sender.from}`);
  console.log("=========================================\n");

  try {
    const result = await runOutreach(teamId, { ...config, sender });

    console.log("\n=========================================");
    console.log("Outreach Complete!");
    console.log("=========================================");
    console.log(`Campaign ID: ${result.campaignId}`);
    console.log(`Status:      ${result.status}`);
    console.log(`Total:       ${result.total}`);
    console.log(`Sent:        ${result.sent}`);
    console.log(`Failed:      ${result.failed}`);
    console.log(`Skipped:     ${result.skipped}`);
    console.log("=========================================\n");

    process.exit(0);
  } catch (err) {
    console.error("\nOutreach failed:", err.message);
    process.exit(1);
  }
}

main();
