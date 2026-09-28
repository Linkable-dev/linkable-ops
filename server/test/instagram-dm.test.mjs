// The rules the Instagram DM writer enforces in code rather than trusting the
// model with. Pure functions, no network:
//   cd server && npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  brandNameFor, factSheet, finishDraft, languageFor, MAX_DM_CHARS,
} from "../lib/instagram-dm-writer.js";

const lead = {
  handle: "wildmoor",
  brand_name: "wildmoor skincare",
  country: "GB",
  domain: "wildmoor.co.uk",
  intent_signal: "open_call",
  intent_caption: "We're looking for UGC creators for our autumn launch!",
  top_creators: "@annaglow, @skinbyjo",
  distinct_creators_90d: 4,
  affiliate_app: "none",
  ig_category: "None",
};

test("a link is refused, a handle ending in a TLD is not a link", () => {
  const linked = finishDraft("Saw your call for creators. More at https://linkable.link/brands", lead);
  assert.ok(linked.problems.some((p) => p.startsWith("wrote a link")));
  const bare = finishDraft("Have a look at linkable.link when you can.", lead);
  assert.ok(bare.problems.some((p) => p.startsWith("wrote a link")));

  const handle = finishDraft("@skinbyjo.shop already posts about you. Worth a look?",
                             { ...lead, top_creators: "@skinbyjo.shop" });
  assert.deepEqual(handle.problems, []);
});

test("a handle it was not given is refused", () => {
  const { problems } = finishDraft("@madeupcreator loves your serum. Want to see how it works?", lead);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /madeupcreator/);
});

test("the brand's own handle and the creators it was given are allowed", () => {
  const { problems } = finishDraft("Hi @wildmoor, @annaglow posted about you last week.", lead);
  assert.deepEqual(problems, []);
});

test("an overlong message is refused rather than trimmed mid-sentence", () => {
  const { problems } = finishDraft("word ".repeat(MAX_DM_CHARS), lead);
  assert.ok(problems.some((p) => p.startsWith("too long")));
});

test("Italian brands are written to in Italian, everyone else in English", () => {
  assert.equal(languageFor({ country: "IT" }), "it");
  assert.equal(languageFor({ country: "it" }), "it");
  assert.equal(languageFor({ country: "GB" }), "en");
  assert.equal(languageFor({}), "en");
});

test("the fact sheet carries the call, the creators and the language", () => {
  const facts = factSheet(lead, { language: "it" });
  assert.match(facts, /looking for UGC creators/);
  assert.match(facts, /@annaglow, @skinbyjo/);
  assert.match(facts, /Write in: Italian/);
  // The profile scraper's "None" is not a category.
  assert.doesNotMatch(facts, /Instagram category/);
  assert.match(facts, /Do not invent a name/);
});

test("a brand with an affiliate app is never told it has no tracking", () => {
  const facts = factSheet({ ...lead, affiliate_app: "uppromote" }, { language: "en" });
  assert.match(facts, /already run an affiliate app \(uppromote\)/);
});

test("a lower-case store name is title-cased, a shouted one is left alone", () => {
  assert.equal(brandNameFor(lead), "Wildmoor Skincare");
  assert.equal(brandNameFor({ handle: "promixx", brand_name: "PROMIXX" }), "PROMIXX");
});
