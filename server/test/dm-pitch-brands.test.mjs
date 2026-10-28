// DM sent → a brand creators can pitch (main app QA 145). No database: the
// query is passed in.
//   cd server && npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import { dmPitchStore, dmPitchRequest, queueDmBrandForPitch, DM_PITCH_TARGET } from "../lib/dm-pitch-brands.js";

const lead = {
  id: 3047, handle: "WonderAndWise", brand_name: "Wonder and Wise", domain: "https://www.WonderAndWise.com/collections/all",
  myshopify_domain: "wonder-and-wise.myshopify.com", contact_email: "Hello@WonderAndWise.com", country: "us",
  vertical_effective: "BABY_PARENTING", ig_biography: "Heirloom toys for little ones.", is_agency: false,
};

test("the request names the store, the lead and what the lead knows", () => {
  const { params, skip } = dmPitchRequest(lead, "Fede");
  assert.equal(skip, undefined);
  assert.deepEqual(params, [
    "DM sent by Fede", "wonderandwise.com", "hello@wonderandwise.com", "BABY_PARENTING", "instagram_dm", 3047,
    "wonderandwise", "Heirloom toys for little ones.", "US",
  ]);
  assert.equal(dmPitchStore({ myshopify_domain: "wonder-and-wise.myshopify.com" }), "wonder-and-wise.myshopify.com");
  assert.equal(DM_PITCH_TARGET, "prod");
});

test("nothing is sent for a lead with no store or one that isn't a brand", async () => {
  const query = async () => { assert.fail("reached SQL"); };
  for (const l of [{ ...lead, domain: "", myshopify_domain: null }, { ...lead, is_agency: true }]) {
    const out = await queueDmBrandForPitch(l, "Fede", { query });
    assert.equal(out.status, "skipped");
    assert.ok(!out.message.includes(":"), out.message);
  }
});

test("queued once; a second press is already there", async () => {
  const seen = [];
  let first = true;
  const query = async (sql, params) => {
    seen.push({ sql, params });
    const rows = first ? [{ id: "r1" }] : [];
    first = false;
    return { rows };
  };
  assert.equal((await queueDmBrandForPitch(lead, "Fede", { query })).status, "queued");
  assert.equal((await queueDmBrandForPitch(lead, "Fede", { query })).status, "already");
  assert.match(seen[0].sql, /INSERT INTO pitch_brand_requests/);
  assert.match(seen[0].sql, /'dm_pending'\)/);
  assert.match(seen[0].sql, /ON CONFLICT \(prospector_lead_id\) WHERE source = 'instagram_dm' AND status <> 'failed' DO NOTHING/);
});

test("a database that can't take it yet never fails the send", async () => {
  for (const code of ["42703", "08006"]) {
    const out = await queueDmBrandForPitch(lead, "Fede", {
      query: async () => { throw Object.assign(new Error("boom"), { code }); },
    });
    assert.equal(out.status, "failed");
    assert.ok(out.message.startsWith("Not added to Pitch") && !out.message.includes(":"), out.message);
  }
});

test("a database that doesn't answer is given up on, not waited for", async () => {
  const out = await queueDmBrandForPitch(lead, "Fede", { query: () => new Promise(() => {}), timeoutMs: 20 });
  assert.equal(out.status, "failed");
});
