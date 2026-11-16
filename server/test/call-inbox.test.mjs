import { test } from "node:test";
import assert from "node:assert/strict";
import { addCallFromPhone, cleanPostUrl, readCallScreenshots } from "../lib/callInbox.js";

// Add calls from the phone: the link decides nothing, the form does.

const admin = { email: "calls-test@example.com" };
const IMG = { media_type: "image/jpeg", data: "aGVsbG8=" };

function fakes(facts) {
  const seen = [];
  return {
    seen,
    deps: {
      read: async (images) => { seen.push(["read", images.length]); return facts; },
      calls: { add: async (o, target) => { seen.push(["call", o.postUrl, o.formUrl, o.caption, o.ownerHandle, o.admin.email, target]); return { id: "c1", status: "reading" }; } },
      signals: { draft: async (o, { admin: a }, target) => { seen.push(["signal", o, a.email, target]); return { id: "s1", status: "draft" }; } },
    },
  };
}

const none = { is_creator_call: true, handle: "", brand_name: "", caption: "", google_form_url: "", website: "", contact_email: "" };

test("Instagram's Copy link is cleaned; anything else is refused with a sentence", async () => {
  assert.equal(cleanPostUrl("https://www.instagram.com/p/DQx9_ab-1/?igsh=MTZ4"), "https://www.instagram.com/p/DQx9_ab-1/");
  assert.equal(cleanPostUrl("https://instagram.com/reel/ABC123?utm_source=ig"), "https://instagram.com/reel/ABC123/");
  assert.equal(cleanPostUrl("https://www.instagram.com/kora.matcha/"), "");
  const { deps } = fakes(none);
  await assert.rejects(addCallFromPhone({ post_url: "kora.matcha" }, { admin }, "prod", deps), /Copy link/);
});

test("a screenshot with a Google Form goes to Campaigns from calls", async () => {
  const { deps, seen } = fakes({ ...none, handle: "kora.matcha", caption: "We're looking for creators!", google_form_url: "https://forms.gle/abc" });
  const out = await addCallFromPhone({ post_url: "https://www.instagram.com/p/X1/?igsh=1", images: [IMG] }, { admin }, "prod", deps);
  assert.equal(out.kind, "campaign");
  assert.deepEqual(seen[1], ["call", "https://www.instagram.com/p/X1/", "https://forms.gle/abc", "We're looking for creators!", "kora.matcha", admin.email, "prod"]);
});

test("no form: a Pitch signal draft with what the screenshot showed; typed fields win", async () => {
  const { deps, seen } = fakes({ ...none, handle: "kora.matcha", brand_name: "KŌRA", caption: "DM us", website: "kora.co", contact_email: "hi@kora.co" });
  const out = await addCallFromPhone({ post_url: "https://www.instagram.com/p/X2/", images: [IMG], caption: "typed caption" }, { admin }, "dev", deps);
  assert.equal(out.kind, "signal");
  assert.deepEqual(seen[1], ["signal", {
    post_url: "https://www.instagram.com/p/X2/", caption: "typed caption", instagram: "kora.matcha", brand_name: "KŌRA",
    website: "kora.co", contact_email: "hi@kora.co",
  }, admin.email, "dev"]);
});

test("a link alone is added without a read; the main app fills what its agent saw", async () => {
  const { deps, seen } = fakes(none);
  const out = await addCallFromPhone({ post_url: "https://www.instagram.com/p/X3/" }, { admin }, "prod", deps);
  assert.equal(out.kind, "signal");
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], "signal");
});

test("too many or wrong screenshots, a bad form link and a failed read are plain sentences", async () => {
  const { deps } = fakes(none);
  const post = "https://www.instagram.com/p/X4/";
  await assert.rejects(addCallFromPhone({ post_url: post, images: [IMG, IMG, IMG, IMG, IMG] }, { admin }, "prod", deps), /up to 4/);
  await assert.rejects(addCallFromPhone({ post_url: post, images: [{ media_type: "application/pdf", data: "x" }] }, { admin }, "prod", deps), /photos/);
  await assert.rejects(addCallFromPhone({ post_url: post, form_url: "https://example.com/form" }, { admin }, "prod", deps), /Google Form link/);
  const broken = { ...deps, read: async () => { throw new Error("Claude API 529"); } };
  await assert.rejects(addCallFromPhone({ post_url: post, images: [IMG] }, { admin }, "prod", broken), (e) => e.status === 502 && /couldn't read/.test(e.message));
});

test("the reader asks Haiku once, thinking off, with a forced tool, and keeps only real links", async () => {
  let asked;
  const facts = await readCallScreenshots([IMG], {
    ask: async (req) => {
      asked = req;
      return { usage: {}, toolCalls: [{ name: "call_facts", input: {
        is_creator_call: true, handle: "@kora.matcha", brand_name: "KŌRA", caption: "Apply below",
        google_form_url: "https://kora.co/apply", website: "kora.co", contact_email: "not an email",
      } }] };
    },
  });
  assert.deepEqual(asked.thinking, { type: "disabled" });
  assert.equal(asked.toolChoice.name, "call_facts");
  assert.equal(asked.temperature, null);
  assert.equal(facts.handle, "kora.matcha");
  assert.equal(facts.google_form_url, "");
  assert.equal(facts.contact_email, "");
});
