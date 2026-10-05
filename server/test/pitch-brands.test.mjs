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
    return /LIMIT/.test(sql) ? { rows: [{ id: "b1", name: "OLIPOP", pitches_sent: 2 }] } : { rows: [{ n: 41 }] };
  });
  const r = await request("/?limit=20&offset=20&sortBy=instagram_followers&sortDir=desc&filter[name]=oli");
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 41);
  assert.equal(r.body.items[0].pitches_sent, 2);
  const list = seen.find((q) => /LIMIT/.test(q.sql));
  assert.match(list.sql, /ORDER BY b\.instagram_followers DESC/);
  assert.match(list.sql, /AS pitches_sent/);
  assert.deepEqual(list.params, ["%oli%", 20, 20]);
  // Most pitched first: the count is a column of the list, sortable by name.
  await request("/?sortBy=pitches_sent&sortDir=desc");
  assert.match(seen.at(-2).sql + seen.at(-1).sql, /ORDER BY pitches_sent DESC/);
});

const ID = "11111111-2222-3333-4444-555555555555";

test("edits are checked before any SQL, and a Linkable brand is read-only", async (t) => {
  const request = await serve(t, async () => { assert.fail("invalid edit reached SQL"); });
  for (const body of [{}, { name: "" }, { instagram: "not a handle!" }, { contact_email: "nope" },
    { category: "SODA" }, { country: "United Kingdom" }, { description: "x".repeat(601) }]) {
    const r = await request(`/${ID}`, "PATCH", body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal((await request("/not-a-uuid", "PATCH", { name: "X" })).status, 404);

  const linkable = await serve(t, async (sql) => {
    if (/SELECT linkable_brand_user_id/.test(sql)) return { rows: [{ on_linkable: true }] };
    assert.fail("a Linkable brand was written");
  });
  const e = await linkable(`/${ID}`, "PATCH", { name: "X" });
  assert.equal(e.status, 409);
  assert.equal((await linkable(`/${ID}`, "DELETE")).status, 409);
});

test("an edit writes only the fields sent; an admin's email is verified", async (t) => {
  const seen = [];
  const request = await serve(t, async (sql, params) => {
    seen.push({ sql, params });
    if (/SELECT linkable_brand_user_id/.test(sql)) return { rows: [{ on_linkable: false }] };
    return { rows: [{ id: ID }] };
  });
  const r = await request(`/${ID}`, "PATCH", { instagram: "https://instagram.com/DrinkOlipop/", contact_email: "Partners@Olipop.com", country: "uk" });
  assert.equal(r.status, 200);
  const update = seen.find((q) => /UPDATE pitch_brands/.test(q.sql));
  assert.deepEqual(update.params, [ID, "drinkolipop", "partners@olipop.com", "GB"]);
  assert.match(update.sql, /contact_verified = true/);
  assert.match(update.sql, /socials_checked_at = CASE WHEN instagram IS DISTINCT FROM \$2/);
  assert.doesNotMatch(update.sql, /\bname =/);
});

test("removing a brand marks who removed it and closes its unsent drafts", async (t) => {
  const seen = [];
  const request = await serve(t, async (sql, params) => {
    seen.push({ sql, params });
    if (/SELECT linkable_brand_user_id/.test(sql)) return { rows: [{ on_linkable: false }] };
    if (/UPDATE pitches/.test(sql)) return { rows: [], rowCount: 2 };
    return { rows: [], rowCount: 1 };
  });
  const r = await request(`/${ID}`, "DELETE");
  assert.equal(r.status, 200);
  assert.equal(r.body.drafts_closed, 2);
  const soft = seen.find((q) => /UPDATE pitch_brands SET deleted/.test(q.sql));
  assert.deepEqual(soft.params, [ID, "pitch-test@example.com"]);
  assert.ok(seen.some((q) => /status = 'expired'/.test(q.sql) && /status = 'ready'/.test(q.sql)));
});
