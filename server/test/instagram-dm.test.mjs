// The rules the Instagram DM writer enforces in code rather than trusting the
// model with. Pure functions, no network:
//   cd server && npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  brandNameFor, factSheet, finishDraft, languageFor, signature, withGreetingGap, CREATOR_CLAIM, MAX_DM_CHARS,
} from "../lib/instagram-dm-writer.js";
import { isDmOpen } from "../lib/instagram-dm-queue.js";

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

test("the fact sheet carries the call and the language, and no creator count", () => {
  const facts = factSheet(lead, { language: "it" });
  assert.match(facts, /looking for UGC creators/);
  assert.match(facts, /Write in: Italian/);
  assert.doesNotMatch(facts, /Creators on Linkable|all niches/);
  // The profile scraper's "None" is not a category.
  assert.doesNotMatch(facts, /Instagram category/);
});

test("a draft pitched as affiliate, or quoting another creator number, is refused", () => {
  const ok = finishDraft(`Hey Wildmoor!\nJust came across your post looking for UGC creators.\nWe have ${CREATOR_CLAIM} creators on Linkable who can apply to collaborate with Wildmoor.\n\nBrands typically start receiving creator applications within 24 hours.`, lead);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(finishDraft("Ciao Wildmoor! Abbiamo 10.000+ creator su Linkable.", lead).problems, []);

  const commission = finishDraft(`We have ${CREATOR_CLAIM} creators who promote them on a commission basis.`, lead);
  assert.ok(commission.problems.some((p) => p.startsWith("pitched it as affiliate")));
  const other = finishDraft("We have 600+ beauty creators on Linkable.", lead);
  assert.ok(other.problems.some((p) => p.includes("600+")));
  // A number that is part of the brand's own name is not a claim.
  assert.deepEqual(finishDraft("Hey Studio 54!", { ...lead, brand_name: "Studio 54" }).problems, []);
  assert.deepEqual(finishDraft("You make 9ct gold jewellery.", { ...lead, ig_biography: "Sterling Silver, 9ct Gold" }).problems, []);
});

test("a signature the model wrote is removed; the real one is added by code", () => {
  const { message } = finishDraft("Hey Wildmoor!\n\nWould you be open to giving it a try?\n\nFederico\nFounder @ Linkable", lead);
  assert.equal(message, "Hey Wildmoor!\n\nWould you be open to giving it a try?");
  assert.equal(signature(), "Federico\nFounder @ Linkable");
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

test("the brand's vertical reaches the prompt", () => {
  const facts = factSheet({ ...lead, vertical: "BEAUTY_SKINCARE" }, { language: "en" });
  assert.match(facts, /Their vertical: Beauty & skincare/);
  assert.doesNotMatch(factSheet({ ...lead, vertical: "NOT_REAL" }, { language: "en" }), /Their vertical/);
});

test("a creator call over two weeks old is left out of the facts", () => {
  const old = { ...lead, intent_posted_at: new Date(Date.now() - 20 * 86_400_000).toISOString() };
  assert.doesNotMatch(factSheet(old, { language: "en" }), /looking for UGC creators/);
  const fresh = { ...lead, intent_posted_at: new Date(Date.now() - 3 * 86_400_000).toISOString() };
  assert.match(factSheet(fresh, { language: "en" }), /looking for UGC creators/);
});

test("the DM queue drops a brand whose creator call is over two weeks old", () => {
  const open = { ...lead, tier: "A", dm_state: "none" };
  const opts = { nonShopify: false };
  const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();
  assert.equal(isDmOpen({ ...open, intent_posted_at: daysAgo(2) }, opts), true);
  assert.equal(isDmOpen({ ...open, intent_posted_at: daysAgo(20) }, opts), false);
  // Found another way, with no dated call: still in the queue.
  assert.equal(isDmOpen({ ...open, intent_posted_at: null }, opts), true);
});

test("the greeting gets a blank line under it, once", () => {
  const body = "Hey Boutique England!\nJust came across your post looking for new content creators.\nWe have 10,000+ creators.";
  assert.equal(withGreetingGap(body),
    "Hey Boutique England!\n\nJust came across your post looking for new content creators.\nWe have 10,000+ creators.");
  // Already spaced, or spaced too much: exactly one blank line.
  assert.equal(withGreetingGap("Hey X!\n\nBody."), "Hey X!\n\nBody.");
  assert.equal(withGreetingGap("Hey X!\n\n\nBody."), "Hey X!\n\nBody.");
  // Nothing after the greeting: left alone.
  assert.equal(withGreetingGap("Hey X!"), "Hey X!");
});
