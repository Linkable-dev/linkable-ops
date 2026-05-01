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

export async function startLeadDiscovery({ teamId, campaignId, filters = {}, limit = 50 }) {
  if (!process.env.STORELEADS_KEY) {
    throw new Error("STORELEADS_KEY not set");
  }
  const run = await createBulkRun({
    teamId,
    campaignId,
    source: "discover_storeleads",
    filters,
    total: limit,
  });

  processDiscovery(run.id, teamId, campaignId, filters, limit).catch((err) => {
    console.error(`discovery run ${run.id} failed:`, err);
    updateBulkRun(run.id, {
      status: "failed",
      error: err.message,
      completed_at: new Date().toISOString(),
    }).catch(() => {});
  });

  return { run_id: run.id, target: limit };
}

async function processDiscovery(runId, teamId, campaignId, filters, limit) {
  const counters = { processed: 0, sent: 0, skipped: 0, failed: 0 };
  let cursor = null;
  let cancelled = false;

  while (counters.sent < limit && !cancelled) {
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

    for (const brand of batch.domains) {
      if (counters.sent >= limit || cancelled) break;
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
    return { qualified: false, reason: "no email on brand" };
  }

  // Role filter only when we have a stated position. Apollo / Hunter return
  // titles; StoreLeads-personal usually doesn't, so we don't gate on it.
  const pos = (person.position || "").toLowerCase();
  if (pos) {
    const isFounder = /founder|ceo|owner|co-founder|coo|cto|president/.test(pos);
    const isMarketing = /marketing|cmo|growth|brand|ecommerce|e-commerce|digital|creator|influencer|partnership/.test(pos);
    const fromOrgChart = person.source === "apollo-orgchart";
    const fromGenericLocal = person.source === "storeleads-personal" && !person.firstName;
    if (!isFounder && !isMarketing && !fromOrgChart && !fromGenericLocal) {
      return { qualified: false, reason: `role ${person.position} not target` };
    }
  }

  // Verify only if Hunter is alive (skip when key missing or rate-limited).
  if (person.source !== "apollo-orgchart" && process.env.HUNTER_API_KEY) {
    const status = await hunterVerify(person.email).catch(() => "unknown");
    if (status === "invalid") return { qualified: false, reason: "Hunter says invalid" };
    // 429 etc. → "unknown" → we keep the lead, accepting the deliverability risk.
  }

  // Write to storeleads_brands. The bulk runner reads from this table when
  // source = "storeleads".
  const emails = (brand.contact_info || []).filter((c) => c.type === "email").map((c) => c.value);
  await supabase.from("storeleads_brands").upsert(
    {
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
      language_code: brand.language_code || null,
      email: person.email,
      contact_first_name: person.firstName,
      contact_last_name: person.lastName,
      contact_position: person.position,
      emails,
      contact_info: brand.contact_info || [],
      avg_price: brand.avg_price_formatted || null,
      created_at_storeleads: brand.created_at || null,
      last_updated_at: brand.last_updated_at || null,
      trustpilot_rating: brand.trustpilot?.avg_rating || null,
      trustpilot_reviews: brand.trustpilot?.review_count || null,
      about_us: brand.about_us || null,
      contact_page: brand.contact_page || null,
      raw_data: brand,
      imported_at: new Date().toISOString(),
    },
    { onConflict: "domain" }
  );

  return { qualified: true, email: person.email, name: person.firstName };
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
  if (filters.categories?.length) {
    conjuncts.push({
      field: "cat",
      operator: "or",
      analyzer: "advanced",
      match: filters.categories.join(" "),
    });
  } else {
    // Default: beauty + wellness
    conjuncts.push({
      field: "cat",
      operator: "or",
      analyzer: "advanced",
      match: "/Beauty...&...Fitness /Beauty...&...Fitness/Face...&...Body...Care /Beauty...&...Fitness/Face...&...Body...Care/Skin...&...Nail...Care /Health/Nutrition /Beauty...&...Fitness/Face...&...Body...Care/Make-Up...&...Cosmetics /Beauty...&...Fitness/Face...&...Body...Care/Perfumes...&...Fragrances",
    });
  }
  return JSON.stringify({ must: { conjuncts } });
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
function pickPersonalFromStoreLeads(domain, contactInfo) {
  const emails = (contactInfo || [])
    .filter((c) => c.type === "email" && c.value)
    .map((c) => c.value.toLowerCase().trim());
  if (emails.length === 0) return null;

  const root = domain.replace(/^www\./, "").split(".")[0];
  const HARD_REJECT = new Set(["support", "help", "orders", "returns", "billing", "legal", "jobs", "careers", "wholesale", "privacy", "noreply", "no-reply", "abuse", "spam", "postmaster", "mailer-daemon", "unsubscribe", "donotreply", "customerservice", "customercare", "cs", "compliance", "verify", "webmaster", "admin", "hostmaster", "security", "recruitment", "hr", "finance", "accounts", "investor", "ir", "gdpr", "dpo", "data"]);
  const SOFT_REJECT = new Set(["hello", "hi", "info", "contact", "team", "press", "pr", "media", "service"]);

  let scored = [];
  for (const e of emails) {
    const local = e.split("@")[0];
    const dom = e.split("@")[1] || "";
    if (!dom.includes(root)) continue;
    if (HARD_REJECT.has(local)) continue;

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
    } else if (/^founder|ceo|owner/i.test(local)) {
      score = 90;
      position = local;
    } else if (/^marketing|partnerships?|brand|growth|creators?|influencers?/i.test(local)) {
      score = 80;
      position = local;
    } else if (/^[a-z]{2,12}$/.test(local) && !SOFT_REJECT.has(local)) {
      // Single-word personal name (sara@, tom@, marco@). Likely a real person.
      score = 70;
      firstName = cap(local);
    } else if (SOFT_REJECT.has(local)) {
      // Fallback: hello@, info@ — accept but mark generic, no first name.
      score = 30;
    } else {
      // Other patterns: accept conservatively.
      score = 40;
    }

    scored.push({ email: e, score, firstName, lastName, position });
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score === 0) return null;
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
