import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { pitchBrandsRoutes } from "../routes/pitch-brands.js";

async function serve(t, query) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.admin = { email: "pitch-test@example.com" }; req.dbTarget = "dev"; next(); });
  app.use(pitchBrandsRoutes({ query }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return async (path, method = "GET", body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
}

test("bad input never reaches SQL", async (t) => {
  const request = await serve(t, async () => { assert.fail("invalid input reached SQL"); });
  for (const body of [{}, { input: "   " }, { input: "x".repeat(201) },
    { input: "@olipop", contact_email: "not-an-email" }, { input: "@olipop", category: "SODA" }]) {
    const r = await request("/requests", "POST", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(r.body.error && !r.body.error.includes(":"), r.body.error);
  }
});

test("a request is written with the admin's email", async (t) => {
  const seen = [];
  const request = await serve(t, async (sql, params) => {
    seen.push({ sql, params });
    return { rows: [{ id: "r1", input: params[1], status: "pending", error: "" }] };
  });
  const r = await request("/requests", "POST", { input: " @drinkolipop ", contact_email: "Hello@Olipop.com", category: "FOOD_BEVERAGE" });
  assert.equal(r.status, 200);
  assert.deepEqual(seen[0].params, ["pitch-test@example.com", "@drinkolipop", "hello@olipop.com", "FOOD_BEVERAGE"]);
  assert.match(seen[0].sql, /INSERT INTO pitch_brand_requests/);
});

test("a database without Pitch says so instead of failing", async (t) => {
  const request = await serve(t, async () => { throw Object.assign(new Error("missing"), { code: "42P01" }); });
  assert.deepEqual((await request("/")).body, { available: false, items: [], total: 0 });
  assert.deepEqual((await request("/requests")).body, { available: false, requests: [] });
  const w = await request("/requests", "POST", { input: "drinkolipop.com" });
  assert.equal(w.status, 409);
  assert.ok(!w.body.error.includes(":"), w.body.error);
});

test("the brand list pages and filters on the server", async (t) => {
  const seen = [];
  const request = await serve(t, async (sql, params) => {
    seen.push({ sql, params });
    return /count\(\*\)/.test(sql) ? { rows: [{ n: 41 }] } : { rows: [{ id: "b1", name: "OLIPOP" }] };
  });
  const r = await request("/?limit=20&offset=20&sortBy=instagram_followers&sortDir=desc&filter[name]=oli");
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 41);
  const list = seen.find((q) => !/count\(\*\)/.test(q.sql));
  assert.match(list.sql, /ORDER BY b\.instagram_followers DESC/);
  assert.deepEqual(list.params, ["%oli%", 20, 20]);
});
