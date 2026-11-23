import { test } from "node:test";
import assert from "node:assert/strict";
import { nextRun, stage, tally, STAGES } from "../lib/outreach-monitor.js";

// The Outreach page's arithmetic.

test("the next send is the next run hour on a working day", () => {
  assert.equal(nextRun(new Date("2026-11-22T14:30:00Z")).toISOString(), "2026-11-23T09:10:00.000Z"); // Sunday
  assert.equal(nextRun(new Date("2026-11-23T09:30:00Z")).toISOString(), "2026-11-23T11:10:00.000Z");
  assert.equal(nextRun(new Date("2026-11-27T16:00:00Z")).toISOString(), "2026-11-30T09:10:00.000Z"); // Friday evening
});

test("each person is in exactly one place", () => {
  assert.equal(stage({ status: "active", step: 0 }), "waiting");
  assert.equal(stage({ status: "active", step: 2 }), "in_progress");
  assert.equal(stage({ status: "done", step: 3 }), "finished");
  assert.equal(stage({ status: "replied" }), "replied");
  assert.equal(stage({ status: "replied", needs_person: true }), "needs_person");
  assert.equal(stage({ status: "unsubscribed", stop_reason: "opt_out" }), "unsubscribed");
  assert.equal(stage({ status: "unsubscribed", stop_reason: "complaint" }), "marked_spam");
  assert.equal(stage({ status: "bounced" }), "bounced");
  assert.ok(STAGES.includes("needs_person") && STAGES.includes("waiting"));
});

test("the numbers add up, and an email not yet gone is counted as timed, not sent", () => {
  const now = new Date("2026-11-24T12:00:00Z");
  const people = [
    { audience: "brand", status: "active", step: 0 },
    { audience: "brand", status: "active", step: 1, first_sent_at: "2026-11-23T09:20:00Z" },
    { audience: "brand", status: "replied", step: 1, first_sent_at: "2026-11-23T09:40:00Z", reply_at: "2026-11-23T15:00:00Z", intent: "interested", auto_answers: 1, answer_cost_usd: 0.012, opened_at: "2026-11-23T09:44:00Z", clicked_at: "2026-11-23T09:45:00Z" },
    { audience: "brand", status: "replied", step: 1, first_sent_at: "2026-11-23T10:00:00Z", reply_at: "2026-11-24T08:00:00Z", needs_person: true, answer_cost_usd: 0.004 },
    { audience: "creator", status: "bounced", step: 1, first_sent_at: "2026-11-23T09:30:00Z" },
    { audience: "creator", status: "replied", step: 2, first_sent_at: "2026-11-23T09:30:00Z", reply_at: "2026-11-24T09:00:00Z", signed_up_at: "2026-11-24T10:00:00Z", activated_at: "2026-11-24T11:00:00Z" },
  ];
  const emails = [
    { audience: "brand", kind: "sequence", scheduled_for: "2026-11-23T09:20:00Z", delivered_at: "2026-11-23T09:20:05Z" },
    { audience: "brand", kind: "sequence", scheduled_for: "2026-11-23T09:40:00Z", delivered_at: "2026-11-23T09:40:05Z" },
    { audience: "brand", kind: "answer", scheduled_for: "2026-11-23T15:12:00Z", delivered_at: "2026-11-23T15:12:03Z" },
    { audience: "brand", kind: "sequence", scheduled_for: "2026-11-24T13:20:00Z" }, // timed, later today
    { audience: "brand", kind: "sequence", scheduled_for: "2026-11-24T10:00:00Z", cancelled_at: "2026-11-24T09:00:00Z" }, // called back
    { audience: "creator", kind: "sequence", scheduled_for: "2026-11-23T09:30:00Z", bounced_at: "2026-11-23T09:30:09Z" },
  ];
  const { boxes, days, answer_cost_usd } = tally(people, emails, now);
  const b = boxes.brand;
  assert.equal(b.mailbox, "brand@linkable.link");
  assert.deepEqual([b.total, b.waiting, b.in_progress, b.replied, b.needs_person], [4, 1, 1, 2, 1]);
  assert.deepEqual([b.emails_sent, b.answers_sent, b.emails_timed, b.emails_delivered], [2, 1, 1, 3]);
  assert.deepEqual([b.interested, b.answered_by_itself, b.people_emailed], [1, 1, 3]);
  assert.deepEqual([b.opened, b.clicked], [1, 1], "people who opened, not how many times");
  const c = boxes.creator;
  assert.deepEqual([c.total, c.bounced, c.replied, c.signed_up, c.activated, c.emails_bounced], [2, 1, 1, 1, 1, 1]);
  assert.equal(answer_cost_usd, 0.02);
  assert.equal(days.length, 14);
  const monday = days.find((d) => d.day === "2026-11-23");
  assert.deepEqual([monday.brand_sent, monday.creator_sent, monday.replies], [3, 1, 1]);
  assert.equal(days.at(-1).day, "2026-11-24");
  assert.equal(days.at(-1).replies, 2);
});
