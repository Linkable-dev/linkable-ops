// The Instagram DM loop's pure parts: Meta's webhook, matching a signup to a
// DMed brand, and the message variants. No network, no database:
//   cd server && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { validSignature, messagesIn, webhookSecrets } from "../routes/instagram-webhook.js";
import { matchSignup, bareDomain } from "../lib/dm-conversions.js";
import { fingerprint, pickToken, refreshDue, tokenProblem } from "../lib/instagram-graph.js";
import { DM_VARIANT } from "../lib/instagram-dm-writer.js";

test("a webhook body is accepted only with the app secret's signature", () => {
  const body = Buffer.from(JSON.stringify({ object: "instagram" }));
  const sig = "sha256=" + crypto.createHmac("sha256", "s3cret").update(body).digest("hex");
  assert.equal(validSignature(body, sig, "s3cret"), true);
  assert.equal(validSignature(body, sig, "other"), false);
  assert.equal(validSignature(body, "sha256=00", "s3cret"), false);
  assert.equal(validSignature(body, undefined, "s3cret"), false);
  assert.equal(validSignature(body, sig, undefined), false, "no secret configured: nothing is trusted");
});

test("a brand's message is 'in'; an echo of ours is 'out' and names the brand as recipient", () => {
  const events = messagesIn({
    object: "instagram",
    entry: [{
      id: "OUR_ID",
      messaging: [
        { sender: { id: "BRAND_1" }, recipient: { id: "OUR_ID" }, timestamp: 1790000000000,
          message: { mid: "m1", text: "Yes, tell me more" } },
        { sender: { id: "OUR_ID" }, recipient: { id: "BRAND_2" }, timestamp: 1790000001000,
          message: { mid: "m2", text: "Hey Brand!", is_echo: true } },
        { sender: { id: "BRAND_3" }, recipient: { id: "OUR_ID" }, timestamp: 1790000002000,
          message: { mid: "m3", is_deleted: true } },
        { sender: { id: "BRAND_4" }, recipient: { id: "OUR_ID" }, read: { mid: "m1" } },
      ],
    }],
  });
  assert.deepEqual(events.map((e) => [e.igsid, e.direction, e.text]), [
    ["BRAND_1", "in", "Yes, tell me more"],
    ["BRAND_2", "out", "Hey Brand!"],
  ]);
});

test("a signup is matched by the store address first, then the domain, then the email", () => {
  const lead = { myshopify_domain: "wildmoor.myshopify.com", domain: "wildmoor.co.uk", contact_email: "Hi@Wildmoor.co.uk" };
  assert.equal(matchSignup(lead, [{ shopify_shop: "wildmoor.myshopify.com" }]).how, "shopify store");
  assert.equal(matchSignup(lead, [{ store_website: "https://www.wildmoor.co.uk/" }]).how, "domain");
  assert.equal(matchSignup(lead, [{ email: "hi@wildmoor.co.uk" }]).how, "email");
  assert.equal(matchSignup(lead, [{ shopify_shop: "other.myshopify.com", email: "x@y.z" }]), null);
  assert.equal(matchSignup({}, [{ email: "" }]), null, "a lead with nothing to match matches nothing");
  assert.equal(bareDomain("HTTPS://www.Shop.com/products"), "shop.com");
});

test("every first message is Federico's format, variant A", () => {
  assert.equal(DM_VARIANT, "A");
});

test("both Meta secrets are trusted, blanks are not", () => {
  assert.deepEqual(webhookSecrets({ META_APP_SECRET: " a \n", IG_APP_SECRET: "b" }), ["a", "b"]);
  assert.deepEqual(webhookSecrets({ IG_APP_SECRET: "b" }), ["b"]);
  assert.deepEqual(webhookSecrets({ META_APP_SECRET: "  " }), []);
});

test("the dashboard's Test payload is read like a live message", () => {
  const body = { object: "instagram", entry: [{ id: "0", time: 1, changes: [{ field: "messages", value: {
    sender: { id: "12334" }, recipient: { id: "23245" }, timestamp: "1527459824",
    message: { mid: "random_mid", text: "random_text" } } }] }] };
  const [m] = messagesIn(body);
  assert.equal(m.igsid, "12334");
  assert.equal(m.direction, "in");
  assert.equal(m.text, "random_text");
});

test("the stored token counts only while it grew from the token in Vercel", () => {
  const stored = { token: "renewed", from: fingerprint("env-a") };
  assert.equal(pickToken(stored, "env-a"), "renewed");
  assert.equal(pickToken(stored, "env-b"), "env-b", "a newly pasted token wins");
  assert.equal(pickToken(null, "env-a"), "env-a");
  assert.equal(pickToken({ from: fingerprint("env-a"), error: "x" }, "env-a"), "env-a", "a failed first renewal has no token");
});

test("the token is renewed weekly, and at once for a new Vercel token", () => {
  const now = Date.parse("2026-10-10T09:30:00Z");
  const base = { token: "t", from: fingerprint("env") };
  assert.equal(refreshDue(null, "env", now), true);
  assert.equal(refreshDue({ ...base, refreshed_at: "2026-10-06T09:30:00Z" }, "env", now), false);
  assert.equal(refreshDue({ ...base, refreshed_at: "2026-10-02T09:30:00Z" }, "env", now), true);
  assert.equal(refreshDue({ ...base, refreshed_at: "2026-10-09T09:30:00Z" }, "other", now), true);
});

test("the brief speaks up only when the token needs a person", () => {
  const now = Date.parse("2026-10-10T09:30:00Z");
  assert.equal(tokenProblem(null, now), null);
  assert.equal(tokenProblem({ expires_at: "2026-11-30T00:00:00Z" }, now), null);
  assert.match(tokenProblem({ expires_at: "2026-10-15T00:00:00Z" }, now), /expires in 4 days/);
  assert.equal(tokenProblem({ error: "too young", failing_since: "2026-10-09T09:30:00Z" }, now), null, "one failed morning is not news");
  assert.match(tokenProblem({ error: "bad", failing_since: "2026-10-05T09:30:00Z" }, now), /cannot be renewed \(bad\)/);
});
