import { test } from "node:test";
import assert from "node:assert/strict";
import { listFeatureSwitches, setFeatureSwitch } from "../lib/featureSwitches.js";

// Switches: the team turns a main-app feature off or on. Only rows the app
// wrote can be flipped, on the database that was asked for, with who did it.

const admin = { email: "switch-test@example.com" };
const row = { key: "auto_answer", enabled: true, label: "Answer applications for you", about: "", updated: "2026-11-21", updated_by: "" };

test("the list comes from the database that was picked", async () => {
  const seen = [];
  const query = async (sql, params, target) => { seen.push(target); return { rows: [row] }; };
  assert.deepEqual(await listFeatureSwitches("dev", { query }), { switches: [row], ready: true });
  assert.deepEqual(seen, ["dev"]);
});

test("a database whose app has no switches yet says so instead of failing", async () => {
  const query = async () => { throw Object.assign(new Error('relation "feature_switches" does not exist'), { code: "42P01" }); };
  assert.deepEqual(await listFeatureSwitches("prod", { query }), { switches: [], ready: false });
  await assert.rejects(setFeatureSwitch("auto_answer", false, admin, "prod", { query }), /no switch on this database/);
});

test("switching records who did it and returns the row", async () => {
  const seen = [];
  const query = async (sql, params, target) => { seen.push([params, target]); return { rows: [{ ...row, enabled: false, updated_by: admin.email }] }; };
  const out = await setFeatureSwitch("auto_answer", false, admin, "prod", { query });
  assert.equal(out.enabled, false);
  assert.deepEqual(seen, [[["auto_answer", false, admin.email], "prod"]]);
});

test("nothing is written for a key that is not a switch, or a value that is not on or off", async () => {
  let calls = 0;
  const query = async () => { calls += 1; return { rows: [] }; };
  await assert.rejects(setFeatureSwitch("x; drop table users", false, admin, "dev", { query }), /Choose a feature/);
  await assert.rejects(setFeatureSwitch("auto_answer", "false", admin, "dev", { query }), /Choose a feature/);
  assert.equal(calls, 0);
  await assert.rejects(setFeatureSwitch("never_made", true, admin, "dev", { query }), /no switch on this database/);
  assert.equal(calls, 1);
});
