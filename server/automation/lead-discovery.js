// Lead discovery: pulls Shopify brands from StoreLeads, finds the founder /
// marketing decision-maker via Apollo, falls back to Hunter, verifies via
// Hunter, and writes the result to `storeleads_brands` so the AI bulk runner
// can pick them up.
//
// All credentials read from env. Designed to run as a background job —
// progress is tracked in ai_bulk_runs.
//
// Filters supported:
//   country     "US,GB"            (StoreLeads field `cc`)
//   minRevenue  number              (USD, monthly; field `er` min)
//   maxRevenue  number              (USD, monthly; field `er` max)
//   categories  ["/Apparel", ...]   (StoreLeads category paths)
//   limit       integer             (max brands to process)

import { supabase } from "../lib/supabase.js";
import { createBulkRun, updateBulkRun } from "./conversation-state.js";
import { isLikelyFirstName } from "./first-names.js";

const STORELEADS_BASE = "https://storeleads.app/json/api/v1/all/domain";

// ---------- ENTRY ----------

// Queue a discovery run. The web handler can't actually do the work — Vercel
// kills serverless functions ~60s after the response, mid-loop. So we just
// persist a 'pending' row here; an out-of-band worker (run-discovery-worker.js,
// invoked by cron / a scheduled Claude Code agent / locally) picks it up and
// drives it to completion.
export async function queueLeadDiscovery({ teamId, campaignId, filters = {}, limit = 50 }) {
  // Self-heal: prior 'running' rows quiet for 5+ minutes are dead worker
  // remnants from the old in-handler design. Mark them failed.
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  await supabase.from("ai_bulk_runs")
    .update({ status: "failed", error: "stalled — likely killed by serverless timeout", completed_at: new Date().toISOString() })
    .eq("team_id", teamId)
    .eq("source", "discover_storeleads")
    .eq("status", "running")
    .lt("started_at", fiveMinAgo);

  const run = await createBulkRun({
    teamId,
    campaignId,
    source: "discover_storeleads",
    filters,
    total: limit,
    status: "pending",
  });

  return { run_id: run.id, target: limit, status: "pending" };
}

// Backward-compat alias — older callers still import startLeadDiscovery.
export const startLeadDiscovery = queueLeadDiscovery;

// Helper: revenue band check matching the lead-pool filter. raw_data is jsonb,
// `estimated_sales` is monthly USD as text — convert and compare in JS.
function inRevenueBand(row, { minRev, maxRev }) {
  if (minRev == null && maxRev == null) return true;
  const rev = Number(row?.raw_data?.estimated_sales);
  if (!Number.isFinite(rev)) return false;
  if (minRev != null && rev < minRev) return false;
  if (maxRev != null && rev > maxRev) return false;
  return true;
}

// Auto top-up: walks every active email_campaign for a team, queues a discovery
// run when its uncontacted in-band lead pool drops below `threshold`. Skips
// campaigns that already have a pending/running run from the last hour.
//
// Used by the cron tick. Returns a per-campaign summary so the cron handler
// can log it. Idempotent.
export async function autoTopUpDiscovery({ teamId, threshold = 50, batch = 200, dryRun = false }) {
  const { data: campaigns, error } = await supabase
    .from("email_campaigns")
    .select("id,name,target_filters,team_id")
    .eq("team_id", teamId).eq("status", "active");
  if (error) throw new Error(error.message);

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const summary = [];

  for (const c of campaigns || []) {
    const tf = c.target_filters || {};
    const filters = {
      countries: tf.countries || [],
      minRev: tf.min_revenue ?? null,
      maxRev: tf.max_revenue ?? null,
    };

    // Count uncontacted in-band leads. raw_data->>estimated_sales is text in
    // jsonb so we JS-filter; cap at 5000 to bound work.
    let q = supabase.from("storeleads_brands")
      .select("id,emailed,raw_data")
      .eq("team_id", teamId)
      .not("email", "is", null)
      .eq("emailed", false)
      .limit(5000);
    if (filters.countries.length) q = q.in("country_code", filters.countries);
    const { data: pool, error: pErr } = await q;
    if (pErr) { summary.push({ campaign_id: c.id, name: c.name, error: pErr.message }); continue; }
    const eligible = (pool || []).filter((r) => inRevenueBand(r, filters)).length;

    // Skip if a run is already in-flight for this campaign — don't pile up.
    const { data: recent } = await supabase
      .from("ai_bulk_runs")
      .select("id,status,created_at")
      .eq("team_id", teamId)
      .eq("source", "discover_storeleads")
      .eq("filters->>email_campaign_id", c.id)
      .in("status", ["pending", "running"])
      .gte("created_at", oneHourAgo)
      .limit(1);
    const inFlight = (recent || []).length > 0;

    const action = eligible >= threshold
      ? "skip:above-threshold"
      : inFlight
        ? "skip:run-in-flight"
        : dryRun
          ? "would-queue"
          : "queued";
    let runId = null;
    if (action === "queued") {
      const out = await queueLeadDiscovery({
        teamId, campaignId: null, limit: batch,
        filters: {
          countries: (tf.countries || []).join(" "),
          minRevenue: tf.min_revenue,
          maxRevenue: tf.max_revenue,
          categories: tf.categories || [],
          email_campaign_id: c.id,
        },
      });
      runId = out.run_id;
    }
    summary.push({ campaign_id: c.id, name: c.name, eligible, action, run_id: runId });
  }

  return { threshold, batch, dryRun, campaigns: summary };
}

// Worker entry point — drains the queue end-to-end. Used by the CLI script.
// Picks the oldest pending run for the team (or any team if teamId omitted),
// flips it to 'running', and processes it to completion. No deadline.
export async function processOnePendingRun({ teamId } = {}) {
  if (!process.env.STORELEADS_KEY) throw new Error("STORELEADS_KEY not set");

  let q = supabase.from("ai_bulk_runs")
    .select("*").eq("source", "discover_storeleads").eq("status", "pending")
    .order("created_at", { ascending: true }).limit(1);
  if (teamId) q = q.eq("team_id", teamId);
  const { data: pending } = await q.maybeSingle();
  if (!pending) return null;

  // Claim the run. Conditional update guards against two workers racing.
  const { data: claimed } = await supabase.from("ai_bulk_runs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", pending.id).eq("status", "pending")
    .select("*").maybeSingle();
  if (!claimed) return null; // someone else got it

  try {
    await processDiscovery(claimed.id, claimed.team_id, claimed.campaign_id, claimed.filters || {}, claimed.total || 50);
  } catch (err) {
    await updateBulkRun(claimed.id, {
      status: "failed", error: err.message, completed_at: new Date().toISOString(),
    }).catch(() => {});
    throw err;
  }
  const { data: final } = await supabase.from("ai_bulk_runs").select("*").eq("id", claimed.id).maybeSingle();
  return final;
}

// Cron tick — designed to run inside a Vercel function with maxDuration=60s.
// Picks oldest pending OR resumes oldest already-running run, processes for
// at most `deadlineMs` ms (default 50s), then yields. The next tick continues.
export async function processOneRunTick({ teamId, deadlineMs = 50_000 } = {}) {
  if (!process.env.STORELEADS_KEY) throw new Error("STORELEADS_KEY not set");

  // Prefer continuing an in-flight run before starting a new one.
  const baseSelect = supabase.from("ai_bulk_runs")
    .select("*").eq("source", "discover_storeleads")
    .order("created_at", { ascending: true }).limit(1);

  let target = null;
  {
    const { data: running } = await (teamId ? baseSelect.eq("team_id", teamId) : baseSelect)
      .eq("status", "running").maybeSingle();
    if (running) target = running;
  }
  if (!target) {
    const { data: pending } = await (teamId
      ? supabase.from("ai_bulk_runs").select("*").eq("source", "discover_storeleads").eq("team_id", teamId).eq("status", "pending").order("created_at", { ascending: true }).limit(1).maybeSingle()
      : supabase.from("ai_bulk_runs").select("*").eq("source", "discover_storeleads").eq("status", "pending").order("created_at", { ascending: true }).limit(1).maybeSingle());
    if (!pending) return { picked: null };

    const { data: claimed } = await supabase.from("ai_bulk_runs")
      .update({ status: "running", started_at: new Date().toISOString() })
      .eq("id", pending.id).eq("status", "pending").select("*").maybeSingle();
    if (!claimed) return { picked: null };
    target = claimed;
  }

  try {
    const out = await processDiscovery(target.id, target.team_id, target.campaign_id, target.filters || {}, target.total || 50, { deadlineMs });
    return { picked: target.id, ...out };
  } catch (err) {
    await updateBulkRun(target.id, {
      status: "failed", error: err.message, completed_at: new Date().toISOString(),
    }).catch(() => {});
    throw err;
  }
}

async function processDiscovery(runId, teamId, campaignId, filters, limit, opts = {}) {
  // Resume from whatever state is in the row — counters and cursor live in
  // ai_bulk_runs so each cron tick can pick up where the last left off.
  const { data: existingRow } = await supabase
    .from("ai_bulk_runs").select("*").eq("id", runId).maybeSingle();
  const counters = {
    processed: existingRow?.processed || 0,
    sent: existingRow?.sent || 0,
    skipped: existingRow?.skipped || 0,
    failed: existingRow?.failed || 0,
  };
  let cursor = filters?._cursor || null;
  let cancelled = false;

  // Build a Set of every domain we've already processed for this team so
  // re-runs effectively continue from where the last left off — they page
  // through StoreLeads but skip known domains without burning Apollo/Hunter
  // calls. The cursor naturally advances through the result set.
  const seenDomains = new Set();
  {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data: page, error } = await supabase
        .from("storeleads_brands").select("domain")
        .eq("team_id", teamId).range(from, from + PAGE - 1);
      if (error || !page?.length) break;
      for (const r of page) seenDomains.add(r.domain);
      if (page.length < PAGE) break;
    }
  }
  let alreadySeenInRun = 0;

  // Soft deadline lets the cron tick exit cleanly before Vercel kills it
  // (default 50s with 60s maxDuration). When unset (CLI runs), runs forever.
  const deadlineAt = opts.deadlineMs ? Date.now() + opts.deadlineMs : null;
  const deadlineHit = () => deadlineAt != null && Date.now() >= deadlineAt;

  while (counters.sent < limit && !cancelled && !deadlineHit()) {
    // Cooperative cancel.
    if (counters.processed % 20 === 0 && counters.processed > 0) {
      const { data: row } = await supabase
        .from("ai_bulk_runs").select("status").eq("id", runId).maybeSingle();
      if (row?.status === "stopped") { cancelled = true; break; }
    }

    let batch;
    try {
      batch = await fetchStoreLeadsBatch({ filters, cursor });
    } catch (err) {
      counters.failed++;
      await updateBulkRun(runId, { error: `StoreLeads: ${err.message}` });
      break;
    }
    if (!batch?.domains?.length) break;
    cursor = batch.nextCursor;
    // Persist the new cursor immediately so we can resume if killed mid-page.
    await updateBulkRun(runId, { filters: { ...filters, _cursor: cursor } });

    for (const brand of batch.domains) {
      if (counters.sent >= limit || cancelled || deadlineHit()) break;
      const cleanDomain = (brand.name || "").replace(/^www\./, "").toLowerCase();
      if (seenDomains.has(cleanDomain)) {
        // Already in the pool — skip without burning enrichment calls.
        // Keeps the loop advancing through StoreLeads pages until we find
        // `limit` brand-new qualified brands.
        alreadySeenInRun++;
        continue;
      }
      try {
        const result = await processOneBrand({ teamId, brand });
        counters.processed++;
        if (result.qualified) counters.sent++;
        else counters.skipped++;
        seenDomains.add(cleanDomain);
      } catch (err) {
        counters.processed++;
        counters.failed++;
        console.error(`brand ${brand.name} failed:`, err.message);
        seenDomains.add(cleanDomain);
      }
      if (counters.processed % 5 === 0) {
        await updateBulkRun(runId, {
          processed: counters.processed,
          sent: counters.sent,
          skipped: counters.skipped,
          failed: counters.failed,
        });
      }
    }
    if (!batch.hasMore) break;
  }

  // Deadline-yield path: save state, leave status='running' so the next tick
  // continues. Don't flip to complete.
  if (deadlineHit() && counters.sent < limit) {
    await updateBulkRun(runId, {
      processed: counters.processed,
      sent: counters.sent,
      skipped: counters.skipped,
      failed: counters.failed,
    });
    return { yielded: true, ...counters };
  }

  await updateBulkRun(runId, {
    processed: counters.processed,
    sent: counters.sent,
    skipped: counters.skipped,
    failed: counters.failed,
    status: cancelled ? "stopped" : "complete",
    completed_at: new Date().toISOString(),
  });
  if (alreadySeenInRun > 0) {
    console.log(`Run ${runId}: skipped ${alreadySeenInRun} already-known domains during paging.`);
  }
}

// ---------- ONE BRAND ----------

export async function processOneBrand({ teamId, brand }) {
  const cleanDomain = (brand.name || "").replace(/^www\./, "").toLowerCase();
  if (!cleanDomain) return { qualified: false, reason: "no domain" };

  const emails = (brand.contact_info || []).filter((c) => c.type === "email").map((c) => c.value);
  // Build the full StoreLeads-derived row up front. We persist this regardless
  // of whether we end up qualifying the brand — even rejected brands are
  // useful (skip-list, future requalification, audit trail).
  const baseRow = {
    team_id: teamId,
    domain: cleanDomain,
    merchant_name: brand.merchant_name || null,
    title: brand.title || null,
    description: brand.description || null,
    platform: brand.platform || null,
    plan: brand.plan || null,
    country_code: brand.country_code || null,
    currency_code: brand.currency_code || null,
    city: brand.city || null,
    state: brand.state || brand.region || null,
    language_code: brand.language_code || null,
    emails,
    contact_info: brand.contact_info || [],
    categories: brand.categories || [],
    avg_price: brand.avg_price_formatted || null,
    created_at_storeleads: brand.created_at || null,
    last_updated_at: brand.last_updated_at || null,
    trustpilot_rating: brand.trustpilot?.avg_rating || null,
    trustpilot_reviews: brand.trustpilot?.review_count || null,
    about_us: brand.about_us || null,
    contact_page: brand.contact_page || null,
    career_page: brand.career_page || null,
    raw_data: brand,
    imported_at: new Date().toISOString(),
  };

  async function persistAndReturn({ qualified, reason, person, hunterStatus }) {
    const row = { ...baseRow };
    if (person) {
      row.email = person.email;
      row.contact_first_name = person.firstName;
      row.contact_last_name = person.lastName;
      row.contact_position = person.position;
      row.contact_source = person.source;
    }
    if (!qualified) {
      // Stamp the reason inside raw_data so we can audit later without a
      // migration. (raw_data is jsonb so this is cheap to query.)
      row.raw_data = { ...brand, _disqualify_reason: reason || null, _hunter_status: hunterStatus || null };
    }
    await supabase.from("storeleads_brands").upsert(row, { onConflict: "domain" });
    return { qualified, email: person?.email, name: person?.firstName, reason };
  }

  // Decision-maker finder. Try sources in order; if a source returns a
  // result we can't use (generic mailbox, generic name), fall through to the
  // next source instead of giving up. Apollo's 429 is handled gracefully
  // (apolloSearch returns null fast when exhausted).
  //   1. Apollo — verified org-chart roots, returns null fast when 429'd.
  //   2. Hunter — role-prioritized domain search.
  //   3. StoreLeads contact_info — free, only accepts clearly-named people.
  function isUsable(p) {
    if (!p?.email) return false;
    const local = p.email.split("@")[0]?.toLowerCase();
    if (isGenericLocal(local)) return false;
    if (p.firstName && isGenericLocal(p.firstName.toLowerCase())) return false;
    return true;
  }

  let person = null;
  let lastRejected = null;
  if (process.env.APOLLO_API_KEY) {
    const p = await apolloSearch(cleanDomain).catch(() => null);
    if (isUsable(p)) person = p;
    else if (p) lastRejected = p;
  }
  if (!person && process.env.HUNTER_API_KEY) {
    const p = await hunterSearch(cleanDomain).catch(() => null);
    if (isUsable(p)) person = p;
    else if (p) lastRejected = lastRejected || p;
  }
  if (!person) {
    const p = pickPersonalFromStoreLeads(cleanDomain, brand.contact_info);
    if (isUsable(p)) person = p;
    else if (p) lastRejected = lastRejected || p;
  }

  if (!person) {
    if (lastRejected) {
      const local = lastRejected.email?.split("@")[0]?.toLowerCase();
      const reason = local && isGenericLocal(local)
        ? `generic mailbox (${local}@) — no usable contact across sources`
        : `generic name (${lastRejected.firstName}) — no usable contact across sources`;
      return persistAndReturn({ qualified: false, reason, person: lastRejected });
    }
    return persistAndReturn({ qualified: false, reason: "no email on brand" });
  }

  // Role filter only when we have a stated position. Apollo / Hunter return
  // titles; StoreLeads-personal usually doesn't, so we don't gate on it.
  const pos = (person.position || "").toLowerCase();
  if (pos) {
    const isFounder = /founder|ceo|owner|co-founder|coo|cto|president/.test(pos);
    const isMarketing = /marketing|cmo|growth|brand|ecommerce|e-commerce|digital|creator|influencer|partnership/.test(pos);
    const fromOrgChart = person.source === "apollo-orgchart";
    if (!isFounder && !isMarketing && !fromOrgChart) {
      return persistAndReturn({ qualified: false, reason: `role ${person.position} not target`, person });
    }
  }

  // Verify only what we can't already trust:
  //   - apollo-orgchart: Apollo already returned email_status='verified', skip.
  //   - hunter: domain-search returned with confidence>=70, which is the same
  //     deliverability signal as the verifier — skip to save credits.
  //   - storeleads-personal: address scraped from a public page; could be a
  //     guess or stale. This is the case worth spending a verification credit on.
  let hunterStatus = null;
  if (person.source === "storeleads-personal" && process.env.HUNTER_API_KEY) {
    hunterStatus = await hunterVerify(person.email).catch(() => "unknown");
    if (hunterStatus === "invalid") {
      return persistAndReturn({ qualified: false, reason: "Hunter says invalid", person, hunterStatus });
    }
    // 429 etc. → "unknown" → we keep the lead, accepting the deliverability risk.
  }

  return persistAndReturn({ qualified: true, person, hunterStatus });
}

// ---------- STORELEADS ----------

async function fetchStoreLeadsBatch({ filters, cursor }) {
  const bq = buildStoreLeadsBQ(filters);
  const url = cursor
    ? `${STORELEADS_BASE}?bq=${encodeURIComponent(bq)}&cursor=${encodeURIComponent(cursor)}`
    : `${STORELEADS_BASE}?bq=${encodeURIComponent(bq)}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.STORELEADS_KEY}` },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`StoreLeads API ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = await res.json();
      return {
        domains: data.domains || [],
        hasMore: !!data.has_next_page,
        nextCursor: data.has_next_page ? data.next_cursor : null,
      };
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(5000);
    }
  }
}

// Build the Bleve query JSON for StoreLeads. Encoded structure mirrors what
// the dashboard generates. Defaults match the existing run-storeleads.js
// (Shopify, US+GB, beauty/wellness, $50k–$100k revenue, but everything is
// overridable via filters).
function buildStoreLeadsBQ(filters) {
  const conjuncts = [
    // platform = Shopify (1)
    { field: "p", operator: "or", analyzer: "advanced", match: "1" },
  ];
  const minRev = filters.minRevenue ?? 5_000_000;
  const maxRev = filters.maxRevenue ?? 10_000_000;
  conjuncts.push({
    field: "er",
    min: minRev,
    max: maxRev,
    inclusive_min: true,
    inclusive_max: true,
  });
  const countries = (filters.countries || filters.country || "US GB")
    .toString()
    .toUpperCase()
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (countries) {
    conjuncts.push({ field: "cc", operator: "or", analyzer: "advanced", match: countries });
  }
  const matchString = categoriesToBleveMatch(filters.categories);
  if (matchString) {
    conjuncts.push({ field: "cat", operator: "or", analyzer: "advanced", match: matchString });
  }
  return JSON.stringify({ must: { conjuncts } });
}

// Friendly preset → StoreLeads `cat` paths (Google product taxonomy, with the
// bleve-analyzer encoding "..." for spaces). Plain words like "beauty" match
// nothing in the StoreLeads index, so the UI now picks from these presets.
export const CATEGORY_PRESETS = {
  beauty:    { label: "Beauty (broad)",    paths: ["/Beauty...&...Fitness", "/Beauty...&...Fitness/Face...&...Body...Care"] },
  skincare:  { label: "Skincare",          paths: ["/Beauty...&...Fitness/Face...&...Body...Care/Skin...&...Nail...Care"] },
  makeup:    { label: "Makeup / Cosmetics",paths: ["/Beauty...&...Fitness/Face...&...Body...Care/Make-Up...&...Cosmetics"] },
  fragrance: { label: "Fragrance",         paths: ["/Beauty...&...Fitness/Face...&...Body...Care/Perfumes...&...Fragrances"] },
  haircare:  { label: "Haircare",          paths: ["/Beauty...&...Fitness/Face...&...Body...Care/Hair...Care"] },
  wellness:  { label: "Wellness / Nutrition", paths: ["/Health", "/Health/Nutrition"] },
  fitness:   { label: "Fitness",           paths: ["/Beauty...&...Fitness/Fitness"] },
  apparel:   { label: "Apparel",           paths: ["/Apparel"] },
};

function categoriesToBleveMatch(categories) {
  if (!categories?.length) {
    // Default: beauty + wellness umbrella
    return [
      ...CATEGORY_PRESETS.beauty.paths,
      ...CATEGORY_PRESETS.skincare.paths,
      ...CATEGORY_PRESETS.makeup.paths,
      ...CATEGORY_PRESETS.fragrance.paths,
      ...CATEGORY_PRESETS.wellness.paths,
    ].join(" ");
  }
  const out = [];
  for (const c of categories) {
    if (typeof c !== "string") continue;
    if (c.startsWith("/")) {
      // Real Google-taxonomy path — encode spaces as the bleve analyzer expects.
      out.push(c.replace(/ /g, "..."));
      continue;
    }
    const preset = CATEGORY_PRESETS[c.toLowerCase()];
    if (preset) out.push(...preset.paths);
  }
  return out.join(" ");
}

// ---------- APOLLO ----------

// Apollo enforces a per-hour cap (200 on the free plan) and starts returning
// 429 once it's burned. Once we see a 429, skip Apollo for the rest of the
// hour — saves time, avoids spamming, and lets the run fall through to
// Hunter / StoreLeads cleanly. Process-local state is fine because the
// worker runs once per cron tick (or once per CLI invocation).
let apolloExhaustedUntil = 0;
function apolloIsExhausted() { return Date.now() < apolloExhaustedUntil; }
function markApolloExhausted() {
  // Hour-long cooldown by default — Apollo's 429 message says "200 per hour".
  apolloExhaustedUntil = Date.now() + 60 * 60 * 1000;
}

async function apolloSearch(domain) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return null;
  if (apolloIsExhausted()) return null;
  const orgRes = await fetch(`https://api.apollo.io/v1/organizations/enrich?domain=${domain}`, {
    headers: { "X-Api-Key": apiKey },
    signal: AbortSignal.timeout(10_000),
  });
  if (orgRes.status === 429) { markApolloExhausted(); return null; }
  if (!orgRes.ok) return null;
  const orgData = await orgRes.json();
  const personIds = orgData.organization?.org_chart_root_people_ids || [];

  if (personIds.length > 0) {
    const personRes = await fetch("https://api.apollo.io/v1/people/match", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
      body: JSON.stringify({ id: personIds[0] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (personRes.status === 429) { markApolloExhausted(); return null; }
    if (personRes.ok) {
      const data = await personRes.json();
      const p = data.person;
      if (p?.email && p.email_status === "verified" && p.first_name) {
        return {
          email: p.email,
          firstName: p.first_name,
          lastName: p.last_name,
          position: p.title,
          source: "apollo-orgchart",
        };
      }
    }
  }

  const orgName = orgData.organization?.name;
  if (orgName) {
    for (const title of ["CEO", "Founder", "CMO", "Marketing Director"]) {
      if (apolloIsExhausted()) break;
      const res = await fetch("https://api.apollo.io/v1/people/match", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
        body: JSON.stringify({ organization_name: orgName, domain, title }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 429) { markApolloExhausted(); break; }
      if (!res.ok) continue;
      const data = await res.json();
      const p = data.person;
      if (p?.email && p.first_name) {
        return {
          email: p.email,
          firstName: p.first_name,
          lastName: p.last_name,
          position: p.title,
          source: "apollo-match",
        };
      }
    }
  }
  return null;
}

// ---------- HUNTER ----------

let hunterExhaustedUntil = 0;
function hunterIsExhausted() { return Date.now() < hunterExhaustedUntil; }
function markHunterExhausted() {
  // Hunter's plans are typically per-month, but a 429 still means stop for now.
  // 1-hour cooldown matches our Apollo handling — long enough to be useful,
  // short enough that the next cron tick can recover.
  hunterExhaustedUntil = Date.now() + 60 * 60 * 1000;
}

async function hunterSearch(domain) {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) return null;
  if (hunterIsExhausted()) return null;
  // seniority + department filter Hunter's results server-side at no extra
  // cost. Without these we'd get 10 random hits and reject most as junior /
  // wrong-team, burning the credit. With them, the 10 we get back are the
  // ones we actually want — better usable-result rate per credit.
  const params = new URLSearchParams({
    domain,
    api_key: apiKey,
    limit: "10",
    seniority: "executive,senior",
    department: "executive,marketing",
  });
  const res = await fetch(
    `https://api.hunter.io/v2/domain-search?${params.toString()}`,
    { signal: AbortSignal.timeout(10_000) }
  );
  if (res.status === 429) { markHunterExhausted(); return null; }
  if (!res.ok) return null;
  const data = await res.json();
  // Take all emails with a real first_name, ranked by role. We'll then walk
  // through them and return the first one whose local part isn't generic —
  // this catches cases where Hunter has 'CEO' Sarah but only via marketing@.
  const emails = (data.data?.emails || [])
    .filter((e) => e.confidence >= 70 && e.first_name)
    .sort((a, b) => roleScore(b.position) - roleScore(a.position));
  for (const e of emails) {
    const local = e.value.split("@")[0]?.toLowerCase();
    if (isGenericLocal(local)) continue;
    if (isGenericLocal(e.first_name?.toLowerCase())) continue;
    return {
      email: e.value,
      firstName: e.first_name,
      lastName: e.last_name,
      position: e.position,
      confidence: e.confidence,
      source: "hunter",
    };
  }
  return null;
}

async function hunterVerify(email) {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) return "unknown";
  const res = await fetch(
    `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${apiKey}`,
    { signal: AbortSignal.timeout(10_000) }
  );
  if (!res.ok) return "unknown";
  const data = await res.json();
  return data.data?.status || "unknown";
}

function roleScore(positionRaw) {
  const pos = (positionRaw || "").toLowerCase();
  if (/founder|ceo|owner|co-founder|coo|cmo/.test(pos)) return 10;
  if (/marketing|growth|brand|partner|creator|influencer|ecommerce|e-commerce|digital/.test(pos)) return 8;
  if (/director|head of|vp|vice president/.test(pos)) return 6;
  if (/manager/.test(pos)) return 4;
  if (/sales|business dev/.test(pos)) return 3;
  return 1;
}

// ---------- STORELEADS PERSONAL EMAIL FALLBACK ----------

// Accept any non-generic email on the brand's domain, ranked by likelihood
// of being a real person. Returns first name when extractable from the
// local part, otherwise leaves it null and we'll greet generically.
// Comprehensive list of shared-mailbox prefixes that are NOT a single
// decision maker. Anything matching these is rejected outright — we'd
// rather skip a brand than email a shared inbox where the message disappears.
export const GENERIC_MAILBOX_LOCALS = new Set([
  // Generic catch-alls + greetings
  "info", "infor", "information", "atinfo", "hello", "hey", "hi", "ciao",
  "bonjour", "hola", "salut", "contact", "contactus", "contact-us",
  "enquiries", "enquires", "enquiry", "general", "ask", "email", "mail",
  "mailbox", "talk", "chat", "gcc", "applications", "agents",
  // Sales / biz dev (shared)
  "sales", "sale", "biz", "business", "wholesale", "trade", "trades",
  "commercial", "b2b", "deals", "stockists",
  // Press / marketing / brand (shared inboxes, not a person)
  "press", "pr", "media", "marketing", "brand", "branding", "communications",
  "comms", "social", "newsletter", "blog",
  // Operations / brand catch-alls
  "office", "studio", "shop", "store", "online", "web", "team", "theteam",
  "service", "services", "events", "appointments", "bookings", "booking",
  "reservations", "concierge", "clinic", "management", "mgmt", "operations",
  "ops", "retail", "vip", "kontakt", "inquiries", "inquiry",
  // Support / CS / care
  "support", "suppport", "help", "helpme", "helpdesk", "cs", "care", "customer",
  "customers", "customerservice", "customercare", "custserv", "service-desk",
  "complaints", "complaint", "feedback", "refunds", "refund", "returns",
  "return", "exchange", "exchanges", "eusupport", "emailcontact",
  // Orders / transactional
  "orders", "order", "shipping", "tracking", "fulfillment",
  // Partnerships (often goes to shared mailbox)
  "partners", "partnerships", "partnership", "collab", "collabs", "collaborations",
  "affiliates", "affiliate", "ambassadors", "ambassador", "creators", "creator",
  "influencers", "influencer", "connect",
  // Finance / legal / admin
  "billing", "accounts", "finance", "invoices", "ar", "ap", "legal", "compliance",
  "privacy", "gdpr", "dpo", "investor", "ir",
  // HR / recruitment
  "hr", "jobs", "careers", "recruitment", "recruiting", "talent",
  // System
  "noreply", "no-reply", "donotreply", "do-not-reply", "abuse", "spam",
  "postmaster", "mailer-daemon", "unsubscribe", "verify", "webmaster",
  "hostmaster", "security", "data", "admin",
]);

export function isGenericLocal(local) {
  if (!local) return true;
  const l = local.toLowerCase();
  if (GENERIC_MAILBOX_LOCALS.has(l)) return true;
  // Compound forms separated by . - _ (e.g. customer.service, the.team).
  const parts = l.split(/[._-]+/);
  if (parts.length > 1 && parts.every((p) => GENERIC_MAILBOX_LOCALS.has(p) || p.length <= 2)) return true;
  // Substring match against high-confidence shared-mailbox tokens. Catches
  // typos and compounds like 'eusupport', 'helpme', 'suppport', 'custserv'
  // that won't ever be a person's name.
  if (/(support|service|helpdesk|customercare|custserv|enquir|inquir|complaint|refund|return|booking|tracking|fulfillment|wholesale|partnership|affiliate|ambassador|influencer|marketing|newsletter|noreply|donotreply|webmaster|postmaster|unsubscribe)/i.test(l)) return true;
  return false;
}

function pickPersonalFromStoreLeads(domain, contactInfo) {
  const emails = (contactInfo || [])
    .filter((c) => c.type === "email" && c.value)
    .map((c) => c.value.toLowerCase().trim());
  if (emails.length === 0) return null;

  const root = domain.replace(/^www\./, "").split(".")[0];

  let scored = [];
  for (const e of emails) {
    const local = e.split("@")[0];
    const dom = e.split("@")[1] || "";
    if (!dom.includes(root)) continue;
    if (isGenericLocal(local)) continue; // catches shared mailboxes incl. compounds

    let score = 0;
    let firstName = null;
    let lastName = null;

    // first.last@ pattern → highest signal IF first half looks like a real
    // first name (rejects customer.service@, partner.relations@, etc.).
    const dotMatch = local.match(/^([a-z]+)\.([a-z]+)$/);
    if (dotMatch && isLikelyFirstName(dotMatch[1]) && !isGenericLocal(dotMatch[2])) {
      score = 100;
      firstName = cap(dotMatch[1]);
      lastName = cap(dotMatch[2]);
    } else if (/^(founder|ceo|owner|cofounder|coo|cmo)$/i.test(local)) {
      // Role-only local — accept but flag (no firstName, generic greeting).
      score = 80;
      firstName = null;
    } else if (isLikelyFirstName(local)) {
      // Single-word local that matches a known first name (sara@, tom@,
      // marco@). Whitelist-based — was previously a blacklist which let
      // through custom@, consumercare@, gcc@, etc.
      score = 70;
      firstName = cap(local);
    } else {
      // Anything else (numbers, weird patterns, unknown words) — skip.
      continue;
    }

    scored.push({ email: e, score, firstName, lastName });
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  // Require an actual personal signal (firstName) — no more generic role locals.
  if (!best || !best.firstName) return null;
  return {
    email: best.email,
    firstName: best.firstName,
    lastName: best.lastName,
    position: null,
    source: "storeleads-personal",
  };
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
