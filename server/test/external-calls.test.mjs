import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { externalCallsRoutes } from "../routes/external-calls.js";
import { decodeMessage } from "../lib/mainAppGrpc.js";
import {
  BRAND, CALL, SUBMISSION, addExternalCall, decideExternalCall, listExternalCalls, setExternalCallImage, updateExternalCall,
} from "../lib/externalCalls.js";
import { draftProblems, sourceLabel, CLOSE_REASONS } from "../../src/components/externalCalls/externalCallLabels.js";

// Campaigns from calls (main app QA 171): ops' queue, through the main app.

async function serve(t, calls) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.admin = { email: "calls-test@example.com" }; req.dbTarget = "dev"; next(); });
  app.use(externalCallsRoutes({ calls }));
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
const plain = (e) => assert.ok(e && !e.includes("rpc error"), e);

test("the routes pass the list, the edits and who decided to the main app", async (t) => {
  const calls = [];
  const request = await serve(t, {
    list: async (q, target) => { calls.push(["list", q, target]); return { available: true, items: [], total: 0 }; },
    add: async (o, target) => { calls.push(["add", o.postUrl, o.formUrl, o.caption, o.admin.email, target]); return { id: ID, status: "reading" }; },
    update: async (id, o, target) => { calls.push(["update", id, o.draft.brand_name, target]); return { id }; },
    decide: async (id, o, target) => { calls.push(["decide", id, o.decision, o.reason, o.admin.email, target]); return { id, status: "live" }; },
    submissions: async (q, target) => { calls.push(["submissions", q, target]); return { available: true, items: [], total: 0 }; },
    act: async (id, o, target) => { calls.push(["act", id, o.action, target]); return { id, status: "sent" }; },
    brands: async (q, target) => { calls.push(["brands", q, target]); return { available: true, items: [], total: 0 }; },
  });
  assert.equal((await request("/?status=draft&source=manual&limit=10&offset=20")).status, 200);
  assert.deepEqual(calls[0], ["list", { status: "draft", source: "manual", limit: 10, offset: 20 }, "dev"]);
  const add = await request("/", "POST", { post_url: "https://www.instagram.com/p/X/", form_url: "https://forms.gle/x", caption: "hi" });
  assert.deepEqual(add.body, { id: ID, status: "reading" });
  assert.deepEqual(calls[1], ["add", "https://www.instagram.com/p/X/", "https://forms.gle/x", "hi", "calls-test@example.com", "dev"]);
  await request(`/${ID}`, "PUT", { draft: { brand_name: "KŌRA" } });
  assert.deepEqual(calls[2], ["update", ID, "KŌRA", "dev"]);
  const ok = await request(`/${ID}/decide`, "POST", { decision: "approve" });
  assert.deepEqual(ok.body, { id: ID, status: "live" });
  assert.deepEqual(calls[3], ["decide", ID, "approve", undefined, "calls-test@example.com", "dev"]);
  await request("/submissions?status=held&brand=kora");
  assert.deepEqual(calls[4], ["submissions", { status: "held", callId: "", brandHandle: "kora", limit: 25, offset: 0 }, "dev"]);
  await request(`/submissions/${ID}`, "POST", { action: "retry" });
  assert.deepEqual(calls[5], ["act", ID, "retry", "dev"]);
  await request("/brands?limit=5");
  assert.deepEqual(calls[6], ["brands", { limit: 5, offset: 0 }, "dev"]);
});

test("a refusal from the main app keeps its status and sentence", async (t) => {
  const refuse = async () => { const e = new Error("Add the brand’s name first."); e.status = 409; throw e; };
  const request = await serve(t, { decide: refuse });
  const r = await request(`/${ID}/decide`, "POST", { decision: "approve" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "Add the brand’s name first.");
});

test("without the service key the page says so, and bad input never reaches the main app", async () => {
  const before = process.env.MAIN_APP_SERVICE_KEY;
  delete process.env.MAIN_APP_SERVICE_KEY;
  try {
    const r = await listExternalCalls({ status: "draft" }, "dev");
    assert.equal(r.available, false);
    plain(r.reason);
    await assert.rejects(addExternalCall({ postUrl: "https://example.com", formUrl: "https://forms.gle/x" }, "dev"), (e) => e.status === 400);
    await assert.rejects(addExternalCall({ postUrl: "https://instagram.com/p/x", formUrl: "https://example.com/form" }, "dev"), (e) => e.status === 400);
    await assert.rejects(decideExternalCall("nope", { decision: "approve" }, "dev"), (e) => e.status === 404);
    await assert.rejects(decideExternalCall(ID, { decision: "maybe" }, "dev"), (e) => e.status === 400);
    await assert.rejects(updateExternalCall(ID, { draft: null }, "dev"), (e) => e.status === 400);
    await assert.rejects(setExternalCallImage(ID, { imageUrl: "javascript:alert(1)" }, "dev"), (e) => e.status === 400);
    await assert.rejects(decideExternalCall(ID, { decision: "approve" }, "dev"), (e) => e.status === 503);
  } finally {
    if (before !== undefined) process.env.MAIN_APP_SERVICE_KEY = before;
  }
});

// Bytes the main app's Go marshaller wrote (proto/external_calls.proto).
test("the main app's lists decode field by field", () => {
  const calls = decodeMessage(Buffer.from("0a470a026331120564726166741a066d616e75616c32046b6f726152054bc58c52415a064d61746368619201167b226272616e645f6e616d65223a224bc58c5241227db00103b801011007", "hex"),
    { 1: ["calls", { repeated: true, schema: CALL }], 2: ["total", "int"] });
  assert.equal(calls.total, 7);
  assert.equal(calls.calls[0].brand_name, "KŌRA");
  assert.equal(calls.calls[0].source, "manual");
  assert.equal(calls.calls[0].applicants, 3);
  assert.equal(calls.calls[0].held, 1);
  assert.deepEqual(JSON.parse(calls.calls[0].draft_json), { brand_name: "KŌRA" });
  const subs = decodeMessage(Buffer.from("0a170a0273312a034d656c420468656c64600272046b6f72611001", "hex"),
    { 1: ["submissions", { repeated: true, schema: SUBMISSION }], 2: ["total", "int"] });
  assert.equal(subs.submissions[0].status, "held");
  assert.equal(subs.submissions[0].attempts, 2);
  assert.equal(subs.submissions[0].brand_handle, "kora");
  const brands = decodeMessage(Buffer.from("0a130a046b6f726112054bc58c52411802200128051001", "hex"),
    { 1: ["brands", { repeated: true, schema: BRAND }], 2: ["total", "int"] });
  assert.deepEqual([brands.brands[0].handle, brands.brands[0].calls, brands.brands[0].live_calls, brands.brands[0].applicants], ["kora", 2, 1, 5]);
});

test("labels and the draft check read plainly", () => {
  assert.equal(sourceLabel("manual"), "Added manually");
  assert.equal(sourceLabel("agent"), "Found by the agent");
  assert.ok(CLOSE_REASONS.form_closed);
  const form = { fields: [{ entry: "entry.1", title: "Name", required: true }] };
  assert.deepEqual(draftProblems({ brand_name: "", product_title: "Matcha", questions: [{ entry: "entry.1", field: "skip" }] }, form),
    ["Add the brand’s name.", "“Name” is required: map it to a profile field or “also asks”."]);
  assert.deepEqual(draftProblems({ brand_name: "KŌRA", product_title: "Matcha", questions: [{ entry: "entry.1", field: "full_name" }] }, form), []);
});
