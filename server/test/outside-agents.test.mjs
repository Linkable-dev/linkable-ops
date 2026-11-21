import { test } from "node:test";
import assert from "node:assert/strict";
import { actOnItem, briefFor, draftMissing, draftProblem, listItems, queueDailyPosts } from "../lib/outside-agents.js";
import { settingProblem } from "../lib/instagram-dm-queue.js";

// The outside agents draft; a person posts or sends. These check what the
// draft is asked for, what is refused, and that a decision is recorded.

const brandPost = { id: 1, kind: "signal", side: "brand", platform: "linkedin", title: "KORA on LinkedIn", snippet: "We're looking for UGC creators" };
const creatorPost = { id: 2, kind: "signal", side: "creator", platform: "reddit", title: "How do I get brand deals?", snippet: "2k followers" };
const partner = { id: 3, kind: "partner", side: "partner", platform: "community", url: "https://ugcclub.co.uk/", title: "UGC Club", snippet: "A community" };
const ownPost = { id: 4, kind: "post", platform: "linkedin", title: "How to brief a creator", snippet: "Five lines.", meta: { article_url: "https://www.linkable.link/blog/brief" } };

test("each kind of item is asked for the right thing", () => {
  assert.match(briefFor(brandPost), /brand posted this on LinkedIn[\s\S]*free trial of 30 days/);
  assert.match(briefFor(creatorPost), /creator posted this on Reddit[\s\S]*free for creators[\s\S]*Reddit: no link/);
  assert.match(briefFor(partner), /runs a community for creators[\s\S]*Do not offer a commission/);
  assert.match(briefFor(ownPost), /LinkedIn post[\s\S]*https:\/\/www\.linkable\.link\/blog\/brief/);
});

test("a draft that promises, offers terms, or links on Reddit is refused", () => {
  const ok = "Hi, I work at Linkable. Creators apply to your campaign and you choose the ones you like.";
  assert.equal(draftProblem(brandPost, { text: ok }), "");
  assert.match(draftProblem(brandPost, { text: "" }), /empty/);
  assert.match(draftProblem(brandPost, { text: `${ok} We guarantee results.` }), /promise/);
  assert.match(draftProblem(creatorPost, { text: `${ok} https://www.linkable.link` }), /Reddit/);
  assert.match(draftProblem(partner, { text: ok, subject: "" }), /no subject/);
  assert.match(draftProblem(partner, { text: `${ok} We pay 30% for every brand.`, subject: "Hello" }), /terms/);
  assert.equal(draftProblem(partner, { text: ok, subject: "Working together" }), "");
  assert.match(draftProblem(ownPost, { text: "A pitch is five moves. We work at Linkable and wrote it up." }), /own account/);
  assert.match(draftProblem(ownPost, { text: "Line 1: A pitch is five moves, not five paragraphs." }), /labels/);
  assert.equal(draftProblem(ownPost, { text: "A pitch is five moves, not five paragraphs. We wrote them up." }), "");
});

// A tiny stand-in for the database: one table of rows, the few calls used.
function fakeDb(rows) {
  const calls = [];
  const table = () => {
    const q = { filters: [], patch: null };
    const api = {
      select: () => api, order: () => api, limit: () => api,
      eq: (k, v) => { q.filters.push([k, v]); return api; },
      is: (k, v) => { q.filters.push([k, v]); return api; },
      range: () => api,
      update: (patch) => { q.patch = patch; return api; },
      upsert: (list, opts) => { calls.push(["upsert", list, opts]); return { select: async () => ({ data: list.map((_, i) => ({ id: i + 1 })), error: null }) }; },
      then: (resolve) => {
        let out = rows.filter((r) => q.filters.every(([k, v]) => (r[k] ?? null) === v));
        if (q.patch) { out.forEach((r) => Object.assign(r, q.patch)); calls.push(["update", q.patch, q.filters]); }
        resolve({ data: out, error: null, count: out.length });
      },
    };
    return api;
  };
  return { from: table, calls };
}

test("missing drafts are written and kept; a refused one is left for next time", async () => {
  const rows = [
    { ...brandPost, state: "new", draft_text: null },
    { ...partner, state: "new", draft_text: null },
    { ...creatorPost, state: "done", draft_text: null },
  ];
  const db = fakeDb(rows);
  const ask = async ({ messages }) => {
    const forPartner = /first email/.test(messages[0].content);
    return {
      usage: { input_tokens: 1000, output_tokens: 100 },
      // The partner draft keeps offering terms, so it is refused twice.
      toolCalls: [{ name: "draft", input: forPartner
        ? { subject: "Hello", text: "Hi, I work at Linkable. We pay 30% commission for every brand you send." }
        : { text: "Hi, I work at Linkable. Creators apply to your campaign and you choose the ones you like." } }],
    };
  };
  const out = await draftMissing({ db, ask });
  assert.equal(out.drafted, 1);
  assert.equal(out.refused, 1);
  assert.ok(out.cost_usd > 0);
  assert.match(rows[0].draft_text, /I work at Linkable/);
  assert.equal(rows[1].draft_text, null);
  assert.equal(rows[2].draft_text, null); // already done: not drafted
});

test("today's posts are one row per platform from the newest article, added once", async () => {
  const db = fakeDb([]);
  const blog = { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [{ slug: "brief", title: "How to brief a creator", excerpt: "Five lines." }], error: null }) }) }) }) }) };
  const out = await queueDailyPosts({ db, blog });
  assert.equal(out.added, 3);
  const [, list, opts] = db.calls[0];
  assert.deepEqual(list.map((r) => r.url), ["linkedin", "instagram", "tiktok"].map((p) => `https://www.linkable.link/blog/brief#${p}`));
  assert.deepEqual(opts, { onConflict: "url", ignoreDuplicates: true });
});

test("a decision records who made it; an edit keeps the item open", async () => {
  const rows = [{ ...brandPost, state: "new", draft_text: "old" }];
  const db = fakeDb(rows);
  const admin = { email: "ops-test@example.com" };
  await actOnItem(1, { action: "save", text: "  new words  ", admin }, { db });
  assert.equal(rows[0].draft_text, "new words");
  assert.equal(rows[0].state, "new");
  await actOnItem(1, { action: "done", admin }, { db });
  assert.equal(rows[0].state, "done");
  assert.equal(rows[0].acted_by, admin.email);
  await actOnItem(1, { action: "reopen", admin }, { db });
  assert.equal(rows[0].state, "new");
  assert.equal(rows[0].acted_by, null);
  await assert.rejects(actOnItem(1, { action: "send it for me", admin }, { db }), /Choose what to do/);
  await assert.rejects(actOnItem(1, { action: "save", text: " ", admin }, { db }), /Write something/);
  await assert.rejects(actOnItem(99, { action: "done", admin }, { db }), /doesn't exist/);
  await assert.rejects(actOnItem("x", { action: "done", admin }, { db }), /doesn't exist/);
});

test("a list is one known kind and state, and the switch is a yes or no", async () => {
  await assert.rejects(listItems({ kind: "everything", db: fakeDb([]) }), /Choose a list/);
  const out = await listItems({ kind: "signal", state: "new", db: fakeDb([{ ...brandPost, state: "new" }]) });
  assert.equal(out.total, 1);
  assert.equal(settingProblem("outside_agents", false), null);
  assert.match(settingProblem("outside_agents", "off"), /must be a boolean/);
});
