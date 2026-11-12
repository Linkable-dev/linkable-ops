import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { pitchRoutes } from "../routes/pitch.js";
import { decodeMessage, encodeFields } from "../lib/mainAppGrpc.js";
import {
  SIGNAL, SIGNAL_LIST, STATS, encodeSignalEdit, listPitchSignals, draftPitchSignal, updatePitchSignal,
  approvePitchSignal, hidePitchSignal, rereadPitchSignal, pitchSignalStats,
} from "../lib/pitchSignals.js";
import { SIGNAL_TABS, signalWants, signalSource, replyRate, signalContactFrom } from "../../src/components/pitch/pitchLabels.js";

// Pitch signals (main app QA 172): ops' list and manual add, through the main app.

async function serve(t, signals) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.admin = { email: "signals-test@example.com" }; req.dbTarget = "dev"; next(); });
  app.use(pitchRoutes({ query: async () => ({ rows: [] }), signals }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return async (path, method = "GET", body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
}

const ID = "11111111-2222-3333-4444-555555555555";
const POST = "https://www.instagram.com/p/DQx1abcDEF/";

test("the routes pass the status, the edits and who acted to the main app", async (t) => {
  const calls = [];
  const request = await serve(t, {
    list: async (q, target) => { calls.push(["list", q, target]); return { available: true, items: [], total: 0 }; },
    stats: async (q, target) => { calls.push(["stats", q, target]); return { available: true, rows: [], live: 3 }; },
    draft: async (input, o, target) => { calls.push(["draft", input.post_url, o.admin.email, target]); return { id: ID, status: "draft" }; },
    update: async (id, s, o, target) => { calls.push(["update", id, s.keyword, o.admin.email, target]); return { id, status: "draft" }; },
    approve: async (id, o, target) => { calls.push(["approve", id, o.admin.email, target]); return { id, status: "live" }; },
    hide: async (id, o, target) => { calls.push(["hide", id, o.reason, target]); return { id, status: "hidden" }; },
    reread: async (id, o, target) => { calls.push(["reread", id, o.caption, o.imageUrl, target]); return { id, status: "draft" }; },
  });
  assert.equal((await request("/signals?status=draft&limit=10&offset=20")).status, 200);
  assert.deepEqual(calls[0], ["list", { status: "draft", limit: 10, offset: 20 }, "dev"]);
  assert.equal((await request("/signals/stats")).body.live, 3);
  assert.deepEqual((await request("/signals", "POST", { post_url: POST })).body, { id: ID, status: "draft" });
  assert.deepEqual(calls[2], ["draft", POST, "signals-test@example.com", "dev"]);
  await request(`/signals/${ID}`, "PATCH", { keyword: "PDRN CREATOR" });
  assert.deepEqual(calls[3], ["update", ID, "PDRN CREATOR", "signals-test@example.com", "dev"]);
  assert.equal((await request(`/signals/${ID}/approve`, "POST", {})).body.status, "live");
  await request(`/signals/${ID}/hide`, "POST", { reason: "Found its creators" });
  assert.deepEqual(calls[5], ["hide", ID, "Found its creators", "dev"]);
  await request(`/signals/${ID}/reread`, "POST", { caption: "We're looking for dog owners", image_url: "https://x.test/a.jpg" });
  assert.deepEqual(calls[6], ["reread", ID, "We're looking for dog owners", "https://x.test/a.jpg", "dev"]);
});

test("a refusal from the main app keeps its status and sentence", async (t) => {
  const refuse = async () => { const e = new Error("Add a contact email before it goes live."); e.status = 409; throw e; };
  const request = await serve(t, { approve: refuse });
  const r = await request(`/signals/${ID}/approve`, "POST", {});
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "Add a contact email before it goes live.");
});

test("without the service key the list says so, and bad input never reaches the main app", async () => {
  const before = process.env.MAIN_APP_SERVICE_KEY;
  delete process.env.MAIN_APP_SERVICE_KEY;
  try {
    const r = await listPitchSignals({ status: "live" }, "dev");
    assert.equal(r.available, false);
    assert.equal((await pitchSignalStats({}, "dev")).available, false);
    await assert.rejects(draftPitchSignal({ post_url: "https://example.com/x" }, {}, "dev"), (e) => e.status === 400);
    await assert.rejects(draftPitchSignal({ post_url: POST, contact_email: "nope" }, {}, "dev"), (e) => e.status === 400);
    await assert.rejects(draftPitchSignal({ post_url: POST }, {}, "dev"), (e) => e.status === 503);
    await assert.rejects(updatePitchSignal("nope", {}, {}, "dev"), (e) => e.status === 404);
    await assert.rejects(updatePitchSignal(ID, { regions: "United Kingdom" }, {}, "dev"), (e) => e.status === 400);
    await assert.rejects(updatePitchSignal(ID, { deadline: "30/11/2026" }, {}, "dev"), (e) => e.status === 400);
    await assert.rejects(updatePitchSignal(ID, { min_followers: 50000, max_followers: 1000 }, {}, "dev"), (e) => e.status === 400);
    await assert.rejects(approvePitchSignal("nope", {}, "dev"), (e) => e.status === 404);
    await assert.rejects(hidePitchSignal(ID, { reason: " " }, "dev"), (e) => e.status === 400);
    await assert.rejects(rereadPitchSignal(ID, { imageUrl: "ftp://x" }, "dev"), (e) => e.status === 400);
    await assert.rejects(approvePitchSignal(ID, {}, "dev"), (e) => e.status === 503);
  } finally {
    if (before !== undefined) process.env.MAIN_APP_SERVICE_KEY = before;
  }
});

test("an edit encodes as a PitchSignalAdmin the main app can read back", () => {
  const bytes = encodeSignalEdit(ID, {
    brand_name: "MOEV", spots: "5 creators", asks: "1 Reel, 2 to 3 Stories", offers: "The full PDRN routine",
    how_to_apply: "dm", keyword: "PDRN CREATOR", checklist: ["Your handle", "A short clip"],
    contact_email: "Hello@Moev.com", regions: "ae, sa", niches: ["beauty_skincare"], min_followers: "1000",
    max_followers: 0, deadline: "2026-11-30", instagram: "@moev",
  });
  const s = decodeMessage(bytes, SIGNAL);
  assert.equal(s.id, ID);
  assert.equal(s.brand_name, "MOEV");
  assert.equal(s.instagram, "moev");
  assert.equal(s.contact_email, "hello@moev.com");
  assert.deepEqual(s.checklist, ["Your handle", "A short clip"]);
  assert.deepEqual(s.regions, ["AE", "SA"]);
  assert.deepEqual(s.niches, ["BEAUTY_SKINCARE"]);
  assert.equal(s.min_followers, 1000);
  assert.equal(s.max_followers, 0);
  assert.equal(s.deadline, "2026-11-30");
  assert.equal(s.status, "");
  // Nested in PitchSignalUpdate { signal: 1, actor: 2 }.
  const update = decodeMessage(encodeFields({ 1: bytes, 2: "ops@linkable.link" }),
    { 1: ["signal", { schema: SIGNAL }], 2: ["actor", "string"] });
  assert.equal(update.signal.keyword, "PDRN CREATOR");
  assert.equal(update.actor, "ops@linkable.link");
  // Empty arrays are left out, like proto3.
  assert.equal(encodeFields({ 1: [], 2: "x" }).toString("hex"), "1201" + "78");
});

test("a list and the stats decode field by field", () => {
  const one = encodeFields({ 1: ID, 2: "live", 3: "manual", 10: "Floof n Fluff", 13: "Small or medium dogs", 22: "post", 32: 4, 33: 1 });
  const list = decodeMessage(encodeFields({ 1: [one], 2: 7 }), SIGNAL_LIST);
  assert.equal(list.total, 7);
  assert.equal(list.signals[0].brand_name, "Floof n Fluff");
  assert.equal(list.signals[0].pitches_sent, 4);
  assert.equal(list.signals[0].replies, 1);
  // A double (wire type 1) for reply_rate.
  const rate = Buffer.alloc(8);
  rate.writeDoubleLE(0.25);
  const row = Buffer.concat([encodeFields({ 1: "Signal, under 1 day", 2: 8, 3: 2 }), Buffer.from([0x21]), rate]);
  const stats = decodeMessage(encodeFields({ 1: [row], 2: 5 }), STATS);
  assert.deepEqual(stats.rows, [{ label: "Signal, under 1 day", sent: 8, replied: 2, reply_rate: 0.25 }]);
  assert.equal(stats.live, 5);

  assert.deepEqual(signalWants({ spots: "5 creators", wants: "x" }), { label: "Spots", text: "5 creators" });
  assert.deepEqual(signalWants({ wants: "Dog owners" }), { label: "Wants", text: "Dog owners" });
  assert.equal(signalSource({ source: "manual" }), "Added manually");
  assert.equal(signalSource({ source: "agent" }), "Agent");
  assert.equal(replyRate(0.125), "12.5%");
  assert.equal(signalContactFrom("instagram"), "from their Instagram profile");
  assert.deepEqual(SIGNAL_TABS.map((x) => x.value), ["live", "draft", "hidden", "dropped"]);
});
