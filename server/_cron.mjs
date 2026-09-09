import express from "express";
import { cronRoutes } from "./routes/cron.js";
const app = express(); app.use(express.json());
app.use("/api/cron", cronRoutes());
const s = app.listen(0); const p = s.address().port;
const secret = process.env.CRON_SECRET;
const call = async (path, withAuth = true) => {
  const r = await fetch(`http://127.0.0.1:${p}${path}`, withAuth ? { headers: { Authorization: `Bearer ${secret}` } } : {});
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = t.slice(0, 200); }
  return { status: r.status, body: b };
};
console.log(`CRON_SECRET present: ${!!secret}\n`);

// Auth must fail closed.
const noAuth = await call("/api/cron/run-daily-outbound", false);
console.log(`no auth              -> ${noAuth.status} ${JSON.stringify(noAuth.body)}`);
const badAuth = await (async () => { const r = await fetch(`http://127.0.0.1:${p}/api/cron/run-daily-outbound`, { headers: { Authorization: "Bearer wrong" } }); return { status: r.status }; })();
console.log(`wrong secret         -> ${badAuth.status}`);

// Dry run: exercises the scheduler + deliverability brake, sends nothing.
const dry = await call("/api/cron/run-daily-outbound?dry=1");
console.log(`\nrun-daily-outbound?dry=1 -> ${dry.status}`);
if (dry.status === 200) {
  console.log(`  fired: ${dry.body.fired}`);
  console.log(`  deliverability: ${JSON.stringify(dry.body.deliverability)}`);
  console.log(`  attribution: ${JSON.stringify(dry.body.attribution)} (null on a dry run by design)`);
  for (const l of (dry.body.log || []).filter(x => /deliverability|attribution/.test(x))) console.log(`  log: ${l}`);
}
// The health snapshot rides the discovery cron.
const disc = await call("/api/cron/auto-discover?dry=1");
console.log(`\nauto-discover?dry=1  -> ${disc.status}  health: ${JSON.stringify(disc.body.health)} (null on dry by design)`);
s.close(); process.exit(0);
