import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { pitchRoutes } from "../routes/pitch.js";

async function serve(t, query, sign = async (keys) => keys.map(() => null)) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.admin = { email: "pitch-test@example.com" }; req.dbTarget = "dev"; next(); });
  app.use(pitchRoutes({ query, sign }));
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
const plain = (e) => assert.ok(e && !e.includes(":"), e);

test("the pitch list shows sent pitches unless asked otherwise, and binds every filter", async (t) => {
  const seen = [];
  const request = await serve(t, async (sql, params) => {
    seen.push({ sql, params });
    return /count\(\*\)::int AS n/.test(sql) ? { rows: [{ n: 3 }] } : { rows: [{ id: "p1", profile_pic_name: "", instagram_profile_image: "https://cdn.example/x.jpg" }] };
  });
  const r = await request(`/pitches?view=bogus&limit=10&offset=10&sortBy=views&sortDir=asc&filter[creator]=mel&filter[status]=viewed&filter[creator_id]=${ID}&filter[brand_id]=not-a-uuid`);
  assert.equal(r.status, 200);
  assert.equal(r.body.view, "sent");
  assert.equal(r.body.total, 3);
  assert.equal(r.body.items[0].creator_avatar, "https://cdn.example/x.jpg");
  assert.ok(!("instagram_profile_image" in r.body.items[0]));
  const list = seen.find((q) => /LIMIT/.test(q.sql));
  assert.match(list.sql, /'-infinity' AND p\.sent_at IS NOT NULL/);
  assert.match(list.sql, /p\.status = 'viewed'/);
  assert.match(list.sql, /ORDER BY p\.view_count ASC/);
  assert.doesNotMatch(list.sql, /not-a-uuid/);
  assert.deepEqual(list.params, ["%mel%", ID, 10, 10]);
});

test("drafts and all are views of their own", async (t) => {
  const seen = [];
  const request = await serve(t, async (sql) => { seen.push(sql); return { rows: [{ n: 0 }] }; });
  await request("/pitches?view=drafts");
  assert.ok(seen.every((s) => /'-infinity' AND p\.status = 'ready'/.test(s)));
  seen.length = 0;
  await request("/pitches?view=all");
  assert.ok(seen.every((s) => !/'-infinity' AND p\.(sent_at|status)/.test(s)));
});

test("an unknown status or channel is ignored, not interpolated", async (t) => {
  const seen = [];
  const request = await serve(t, async (sql, params) => { seen.push({ sql, params }); return { rows: [{ n: 0 }] }; });
  await request("/pitches?filter[status]=x';drop table pitches;--&filter[channel]=nope");
  for (const q of seen) assert.doesNotMatch(q.sql, /drop table/i);
});

test("one pitch comes with its events and replies", async (t) => {
  const request = await serve(t, async (sql) => {
    if (/WHERE p\.id = \$1/.test(sql)) return { rows: [{ id: ID, creator_name: "Mel", brand_name: "Aiku", profile_pic_name: "", instagram_profile_image: "" }] };
    if (/FROM pitch_replies/.test(sql)) return { rows: [] };
    return { rows: [{ id: "1", event: "sent", detail: {} }] };
  });
  const r = await request(`/pitches/${ID}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.pitch.brand_name, "Aiku");
  assert.equal(r.body.events.length, 1);
  assert.deepEqual(r.body.replies, []);
  const missing = await request("/pitches/not-an-id");
  assert.equal(missing.status, 404);
  plain(missing.body.error);
});

test("the summary counts sent pitches in the period and the paying rate", async (t) => {
  const seen = [];
  const request = await serve(t, async (sql, params) => {
    seen.push({ sql, params });
    if (/pitch_settings/.test(sql)) return { rows: [{ value: "the campaign has no sender" }] };
    if (/AS sending/.test(sql)) return { rows: [{ sending: 1, drafts: 4, no_contact: 0, weekly_creators: 2 }] };
    return { rows: [{ sent: 40, creators: 5, brands: 30, viewed: 10, replied: 3, accepted: 1, trials: 1, paying: 1 }] };
  });
  const r = await request("/summary?days=30");
  assert.equal(r.status, 200);
  assert.equal(r.body.paying_per_100, 2.5);
  assert.equal(r.body.sending_problem, "the campaign has no sender");
  assert.deepEqual(seen.find((q) => /AS paying/.test(q.sql)).params, [30]);
  const all = await request("/summary?days=forever");
  assert.equal(all.body.days, null);
});

test("a database without Pitch says so instead of failing", async (t) => {
  const request = await serve(t, async () => { throw Object.assign(new Error("missing"), { code: "42P01" }); });
  assert.deepEqual((await request("/summary")).body, { available: false });
  assert.deepEqual((await request("/pitches")).body, { available: false, view: "sent", items: [], total: 0 });
  assert.deepEqual((await request("/creators")).body, { available: false, view: "all", items: [], total: 0 });
  const w = await request(`/creators/${ID}`, "PATCH", { weekly: true });
  assert.equal(w.status, 409);
  plain(w.body.error);
});

test("weekly picks: bad input never reaches SQL", async (t) => {
  const request = await serve(t, async () => { assert.fail("invalid input reached SQL"); });
  for (const [path, method, body, status] of [
    ["/creators/nope", "PATCH", { weekly: true }, 404],
    [`/creators/${ID}`, "PATCH", { weekly: "yes" }, 400],
    [`/creators/${ID}`, "PATCH", {}, 400],
    ["/creators", "POST", { email: "not an email" }, 400],
    ["/creators", "POST", {}, 400],
  ]) {
    const r = await request(path, method, body);
    assert.equal(r.status, status, `${method} ${path} ${JSON.stringify(body)}`);
    plain(r.body.error);
  }
});

test("weekly picks switch on only for a live creator", async (t) => {
  const seen = [];
  let found = true;
  const request = await serve(t, async (sql, params) => {
    seen.push({ sql, params });
    if (/FROM users u/.test(sql)) return { rows: found ? [{ id: ID, email: "maya@example.com" }] : [] };
    return { rows: [{ user_id: ID, weekly: params[1] }] };
  });
  const on = await request("/creators", "POST", { email: " Maya@Example.com " });
  assert.equal(on.status, 200);
  assert.deepEqual(on.body.creator, { user_id: ID, weekly: true });
  assert.deepEqual(seen[0].params, ["maya@example.com"]);
  assert.match(seen[1].sql, /INSERT INTO pitch_creators/);
  const off = await request(`/creators/${ID}`, "PATCH", { weekly: false });
  assert.deepEqual(off.body.creator, { user_id: ID, weekly: false });
  found = false;
  const gone = await request("/creators", "POST", { email: "ghost@example.com" });
  assert.equal(gone.status, 404);
  plain(gone.body.error);
});
