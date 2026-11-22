import { test } from "node:test";
import assert from "node:assert/strict";
import { SEQUENCES, MAILBOXES, fill, compose, nextDue, onWorkingDay, buildMessage, sendDue } from "../lib/direct-outreach.js";
import { settingProblem } from "../lib/instagram-dm-queue.js";

// Our own sender: brands from brand@, creators from influencer@, with the
// wording that used to live in Lemlist.

const creator = {
  audience: "creator", sequence: "creator", to_email: "anna@example.com", unsub_token: "a".repeat(32), step: 0, thread: [],
  variables: { greeting: "Hi Anna,", exampleBrand: "@glossier", examplePost: "https://www.instagram.com/p/abc/", signature: "Luca", senderName: "Luca from Linkable", footer: "Not for you? Reply 'no thanks' and I won't follow up." },
};

test("every sequence sends from the mailbox for its audience", () => {
  assert.equal(MAILBOXES.brand, "brand@linkable.link");
  assert.equal(MAILBOXES.creator, "influencer@linkable.link");
  for (const [key, seq] of Object.entries(SEQUENCES)) {
    assert.ok(MAILBOXES[seq.audience], key);
    assert.ok(seq.steps[0].subject, `${key} opens with a subject`);
    assert.equal(seq.steps[0].afterDays, 0);
  }
});

test("the first creator email reads as written, with the footer under the sign-off", () => {
  const out = compose(creator, 0);
  assert.equal(out.subject, "your @glossier post");
  assert.equal(out.text, [
    "Hi Anna,",
    "Saw your post about @glossier.\nhttps://www.instagram.com/p/abc/",
    "I work on Linkable. Brands post campaigns there and creators apply. You see the reward before you apply: free product, a fixed fee, commission on what you sell, or a mix.",
    "It's free for creators, and you can pitch any brand you like from it too.",
    "Want me to send you the sign-up?",
    "Luca\nlinkable.link",
    "Not for you? Reply 'no thanks' and I won't follow up.",
  ].join("\n\n"));
});

test("a blank is a reason not to send, never a hole in a sentence", () => {
  const row = { ...creator, variables: { ...creator.variables, examplePost: " " } };
  assert.match(compose(row, 0).problem, /examplePost/);
  assert.deepEqual(fill("{{a}} and {{b}}", { a: "x" }).missing, ["b"]);
  assert.match(compose({ ...creator, sequence: "nope" }, 0).problem, /no wording/);
});

test("a follow-up answers the first email", () => {
  assert.match(compose(creator, 1).problem, /subject was not kept/);
  const out = compose({ ...creator, subject: "your @glossier post" }, 1);
  assert.equal(out.subject, "Re: your @glossier post");
  assert.match(out.text, /^Hi Anna,\n\nQuick one\./);
  const msg = buildMessage({ ...creator, thread: [{ step: 1, message_id: "<one@linkable.link>" }] }, 1, out);
  assert.equal(msg.payload.headers["In-Reply-To"], "<one@linkable.link>");
  assert.equal(msg.payload.from, "Luca from Linkable <influencer@linkable.link>");
  assert.equal(msg.payload.reply_to, "replies@reply.linkable.link");
  assert.match(msg.payload.headers["List-Unsubscribe"], /\/api\/out\/unsubscribe\?t=a{32}>/);
  assert.equal(msg.payload.html, undefined);
});

test("brands: four steps, tier A keeps its tracking paragraph and tier B does not", () => {
  const variables = { greeting: "Hi,", proofBlock: "P", listOffer: "L", followUpHook: "F", socialProof: "S", closingOffer: "C", subjectLine: "creators posting about Acme", signature: "Luca" };
  const a = compose({ sequence: "brand_a", variables }, 0);
  const b = compose({ sequence: "brand_b", variables }, 0);
  assert.match(a.text, /Shopify app, about ten minutes\./);
  assert.doesNotMatch(b.text, /Shopify app/);
  assert.equal(SEQUENCES.brand_a.steps.length, 4);
  assert.match(compose({ sequence: "brand_a", variables, subject: a.subject }, 3).text, /Last one from me, I won't keep going\./);
});

test("steps wait the days they waited in Lemlist, and never land on a weekend", () => {
  // Thursday 19 Nov 2026 + 4 days = Monday; + 3 from a Wednesday = Saturday, so Monday.
  assert.equal(nextDue("creator", 0, "2026-11-19T10:00:00Z").toISOString(), "2026-11-23T10:00:00.000Z");
  assert.equal(nextDue("brand_a", 0, "2026-11-18T10:00:00Z").toISOString(), "2026-11-23T10:00:00.000Z");
  assert.equal(nextDue("creator", 2, "2026-11-19T10:00:00Z"), null);
  assert.equal(onWorkingDay("2026-11-22T09:00:00Z").getUTCDay(), 1);
});

test("paused or a weekend: nothing is read and nothing goes", async () => {
  assert.equal((await sendDue({ paused: true })).paused, true);
  assert.equal((await sendDue({ now: new Date("2026-11-22T10:00:00Z") })).weekend, true);
});

test("the pause is a team setting", () => {
  assert.equal(settingProblem("direct_send_paused", true), null);
  assert.match(settingProblem("direct_send_paused", "yes"), /boolean/);
});
