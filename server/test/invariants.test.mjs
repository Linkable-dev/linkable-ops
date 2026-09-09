// Invariant tests for the numbers the ops app reports.
//
// These assert relationships that must hold whatever the data says, rather than
// fixed values that go stale: funnel stages nest, rates never exceed 100%, a
// campaign row equals the sum of the creators you see when you expand it, money
// is never added across currencies. That is the class of bug the September 2026
// audit found, and the reason this file exists.
//
// Everything here is read-only. The routers are mounted without requireOpsAdmin
// and queried in process, so no server or login is needed:
//   cd server && npm test
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";

import { analyticsRoutes } from "../routes/analytics.js";
import { opsRoutes } from "../routes/ops.js";
import { insightsRoutes } from "../routes/insights.js";
import { outboundRoutes } from "../routes/outbound.js";
import { adminUsersRoutes } from "../routes/admin-users.js";
import { closeCloudSql } from "../lib/cloudsql.js";
import { wordCount, readMinutes, validateArticle, LIMITS } from "../lib/blog-writer.js";
import { HEALTH_WEIGHTS, scoreBrand } from "../lib/brand-health.js";

let server, base;

before(async () => {
  const app = express();
  app.use(express.json());
  // The real stack applies dbTargetMiddleware + requireOpsAdmin here; the tests
  // pin the target and skip auth so they exercise the handlers themselves.
  app.use((req, _res, next) => { req.dbTarget = "prod"; req.admin = { email: "test@linkable.link" }; next(); });
  app.use("/analytics", analyticsRoutes());
  app.use("/ops", opsRoutes());
  app.use("/insights", insightsRoutes());
  app.use("/outbound", outboundRoutes());
  app.use("/admin-users", adminUsersRoutes());
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closeCloudSql();
});

const get = async (path) => {
  const res = await fetch(`${base}${path}`);
  const body = await res.json();
  assert.equal(res.status, 200, `GET ${path} returned ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  assert.equal(body.error, undefined, `GET ${path} returned an error: ${body.error}`);
  return body;
};

// A rate is a share of something: null when there is no denominator yet, never
// above 1. "200% opened" was a real bug caused by a fallback denominator of 1.
const assertRate = (value, label) => {
  if (value === null || value === undefined) return;
  assert.ok(Number.isFinite(value), `${label} should be a number, got ${value}`);
  assert.ok(value >= 0 && value <= 1, `${label} should be between 0 and 1, got ${value}`);
};

describe("home metrics", { timeout: 120_000 }, () => {
  let home;
  before(async () => { home = await get("/analytics/home"); });

  test("the activation funnel never widens as it goes down", () => {
    const { signedUp, launchedCampaign, gotCreator, gotSale } = home.funnel;
    assert.ok(launchedCampaign <= signedUp, `launched (${launchedCampaign}) > signed up (${signedUp})`);
    assert.ok(gotCreator <= launchedCampaign, `got a creator (${gotCreator}) > launched (${launchedCampaign})`);
    assert.ok(gotSale <= gotCreator, `got a sale (${gotSale}) > got a creator (${gotCreator})`);
  });

  test("subscription buckets are disjoint and fit inside the brand base", () => {
    const s = home.subscriptions;
    const total = s.paying + s.inTrial + s.extendedTrialActive + s.cancelledInGrace + s.noPaidPlan;
    assert.ok(total <= home.funnel.signedUp,
      `buckets sum to ${total}, more than the ${home.funnel.signedUp} active brands, so a brand is counted twice`);
  });

  test("ARR is twelve months of MRR and ARPA divides evenly", () => {
    assert.equal(home.revenue.arr, Math.round(home.revenue.mrr * 12));
    if (home.revenue.payingBrands > 0) {
      const arpa = home.revenue.mrr / home.revenue.payingBrands;
      assert.ok(Math.abs(home.revenue.arpa - arpa) < 0.02, `ARPA ${home.revenue.arpa} != MRR/brands ${arpa}`);
    } else {
      assert.equal(home.revenue.arpa, 0);
    }
  });

  test("MRR by plan reconciles with the headline MRR", () => {
    const summed = home.revenue.byTier.reduce((a, t) => a + t.mrr, 0);
    assert.ok(Math.abs(summed - home.revenue.mrr) < 0.51,
      `tiers sum to ${summed} but MRR is ${home.revenue.mrr}`);
    const brands = home.revenue.byTier.reduce((a, t) => a + t.brands, 0);
    assert.equal(brands, home.revenue.payingBrands);
  });

  test("marketplace figures carry a currency and stay self consistent", () => {
    const m = home.marketplace;
    assert.match(m.gmvCurrency, /^[A-Z]{3}$/, `GMV needs an ISO currency, got ${m.gmvCurrency}`);
    assert.ok(m.creatorsActive <= m.creatorsTotal, "more active creators than creators");
    assert.ok(m.linksWithOrders <= m.orders || m.orders === 0,
      `${m.linksWithOrders} links sold but only ${m.orders} orders`);
    assert.ok(m.paidOutCount >= 0 && m.paidOut >= 0, "paid out cannot be negative");
  });
});

describe("dashboard overview", { timeout: 120_000 }, () => {
  let overview;
  before(async () => { overview = await get("/analytics/overview"); });

  test("revenue split by currency adds up to the reported total", () => {
    const summed = overview.revenue.byCurrency.reduce((a, c) => a + c.total, 0);
    assert.ok(Math.abs(summed - overview.revenue.total) < 0.01,
      `currencies sum to ${summed} but total is ${overview.revenue.total}`);
    const orders = overview.revenue.byCurrency.reduce((a, c) => a + c.orders, 0);
    assert.equal(orders, overview.revenue.totalOrders);
  });

  test("accepted links are a subset of all links", () => {
    assert.ok(overview.kpis.activeLinks <= overview.kpis.links,
      `${overview.kpis.activeLinks} accepted > ${overview.kpis.links} total`);
  });

  test("creator payout readiness is measured against creators, not every user", () => {
    const { stripeConnected, totalCreators } = overview.creatorPayments;
    assert.ok(stripeConnected <= totalCreators, "more payout-ready creators than creators");
    assert.ok(totalCreators <= overview.kpis.influencers,
      `payout denominator ${totalCreators} exceeds the ${overview.kpis.influencers} creators, so it is counting other roles`);
  });

  test("trial buckets partition the brand base", () => {
    const { activeTrial, expiredTrial, onTrial } = overview.monetization;
    assert.equal(activeTrial + expiredTrial, onTrial,
      `active (${activeTrial}) + expired (${expiredTrial}) should equal every brand that ever had a trial (${onTrial})`);
    assert.ok(onTrial <= overview.kpis.brands, "more trials than brands");
  });

  test("brands on Stripe and with a card are shares of the brand base", () => {
    assert.ok(overview.monetization.hasStripe <= overview.kpis.brands);
    assert.ok(overview.monetization.hasPaymentMethod <= overview.kpis.brands);
  });
});

describe("campaign operations", { timeout: 180_000 }, () => {
  let page;
  before(async () => { page = await get("/ops/campaigns?limit=50"); });

  test("every campaign funnel nests correctly", () => {
    for (const c of page.rows) {
      const where = `campaign "${c.campaign_name}"`;
      assert.ok(c.creators_accepted <= c.creators_applied,
        `${where}: accepted ${c.creators_accepted} > applied ${c.creators_applied}`);
      assert.ok(c.products_shipped <= c.samples_accepted,
        `${where}: shipped ${c.products_shipped} > samples accepted ${c.samples_accepted}`);
      assert.ok(c.externals_accepted <= c.creators_accepted,
        `${where}: external accepted ${c.externals_accepted} > accepted ${c.creators_accepted}`);
      assert.ok(c.externals_invited <= c.creators_invited, `${where}: external invited exceeds invited`);
      assert.ok(c.externals_applied <= c.creators_applied, `${where}: external applied exceeds applied`);
    }
  });

  test("the bottleneck label matches the severity it sorts by", () => {
    const expected = { "No outreach": 2, "Awaiting invite responses": 1, "No acceptances": 2, "Brand: accepted, not shipped": 3, "Brand: not shipping": 3, "Content: no sales": 1 };
    for (const c of page.rows) {
      if (!c.bottleneck_label) {
        assert.equal(c.bottleneck_severity, 0, `"${c.campaign_name}" has no label but severity ${c.bottleneck_severity}`);
        continue;
      }
      assert.equal(c.bottleneck_severity, expected[c.bottleneck_label],
        `"${c.campaign_name}" shows "${c.bottleneck_label}" but sorts at severity ${c.bottleneck_severity}`);
    }
  });

  test("shipping is never judged against creators who cannot receive a sample", () => {
    // External creators are invited by email and never get a sample_request row,
    // so counting them as unshipped marked healthy campaigns as broken.
    for (const c of page.rows) {
      if (c.bottleneck_label !== "Brand: not shipping") continue;
      const platformAccepted = c.creators_accepted - c.externals_accepted;
      assert.ok(c.products_shipped < platformAccepted,
        `"${c.campaign_name}" is flagged as not shipping, but ${c.products_shipped} shipped covers its ${platformAccepted} platform acceptances`);
    }
  });

  test("a campaign row equals the sum of the creators behind it", async () => {
    const withSales = page.rows.filter((c) => c.sales > 0).slice(0, 3);
    const sample = withSales.length ? withSales : page.rows.slice(0, 3);
    for (const c of sample) {
      const creators = await get(`/ops/campaigns/${c.id}/creators`);
      const sales = creators.reduce((a, x) => a + Number(x.sales || 0), 0);
      assert.equal(sales, c.sales,
        `"${c.campaign_name}" reports ${c.sales} sales but its creators add up to ${sales}`);
      const accepted = creators.filter((x) => ["Accepted", "Sample Accepted", "Shipped", "Sold"].includes(x.status)).length;
      assert.equal(accepted, c.creators_accepted,
        `"${c.campaign_name}" reports ${c.creators_accepted} accepted but the drill-down shows ${accepted}`);
    }
  });

  test("rejected and ended creators are not counted as applications", async () => {
    const c = page.rows[0];
    if (!c) return;
    const creators = await get(`/ops/campaigns/${c.id}/creators`);
    const applied = creators.filter((x) => !["Invited", "Rejected", "Ended"].includes(x.status)).length;
    assert.equal(applied, c.creators_applied,
      `"${c.campaign_name}" reports ${c.creators_applied} applied but the drill-down shows ${applied} once rejected and ended are excluded`);
  });

  test("a quick filter narrows the total, never just the page", async () => {
    const stuck = await get("/ops/campaigns?limit=50&quick=stuck-shipping");
    assert.ok(stuck.total <= page.total, "filtered total exceeds the unfiltered total");
    assert.equal(stuck.rows.length, Math.min(stuck.total, 50),
      `${stuck.total} matches but ${stuck.rows.length} rows came back, so the total describes a different set`);
  });
});

describe("outbound", { timeout: 120_000 }, () => {
  let stats;
  before(async () => { stats = await get("/outbound/stats?scope=all"); });

  test("no engagement rate exceeds 100%", () => {
    for (const [name, value] of Object.entries(stats.rates)) assertRate(value, `rates.${name}`);
  });

  test("counters are consistent with each other", () => {
    assert.ok(stats.sent <= stats.total, `sent ${stats.sent} > ${stats.total} rows in the window`);
    assert.ok(stats.delivered <= stats.sent, `delivered ${stats.delivered} > sent ${stats.sent}`);
    assert.ok(stats.opened <= stats.delivered || stats.delivered === 0, "opened exceeds delivered");
    assert.ok(stats.clicked <= stats.opened || stats.opened === 0, "clicked exceeds opened");
  });

  test("queued means still waiting, not every row in the window", () => {
    const waiting = (stats.byStatus.pending || 0) + (stats.byStatus.scheduled || 0);
    assert.equal(stats.queued, waiting, "queued should be pending + scheduled");
    assert.ok(stats.queued <= stats.total);
  });

  test("the status breakdown accounts for every row", () => {
    const summed = Object.values(stats.byStatus).reduce((a, n) => a + n, 0);
    assert.equal(summed, stats.total, "statuses do not add up to the row count");
  });
});

describe("alerts", { timeout: 180_000 }, () => {
  let payload;
  before(async () => { payload = await get("/insights/alerts"); });

  test("every alert can be acted on and dismissed", () => {
    for (const a of payload.alerts) {
      assert.ok(a.key, "an alert has no key, so it could never be dismissed");
      assert.ok(a.fingerprint !== undefined, `${a.key} has no fingerprint, so "Done" could never expire`);
      assert.ok(["danger", "warn", "info"].includes(a.severity), `${a.key} has severity ${a.severity}`);
      assert.ok(a.title && a.detail, `${a.key} is missing its title or detail`);
      assert.ok(a.action, `${a.key} does not say what to do about it`);
    }
  });

  test("alert keys are unique, so dismissing one cannot hide another", () => {
    const keys = payload.alerts.map((a) => a.key);
    assert.equal(new Set(keys).size, keys.length, "two alerts share a key");
  });

  test("open alerts are sorted most urgent first", () => {
    const rank = { danger: 0, warn: 1, info: 2 };
    const ranks = payload.alerts.map((a) => rank[a.severity]);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), "alerts are not ordered by severity");
  });

  test("the open count matches the list", () => {
    assert.equal(payload.openCount, payload.alerts.length);
  });
});

describe("home time series", { timeout: 120_000 }, () => {
  test("each range returns the buckets it promises, with a comparison period", async () => {
    for (const [range, expected] of [["30d", 30], ["90d", 13], ["12m", 12]]) {
      const s = await get(`/insights/series?range=${range}`);
      assert.equal(s.buckets.length, expected, `${range} returned ${s.buckets.length} buckets`);
      assert.ok(s.totals.current, `${range} has no current totals`);
      assert.ok(s.totals.previous, `${range} has nothing to compare against`);
      for (const b of s.buckets) {
        assert.match(b.date, /^\d{4}-\d{2}-\d{2}$/, `bucket date ${b.date} is not a plain date`);
        for (const k of ["brands", "creators", "orders", "gmv"]) {
          assert.ok(b[k] >= 0, `${range} bucket ${b.date} has a negative ${k}`);
        }
      }
    }
  });

  test("bucket values add up to the reported totals", async () => {
    const s = await get("/insights/series?range=90d");
    for (const key of ["brands", "creators", "orders", "gmv"]) {
      const summed = s.buckets.reduce((a, b) => a + (b[key] || 0), 0);
      assert.ok(Math.abs(summed - s.totals.current[key]) < 0.01,
        `${key} buckets sum to ${summed} but the total says ${s.totals.current[key]}`);
    }
  });
});

describe("table analytics", { timeout: 120_000 }, () => {
  test("record counts exclude soft-deleted rows, matching the dashboard", async () => {
    const [brands, overview] = await Promise.all([get("/analytics/brands"), get("/analytics/overview")]);
    assert.equal(brands.total, overview.kpis.brands,
      `table analytics counts ${brands.total} brands, the dashboard ${overview.kpis.brands}`);
  });
});

describe("admin lists", { timeout: 120_000 }, () => {
  test("brand rows carry a total so the footer can say 'of N'", async () => {
    const rows = await get("/admin-users/brands?limit=5");
    assert.ok(Array.isArray(rows));
    if (!rows.length) return;
    assert.ok(Number.isInteger(rows[0].total_count), "no total_count on the row");
    assert.ok(rows[0].total_count >= rows.length);
  });

  test("the deleted list never includes active brands", async () => {
    const rows = await get("/admin-users/deleted-brands?limit=20");
    for (const r of rows) {
      assert.notEqual(r.user_deleted, null, `${r.email} is listed as deleted but has no deletion date`);
      assert.ok(!String(r.user_deleted).startsWith("-infinity"),
        `${r.email} carries the -infinity sentinel, which is not a real deletion`);
      if (r.days_until_purge !== null) assert.ok(r.days_until_purge >= 0, "negative days until purge");
    }
  });
});

// The Supabase Edge Function cannot read loose files, so the prompt data is
// bundled into a JSON module. This fails if someone edits style.md or facts.md
// without re-running scripts/build-edge-blog-data.mjs, which would leave the
// daily article generating from a stale prompt.
describe("edge function prompt data", () => {
  test("the committed bundle matches server/data/blog", async () => {
    const { buildPromptData, serialise, OUT } = await import("../../scripts/build-edge-blog-data.mjs");
    const onDisk = fs.readFileSync(OUT, "utf8");
    assert.equal(onDisk, serialise(buildPromptData()),
      "supabase/functions/_shared/prompt-data.json is stale; run `npm run blog:build-data`");
  });
});

// The blog validator is pure, so these need no database at all.
describe("blog article rules", () => {
  test("word count ignores empty and padded blocks", () => {
    assert.equal(wordCount([{ type: "p", text: "" }]), 0, "an empty block counted as a word");
    assert.equal(wordCount([{ type: "p", text: "  " }]), 0, "whitespace counted as a word");
    assert.equal(wordCount([{ type: "p", text: " two words " }]), 2);
    assert.equal(wordCount([{ type: "ul", items: ["one", "two three"] }]), 3);
    assert.equal(wordCount(null), 0);
  });

  test("read time follows the word count with no floor", () => {
    assert.equal(readMinutes(0), 1);
    assert.equal(readMinutes(200), 1);
    assert.equal(readMinutes(1000), 5);
  });

  test("validator messages quote the limits the validator enforces", () => {
    const short = { title: "x".repeat(50), excerpt: "e", metaDescription: "m".repeat(130), blocks: [{ type: "p", text: "word " .repeat(10) }], faqs: [] };
    const problems = validateArticle(short);
    const wordProblem = problems.find((p) => p.startsWith("body has"));
    assert.ok(wordProblem, "a 10-word article did not trip the length check");
    assert.ok(wordProblem.includes(String(LIMITS.words[0])) && wordProblem.includes(String(LIMITS.words[1])),
      `message "${wordProblem}" does not quote the enforced range ${LIMITS.words.join(" to ")}`);
  });

  test("a dash or an exclamation mark is always rejected", () => {
    const body = Array.from({ length: 70 }, () => ({ type: "p", text: "word ".repeat(10) }));
    const withDash = validateArticle({ title: "x".repeat(50), excerpt: "e", metaDescription: "m".repeat(130), blocks: [...body, { type: "p", text: "an em dash — here" }], faqs: [] });
    assert.ok(withDash.some((p) => p.includes("dash")), "an em dash passed the style check");
  });
});

describe("brand health", { timeout: 120_000 }, () => {
  test("the weights sum to 100", () => {
    assert.equal(Object.values(HEALTH_WEIGHTS).reduce((a, b) => a + b, 0), 100);
  });

  test("a score stays in range for any brand, however sparse the record", () => {
    const rows = [
      { last_sign_in: new Date().toISOString(), active_campaigns: 3, creators_accepted: 9, samples_accepted: 4, samples_shipped: 4, orders_30d: 8, orders_prev_30d: 2, clicks_30d: 900 },
      {},
      { last_sign_in: "nonsense", active_campaigns: "x", creators_accepted: null, samples_accepted: -3, samples_shipped: -9, orders_30d: -1, clicks_30d: -1 },
      { last_sign_in: new Date(0).toISOString(), active_campaigns: 0, creators_accepted: 0, samples_accepted: 5, samples_shipped: 0, orders_30d: 0, clicks_30d: 0, sub_status: "FROZEN" },
    ];
    for (const r of rows) {
      const { score, reasons, risks } = scoreBrand(r);
      assert.ok(score >= 0 && score <= 100, `score ${score} out of range`);
      assert.ok(Array.isArray(reasons) && Array.isArray(risks));
    }
  });

  test("shipping nothing you owe scores below shipping all of it", () => {
    const base = { last_sign_in: new Date().toISOString(), active_campaigns: 1, creators_accepted: 3, orders_30d: 1, clicks_30d: 10 };
    const shipped = scoreBrand({ ...base, samples_accepted: 4, samples_shipped: 4 }).score;
    const unshipped = scoreBrand({ ...base, samples_accepted: 4, samples_shipped: 0 }).score;
    assert.ok(unshipped < shipped, `unshipped ${unshipped} should score below shipped ${shipped}`);
  });

  test("a failed payment is always the first thing an operator is told", () => {
    const { risks } = scoreBrand({ last_sign_in: new Date().toISOString(), active_campaigns: 1, sub_status: "FROZEN", samples_accepted: 2, samples_shipped: 0 });
    assert.match(risks[0], /Payment failed/);
  });

  test("the two rankings hold only the brands they are about", async () => {
    const h = await get("/insights/health?limit=50");
    assert.ok(h.totals.brands > 0, "no brands scored");
    for (const b of h.churnRadar) assert.equal(b.paying, true, `${b.store_name} is on the churn radar but is not paying`);
    for (const b of h.trialRanking) assert.equal(b.in_trial, true, `${b.store_name} is in the trial ranking but is not in a trial`);
    const trialScores = h.trialRanking.map((b) => b.score);
    assert.deepEqual(trialScores, [...trialScores].sort((a, b) => b - a), "trial ranking is not ordered");
    for (const b of h.all) assert.ok(b.score >= 0 && b.score <= 100);
    assert.equal(h.totals.bands.healthy + h.totals.bands.watch + h.totals.bands["at risk"], h.totals.brands,
      "every brand must fall in exactly one band");
  });
});
