import { test } from "node:test";
import assert from "node:assert/strict";
import { balanceVerdict, computeBalance, openCategories, refreshBalance, ENOUGH_CREATORS } from "../lib/gtm-balance.js";
import { settingProblem } from "../lib/instagram-dm-queue.js";

// The balance decides where automatic first contact goes. Brands while
// creators are plentiful; it pauses once most live campaigns run short.

test("plenty of creators and few campaigns: brands are the short side", () => {
  const v = balanceVerdict({ creators: 1128, campaigns: 9, settled: 9, short: 2 });
  assert.equal(v.short_side, "brands");
  assert.match(v.line, /1,128 creators for 9 live campaigns/);
});

test("most live campaigns short of creators: creators are the short side", () => {
  const v = balanceVerdict({ creators: 40, campaigns: 10, settled: 8, short: 5 });
  assert.equal(v.short_side, "creators");
  assert.match(v.line, new RegExp(`5 of 8 live campaigns have fewer than ${ENOUGH_CREATORS} creators`));
});

test("a campaign younger than three days is not judged, and no campaign at all means brands", () => {
  assert.equal(balanceVerdict({ creators: 10, campaigns: 3, settled: 0, short: 0 }).short_side, "brands");
  assert.match(balanceVerdict({ creators: 10 }).line, /no live campaign/);
});

test("the numbers always come from production, and are stored for the worker", async () => {
  const seen = [];
  const query = async (_sql, params, target) => {
    seen.push([params, target]);
    return { rows: [{ creators: 1128, campaigns: 9, settled: 9, short: 1, waiting: 397, niches: [{ niche: "BEAUTY_SKINCARE", creators: 400, campaigns: 4, short: 0, waiting: 120 }] }] };
  };
  const b = await computeBalance({ query });
  assert.deepEqual(seen, [[[ENOUGH_CREATORS], "prod"]]);
  assert.equal(b.short_side, "brands");
  assert.equal(b.waiting, 397);

  const stored = [];
  const supabase = { from: (table) => ({ upsert: async (row, opts) => { stored.push([table, row.key, row.value.short_side, opts.onConflict]); return { error: null }; } }) };
  const out = await refreshBalance({ query, supabase });
  assert.equal(out.stored, true);
  assert.deepEqual(stored, [["prospector_settings", "gtm_balance", "brands", "key"]]);
});

test("the switch is a yes or no and the daily number has a ceiling", () => {
  assert.equal(settingProblem("email_auto_send", true), null);
  assert.match(settingProblem("email_auto_send", "true"), /must be a boolean/);
  assert.equal(settingProblem("email_auto_send_daily_cap", 20), null);
  assert.equal(settingProblem("email_auto_send_daily_cap", 0), null);
  for (const bad of [-1, 101, 2.5, "20"]) assert.match(settingProblem("email_auto_send_daily_cap", bad), /whole number from 0 to 100/);
  assert.equal(settingProblem("creator_auto_send", true), null);
  assert.match(settingProblem("creator_auto_send_daily_cap", 500), /whole number from 0 to 100/);
  assert.equal(settingProblem("creator_campaign", "cam_iGwk5mnHWRgdTDnB5"), null);
  assert.equal(settingProblem("creator_campaign", ""), null);
  assert.match(settingProblem("email_campaign_tier_a", "Brand Outreach"), /not a Lemlist campaign id/);
});

test("the categories to reach first: creators waiting, no live campaign", () => {
  const open = openCategories([
    { niche: "FASHION_ACCESSORIES", label: "Fashion & accessories", creators: 400, campaigns: 6 },
    { niche: "BEAUTY_SKINCARE", label: "Beauty & skincare", creators: 287, campaigns: 0 },
    { niche: "TRAVEL", label: "Travel", creators: 12, campaigns: 0 },
    { niche: "HOME_LIVING", label: "Home & living", creators: 156, campaigns: 0 },
  ]);
  assert.deepEqual(open.map((n) => [n.label, n.creators]), [["Beauty & skincare", 287], ["Home & living", 156]]);
});
