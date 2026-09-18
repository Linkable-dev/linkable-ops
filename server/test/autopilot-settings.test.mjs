import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { autopilotRoutes } from "../routes/autopilot.js";

async function serve(t, query) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.admin = { email: "settings-test@example.com" }; next(); });
  app.use(autopilotRoutes({ query }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return async (path, method = "GET", body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
}

test("invalid settings, allowances and rates never reach SQL", async (t) => {
  const request = await serve(t, async () => { assert.fail("invalid input reached SQL"); });
  for (const [key, value] of [
    ["unknown", "1"], ["agent_max_runs", "11"], ["agent_goal_applications", "501"],
    ["agent_short_wait_minutes", "1e2"], ["agent_short_wait_minutes", "1.5"],
    ["agent_short_wait_minutes", "0"], ["agents_per_tick", "100001"],
    ["outreach_writer", "unknown"], ["house_sequence", "{}"],
    ["house_sequence", JSON.stringify({ steps: [{ subject: 42, message: "Body", delay: 0 }] })],
    ["house_sequence", JSON.stringify({ steps: [{ subject: "Hi", message: "Body", delay: -1 }] })],
  ]) {
    assert.equal((await request(`/settings/${key}`, "PUT", { value })).status, 400, `${key}=${value}`);
  }
  assert.equal((await request("/settings/unknown", "DELETE")).status, 400);
  for (const monthly_searches of [null, "", false, 1.5, -1, 1001]) {
    assert.equal((await request("/allowances/default", "PUT", { monthly_searches })).status, 400);
  }
  for (const unit_cost of [null, "", false, -1, "1e2", "0.0000001", "1000000", "NaN"]) {
    assert.equal((await request("/provider-costs/lemlist", "PUT", { unit_cost, currency: "USD" })).status, 400);
  }
  assert.equal((await request("/provider-costs/lemlist", "PUT", { unit_cost: "0.01", currency: "ZZZ" })).status, 400);
  assert.equal((await request("/provider-costs/unknown", "DELETE")).status, 400);
});

test("missing migrations are reported as unavailable", async (t) => {
  const request = await serve(t, async () => { throw Object.assign(new Error("missing"), { code: "42P01" }); });
  for (const path of ["/settings", "/provider-costs"]) {
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.equal(response.body.available, false);
  }
  assert.equal((await request("/settings/agent_max_runs", "PUT", { value: "2" })).status, 409);
  assert.equal((await request("/provider-costs/lemlist", "PUT", { unit_cost: "1", currency: "USD" })).status, 409);
});

test("admin catalogue matches every Go runtime setting", async (t) => {
  // This contract check runs when the main repository is checked out alongside ops.
  let source;
  try { source = await readFile(new URL("../../../linkable/service-grpc/services/sourcing_settings.go", import.meta.url), "utf8"); }
  catch (e) { if (e.code === "ENOENT") return t.skip("Check out linkable alongside linkable-ops for the cross-repository contract check"); throw e; }
  const goKeys = [...source.matchAll(/Setting\w+\s+=\s+"([^"]+)"/g)].map((m) => m[1]).sort();
  const app = express();
  app.use(autopilotRoutes({ query: async () => ({ rows: [] }) }));
  const route = app._router.stack.find((layer) => layer.name === "router").handle.stack.find((layer) => layer.route?.path === "/settings");
  let body;
  await route.route.stack[0].handle({}, { json: (value) => { body = value; } });
  assert.deepEqual(body.settings.map((s) => s.key).sort(), goKeys);
});

test("HTTP saves, resets and estimates use actual Postgres values", {
  skip: !process.env.OPS_SETTINGS_TEST_DATABASE_URL,
}, async (t) => {
  const db = new pg.Client({ connectionString: process.env.OPS_SETTINGS_TEST_DATABASE_URL });
  await db.connect();
  t.after(async () => { await db.query("ROLLBACK"); await db.end(); });
  await db.query("BEGIN");
  await db.query("CREATE SCHEMA settings_test; SET LOCAL search_path TO settings_test");
  // Execute the actual Go migrations, twice, to verify idempotence.
  for (const file of ["sourcing_settings_migration.go", "provider_costs_migration.go"]) {
    const source = await readFile(new URL(`../../../linkable/service-grpc/migrations/${file}`, import.meta.url), "utf8");
    const sql = source.match(/utils\.Db\.Exec\(`([\s\S]*?)`\)/)[1];
    await db.query(sql); await db.query(sql);
  }
  await db.query(`CREATE TABLE sourcing_runs (created timestamptz, credits_spent numeric);
    CREATE TABLE sourcing_candidates (pushed_at timestamptz, lemlist_campaign_id text);
    INSERT INTO sourcing_runs VALUES (current_timestamp, 12.5), (current_timestamp, 0.5), (date_trunc('month', current_timestamp) - interval '1 day', 999);
    INSERT INTO sourcing_candidates VALUES (current_timestamp, 'cam_test'), (current_timestamp, ''), (NULL, 'cam_test')`);
  const request = await serve(t, (sql, values) => db.query(sql, values));
  const samples = {
    lemlist_template_campaign_id: "cam_test", outreach_writer: "ai", sandbox_max_leads: "3",
    agent_goal_applications: "40", agent_max_runs: "4", agent_patience_hours: "24", agents_per_tick: "2",
    test_recipients: "test@example.com", agent_short_wait_minutes: "7", agent_max_backoff_hours: "3",
    house_sequence: JSON.stringify({ steps: [{ delay: 0, subject: "Hi", message: "Body" }] }),
  };
  assert.equal((await request("/settings")).body.settings.length, Object.keys(samples).length);
  for (const [key, value] of Object.entries(samples)) {
    const saved = await request(`/settings/${key}`, "PUT", { value });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.setting.updated_by, "settings-test@example.com");
    const listed = (await request("/settings")).body.settings.find((s) => s.key === key);
    assert.equal(listed.value, value); assert.equal(listed.set, true);
    assert.equal((await request(`/settings/${key}`, "DELETE")).status, 200);
    assert.equal((await request("/settings")).body.settings.find((s) => s.key === key).set, false);
  }
  await request("/settings/agent_max_runs", "PUT", { value: "" });
  assert.equal((await request("/settings")).body.settings.find((s) => s.key === "agent_max_runs").set, false);
  let costs = (await request("/provider-costs")).body.providers;
  assert.equal(costs[0].estimated_cost, null); assert.equal(costs[0].quantity, "13.0");
  assert.equal((await request("/provider-costs/influencers_club", "PUT", { unit_cost: "0.025", currency: "gbp", note: "contract" })).status, 200);
  assert.equal((await request("/provider-costs/lemlist", "PUT", { unit_cost: "0", currency: "USD" })).status, 200);
  costs = (await request("/provider-costs")).body.providers;
  assert.equal(Number(costs[0].estimated_cost), 0.325); assert.equal(costs[0].currency, "GBP");
  assert.equal(costs[0].note, "contract"); assert.equal(costs[0].updated_by, "settings-test@example.com");
  assert.equal(costs[1].quantity, "1"); assert.equal(costs[1].configured, true);
  assert.equal(Number(costs[1].estimated_cost), 0); assert.equal(costs[1].currency, "USD");
  await request("/provider-costs/influencers_club", "PUT", { unit_cost: "0.05", currency: "GBP" });
  assert.equal(Number((await request("/provider-costs")).body.providers[0].estimated_cost), 0.65);
  await request("/provider-costs/influencers_club", "DELETE");
  assert.equal((await request("/provider-costs")).body.providers[0].estimated_cost, null);
});
