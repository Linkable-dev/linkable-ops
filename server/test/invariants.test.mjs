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
import { normalizeDomain } from "../lib/outbound-attribution.js";
import {
  WEIGHTS, audienceScore, scoreCreator, parseShippingCountries, countryToIso,
} from "../lib/campaign-matchmaking.js";
import { HEALTH_WEIGHTS, scoreBrand } from "../lib/brand-health.js";
import { verdictFor, THRESHOLDS } from "../lib/deliverability.js";
import { isEmailable, EMAILABLE_KINDS } from "../lib/nudge-writer.js";

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
    // The tile is labelled "MRR x 12", so it has to be exactly that — rounding
    // ARR to whole dollars made the two tiles disagree on screen.
    assert.ok(Math.abs(home.revenue.arr - home.revenue.mrr * 12) < 0.01,
      `ARR ${home.revenue.arr} != MRR ${home.revenue.mrr} x 12`);
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
    assert.match(m.paidOutCurrency, /^[A-Z]{3}$/,
      `payouts need an ISO currency, got ${m.paidOutCurrency} — the tile rendered GBP payouts as dollars`);
  });

  // orders.commission holds the commission RATE in percent, not an amount.
  // Summing the column reported four orders at 10/10/10/30 as "60 earned" on
  // 162 of GMV. Commission is a share of GMV, so it cannot exceed it.
  test("commission earned is a share of GMV, not a sum of percentages", () => {
    const m = home.marketplace;
    assert.ok(m.commissionPaid <= m.gmv || m.gmv === 0,
      `commission ${m.commissionPaid} exceeds GMV ${m.gmv}, so it is not money`);
    if (m.gmv > 0) {
      const rate = (m.commissionPaid / m.gmv) * 100;
      assert.ok(rate > 0 && rate <= 100, `implied commission rate is ${rate.toFixed(1)}%`);
    }
  });

  test("the two places that count paying brands agree", () => {
    // Revenue counts them one way and subscription health another; a Shopify
    // test charge was paying in one and not the other, so the page showed
    // "3 paying brands" above "Paying: 4".
    assert.equal(home.subscriptions.paying, home.revenue.payingBrands,
      `subscription health says ${home.subscriptions.paying} paying, revenue says ${home.revenue.payingBrands}`);
  });

  test("the MRR tile agrees with the MRR sparkline beside it", async () => {
    const series = await get("/insights/series?range=90d");
    if (!series.mrrApprox) return; // no subscription mirror on this target
    const latest = series.buckets[series.buckets.length - 1]?.mrr ?? 0;
    // Two independent queries over different tables. They drifted apart when
    // one excluded Shopify test charges and the other did not, and again when
    // one summed GBP and USD subscriptions together.
    assert.ok(Math.abs(latest - home.revenue.mrr) < 1,
      `sparkline says ${latest} but the tile says ${home.revenue.mrr}`);
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

describe("outbound revenue attribution", { timeout: 120_000 }, () => {
  // normalizeDomain IS the join. If it drifts, attribution silently reports
  // zero conversions and nothing else fails, so pin the behaviour directly.
  test("domains normalise to something two databases can agree on", () => {
    const cases = [
      ["https://www.Acme-Store.co.uk/collections/all", "acme-store.co.uk"],
      ["acme.com", "acme.com"],
      ["WWW.ACME.COM/", "acme.com"],
      ["http://shop.acme.com:443", "shop.acme.com"],
      ["acme.com.", "acme.com"],
      ["mailto:hi@acme.com", "acme.com"],
    ];
    for (const [input, want] of cases) {
      assert.equal(normalizeDomain(input), want, `normalizeDomain(${JSON.stringify(input)})`);
    }
  });

  test("things that are not domains never become a join key", () => {
    // Two blanks matching each other would attribute the whole brand base.
    for (const junk of ["", null, undefined, "   ", "not a domain", "localhost", "/", "@"]) {
      assert.equal(normalizeDomain(junk), null, `normalizeDomain(${JSON.stringify(junk)}) must be null`);
    }
  });

  test("the funnel narrows and never claims more than was sent", async () => {
    const a = await get("/outbound/attribution");
    const t = a.totals;
    assert.ok(t.contacted <= t.sends, `${t.contacted} addresses from ${t.sends} sends`);
    assert.ok(t.signups <= t.matched, `${t.signups} signups from ${t.matched} matches`);
    assert.ok(t.paying <= t.signups, `${t.paying} paying from ${t.signups} signups`);
    assert.ok(t.mrr >= 0, "attributed MRR cannot be negative");
    assert.equal(t.matched, t.signups + t.preExisting,
      "every match is either attributed or pre-existing");
  });

  test("each split accounts for every send exactly once", async () => {
    const a = await get("/outbound/attribution");
    for (const key of ["byGroup", "bySender", "byTemplate"]) {
      const sends = a[key].reduce((n, r) => n + r.sends, 0);
      assert.equal(sends, a.totals.sends, `${key} covers ${sends} of ${a.totals.sends} sends`);
      const signups = a[key].reduce((n, r) => n + r.signups, 0);
      assert.equal(signups, a.totals.signups, `${key} covers ${signups} of ${a.totals.signups} signups`);
    }
  });
});

describe("campaign matchmaking", { timeout: 120_000 }, () => {
  test("the weights sum to 100, so a score reads as a percentage", () => {
    assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0), 100);
  });

  test("a score can never leave 0-100 whatever the inputs", () => {
    const ctx = { shipping: true, brandNiche: "HEALTH_WELLNESS", shipsTo: new Set(["GB"]) };
    const inputs = [
      { niche: "HEALTH_WELLNESS", followers: "50000", engagement_rate: "6", country: "United Kingdom", accepted_campaigns: 9, sales: 9, last_sign_in: new Date().toISOString() },
      { niche: null, followers: null, engagement_rate: null, country: null, accepted_campaigns: 0, sales: 0, last_sign_in: null },
      { niche: "PETS", followers: "-5", engagement_rate: "-3", country: "Nowhere", accepted_campaigns: -1, sales: -1, last_sign_in: "not a date" },
      { niche: "HEALTH_WELLNESS", followers: "999999999", engagement_rate: "100", country: "GB", accepted_campaigns: 1, sales: 1, last_sign_in: new Date().toISOString() },
    ];
    for (const c of inputs) {
      const { score } = scoreCreator(c, ctx);
      assert.ok(score >= 0 && score <= 100, `score ${score} out of range for ${JSON.stringify(c)}`);
    }
  });

  test("audience score stays inside its own weight", () => {
    for (const [f, er] of [[0, 0], [500, 1], [50_000, 6], [5_000_000, 9], ["12,000", "3.5"], [null, null]]) {
      const v = audienceScore(f, er);
      assert.ok(v >= 0 && v <= WEIGHTS.audience, `audienceScore(${f}, ${er}) = ${v}`);
    }
  });

  test("a brand's shipping list is read as country codes, not as a country", () => {
    // brands.location is a pipe-separated ISO-2 list, occasionally thousands of
    // characters long. Treating it as a single country awarded nothing on the
    // 12 of 13 active campaigns that ship a sample.
    const parsed = parseShippingCountries("GB | AT | BE | BG | HR");
    assert.ok(parsed instanceof Set);
    assert.ok(parsed.has("GB") && parsed.has("HR"));
    assert.equal(parseShippingCountries("CA | US | * | AU"), "everywhere");
    assert.equal(parseShippingCountries(""), null, "blank is unknown, not 'ships nowhere'");
    assert.equal(parseShippingCountries(null), null);
  });

  test("creator country names resolve to the codes the shipping list uses", () => {
    assert.equal(countryToIso("United Kingdom"), "GB");
    assert.equal(countryToIso("United States"), "US");
    assert.equal(countryToIso("US"), "US", "some rows already hold a code");
    assert.equal(countryToIso("Atlantis"), null, "unknown is null, never a wrong code");
    assert.equal(countryToIso(""), null);
  });

  test("the shortlist never suggests somebody already on the campaign", async () => {
    const list = await get("/ops/campaigns?limit=1");
    const campaign = list.rows[0];
    if (!campaign) return;
    const [matches, existing] = await Promise.all([
      get(`/ops/campaigns/${campaign.id}/creator-matches?limit=25`),
      get(`/ops/campaigns/${campaign.id}/creators`),
    ]);
    const already = new Set((existing.rows || existing || []).map((r) => r.creator_user_id || r.influencer_user_id));
    for (const m of matches.matches) {
      assert.ok(!already.has(m.user_id), `${m.name} is already on the campaign`);
      assert.ok(m.score >= 0 && m.score <= 100);
      assert.ok(Array.isArray(m.reasons) && m.reasons.length > 0, "every ranking needs a reason");
    }
    // Ranked, best first.
    const scores = matches.matches.map((m) => m.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a), "matches are not in rank order");
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

describe("sender deliverability", { timeout: 120_000 }, () => {
  test("a handful of sends is never enough to pause an inbox", () => {
    // 1 bounce out of 3 is 33% and means nothing. Pausing on that would take
    // a healthy inbox out of the pool for noise.
    for (let sent = 0; sent < THRESHOLDS.minSends; sent++) {
      const v = verdictFor({ sent, bounced: sent, complained: sent, isActive: true });
      assert.equal(v.shouldPause, false, `paused on only ${sent} sends`);
      assert.equal(v.judged, false);
    }
  });

  test("a genuinely burning inbox is paused", () => {
    const v = verdictFor({ sent: 200, bounced: 20, complained: 0, isActive: true });
    assert.equal(v.shouldPause, true);
    assert.match(v.breaches[0], /bounce rate/);
  });

  test("complaints bite earlier than bounces, as providers do", () => {
    // 1% complaints with a clean bounce rate must still stop the inbox.
    const v = verdictFor({ sent: 500, bounced: 0, complained: 5, isActive: true });
    assert.equal(v.shouldPause, true);
    assert.match(v.breaches.join(" "), /complaint rate/);
  });

  test("an inbox already out of the pool is never paused again", () => {
    const v = verdictFor({ sent: 200, bounced: 100, complained: 50, isActive: false });
    assert.equal(v.shouldPause, false);
    assert.ok(v.breaches.length > 0, "it should still report the breach");
  });

  test("no input can ever produce a decision to resume", () => {
    // The asymmetry is the safety property: pausing costs a day of capacity,
    // resuming into a reputation problem costs the domain.
    const inputs = [
      { sent: 1000, bounced: 0, complained: 0, isActive: false },
      { sent: 0, bounced: 0, complained: 0, isActive: false },
      { sent: -5, bounced: -5, complained: -5, isActive: false },
      { sent: "200", bounced: "0", complained: "0", isActive: false },
    ];
    for (const i of inputs) {
      const v = verdictFor(i);
      assert.ok(!("shouldResume" in v), "there is no resume decision to make");
      assert.equal(v.shouldPause, false);
    }
  });

  test("rates stay sane for junk input", () => {
    for (const i of [{}, { sent: null }, { sent: "abc", bounced: "x" }, { sent: 10, bounced: 999 }]) {
      const v = verdictFor(i);
      assert.ok(v.bounceRate >= 0 && Number.isFinite(v.bounceRate), `bounceRate ${v.bounceRate}`);
      assert.ok(v.complaintRate >= 0 && Number.isFinite(v.complaintRate));
    }
  });

  test("every configured inbox is reported on", async () => {
    const h = await get("/outbound/inbox-health");
    assert.ok(Array.isArray(h.inboxes));
    for (const b of h.inboxes) {
      assert.ok(b.bounce_rate >= 0 && b.bounce_rate <= 1, `${b.email} bounce_rate ${b.bounce_rate}`);
      assert.ok(b.complaint_rate >= 0 && b.complaint_rate <= 1);
      if (!b.judged) assert.equal(b.should_pause, false, `${b.email} would pause without enough volume`);
    }
  });
});

describe("nudge safety", () => {
  test("only operational alert kinds are ever emailed to a brand", () => {
    // The dangerous case is an operator clicking "nudge all" on a brand that
    // happens to have a purge alert, and the brand being written to about the
    // deletion of their own account.
    for (const kind of ["shipping", "applications", "sales", "billing"]) {
      assert.equal(isEmailable({ kind }), true, `${kind} should be emailable`);
    }
    for (const kind of ["deletion", "trials", "blog", "deliverability", undefined, null, ""]) {
      assert.equal(isEmailable({ kind }), false, `${kind} must never be emailed`);
    }
    assert.equal(isEmailable(null), false);
    assert.equal(isEmailable({}), false);
  });

  test("the allow-list is an allow-list, not a deny-list", () => {
    // A new alert kind must be opted in deliberately, never inherit the right
    // to email customers by default.
    assert.equal(isEmailable({ kind: "some-future-kind" }), false);
    assert.ok(EMAILABLE_KINDS.size <= 6, "the set of things we email about should stay small");
  });
});

describe("hidden brands are not the live marketplace", { timeout: 180_000 }, () => {
  // brands.hidden is the operator's control for taking a store out of
  // circulation: internal stores, test shops, brands that uninstalled. The
  // Users page has always excluded them; the metrics did not, so a hidden test
  // store on a $199 plan counted as a quarter of MRR.
  test("no hidden brand appears in the metrics, the health lists or the alerts", async () => {
    const [visible, hidden, health, alerts] = await Promise.all([
      get("/admin-users/brands?limit=200"),
      get("/admin-users/brands?limit=200&filter[visibility]=hidden"),
      get("/insights/health?limit=200"),
      get("/insights/alerts"),
    ]);
    const hiddenIds = new Set((hidden || []).map((b) => b.user_id));
    if (hiddenIds.size === 0) return; // nothing hidden on this target

    for (const b of health.all) {
      assert.ok(!hiddenIds.has(b.user_id), `hidden brand ${b.store_name} is being scored`);
    }
    for (const a of alerts.alerts) {
      if (!a.brand?.user_id) continue;
      assert.ok(!hiddenIds.has(a.brand.user_id), `hidden brand ${a.brand.store_name} is raising alerts`);
    }
    // And the visible list is what the funnel counts.
    const home = await get("/analytics/home");
    assert.ok(home.funnel.signedUp <= (visible || []).length + hiddenIds.size,
      "the funnel counts more brands than exist");
  });
});
