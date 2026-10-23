import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { pitchRoutes } from "../routes/pitch.js";
import { decodeMessage, encodeFields } from "../lib/mainAppGrpc.js";
import { approvePitchReview, rejectPitchReview, listPitchReviews, REVIEW } from "../lib/pitchReviews.js";
import { reviewAccount } from "../../src/components/pitch/pitchLabels.js";

async function serve(t, query, sign = async (keys) => keys.map(() => null), reviews) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.admin = { email: "pitch-test@example.com" }; req.dbTarget = "dev"; next(); });
  app.use(pitchRoutes({ query, sign, ...(reviews ? { reviews } : {}) }));
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

test("the creator list says when each opened Pitch, and how big each view is", async (t) => {
  const seen = [];
  const request = await serve(t, async (sql, params) => {
    seen.push({ sql, params });
    if (/AS "all"/.test(sql)) return { rows: [{ all: 9, sent: 1, weekly: 0 }] };
    if (/LIMIT/.test(sql)) return { rows: [{ user_id: ID, written: 0, drafts: 0, opened_at: "2026-10-05T17:58:47Z", profile_pic_name: "", instagram_profile_image: "" }] };
    return { rows: [{ n: 9 }] };
  });
  const r = await request("/creators?sortBy=opened&sortDir=desc&filter[opened]=last:7");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.counts, { all: 9, sent: 1, weekly: 0 });
  assert.equal(r.body.items[0].written, 0);
  const list = seen.find((q) => /LIMIT/.test(q.sql));
  assert.match(list.sql, /COALESCE\(pc\.created, s\.first_pitch_at\) AS opened_at/);
  assert.match(list.sql, /ORDER BY COALESCE\(pc\.created, s\.first_pitch_at\) DESC/);
  assert.deepEqual(list.params, [7, 25, 0]);
  // The pills count every creator, whatever the list is filtered by.
  assert.deepEqual(seen.find((q) => /AS "all"/.test(q.sql)).params, undefined);
});

// The In review queue (main app QA 112): ops only relays to the main app,
// which sends. Approve and Reject carry who decided and what they typed.
test("the review queue relays the list, Approve and Reject to the main app", async (t) => {
  const calls = [];
  const reviews = {
    list: async (page, target) => { calls.push(["list", page, target]); return { available: true, items: [{ pitch_id: ID }], total: 1 }; },
    approve: async (id, opts, target) => { calls.push(["approve", id, opts.contactEmail, opts.admin.email, target]); return { status: "scheduled" }; },
    reject: async (id, opts, target) => {
      calls.push(["reject", id, opts.reason, target]);
      const e = new Error("Write the reason the creator will read."); e.status = 400;
      if (!opts.reason) throw e;
      return { status: "ready" };
    },
  };
  const request = await serve(t, async () => ({ rows: [] }), undefined, reviews);
  const list = await request("/reviews?limit=500&offset=-3");
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  assert.deepEqual(calls[0], ["list", { limit: 100, offset: 0 }, "dev"]);
  const ok = await request(`/reviews/${ID}/approve`, "POST", { contact_email: "sophie@kora.com" });
  assert.deepEqual(ok.body, { status: "scheduled" });
  assert.deepEqual(calls[1], ["approve", ID, "sophie@kora.com", "pitch-test@example.com", "dev"]);
  const bad = await request(`/reviews/${ID}/reject`, "POST", {});
  assert.equal(bad.status, 400);
  plain(bad.body.error);
  const rejected = await request(`/reviews/${ID}/reject`, "POST", { reason: "Name the product" });
  assert.deepEqual(rejected.body, { status: "ready" });
});

test("without the service key the queue says so instead of failing", async () => {
  const before = process.env.MAIN_APP_SERVICE_KEY;
  delete process.env.MAIN_APP_SERVICE_KEY;
  try {
    const r = await listPitchReviews({ limit: 10, offset: 0 }, "dev");
    assert.equal(r.available, false);
    plain(r.reason.replace("(MAIN_APP_SERVICE_KEY)", ""));
    await assert.rejects(approvePitchReview(ID, {}, "dev"), (e) => e.status === 503);
    await assert.rejects(rejectPitchReview(ID, { reason: " " }, "dev"), (e) => e.status === 400);
    await assert.rejects(approvePitchReview("nope", {}, "dev"), (e) => e.status === 404);
    await assert.rejects(approvePitchReview(ID, { contactEmail: "not an email" }, "dev"), (e) => e.status === 400);
  } finally {
    if (before !== undefined) process.env.MAIN_APP_SERVICE_KEY = before;
  }
});

// Bytes the main app's Go marshaller wrote for a PitchReviewList: the hand
// decoder reads every field type it uses (nested, repeated, int64, double, bool).
test("a PitchReviewList from the main app decodes field by field", () => {
  const bytes = Buffer.from("0a450a027031220c4d61796120436f6c6c696e7338b8aa02413333333333330b40580172054bc58c5241800101900101c201073120766964656fd20102412ed20102422ed801040a040a0270321002", "hex");
  const REVIEW = {
    1: ["pitch_id", "string"], 4: ["creator_name", "string"], 7: ["creator_followers", "int"], 8: ["creator_engagement", "double"],
    11: ["creator_reviews_passed", "int"], 14: ["brand_name", "string"], 16: ["brand_on_linkable", "bool"],
    18: ["contact_verified", "bool"], 24: ["offers", "string"], 26: ["problems", ["string"]], 27: ["creator_pitches_sent", "int"],
  };
  const list = decodeMessage(bytes, { 1: ["reviews", { repeated: true, schema: REVIEW }], 2: ["total", "int"] });
  assert.equal(list.total, 2);
  assert.equal(list.reviews.length, 2);
  assert.deepEqual(list.reviews[0], {
    pitch_id: "p1", creator_name: "Maya Collins", creator_followers: 38200, creator_engagement: 3.4,
    creator_reviews_passed: 1, brand_name: "KŌRA", brand_on_linkable: true, contact_verified: true,
    offers: "1 video", problems: ["A.", "B."], creator_pitches_sent: 4,
  });
  assert.equal(list.reviews[1].pitch_id, "p2");
  assert.equal(list.reviews[1].brand_on_linkable, false);
  assert.deepEqual(list.reviews[1].problems, []);
  // ListPitchReviewsRequest { limit: 25, offset: 50 }; zero is left out.
  assert.equal(encodeFields({ 1: 25, 2: 50 }).toString("hex"), "08191032");
  assert.equal(encodeFields({ 1: 25, 2: 0 }).toString("hex"), "0819");
});

// Bytes the main app's Go marshaller wrote for two reviews with their main
// account (fields 29-32), read with the decoder's own schema: Moon's TikTok
// (her Instagram's 7 and 8 stay apart), and Maya's Instagram.
test("a PitchReview's main account decodes and the card shows that account only", () => {
  const bytes = Buffer.from("0a3f0a027033220a4d6f6f6e205261686d61387841000000000000f83fea010674696b746f6bf2010a796f7279616d6f6f6e31f801cc3e8102cdcccccccccc18400a470a0270342a0b6d617961636f6c6c696e7338b8aa02413333333333330b40ea0109696e7374616772616df2010b6d617961636f6c6c696e73f801b8aa0281023333333333330b401002", "hex");
  const list = decodeMessage(bytes, { 1: ["reviews", { repeated: true, schema: REVIEW }], 2: ["total", "int"] });
  const [moon, maya] = list.reviews;
  assert.equal(moon.main_platform, "tiktok");
  assert.equal(moon.main_handle, "yoryamoon1");
  assert.equal(moon.main_followers, 8012);
  assert.equal(moon.main_engagement, 6.2);
  assert.equal(moon.creator_followers, 120);
  assert.equal(moon.creator_engagement, 1.5);
  assert.deepEqual(reviewAccount(moon), { handle: "yoryamoon1", line: "TikTok · 8K followers · 6.2% engagement on views" });
  assert.equal(maya.main_platform, "instagram");
  assert.deepEqual(reviewAccount(maya), { handle: "mayacollins", line: "Instagram · 38.2K followers · 3.4% engagement" });

  // Her TikTok not read yet; no account at all; a main app from before 29-32.
  assert.deepEqual(reviewAccount({ ...moon, main_followers: 0, main_engagement: 0 }), { handle: "yoryamoon1", line: "TikTok · No stats yet" });
  assert.deepEqual(reviewAccount({ creator_handle: "", main_platform: "", creator_followers: 0, creator_engagement: 0 }), { handle: "", line: "No stats yet" });
  assert.deepEqual(reviewAccount({ creator_handle: "mayacollins", creator_followers: 38200, creator_engagement: 3.4 }),
    { handle: "mayacollins", line: "Instagram · 38.2K followers · 3.4% engagement" });
  // Neither account, or an old main app, with numbers left on her row but no
  // Instagram handle: not shown as Instagram's.
  assert.deepEqual(reviewAccount({ creator_handle: "", main_platform: "", creator_followers: 38200, creator_engagement: 3.4 }),
    { handle: "", line: "No stats yet" });
  assert.deepEqual(reviewAccount({ creator_handle: "mayacollins", creator_followers: 0, creator_engagement: 0 }),
    { handle: "mayacollins", line: "Instagram · No stats yet" });
});
