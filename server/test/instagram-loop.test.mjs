// The Instagram DM loop's pure parts: Meta's webhook, matching a signup to a
// DMed brand, and the message variants. No network, no database:
//   cd server && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { validSignature, messagesIn, webhookSecrets } from "../routes/instagram-webhook.js";
import { matchSignup, bareDomain } from "../lib/dm-conversions.js";
import { VARIANTS, pickVariant } from "../lib/instagram-dm-writer.js";

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

test("first messages are split between two variants; A is Federico's format unchanged", () => {
  assert.equal(VARIANTS.A, "");
  assert.match(VARIANTS.B, /three short lines/);
  const seen = new Set(Array.from({ length: 200 }, pickVariant));
  assert.deepEqual([...seen].sort(), ["A", "B"]);
});

test("both Meta secrets are trusted, blanks are not", () => {
  assert.deepEqual(webhookSecrets({ META_APP_SECRET: " a \n", IG_APP_SECRET: "b" }), ["a", "b"]);
  assert.deepEqual(webhookSecrets({ IG_APP_SECRET: "b" }), ["b"]);
  assert.deepEqual(webhookSecrets({ META_APP_SECRET: "  " }), []);
});
