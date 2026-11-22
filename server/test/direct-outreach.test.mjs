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
    "I work on Linkable. It lets you pitch any brand you'd like to work with. You pick the brand, we help you write the proposal, send it to the right person there, and follow up for you.",
    "Ten pitches a month are free.",
    "Want me to send you the link?",
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

test("every creator email is about Pitch, and none promises campaigns", () => {
  const variables = { ...creator.variables, niche: "beauty" };
  for (const sequence of ["creator", "creator_cold"]) {
    let subject = "";
    SEQUENCES[sequence].steps.forEach((_, i) => {
      const out = compose({ sequence, variables, subject }, i);
      assert.equal(out.problem, undefined, `${sequence} step ${i + 1}`);
      if (i === 0) subject = out.subject;
      assert.match(out.text, /pitch/i, `${sequence} step ${i + 1}`);
      assert.doesNotMatch(out.text, /campaign|apply/i, `${sequence} step ${i + 1}`);
    });
  }
  assert.equal(compose({ sequence: "creator_cold", variables }, 0).subject, "pitching beauty brands");
});

// ---- tracking: who joined after we wrote to them ----

test("a sign-up is matched to the person we wrote to, never to a namesake", async () => {
  const { matchSignup } = await import("../lib/direct-outreach.js");
  const sent = "2026-11-23T09:30:00Z";
  const user = (over) => ({ id: "u1", created: "2026-11-25T10:00:00Z", email: "x@y.com", handle: null, store_website: null, ...over });
  const creatorRow = { audience: "creator", to_email: "Anna@Gmail.com", handle: "@anna.makes", first_sent_at: sent, variables: {} };
  // Same address, or a different address with the same Instagram handle.
  assert.equal(matchSignup(creatorRow, [user({ email: "anna@gmail.com" })])?.id, "u1");
  assert.equal(matchSignup(creatorRow, [user({ email: "other@icloud.com", handle: "anna.makes" })])?.id, "u1");
  // Joined before we wrote: not ours to count.
  assert.equal(matchSignup(creatorRow, [user({ email: "anna@gmail.com", created: "2026-11-01T00:00:00Z" })]), null);
  assert.equal(matchSignup(creatorRow, [user({ email: "someone@gmail.com" })]), null);

  const brandRow = { audience: "brand", to_email: "hello@acme.co.uk", handle: "acme", first_sent_at: sent, variables: { companyDomain: "acme.co.uk" } };
  // The founder signs up with their own address; the store is what matches.
  assert.equal(matchSignup(brandRow, [user({ email: "jo@gmail.com", store_website: "https://www.acme.co.uk/" })])?.id, "u1");
  assert.equal(matchSignup(brandRow, [user({ email: "jo@gmail.com", store_website: "https://other.com" })]), null);
  // A brand we reached on a free address is never matched by that domain.
  const gmailBrand = { ...brandRow, to_email: "acmeshop@gmail.com", variables: {} };
  assert.equal(matchSignup(gmailBrand, [user({ email: "jo@x.com", store_website: "gmail.com" })]), null);
});

// ---- answering replies by itself ----

const answers = await import("../lib/outreach-answers.js");
const hour = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const replied = (text, over = {}) => ({
  ...creator, id: "row-1", subject: "your @glossier post", auto_answers: 0,
  thread: [{ step: 1, at: hour(20), message_id: "<a@linkable.link>" }],
  conversation: [{ from: "them", at: hour(0.1), subject: "Re: your @glossier post", text, message_id: "<theirs@mail>" }],
  ...over,
});
const model = (out, usage = { input_tokens: 1000, output_tokens: 100 }) => async () => ({ text: JSON.stringify(out), usage, stop_reason: "end_turn" });

test("the exchange is read in order: our email that has left, then theirs", () => {
  const said = answers.exchange(replied("Yes please"));
  assert.deepEqual(said.map((m) => m.from), ["us", "them"]);
  assert.match(said[0].text, /It lets you pitch any brand/);
  // An email of ours that is timed but has not left is not part of it yet.
  const early = answers.exchange(replied("Yes", { thread: [{ step: 1, at: new Date(Date.now() + 3600e3).toISOString() }] }));
  assert.deepEqual(early.map((m) => m.from), ["them"]);
});

test("an answer is sent only when it stays inside the facts", () => {
  const facts = "Starter: $99 per month. Every plan adds 2.5% of creator driven sales.";
  const ok = "Hi Anna,\n\nYes, it is free for ten pitches a month. You can start here: https://app.linkable.link";
  assert.equal(answers.answerProblem(ok, facts), "");
  assert.match(answers.answerProblem("Hi,\n\nIt costs $49 a month to start with, which is fair.", facts), /\$49, which the facts do not state/);
  assert.equal(answers.answerProblem("Hi,\n\nStarter is $99 a month, plus 2.5% of creator driven sales.", facts), "");
  assert.match(answers.answerProblem("Hi,\n\nWe take 10% of what you make from brands.", facts), /percentage/);
  assert.match(answers.answerProblem("Hi,\n\nHave a look at https://bit.ly/abc for the details.", facts), /not one of ours/);
  assert.match(answers.answerProblem("Hi,\n\nI'm a real person, promise. Here is the link.", facts), /a person wrote it/);
  assert.equal(answers.answerProblem("Hi,\n\nGreat to hear from you! Here is the link.", facts), "");
  assert.match(answers.answerProblem("Hi!\n\nGreat to hear from you! Here is the link.", facts), /exclamation/);
  assert.match(answers.answerProblem("Hi,\n\nYes it is free. Feel free to ask me anything else.", facts), /reads as a machine/);
  assert.match(answers.answerProblem("ok", facts), /empty/);
  // A brand's own list: its lines and links are allowed, and nothing else is.
  const list = ["@jo https://www.instagram.com/p/x1/", "@sam https://www.instagram.com/p/x2/"];
  const withList = `Hi Sam,\n\nHere it is.\n${list.join("\n")}\n\nYou can start free at https://app.linkable.link`;
  assert.equal(answers.answerProblem(withList, facts, list), "");
  assert.match(answers.answerProblem(withList, facts, []), /more than one link/);
});

test("the model's decision is taken, checked, and anything doubtful goes to a person", async () => {
  const yes = await answers.decide(replied("Yes please"), { ask: model({ intent: "interested", action: "answer", reply: "Hi Anna,\n\nHere it is: https://app.linkable.link, and it takes a few minutes.", reason: "asked for it" }) });
  assert.equal(yes.action, "answer");
  assert.equal(yes.intent, "interested");
  assert.ok(yes.cost > 0);
  const no = await answers.decide(replied("No thanks"), { ask: model({ intent: "not_interested", action: "no_answer", reply: "", reason: "declined" }) });
  assert.equal(no.action, "no_answer");
  // A reply that breaks a rule twice is not sent.
  const bad = await answers.decide(replied("How much?"), { ask: model({ intent: "question", action: "answer", reply: "Hi,\n\nIt is $7 a month for everything you need.", reason: "" }) });
  assert.equal(bad.action, "hand_over");
  assert.match(bad.reason, /refused twice/);
  // The model down, or declining: a person.
  const down = await answers.decide(replied("Hi"), { ask: async () => { throw new Error("529 overloaded"); } });
  assert.equal(down.action, "hand_over");
  const refused = await answers.decide(replied("Hi"), { ask: async () => ({ text: "", usage: {}, stop_reason: "refusal" }) });
  assert.equal(refused.action, "hand_over");
  // After three answers, the next message is a person's, and the model is not asked.
  let asked = 0;
  const capped = await answers.decide(replied("And another thing", { auto_answers: answers.MAX_AUTO_ANSWERS }), { ask: async () => { asked += 1; } });
  assert.equal(capped.action, "hand_over");
  assert.equal(asked, 0);
});

test("an answer leaves minutes later, in the daytime, under their message", () => {
  const day = answers.answerTime(new Date("2026-11-23T10:00:00Z"), () => 0.5);
  assert.equal(day.toISOString(), "2026-11-23T10:11:00.000Z");
  // Sometimes most of an hour, like someone who was away from their desk.
  assert.equal(answers.answerTime(new Date("2026-11-23T10:00:00Z"), () => 0.9).toISOString(), "2026-11-23T10:54:00.000Z");
  assert.equal(answers.answerTime(new Date("2026-11-23T23:30:00Z"), () => 0.5).toISOString(), "2026-11-24T08:20:00.000Z");
  assert.equal(answers.answerTime(new Date("2026-11-23T03:00:00Z"), () => 0).toISOString(), "2026-11-23T08:00:00.000Z");
  const msg = answers.answerMessage(replied("Yes"), "Hi Anna,\n\nHere it is.", day);
  assert.equal(msg.payload.subject, "Re: your @glossier post");
  assert.equal(msg.payload.from, "Luca from Linkable <influencer@linkable.link>");
  assert.equal(msg.payload.headers["In-Reply-To"], "<theirs@mail>");
  assert.equal(msg.payload.headers.References, "<a@linkable.link> <theirs@mail>");
  assert.equal(msg.payload.text, "Hi Anna,\n\nHere it is.\n\nLuca");
  assert.equal(msg.payload.scheduled_at, "2026-11-23T10:11:00.000Z");
});

test("answering replies is a team setting, off unless switched on", () => {
  assert.equal(settingProblem("reply_auto", true), null);
  assert.match(settingProblem("reply_auto", 1), /boolean/);
});

// ---- Italian and Spanish ----

test("a person in Italy or Spain gets every step in their language, on the same days", async () => {
  const { LOCAL_SEQUENCES, sequenceFor } = await import("../lib/direct-outreach.js");
  for (const lang of ["it", "es"]) {
    for (const [key, english] of Object.entries(SEQUENCES)) {
      const local = LOCAL_SEQUENCES[lang][key];
      assert.equal(local.audience, english.audience, `${lang} ${key}`);
      assert.deepEqual(local.steps.map((x) => x.afterDays), english.steps.map((x) => x.afterDays), `${lang} ${key} days`);
      // The same holes as the English, so the worker's values fill both.
      const holes = (seq) => seq.steps.map((x) => [...(x.subject || "").matchAll(/\{\{(\w+)\}\}/g), ...x.body.join(" ").matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort());
      assert.deepEqual(holes(local), holes(english), `${lang} ${key} holes`);
      const fixed = local.steps.flatMap((x) => x.body).filter((b) => !/^\{\{\w+\}\}$/.test(b)).join(" ").replace(/\{\{\w+\}\}|linkable\.link|https?:\/\/\S+|Linkable|Shopify|creator/g, "");
      assert.doesNotMatch(fixed, /\b(the|you|your|and|with|from)\b/i, `${lang} ${key} has English in it`);
    }
  }
  assert.equal(sequenceFor({ sequence: "creator", variables: { language: "it" } }), LOCAL_SEQUENCES.it.creator);
  assert.equal(sequenceFor({ sequence: "creator", variables: { language: "de" } }), SEQUENCES.creator);
  assert.equal(sequenceFor({ sequence: "creator", variables: {} }), SEQUENCES.creator);
});

test("an Italian creator's first email and follow-up read as written", () => {
  const row = { ...creator, variables: { ...creator.variables, language: "it", greeting: "Ciao Anna,", footer: "Non fa per te? Rispondi 'no grazie' e non ti scrivo più." } };
  const first = compose(row, 0);
  assert.equal(first.subject, "il tuo post su @glossier");
  assert.match(first.text, /^Ciao Anna,\n\nHo visto il tuo post su @glossier\.\nhttps:\/\/www\.instagram\.com\/p\/abc\/\n\nLavoro a Linkable\./);
  assert.match(first.text, /Dieci proposte al mese sono gratis\.\n\nTi mando il link\?\n\nLuca\nlinkable\.link\n\nNon fa per te\?/);
  assert.equal(compose({ ...row, subject: first.subject }, 1).subject, "Re: il tuo post su @glossier");
  // English is untouched.
  assert.equal(compose(creator, 0).subject, "your @glossier post");
});

test("the agent knows the website's own answers, and where an address came from", () => {
  const text = answers.known();
  assert.match(text, /A creator receives the whole commission and the whole fixed fee/);
  assert.match(text, /from their public Instagram profile/);
  assert.match(text, /Starter: \$99 per month/); // the blog's facts are still in it
  assert.equal(answers.answerProblem("Hi Anna,\n\nNo, we don't take a cut. You keep the whole commission, and the brand pays our 2.5% on top.", text), "");
});
