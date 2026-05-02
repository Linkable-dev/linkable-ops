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
      try {
        const result = await processOneBrand({ teamId, brand });
        counters.processed++;
        if (result.qualified) counters.sent++;
        else counters.skipped++;
      } catch (err) {
        counters.processed++;
        counters.failed++;
        console.error(`brand ${brand.name} failed:`, err.message);
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
}

// ---------- ONE BRAND ----------

async function processOneBrand({ teamId, brand }) {
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

  // Best-effort person finder: Apollo first (richer org chart), Hunter as backup.
  let person = null;
  if (process.env.APOLLO_API_KEY) {
    person = await apolloSearch(cleanDomain).catch(() => null);
  }
  if (!person && process.env.HUNTER_API_KEY) {
    person = await hunterSearch(cleanDomain).catch(() => null);
  }

  // StoreLeads contact_info often has personal emails too — last fallback.
  if (!person) {
    const fromStoreleads = pickPersonalFromStoreLeads(cleanDomain, brand.contact_info);
    if (fromStoreleads) person = fromStoreleads;
  }

  if (!person?.email) {
    return persistAndReturn({ qualified: false, reason: "no email on brand" });
  }

  // Final guard: regardless of source, reject generic shared-mailbox emails.
  // (Apollo/Hunter usually filter these but the StoreLeads fallback or stale
  // data can still surface them.)
  const local = person.email.split("@")[0]?.toLowerCase();
  if (GENERIC_MAILBOX_LOCALS.has(local)) {
    return persistAndReturn({ qualified: false, reason: `generic mailbox (${local}@)`, person });
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

  // Verify only if Hunter is alive (skip when key missing or rate-limited).
  let hunterStatus = null;
  if (person.source !== "apollo-orgchart" && process.env.HUNTER_API_KEY) {
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

async function apolloSearch(domain) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return null;
  const orgRes = await fetch(`https://api.apollo.io/v1/organizations/enrich?domain=${domain}`, {
    headers: { "X-Api-Key": apiKey },
    signal: AbortSignal.timeout(10_000),
  });
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
      const res = await fetch("https://api.apollo.io/v1/people/match", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
        body: JSON.stringify({ organization_name: orgName, domain, title }),
        signal: AbortSignal.timeout(10_000),
      });
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

async function hunterSearch(domain) {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) return null;
  const res = await fetch(
    `https://api.hunter.io/v2/domain-search?domain=${domain}&api_key=${apiKey}&limit=5`,
    { signal: AbortSignal.timeout(10_000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const emails = (data.data?.emails || [])
    .filter((e) => e.confidence >= 70 && e.first_name)
    .sort((a, b) => roleScore(b.position) - roleScore(a.position));
  if (emails.length === 0) return null;

  const GENERIC = ["hello", "info", "contact", "hi", "team", "support", "help", "cs", "admin", "sales", "press", "pr", "media", "service", "noreply", "wholesale", "billing", "legal", "privacy", "hr", "careers"];
  const best = emails[0];
  const local = best.value.split("@")[0].toLowerCase();
  if (GENERIC.includes(local)) {
    const alt = emails.find((e) => !GENERIC.includes(e.value.split("@")[0].toLowerCase()));
    if (!alt) return null;
    return {
      email: alt.value,
      firstName: alt.first_name,
      lastName: alt.last_name,
      position: alt.position,
      confidence: alt.confidence,
      source: "hunter",
    };
  }
  return {
    email: best.value,
    firstName: best.first_name,
    lastName: best.last_name,
    position: best.position,
    confidence: best.confidence,
    source: "hunter",
  };
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
  // Generic catch-alls
  "info", "hello", "hi", "contact", "enquiries", "enquiry", "general",
  // Sales/biz dev (shared)
  "sales", "biz", "business", "wholesale", "trade", "trades",
  // Press/marketing (when shared, not a person)
  "press", "pr", "media",
  // Operations
  "office", "studio", "shop", "store", "online", "web", "team", "service", "services",
  // Support/CS
  "support", "help", "cs", "customerservice", "customercare", "service-desk",
  // Orders/transactional
  "orders", "order", "returns", "shipping", "tracking",
  // Partnerships (often goes to shared mailbox)
  "partners", "partnerships", "partnership", "collab", "collabs", "collaborations",
  // Finance/legal/admin
  "billing", "accounts", "finance", "invoices", "ar", "ap", "legal", "compliance",
  "privacy", "gdpr", "dpo", "investor", "ir",
  // HR/recruitment
  "hr", "jobs", "careers", "recruitment", "recruiting", "talent",
  // System
  "noreply", "no-reply", "donotreply", "do-not-reply", "abuse", "spam",
  "postmaster", "mailer-daemon", "unsubscribe", "verify", "webmaster",
  "hostmaster", "security", "data", "admin",
]);

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
    if (GENERIC_MAILBOX_LOCALS.has(local)) continue;   // never accept shared mailboxes

    let score = 0;
    let firstName = null;
    let lastName = null;
    let position = null;

    // first.last@ pattern → highest signal, real person.
    const dotMatch = local.match(/^([a-z]+)\.([a-z]+)$/);
    if (dotMatch) {
      score = 100;
      firstName = cap(dotMatch[1]);
      lastName = cap(dotMatch[2]);
    } else if (/^(founder|ceo|owner)/i.test(local)) {
      score = 90;
      position = local;
    } else if (/^(marketing|partnership|brand|growth|creator|influencer)/i.test(local)) {
      // Only accept role-style locals when explicitly partnerships/marketing —
      // even then we don't have a person, so we score lower.
      score = 60;
      position = local;
    } else if (/^[a-z]{2,12}$/.test(local) && !GENERIC_MAILBOX_LOCALS.has(local)) {
      // Single-word personal name (sara@, tom@, marco@). Real person signal.
      score = 70;
      firstName = cap(local);
    } else {
      // Anything else (numbers, weird patterns) — skip.
      continue;
    }

    scored.push({ email: e, score, firstName, lastName, position });
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  // Only return if we have an actual person signal (firstName) or a
  // partnership-style role local. Generic mailboxes are out.
  if (!best || (!best.firstName && !best.position)) return null;
  return {
    email: best.email,
    firstName: best.firstName,
    lastName: best.lastName,
    position: best.position,
    source: "storeleads-personal",
  };
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
