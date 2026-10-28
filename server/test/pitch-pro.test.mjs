import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { pitchRoutes, PLAN_STATES, PLAN_KINDS } from "../routes/pitch.js";
import {
  planStatus, planPrice, planNext, stripeLinks, money,
  PLAN_STATE_OPTIONS, PLAN_KIND_OPTIONS,
} from "../../src/components/pitch/pitchLabels.js";

// Pitch Pro in ops: who pays (creator_plans, one line per creator).

async function serve(t, query, dbTarget = "dev") {
  const app = express();
  app.use((req, _res, next) => { req.dbTarget = dbTarget; next(); });
  app.use(pitchRoutes({ query, sign: async (keys) => keys.map(() => null) }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return async (path) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: response.status, body: await response.json() };
  };
}

test("the plan list is one line per creator, paged, and binds every filter", async (t) => {
  const seen = [];
  const request = await serve(t, async (sql, params) => {
    seen.push({ sql, params });
    return /count\(\*\)::int AS n/.test(sql) ? { rows: [{ n: 7 }] } : { rows: [{ user_id: "u1", profile_pic_name: "", instagram_profile_image: "" }] };
  });
  const r = await request("/plans?limit=10&offset=20&sortBy=next&sortDir=asc&filter[creator]=mel&filter[status]=trial&filter[plan]=pro_yearly&filter[currency]=gbp&filter[source]=pitch_partner&filter[started]=last:30");
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 7);
  assert.equal(r.body.stripe_dashboard, "https://dashboard.stripe.com/test");
  const list = seen.find((q) => /LIMIT/.test(q.sql));
  // One row per creator, picked as the main app picks her plan.
  assert.match(list.sql, /DISTINCT ON \(c\.user_id\)/);
  assert.match(list.sql, /NOT \(c\.plan = 'founding' AND c\.status IN \('pending', 'expired'\)\)/);
  assert.match(list.sql, /= 'trial'/);
  assert.match(list.sql, /= 'pro_yearly'/);
  assert.match(list.sql, /lower\(r\.currency\) = 'gbp'/);
  assert.match(list.sql, /= 'pitch_partner'/);
  assert.match(list.sql, /ORDER BY \(CASE \(CASE/);
  assert.deepEqual(list.params, ["%mel%", 30, 10, 20]);
  const count = seen.find((q) => /count\(\*\)::int AS n/.test(q.sql));
  assert.deepEqual(count.params, ["%mel%", 30]);
});

test("an unknown status, plan, currency or sort is ignored, never interpolated", async (t) => {
  const seen = [];
  const request = await serve(t, async (sql, params) => { seen.push({ sql, params }); return { rows: [{ n: 0 }] }; });
  await request("/plans?filter[status]=x';drop table creator_plans;--&filter[plan]=nope&filter[currency]=jpy&sortBy=r.id;--");
  for (const q of seen) {
    assert.doesNotMatch(q.sql, /drop table|jpy|nope|r\.id;--/i);
  }
});

test("prod links to live Stripe", async (t) => {
  const request = await serve(t, async (sql) => (/count\(\*\)::int AS n /.test(sql) ? { rows: [{ n: 0 }] } : { rows: [] }), "prod");
  const r = await request("/plans");
  assert.equal(r.body.stripe_dashboard, "https://dashboard.stripe.com");
  assert.deepEqual(r.body.items, []);
});

test("a database without Pitch Pro answers available:false, not a 500", async (t) => {
  const missing = Object.assign(new Error('relation "creator_plans" does not exist'), { code: "42P01" });
  const request = await serve(t, async () => { throw missing; });
  const list = await request("/plans");
  assert.equal(list.status, 200);
  assert.equal(list.body.available, false);
  const summary = await request("/plans/summary");
  assert.equal(summary.status, 200);
  assert.equal(summary.body.available, false);
});

test("the summary counts every state, zero included, and totals per currency only what is paying", async (t) => {
  const seen = [];
  const request = await serve(t, async (sql) => {
    seen.push(sql);
    if (/GROUP BY 1 ORDER BY 2 DESC/.test(sql)) {
      return { rows: [{ currency: "gbp", paying: 2, monthly: 1, monthly_minor: 1900, yearly: 0, yearly_minor: 0, founding: 1, founding_minor: 9900 }] };
    }
    return { rows: [{ state: "paying", n: 2 }, { state: "trial", n: 1 }] };
  });
  const r = await request("/plans/summary");
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 3);
  assert.deepEqual(Object.keys(r.body.counts), PLAN_STATES);
  assert.equal(r.body.counts.paying, 2);
  assert.equal(r.body.counts.past_due, 0);
  assert.equal(r.body.currencies[0].currency, "gbp");
  assert.match(seen.find((s) => /ORDER BY 2 DESC/.test(s)), /= 'paying'/);
});

test("the page's filter options are exactly the server's", () => {
  assert.deepEqual(PLAN_STATE_OPTIONS.map((o) => o.value).sort(), [...PLAN_STATES].sort());
  assert.deepEqual(PLAN_KIND_OPTIONS.map((o) => o.value).sort(), [...PLAN_KINDS].sort());
});

test("statuses read as plain words", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  assert.equal(planStatus({ state: "paying", plan: "pro" }).label, "Paying");
  assert.equal(planStatus({ state: "paying", plan: "founding", paid_at: "2026-10-27T10:00:00Z" }).note, "Paid once, Pitch Pro for good");
  assert.equal(planStatus({ state: "trial", kind: "partner_trial" }).note, "A Pitch Partner's free first month");
  assert.match(planStatus({ state: "trial", kind: "gift", trial_kind: "gift" }).note, /gift runs/);
  assert.match(planStatus({ state: "trial", kind: "gift", trial_kind: "deferred" }).note, /moved past her gift/);
  assert.match(planStatus({ state: "cancels", status: "active", current_period_end: "2026-11-26T19:12:30Z" }).label, /^Cancels on .*2026$/);
  assert.match(planStatus({ state: "cancels", status: "trialing", current_period_end: "2026-11-26T19:12:30Z" }).note, /never charged/);
  assert.match(planStatus({ state: "past_due", status: "past_due", past_due_since: "2026-10-26T00:00:00Z" }, now).note, /^Card failing since/);
  assert.match(planStatus({ state: "past_due", status: "past_due", past_due_since: "2026-10-01T00:00:00Z" }, now).note, /back on Free/);
  assert.equal(planStatus({ state: "refunded", refunded_at: "2026-10-27T10:00:00Z", refund_reason: "sold_out" }).note, "Founding was sold out");
  assert.equal(planStatus({ state: "refunded", refund_due: true }).label, "Refund due");
  assert.equal(planStatus({ state: "ended", status: "granted" }).note, "Her gift ran out");
});

test("prices keep their currency, per month, per year or once", () => {
  assert.equal(money(1900, "gbp"), "£19");
  assert.equal(money(1950, "eur"), "€19.50");
  assert.equal(money(19000, "usd"), "US$190");
  assert.equal(planPrice({ plan: "pro", status: "active", amount_minor: 1900, currency: "gbp", billing_interval: "month" }), "£19 / month");
  assert.equal(planPrice({ plan: "pro", status: "active", amount_minor: 1900, currency: "gbp", billing_interval: "" }), "£19 / month");
  assert.equal(planPrice({ plan: "pro", status: "active", amount_minor: 19000, currency: "eur", billing_interval: "year" }), "€190 / year");
  assert.equal(planPrice({ plan: "founding", status: "paid", amount_minor: 9900, currency: "gbp" }), "£99 once");
  assert.equal(planPrice({ plan: "pro", status: "granted", amount_minor: 0, currency: "" }), "Free");
});

test("the next date says what it is, and Founding never ends", () => {
  assert.deepEqual(planNext({ state: "paying", plan: "founding" }), { verb: "Never ends", at: "" });
  assert.deepEqual(planNext({ state: "paying", plan: "pro", next_at: "2026-11-26" }), { verb: "Renews", at: "2026-11-26" });
  assert.equal(planNext({ state: "trial", next_at: "x" }).verb, "First payment");
  assert.equal(planNext({ state: "cancels", next_at: "x" }).verb, "Ends");
  assert.equal(planNext({ state: "ended", next_at: "x" }).verb, "Ended");
});

test("Stripe links: the subscription or Founding's payment, and the customer", () => {
  const base = "https://dashboard.stripe.com/test";
  assert.deepEqual(stripeLinks({ stripe_subscription_id: "sub_1", stripe_customer_id: "cus_1" }, base), {
    plan: `${base}/subscriptions/sub_1`, customer: `${base}/customers/cus_1`,
  });
  assert.equal(stripeLinks({ stripe_subscription_id: "", stripe_payment_intent_id: "pi_1", stripe_customer_id: "cus_1" }, base).plan, `${base}/payments/pi_1`);
  assert.deepEqual(stripeLinks({ stripe_subscription_id: "", stripe_payment_intent_id: "", stripe_customer_id: "" }, base), { plan: "", customer: "" });
});
