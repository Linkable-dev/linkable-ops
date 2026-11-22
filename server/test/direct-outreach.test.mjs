import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEQUENCES, MAILBOXES, MAILBOX_DAILY_CEILING, RAMP, WINDOW_MINUTES, fill, compose, nextDue, onWorkingDay, buildMessage, sendDue,
  newPeopleAllowed, runsLeft, share, spread, trouble, choose,
} from "../lib/direct-outreach.js";
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

// ---- not getting blocked: start slowly, never in a burst, stop at trouble ----

test("a mailbox starts with five new people a day and grows by the week", () => {
  const monday = new Date("2026-11-23T09:10:00Z");
  assert.deepEqual(RAMP, [5, 10, 15, 20]);
  assert.equal(newPeopleAllowed(null, monday), 5);
  assert.equal(newPeopleAllowed("2026-11-23T09:30:00Z", new Date("2026-11-27T15:00:00Z")), 5);
  assert.equal(newPeopleAllowed("2026-11-23T09:30:00Z", new Date("2026-11-30T09:00:00Z")), 10);
  assert.equal(newPeopleAllowed("2026-11-23T09:30:00Z", new Date("2026-12-07T09:00:00Z")), 15);
  assert.equal(newPeopleAllowed("2026-11-23T09:30:00Z", new Date("2027-03-01T09:00:00Z")), 20);
});

test("each run takes its share of what is left today", () => {
  assert.equal(runsLeft(new Date("2026-11-23T09:10:00Z")), 4);
  assert.equal(runsLeft(new Date("2026-11-23T10:05:00Z")), 3); // the 09:10 run, started late
  assert.equal(runsLeft(new Date("2026-11-23T15:40:00Z")), 1);
  assert.equal(runsLeft(new Date("2026-11-23T19:00:00Z")), 1);
  assert.equal(share(5, 4), 2);
  assert.equal(share(3, 3), 1);
  assert.equal(share(0, 4), 0);
  assert.equal(share(-2, 4), 0);
});

test("emails in one run leave apart from each other, inside the window", () => {
  const start = new Date("2026-11-23T09:10:00Z");
  const times = spread(6, start, () => 0.5);
  assert.equal(times.length, 6);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] - times[i - 1] >= 3 * 60000, "at least three minutes apart");
  }
  assert.ok(times[0] - start >= 2 * 60000);
  assert.ok(times[5] - start <= (WINDOW_MINUTES + 2) * 60000);
  // Chance moves each one, never past the next one's slot.
  const jittered = spread(6, start, Math.random);
  for (let i = 1; i < jittered.length; i++) assert.ok(jittered[i] > jittered[i - 1]);
  assert.deepEqual(spread(0, start), []);
});

test("who goes in a run: follow-ups first, then this run's share of new people", () => {
  const row = (audience, step, n) => ({ id: `${audience}-${step}-${n}`, audience, step });
  const rows = [
    row("brand", 2, 1), row("brand", 1, 1),
    ...Array.from({ length: 20 }, (_, i) => row("brand", 0, i)),
    ...Array.from({ length: 20 }, (_, i) => row("creator", 0, i)),
  ];
  const state = { brand: { sent_today: 0, started_today: 0, allowed_new: 5 }, creator: { sent_today: 0, started_today: 4, allowed_new: 5 } };
  const first = choose(rows, state, new Date("2026-11-23T09:10:00Z"));
  // Brand: both follow-ups, and 2 of the day's 5 new (5 over 4 runs). Creator: 1 left of 5.
  assert.deepEqual(first.chosen.map((r) => r.id), ["brand-2-1", "brand-1-1", "brand-0-0", "brand-0-1", "creator-0-0"]);
  assert.equal(first.held, 37);
  // The day's allowance used up: nobody new, whatever is waiting.
  const done = choose(rows, { brand: { started_today: 5, allowed_new: 5 }, creator: { started_today: 9, allowed_new: 5 } }, new Date("2026-11-23T15:10:00Z"));
  assert.deepEqual(done.chosen.map((r) => r.id), ["brand-2-1", "brand-1-1"]);
  // The ceiling holds even for follow-ups.
  const full = choose(rows, { brand: { sent_today: MAILBOX_DAILY_CEILING }, creator: { sent_today: MAILBOX_DAILY_CEILING } }, new Date("2026-11-23T09:10:00Z"));
  assert.equal(full.chosen.length, 0);
});

test("sending pauses itself on bounces or spam reports, and not on a small sample", () => {
  const mailbox = "brand@linkable.link";
  assert.equal(trouble({ mailbox, people: 100, bounced: 4, complaints: 0 }), null);
  assert.match(trouble({ mailbox, people: 100, bounced: 5 }), /5 of the last 100 emails from brand@linkable.link bounced/);
  assert.equal(trouble({ mailbox, people: 10, bounced: 3 }), null);
  assert.equal(trouble({ mailbox, people: 10, complaints: 1 }), null);
  assert.match(trouble({ mailbox, people: 10, complaints: 2 }), /2 people marked emails .* as spam/);
});
