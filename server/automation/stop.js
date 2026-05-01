// Manual stop-list CLI for the daily-200 outbound sequencer.
//
// Federico triages brand@linkable.link replies each morning and pastes the
// "remove me" / "not interested" / opt-out addresses here. This:
//   - cancels every pending T+3 / T+7 touch for that address
//   - inserts the address into ai_suppressions so it can never be hit again
//
// Usage:
//   node server/automation/stop.js a@x.com b@y.com c@z.com
//   echo "a@x.com\nb@y.com" | node server/automation/stop.js -
//   node server/automation/stop.js --reason opted_out a@x.com
//
// Default reason is `replied` (soft cancel — prospect engaged, may convert).
// Use `--reason opted_out` for explicit "stop emailing me" replies.

// supabase.js auto-loads server/.env when SUPABASE_URL is unset, so importing
// it first populates process.env for the rest of the script.
import { supabase } from "../lib/supabase.js";
import { cancelPendingTouches } from "./sequencer.js";

const TEAM_ID = process.env.TEAM_ID || "a0000000-0000-0000-0000-000000000001";

function parseArgs() {
  const out = { reason: "replied", emails: [], readStdin: false };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--reason") out.reason = process.argv[++i];
    else if (a === "-") out.readStdin = true;
    else if (a.includes("@")) out.emails.push(a.toLowerCase().trim());
    else console.warn(`ignoring arg: ${a}`);
  }
  return out;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8")
    .split(/\s+/)
    .map((s) => s.toLowerCase().trim())
    .filter((s) => s.includes("@"));
}

async function suppressOne(email, reason) {
  const { error } = await supabase
    .from("ai_suppressions")
    .upsert(
      {
        team_id: TEAM_ID,
        email,
        reason,
        detail: "manual stop-list",
      },
      { onConflict: "team_id,email" }
    );
  if (error) console.error(`  suppress ${email}: ${error.message}`);
}

async function main() {
  const args = parseArgs();
  if (args.readStdin) {
    args.emails.push(...(await readStdin()));
  }
  if (args.emails.length === 0) {
    console.error("usage: node stop.js [--reason replied|opted_out] email1 email2 ...");
    console.error("       node stop.js -   (read newline-separated emails from stdin)");
    process.exit(1);
  }

  const valid = ["replied", "opted_out", "bounced", "manual"];
  if (!valid.includes(args.reason)) {
    console.error(`invalid --reason: ${args.reason} (must be one of ${valid.join(", ")})`);
    process.exit(1);
  }

  console.log(`[stop] team=${TEAM_ID} reason=${args.reason} addresses=${args.emails.length}`);

  let totalCancelled = 0;
  for (const email of args.emails) {
    await suppressOne(email, args.reason);
    const { cancelled } = await cancelPendingTouches({
      teamId: TEAM_ID,
      email,
      reason: args.reason,
    });
    totalCancelled += cancelled;
    console.log(`  ${email}: suppressed + cancelled ${cancelled} pending touches`);
  }

  console.log(`[stop] DONE — ${args.emails.length} addresses suppressed, ${totalCancelled} touches cancelled`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
