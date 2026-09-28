// The rules the Instagram DM writer enforces in code rather than trusting the
// model with. Pure functions, no network:
//   cd server && npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  brandNameFor, factSheet, finishDraft, languageFor, signature, MAX_DM_CHARS,
} from "../lib/instagram-dm-writer.js";
import { roundDown, summarisePool } from "../lib/creator-pool.js";

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

test("the fact sheet carries the call, the live creator count and the language", () => {
  const pool = { total: 600, niches: [{ label: "fashion and accessories", count: 150 }] };
  const facts = factSheet(lead, { language: "it", pool });
  assert.match(facts, /looking for UGC creators/);
  assert.match(facts, /- all niches: 600\+/);
  assert.match(facts, /- fashion and accessories: 150\+/);
  assert.match(facts, /Write in: Italian/);
  // The profile scraper's "None" is not a category.
  assert.doesNotMatch(facts, /Instagram category/);
});

test("with no creator count, the DM is told to state no number", () => {
  assert.match(factSheet(lead, { language: "en", pool: null }), /Do not state any number of creators/);
});

test("a signature the model wrote is removed; the real one is added by code", () => {
  const { message } = finishDraft("Hey Wildmoor!\n\nWould you be open to giving it a try?\n\nFederico\nFounder @ Linkable", lead);
  assert.equal(message, "Hey Wildmoor!\n\nWould you be open to giving it a try?");
  assert.equal(signature(), "Federico\nFounder @ Linkable");
});

test("creator counts are rounded down, and small niches are not quoted by name", () => {
  assert.equal(roundDown(628), 600);
  assert.equal(roundDown(166), 150);
  assert.equal(roundDown(104), 100);
  assert.equal(roundDown(1234), 1000);
  const pool = summarisePool([
    { niche: "FASHION_ACCESSORIES", n: 166 },
    { niche: "HEALTH_WELLNESS", n: 104 },
    { niche: "BEAUTY_SKINCARE", n: 20 },
    { niche: "BEAUTY_SKINCARE | HEALTH_WELLNESS", n: 1 },
    { niche: "SOMETHING_NEW", n: 500 },
  ], 628);
  assert.equal(pool.total, 600);
  assert.deepEqual(pool.niches, [
    { label: "fashion and accessories", count: 150 },
    { label: "health and wellness", count: 100 },
  ]);
});

test("a lower-case store name is title-cased, a shouted one is left alone", () => {
  assert.equal(brandNameFor(lead), "Wildmoor Skincare");
  assert.equal(brandNameFor({ handle: "promixx", brand_name: "PROMIXX" }), "PROMIXX");
});

test("a brand not on Shopify is never pitched the Shopify integration", () => {
  const facts = factSheet({ ...lead, status: "not_shopify", domain: "wildmoor.com" }, { language: "en" });
  assert.match(facts, /is NOT on Shopify/);
  assert.doesNotMatch(facts, /a Shopify store/);
  assert.doesNotMatch(facts, /affiliate/);
});

test("with no country, the language comes from what the brand wrote", () => {
  assert.equal(languageFor({ intent_caption: "Cerchiamo creator per la nostra nuova collezione, scrivici!" }), "it");
  assert.equal(languageFor({ intent_caption: "We're looking for creators for our new collection" }), "en");
  // A country, when there is one, wins over the words.
  assert.equal(languageFor({ country: "GB", intent_caption: "Cerchiamo creator per la nostra nuova collezione" }), "en");
});
