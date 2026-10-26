import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { pitchRoutes } from "../routes/pitch.js";
import { decodeMessage, encodeFields } from "../lib/mainAppGrpc.js";
import { APPLICATION, decidePitchPartner, listPitchPartners, verifyPitchPartnerVideo } from "../lib/pitchPartners.js";
import { partnerAccount, PARTNER_QUEUES } from "../../src/components/pitch/pitchLabels.js";

// Pitch Partners (main app QA 132): ops' queue, through the main app.

async function serve(t, partners) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.admin = { email: "partners-test@example.com" }; req.dbTarget = "dev"; next(); });
  app.use(pitchRoutes({ query: async () => ({ rows: [] }), partners }));
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

test("the routes pass the queue, the decision and who decided to the main app", async (t) => {
  const calls = [];
  const request = await serve(t, {
    list: async (q, target) => { calls.push(["list", q, target]); return { available: true, queue: q.queue, items: [], total: 0 }; },
    decide: async (id, o, target) => { calls.push(["decide", id, o.decision, o.reason, o.admin.email, target]); return { status: "approved" }; },
    video: async (id, o, target) => { calls.push(["video", id, o.decision, o.reason, target]); return { video_status: "verified" }; },
  });
  const list = await request("/partners?queue=videos&limit=10&offset=20");
  assert.equal(list.status, 200);
  assert.deepEqual(calls[0], ["list", { queue: "videos", limit: 10, offset: 20 }, "dev"]);
  const ok = await request(`/partners/${ID}/decide`, "POST", { decision: "approve" });
  assert.deepEqual(ok.body, { status: "approved" });
  assert.deepEqual(calls[1], ["decide", ID, "approve", undefined, "partners-test@example.com", "dev"]);
  const v = await request(`/partners/${ID}/video`, "POST", { decision: "reject", reason: "Private account" });
  assert.deepEqual(v.body, { video_status: "verified" });
  assert.deepEqual(calls[2], ["video", ID, "reject", "Private account", "dev"]);
});

test("a refusal from the main app keeps its status and sentence", async (t) => {
  const refuse = async () => { const e = new Error("That application has been decided already."); e.status = 409; throw e; };
  const request = await serve(t, { list: refuse, decide: refuse, video: refuse });
  const r = await request(`/partners/${ID}/decide`, "POST", { decision: "approve" });
  assert.equal(r.status, 409);
  plain(r.body.error);
});

test("without the service key the queue says so, and bad input never reaches the main app", async () => {
  const before = process.env.MAIN_APP_SERVICE_KEY;
  delete process.env.MAIN_APP_SERVICE_KEY;
  try {
    const r = await listPitchPartners({ queue: "videos" }, "dev");
    assert.equal(r.available, false);
    plain(r.reason.replace("(MAIN_APP_SERVICE_KEY)", ""));
    await assert.rejects(decidePitchPartner("nope", { decision: "approve" }, "dev"), (e) => e.status === 404);
    await assert.rejects(decidePitchPartner(ID, { decision: "maybe" }, "dev"), (e) => e.status === 400);
    await assert.rejects(decidePitchPartner(ID, { decision: "reject", reason: " " }, "dev"), (e) => e.status === 400);
    await assert.rejects(verifyPitchPartnerVideo(ID, { decision: "reject", reason: "x".repeat(501) }, "dev"), (e) => e.status === 400);
    await assert.rejects(decidePitchPartner(ID, { decision: "approve" }, "dev"), (e) => e.status === 503);
  } finally {
    if (before !== undefined) process.env.MAIN_APP_SERVICE_KEY = before;
  }
});

// Bytes the main app's Go marshaller wrote for a PitchPartnerList and a
// PitchPartnerDecisionResponse.
test("a PitchPartnerList from the main app decodes field by field", () => {
  const bytes = Buffer.from("0aaf010a027531120a4d656c204a6f6e736f6e1a0f6d656c406578616d706c652e636f6d2209696e7374616772616d2a096d656c6a6f6e736f6e309484023a096d656c6a6f6e736f6e42066d656c2e74744a0641205265656c50015a08617070726f76656482012168747470733a2f2f7777772e696e7374616772616d2e636f6d2f7265656c2f782f8a01097375626d69747465649a0114323032362d31312d32355431303a30303a30305aa00118a801060a0d0a0275325a076170706c6965641002", "hex");
  const list = decodeMessage(bytes, { 1: ["partners", { repeated: true, schema: APPLICATION }], 2: ["total", "int"] });
  assert.equal(list.total, 2);
  const [mel, other] = list.partners;
  assert.equal(mel.user_id, "u1");
  assert.equal(mel.name, "Mel Jonson");
  assert.equal(mel.main_followers, 33300);
  assert.equal(mel.usage_rights, true);
  assert.equal(mel.video_status, "submitted");
  assert.equal(mel.pro_until, "2026-11-25T10:00:00Z");
  assert.equal(mel.signups, 24);
  assert.equal(mel.on_pro, 6);
  assert.equal(other.status, "applied");
  assert.equal(other.usage_rights, false);
  const res = decodeMessage(Buffer.from("0a08617070726f766564120876657269666965641a14323032372d30312d32355431303a30303a30305a", "hex"),
    { 1: ["status", "string"], 2: ["video_status", "string"], 3: ["pro_until", "string"] });
  assert.deepEqual(res, { status: "approved", video_status: "verified", pro_until: "2027-01-25T10:00:00Z" });
  // ListPitchPartnersRequest { queue: "videos", limit: 10 }; offset 0 is left out.
  assert.equal(encodeFields({ 1: "videos", 2: 10, 3: 0 }).toString("hex"), "0a06766964656f73100a");

  assert.deepEqual(partnerAccount(mel), {
    line: "Instagram · @meljonson · 33.3K followers",
    links: [
      { label: "Instagram", href: "https://www.instagram.com/meljonson/" },
      { label: "TikTok", href: "https://www.tiktok.com/@mel.tt" },
    ],
  });
  assert.deepEqual(partnerAccount({ main_platform: "", instagram_handle: "bad handle!" }), { line: "", links: [] });
});

test("payouts, removals and blocked earnings: the new decisions and fields", async () => {
  const before = process.env.MAIN_APP_SERVICE_KEY;
  delete process.env.MAIN_APP_SERVICE_KEY;
  try {
    // A removal needs the reason; approve_payout doesn't; both reach the main app (503 without the key).
    await assert.rejects(decidePitchPartner(ID, { decision: "remove", reason: " " }, "dev"), (e) => e.status === 400);
    await assert.rejects(decidePitchPartner(ID, { decision: "remove", reason: "Misleading claims" }, "dev"), (e) => e.status === 503);
    await assert.rejects(decidePitchPartner(ID, { decision: "approve_payout" }, "dev"), (e) => e.status === 503);
    const r = await listPitchPartners({ queue: "payouts" }, "dev");
    assert.equal(r.queue, "payouts");
  } finally {
    if (before !== undefined) process.env.MAIN_APP_SERVICE_KEY = before;
  }
  // PitchPartnerApplication { blocked_earnings: 2, blocked_reason: "same_card",
  // payout_review_reason: "first_payout", payout_review_since: "2026-11-25T10:00:00Z" }
  const bytes = encodeFields({ 23: 2, 24: "same_card", 25: "first_payout", 26: "2026-11-25T10:00:00Z", 27: "£2,509.50" });
  const row = decodeMessage(bytes, APPLICATION);
  assert.equal(row.blocked_earnings, 2);
  assert.equal(row.blocked_reason, "same_card");
  assert.equal(row.payout_review_reason, "first_payout");
  assert.equal(row.payout_review_since, "2026-11-25T10:00:00Z");
  assert.equal(row.payout_review_amount, "£2,509.50");
  assert.deepEqual(PARTNER_QUEUES.map((q) => q.value), ["applications", "videos", "payouts", "approved", "rejected", "removed"]);
});
