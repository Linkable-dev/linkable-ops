import { sendMorningBrief, briefRecipients } from "./lib/morning-brief.js";
console.log("recipients:", (await briefRecipients()).join(", ") || "(none)");
const r = await sendMorningBrief({ dryRun: true });
console.log(`\nSubject: ${r.subject}\n${"-".repeat(70)}\n${r.body}\n${"-".repeat(70)}`);
process.exit(0);
