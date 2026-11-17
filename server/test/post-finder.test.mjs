import { test } from "node:test";
import assert from "node:assert/strict";
import { findPost, matchScore, brandWebsite } from "../lib/postFinder.js";
import { findPostFromScreenshot, readOneScreenshot, formLinkIn, addCallFromPhone } from "../lib/callInbox.js";

// Batch mode: a screenshot's caption opening finds the post, never a guess.

test("the caption's opening matches through emoji, fancy letters, curly quotes and '... more'", () => {
  assert.equal(matchScore("CALLING ALL CONTENT CREATORS! Do you love capturing beautiful places... more",
    "📸 CALLING ALL CONTENT CREATORS! 🎥✨\n\nDo you love capturing beautiful places, creating inspiring content"), 1);
  assert.ok(matchScore("we're looking for ugc girlies open to gifted", "we’re looking for ugc girlies open to gifted collaborations 🤍") >= 0.9);
  assert.ok(matchScore("𝗦𝗠𝗔𝗟𝗟 𝗕𝗥𝗔𝗡𝗗, 𝗕𝗜𝗚 𝗗𝗥𝗘𝗔𝗠𝗦", "SMALL BRAND, BIG DREAMS. SEND THIS REEL TO US") >= 0.75);
  assert.ok(matchScore("Autumn in New York, where the city slows", "CALLING ALL CONTENT CREATORS! Do you love") < 0.3);
  assert.equal(matchScore("Hi", "Hi there"), 0, "too little to go on");
});

test("only a brand's own site counts as its website", () => {
  assert.equal(brandWebsite("https://www.archive47.co.uk/shop"), "archive47.co.uk");
  assert.equal(brandWebsite("https://linktr.ee/brand"), "");
  assert.equal(brandWebsite("https://www.etsy.com/shop/x"), "");
  assert.equal(brandWebsite("not a link"), "");
});

const grid = [
  { shortCode: "AAA111", type: "Image", caption: "Autumn in New York", timestamp: "2026-11-16T10:00:00Z" },
  { shortCode: "BBB222", type: "Sidecar", caption: "📸 CALLING ALL CONTENT CREATORS! Do you love hidden gems?", timestamp: "2026-11-11T10:00:00Z" },
];

test("found on the profile's grid: one Apify run, the post's own link and full caption", async () => {
  const runs = [];
  const runActor = async (actor, input) => {
    runs.push([actor, input]);
    return [{ username: "headlands_farm", fullName: "Headlands Farm", externalUrl: "https://headlandsfarm.co.uk/", latestPosts: grid }];
  };
  const out = await findPost({ handle: "@Headlands_Farm", seen: "CALLING ALL CONTENT CREATORS! Do you love... more" }, { token: "t", runActor });
  assert.equal(out.post_url, "https://www.instagram.com/p/BBB222/");
  assert.match(out.caption, /hidden gems/);
  assert.equal(out.website, "headlandsfarm.co.uk");
  assert.deepEqual(runs.map((r) => r[0]), ["apify~instagram-profile-scraper"]);
  assert.deepEqual(runs[0][1], { usernames: ["headlands_farm"] });
});

test("not on the grid: the account's reels, its own only; nothing matching is no link", async () => {
  const runActor = async (actor) => actor.includes("profile")
    ? [{ externalUrl: "https://linktr.ee/x", latestPosts: grid }]
    : [
      { shortCode: "COL999", ownerUsername: "someone_else", caption: "we're looking for ugc girlies open to gifted collabs" },
      { shortCode: "REL333", ownerUsername: "jesperswim", caption: "we’re looking for ugc girlies open to gifted collaborations" },
    ];
  const out = await findPost({ handle: "jesperswim", seen: "we're looking for ugc girlies open to gifted" }, { token: "t", runActor });
  assert.equal(out.post_url, "https://www.instagram.com/reel/REL333/");
  assert.equal(out.website, "");
  const miss = await findPost({ handle: "jesperswim", seen: "Black Friday starts now get 15% off" }, { token: "t", runActor });
  assert.equal(miss.post_url, "");
});

test("no handle or no caption: nothing is looked up", async () => {
  let ran = false;
  const runActor = async () => { ran = true; return []; };
  assert.equal((await findPost({ handle: "", seen: "We are looking for creators" }, { token: "t", runActor })).post_url, "");
  assert.equal((await findPost({ handle: "brand", seen: "👀" }, { token: "t", runActor })).post_url, "");
  assert.equal(ran, false);
});

test("the steps answer in sentences", async () => {
  await assert.rejects(readOneScreenshot({ images: [] }), /screenshot/);
  await assert.rejects(readOneScreenshot({ images: [{ media_type: "image/jpeg", data: "aGk=" }] }, { read: async () => { throw new Error("boom"); } }), /couldn't read/);
  await assert.rejects(findPostFromScreenshot({ handle: "" }), /handle/);
  await assert.rejects(findPostFromScreenshot({ handle: "x", caption: "hi there" }, { find: async () => { throw new Error("402"); } }), /Paste its link/);
});

test("a form link in the post's full caption sends it to Campaigns from calls", async () => {
  assert.equal(formLinkIn("Apply here: https://forms.gle/AbC123 ✨"), "https://forms.gle/AbC123");
  assert.equal(formLinkIn("DM us"), "");
  const seen = [];
  const deps = {
    calls: { add: async (o) => { seen.push(["call", o.formUrl, o.ownerHandle]); return { id: "c1", status: "reading" }; } },
    signals: { draft: async (o) => { seen.push(["signal", o.website, o.brand_name]); return { id: "s1", status: "draft" }; } },
  };
  const admin = { email: "calls-test@example.com" };
  const a = await addCallFromPhone({ post_url: "https://www.instagram.com/p/X1/", caption: "Apply https://forms.gle/AbC123", instagram: "kora" }, { admin }, "prod", deps);
  assert.equal(a.kind, "campaign");
  const b = await addCallFromPhone({ post_url: "https://www.instagram.com/reel/X2/", caption: "Send us this reel", instagram: "kora",
    website: "kora.co", brand_name: "KŌRA" }, { admin }, "prod", deps);
  assert.equal(b.kind, "signal");
  assert.deepEqual(seen, [["call", "https://forms.gle/AbC123", "kora"], ["signal", "kora.co", "KŌRA"]]);
});
