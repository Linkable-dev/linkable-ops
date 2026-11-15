import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { opsRoutes } from "../routes/ops.js";
import { decodeMessage } from "../lib/mainAppGrpc.js";
import { encodeSetHidden, setCampaignHidden, VISIBILITY } from "../lib/campaignVisibility.js";

// "Hide from Discover" / "Show in Discover" on ops' Campaigns page: the
// route hands the switch to the main app (SetCampaignOpsHidden), and the
// list reads ops_hidden_campaigns for the badge and the filter.

const ID = "11111111-2222-3333-4444-555555555555";

async function serve(t, { query, visibility }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.admin = { email: "federico@example.com" }; req.dbTarget = "dev"; next(); });
  app.use(opsRoutes({ query, visibility }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return async (path, method = "GET", body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
}

// The campaigns list's three reads: the count, whether the table exists, the rows.
function fakeQuery(tableExists, rows = []) {
  const seen = [];
  const query = async (sql, params) => {
    seen.push({ sql, params });
    if (sql.includes("to_regclass")) return { rows: [{ ok: tableExists }] };
    if (sql.includes("COUNT(*)::int AS total")) return { rows: [{ total: rows.length }] };
    return { rows };
  };
  return { query, seen };
}

test("the switch goes to the main app with the campaign, the side and who pressed it", async (t) => {
  const calls = [];
  const request = await serve(t, {
    query: fakeQuery(true).query,
    visibility: {
      setHidden: async (id, hidden, o, target) => {
        calls.push([id, hidden, o.admin.email, target]);
        return { product_id: id, hidden, hidden_by: hidden ? "linkable-ops:federico@example.com" : "", hidden_at: "", title: "Matcha" };
      },
    },
  });
  const hide = await request(`/campaigns/${ID}/discover`, "POST", { hidden: true });
  assert.equal(hide.status, 200);
  assert.equal(hide.body.hidden, true);
  const show = await request(`/campaigns/${ID}/discover`, "POST", { hidden: false });
  assert.equal(show.body.hidden, false);
  assert.deepEqual(calls, [[ID, true, "federico@example.com", "dev"], [ID, false, "federico@example.com", "dev"]]);
});

test("a refusal keeps its sentence; anything else becomes one", async (t) => {
  let mode = "refuse";
  const request = await serve(t, {
    query: fakeQuery(true).query,
    visibility: {
      setHidden: async () => {
        if (mode === "refuse") { const e = new Error("That product isn’t a campaign yet, so creators can’t see it anyway."); e.status = 409; throw e; }
        throw new Error("connect ECONNREFUSED 10.0.0.1:5432");
      },
    },
  });
  const refused = await request(`/campaigns/${ID}/discover`, "POST", { hidden: true });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "That product isn’t a campaign yet, so creators can’t see it anyway.");
  mode = "crash";
  const crashed = await request(`/campaigns/${ID}/discover`, "POST", { hidden: true });
  assert.equal(crashed.status, 500);
  assert.equal(crashed.body.error, "We couldn’t change that campaign. Try again.");
});

test("the request carries the id, hidden as a bool and the admin; shown leaves hidden out", () => {
  const schema = { 1: ["product_id", "string"], 2: ["hidden", "bool"], 3: ["actor", "string"] };
  assert.deepEqual(decodeMessage(encodeSetHidden(ID, true, "federico@example.com"), schema),
    { product_id: ID, hidden: true, actor: "federico@example.com" });
  const shown = encodeSetHidden(ID, false, "");
  assert.deepEqual(decodeMessage(shown, schema), { product_id: ID, hidden: false, actor: "" });
  assert.equal(shown.includes(0x10), false, "field 2 is not on the wire when false");
  // The answer, as the main app encodes CampaignOpsVisibility.
  const answer = Buffer.concat([
    Buffer.from([0x0a, ID.length]), Buffer.from(ID), Buffer.from([0x10, 0x01]),
    Buffer.from([0x1a, 3]), Buffer.from("ops"), Buffer.from([0x2a, 6]), Buffer.from("Matcha"),
  ]);
  assert.deepEqual(decodeMessage(answer, VISIBILITY), { product_id: ID, hidden: true, hidden_by: "ops", hidden_at: "", title: "Matcha" });
});

test("bad input never reaches the main app, and without the key it says so", async () => {
  const before = process.env.MAIN_APP_SERVICE_KEY;
  delete process.env.MAIN_APP_SERVICE_KEY;
  try {
    await assert.rejects(setCampaignHidden("nope", true, {}, "dev"), (e) => e.status === 404 && e.message === "We couldn’t find that campaign.");
    await assert.rejects(setCampaignHidden(ID, "yes", {}, "dev"), (e) => e.status === 400);
    await assert.rejects(setCampaignHidden(ID, true, {}, "dev"), (e) => e.status === 503 && /MAIN_APP_SERVICE_KEY/.test(e.message));
  } finally {
    if (before !== undefined) process.env.MAIN_APP_SERVICE_KEY = before;
  }
});

test("the list marks hidden campaigns, filters them, and still loads before the main app has the table", async (t) => {
  const withTable = fakeQuery(true, [{ id: ID, campaign_name: "Matcha", ops_hidden: true, full_count: 1 }]);
  let request = await serve(t, { query: withTable.query, visibility: {} });
  const r = await request("/campaigns?quick=hidden");
  assert.equal(r.status, 200);
  assert.equal(r.body.canHide, true);
  assert.equal(r.body.quick, "hidden");
  assert.equal(r.body.total, 1);
  const main = withTable.seen.at(-1).sql;
  assert.match(main, /LEFT JOIN ops_hidden_campaigns ohc ON ohc\.product_id = p\.id/);
  assert.match(main, /WHERE ops_hidden\b/);
  assert.match(main, /p\.ops_hidden,/);

  const without = fakeQuery(false, []);
  request = await serve(t, { query: without.query, visibility: {} });
  const r2 = await request("/campaigns");
  assert.equal(r2.status, 200);
  assert.equal(r2.body.canHide, false);
  const main2 = without.seen.at(-1).sql;
  assert.doesNotMatch(main2, /ops_hidden_campaigns/);
  assert.match(main2, /false AS ops_hidden/);
});
