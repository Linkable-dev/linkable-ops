#!/usr/bin/env node
// Outreach using StoreLeads API for brand discovery
// Flow: Fetch brands from StoreLeads → Store in Supabase → Send emails
// Only sends to brands with verified emails from StoreLeads

import { supabase } from "../lib/supabase.js";
import { TEMPLATES, getPrimaryProductType, pickTemplate } from "./templates.js";
import { generateObservation, renderTemplate, validateRenderedEmail } from "./personalize.js";
import { sendEmail } from "./send.js";

const TEAM_ID = "a0000000-0000-0000-0000-000000000001";
const STORELEADS_KEY = process.env.STORELEADS_KEY;
const HUNTER_API_KEY = process.env.HUNTER_API_KEY;
const APOLLO_API_KEY = process.env.APOLLO_API_KEY;
if (!STORELEADS_KEY || !HUNTER_API_KEY || !APOLLO_API_KEY) {
  console.error("Missing env: STORELEADS_KEY, HUNTER_API_KEY, APOLLO_API_KEY required");
  process.exit(1);
}
const MAX_EMAILS = 5000;
const DEADLINE = new Date(Date.now() + 6 * 3600000);
const FROM = "Federico from Linkable <brand@linkable.link>";
const REPLY_TO = "federico@linkable.link";
const DELAY_MS = 20000; // 20s between sends

let sent = 0;
let failed = 0;
let skipped = 0;
let totalAlreadySent = 0;
let campaignId = null;

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function pastDeadline() { return new Date() >= DEADLINE; }

// Find best contact via Hunter.io — returns person with name + verified email
async function hunterSearch(domain) {
  try {
    const res = await fetch(
      `https://api.hunter.io/v2/domain-search?domain=${domain}&api_key=${HUNTER_API_KEY}&limit=5`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return null;
    const data = await res.json();

    const emails = (data.data?.emails || [])
      .filter(e => e.confidence >= 70 && e.first_name) // must have a name = real person
      .sort((a, b) => {
        // Prioritize: founder > marketing > director > manager
        const roleScore = (e) => {
          const pos = (e.position || "").toLowerCase();
          if (/founder|ceo|owner|co-founder|coo|cmo/.test(pos)) return 10;
          if (/marketing|growth|brand|partner|creator|influencer|ecommerce|e-commerce|digital/.test(pos)) return 8;
          if (/director|head of|vp|vice president/.test(pos)) return 6;
          if (/manager/.test(pos)) return 4;
          if (/sales|business dev/.test(pos)) return 3;
          return 1;
        };
        return roleScore(b) - roleScore(a);
      });

    if (emails.length === 0) return null;

    // Priority 1: founder/C-suite person
    // Priority 2: marketing/growth/brand person
    // Priority 3: any named person with high confidence
    const best = emails[0];

    // Reject if the email itself is generic (Hunter sometimes returns hello@ with a name attached)
    const local = best.value.split("@")[0].toLowerCase();
    const GENERIC = ["hello", "info", "contact", "hi", "team", "support", "help", "cs", "admin", "sales", "press", "pr", "media", "service", "noreply", "wholesale", "billing", "legal", "privacy", "hr", "careers"];
    if (GENERIC.includes(local)) {
      // Try next person
      const alt = emails.find(e => !GENERIC.includes(e.value.split("@")[0].toLowerCase()));
      if (!alt) return null;
      return { email: alt.value, firstName: alt.first_name || null, lastName: alt.last_name || null, position: alt.position || null, confidence: alt.confidence };
    }

    return {
      email: best.value,
      firstName: best.first_name || null,
      lastName: best.last_name || null,
      position: best.position || null,
      confidence: best.confidence,
    };
  } catch {
    return null;
  }
}

// Verify email via Hunter.io
async function hunterVerify(email) {
  try {
    const res = await fetch(
      `https://api.hunter.io/v2/email-verifier?email=${email}&api_key=${HUNTER_API_KEY}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return "unknown";
    const data = await res.json();
    return data.data?.status || "unknown"; // valid, invalid, accept_all, unknown
  } catch {
    return "unknown";
  }
}

// Find decision maker via Apollo — org enrich → get top person → get email
async function apolloSearch(domain) {
  try {
    // Step 1: Get org chart root person ID
    const orgRes = await fetch(`https://api.apollo.io/v1/organizations/enrich?domain=${domain}`, {
      headers: { "X-Api-Key": APOLLO_API_KEY },
      signal: AbortSignal.timeout(10000),
    });
    if (!orgRes.ok) return null;
    const orgData = await orgRes.json();
    const personIds = orgData.organization?.org_chart_root_people_ids || [];

    if (personIds.length > 0) {
      // Step 2: Get person by ID
      const personRes = await fetch("https://api.apollo.io/v1/people/match", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": APOLLO_API_KEY },
        body: JSON.stringify({ id: personIds[0] }),
        signal: AbortSignal.timeout(10000),
      });
      if (personRes.ok) {
        const personData = await personRes.json();
        const p = personData.person;
        if (p?.email && p.email_status === "verified" && p.first_name) {
          return { email: p.email, firstName: p.first_name, lastName: p.last_name, position: p.title, source: "apollo-orgchart" };
        }
      }
    }

    // Fallback: try people/match with org name + common founder titles
    const orgName = orgData.organization?.name;
    if (orgName) {
      for (const title of ["CEO", "Founder", "CMO", "Marketing Director"]) {
        const res = await fetch("https://api.apollo.io/v1/people/match", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Api-Key": APOLLO_API_KEY },
          body: JSON.stringify({ organization_name: orgName, domain, title }),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) continue;
        const data = await res.json();
        const p = data.person;
        if (p?.email && p.first_name) {
          return { email: p.email, firstName: p.first_name, lastName: p.last_name, position: p.title, source: "apollo-match" };
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

// Check DB if this email domain was already contacted
async function isAlreadySent(emailDomain) {
  const root = emailDomain.split(".")[0];
  const { data } = await supabase
    .from("email_sends")
    .select("to_email")
    .eq("team_id", TEAM_ID)
    .eq("status", "sent")
    .ilike("to_email", `%${root}%`)
    .limit(1);
  return data?.length > 0;
}

// StoreLeads query: Shopify, US+UK, $50k-$100k/mo, Beauty & Wellness categories
const STORELEADS_BQ = "bq=%7B%22must%22%3A%7B%22conjuncts%22%3A%5B%7B%22field%22%3A%22p%22%2C%22operator%22%3A%22or%22%2C%22analyzer%22%3A%22advanced%22%2C%22match%22%3A%221%22%7D%2C%7B%22field%22%3A%22er%22%2C%22min%22%3A5000000%2C%22max%22%3A10000000%2C%22inclusive_min%22%3Atrue%2C%22inclusive_max%22%3Atrue%7D%2C%7B%22field%22%3A%22cc%22%2C%22operator%22%3A%22or%22%2C%22analyzer%22%3A%22advanced%22%2C%22match%22%3A%22US%20GB%22%7D%2C%7B%22field%22%3A%22cat%22%2C%22operator%22%3A%22or%22%2C%22analyzer%22%3A%22advanced%22%2C%22match%22%3A%22%2FApparel%20%2FBeauty...%26...Fitness%20%2FBeauty...%26...Fitness%2FFace...%26...Body...Care%20%2FBeauty...%26...Fitness%2FFace...%26...Body...Care%2FSkin...%26...Nail...Care%20%2FHealth%2FNutrition%20%2FBeauty...%26...Fitness%2FFace...%26...Body...Care%2FMake-Up...%26...Cosmetics%20%2FBeauty...%26...Fitness%2FFitness%20%2FBeauty...%26...Fitness%2FFace...%26...Body...Care%2FPerfumes...%26...Fragrances%22%7D%5D%7D%7D";

// Fetch brands with cursor pagination + retry
let nextCursor = null;

async function fetchStoreLeadsNext() {
  const url = nextCursor
    ? `https://storeleads.app/json/api/v1/all/domain?${STORELEADS_BQ}&cursor=${encodeURIComponent(nextCursor)}`
    : `https://storeleads.app/json/api/v1/all/domain?${STORELEADS_BQ}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "Authorization": `Bearer ${STORELEADS_KEY}` },
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new Error(`StoreLeads API error: ${res.status}`);
      const data = await res.json();
      nextCursor = data.has_next_page ? data.next_cursor : null;
      return { domains: data.domains || [], hasMore: !!data.has_next_page };
    } catch (e) {
      console.log(`  Attempt ${attempt} failed: ${e.message}`);
      if (attempt < 3) await delay(5000);
      else throw e;
    }
  }
}

// Extract best email from StoreLeads contact_info
function getBestEmail(domain, contactInfo) {
  const emails = (contactInfo || [])
    .filter(c => c.type === "email")
    .map(c => c.value?.toLowerCase().trim())
    .filter(Boolean);

  if (emails.length === 0) return null;

  const domainRoot = domain.replace(/^www\./, "").split(".")[0];

  // Hard reject list — never send to these
  const REJECT = ["support", "help", "orders", "returns", "billing", "legal", "jobs", "careers",
    "wholesale", "privacy", "noreply", "no-reply", "dmca", "copyright", "abuse", "spam",
    "jubao", "postmaster", "mailer-daemon", "unsubscribe", "donotreply", "customerservice",
    "customercare", "cs", "compliance", "verify", "apacinfo", "intl", "webmaster",
    "admin", "hostmaster", "security", "recruitment", "hr", "finance", "accounts",
    "bookkeeping", "investor", "ir", "gdpr", "dpo", "data"];

  const scored = emails.map(e => {
    const local = e.split("@")[0];
    const emailDom = e.split("@")[1];
    let score = 0;

    // Must be from brand's domain
    if (!emailDom?.includes(domainRoot)) return { email: e, score: -10 };
    score += 10;

    // Hard reject
    if (REJECT.some(k => local === k || local.startsWith(k + "."))) return { email: e, score: -10 };

    // Only want decision makers — founder, marketing, partnerships
    if (["founder", "ceo", "owner", "cofounder"].some(k => local.includes(k))) score += 10;
    if (/^[a-z]+\.[a-z]+$/.test(local)) score += 9; // first.last = personal email
    if (/^[a-z]{2,12}$/.test(local) && !REJECT.includes(local) && !["hello", "hi", "info", "contact", "team", "press", "pr", "media"].includes(local)) score += 8; // personal name
    if (["marketing", "partnerships", "collab", "brand", "creators", "influencers", "growth"].some(k => local.includes(k))) score += 7;

    // Reject generic emails — we only want people
    if (["hello", "hi", "info", "contact", "team", "press", "pr", "media"].includes(local)) return { email: e, score: -1 };

    return { email: e, score };
  }).filter(e => e.score > 0).sort((a, b) => b.score - a.score);

  return scored[0]?.email || null;
}

// Store brand in storeleads_brands table
async function storeBrand(domain, data) {
  const emails = (data.contact_info || []).filter(c => c.type === "email").map(c => c.value);
  const bestEmail = getBestEmail(domain, data.contact_info);

  await supabase.from("storeleads_brands").upsert({
    domain: domain.replace(/^www\./, ""),
    merchant_name: data.merchant_name || null,
    title: data.title || null,
    description: data.description || null,
    platform: data.platform || null,
    plan: data.plan || null,
    country_code: data.country_code || null,
    currency_code: data.currency_code || null,
    city: data.city || null,
    language_code: data.language_code || null,
    email: bestEmail,
    emails: emails,
    contact_info: data.contact_info || [],
    avg_price: data.avg_price_formatted || null,
    created_at_storeleads: data.created_at || null,
    last_updated_at: data.last_updated_at || null,
    trustpilot_rating: data.trustpilot?.avg_rating || null,
    trustpilot_reviews: data.trustpilot?.review_count || null,
    about_us: data.about_us || null,
    contact_page: data.contact_page || null,
    career_page: data.career_page || null,
    raw_data: data,
    imported_at: new Date().toISOString(),
  }, { onConflict: "domain" });

  return bestEmail;
}

// Process a single brand
async function processBrand(domainData, index) {
  const cleanDomain = (domainData.name || "").replace(/^www\./, "").toLowerCase();
  if (!cleanDomain) return "skip";

  let email = await storeBrand(cleanDomain, domainData);
  let contactFirstName = null;
  let contactLastName = null;
  let contactPosition = null;
  let emailSource = "storeleads";

  // Email finder chain: Apollo → Hunter → StoreLeads personal emails
  // 1. Try Apollo (free, large database)
  const apollo = await apolloSearch(cleanDomain);
  if (apollo) {
    email = apollo.email;
    contactFirstName = apollo.firstName;
    contactLastName = apollo.lastName;
    contactPosition = apollo.position;
    emailSource = "apollo";
    console.log(`  Apollo: ${email} (${apollo.firstName} ${apollo.lastName}, ${apollo.position})`);
  }

  // 2. If Apollo didn't find anyone, try Hunter (limited credits)
  if (!email || /^(hello|info|contact|hi|team|support|help)@/i.test(email)) {
    const hunter = await hunterSearch(cleanDomain);
    if (hunter) {
      email = hunter.email;
      contactFirstName = hunter.firstName;
      contactLastName = hunter.lastName;
      contactPosition = hunter.position;
      emailSource = "hunter";
      console.log(`  Hunter: ${email} (${hunter.firstName} ${hunter.lastName}, ${hunter.position}, ${hunter.confidence}%)`);
    }
  }

  // 3. StoreLeads email is the last resort (already set from storeBrand above)

  // STRICT: Only send if we KNOW it's a real person (from Apollo/Hunter with name)
  // or the email is clearly first.last@ / first_last@ pattern
  if (!email) { skipped++; console.log(`  SKIP: no email found`); return "skip"; }
  const localPart = email.split("@")[0].toLowerCase();

  // If email came from Apollo or Hunter with a verified first name — trust it
  const fromPersonFinder = (emailSource === "apollo" || emailSource === "hunter") && contactFirstName;

  if (!fromPersonFinder) {
    // Without Apollo/Hunter verification — reject everything
    // We only want verified founders/marketing people
    skipped++;
    console.log(`  SKIP: ${email} — no verified person found`);
    return "skip";
  }

  // Apollo/Hunter found someone — only accept founders or marketing people
  const pos = (contactPosition || "").toLowerCase();
  const isFounder = /founder|ceo|owner|co-founder|coo|cto|president/.test(pos);
  const isMarketing = /marketing|cmo|growth|brand|ecommerce|e-commerce|digital|creator|influencer|partnership/.test(pos);
  if (!isFounder && !isMarketing) {
    skipped++;
    console.log(`  SKIP: ${email} — ${contactPosition} (not founder/marketing)`);
    return "skip";
  }

  // Verify via Hunter if it's from StoreLeads (Hunter results are pre-verified)
  if (emailSource === "storeleads") {
    const status = await hunterVerify(email);
    if (status === "invalid") {
      skipped++;
      console.log(`  SKIP: ${email} — invalid (Hunter verified)`);
      return "skip";
    }
  }

  // Check if this exact email was already sent
  const { data: exactMatch } = await supabase
    .from("email_sends").select("id").eq("team_id", TEAM_ID).eq("status", "sent")
    .eq("to_email", email).limit(1);
  if (exactMatch?.length > 0) {
    skipped++;
    console.log(`  SKIP: ${email} — exact email already sent`);
    return "skip";
  }

  // Domain dedup — but allow resend if new email is a verified person (different from previous)
  const emailDomain = email.split("@")[1];
  const alreadySent = await isAlreadySent(emailDomain);
  if (alreadySent && !fromPersonFinder) {
    skipped++;
    console.log(`  SKIP: ${emailDomain} already contacted (no new personal email)`);
    return "skip";
  }
  if (alreadySent && fromPersonFinder) {
    console.log(`  RESEND: ${emailDomain} — found decision maker → ${contactFirstName} ${contactLastName}, ${contactPosition}`);
  }

  const template = pickTemplate(index, TEMPLATES);

  // Rich personalization using StoreLeads data
  const brandName = domainData.merchant_name || cleanDomain.split(".")[0].replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const desc = domainData.description || "";
  const categories = (domainData.categories || []).join(" ");
  const productType = getPrimaryProductType([], [], desc + " " + categories + " " + cleanDomain);
  const productCount = domainData.product_count || null;
  const firstName = contactFirstName || "there";

  console.log(`[${totalAlreadySent + sent + 1}/${MAX_EMAILS}] ${cleanDomain} → ${email} — Template ${template.variant} (${productType})`);

  // Build observation using StoreLeads data — for templates A and D
  let observation = "";
  if (template.variant === "A" || template.variant === "D") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      try {
        const socialInfo = (domainData.contact_info || [])
          .filter(c => ["instagram", "tiktok"].includes(c.type) && c.followers)
          .map(c => `${c.type}: ${c.followers.toLocaleString()} followers`)
          .join(", ");

        observation = await generateObservation({
          storeName: brandName, domain: cleanDomain,
          sampleTypes: [], matchedKeywords: categories.split(" "),
          productCount, country: domainData.country_code,
          brandInfo: {
            brandStory: desc,
            hasCreators: (domainData.contact_info || []).some(c => c.description?.toLowerCase().includes("creator")),
            hasInfluencers: (domainData.contact_info || []).some(c => c.description?.toLowerCase().includes("influencer")),
            socialFollowing: socialInfo,
          },
        }, apiKey);
      } catch {}
    }
    if (!observation) {
      // Build a data-driven fallback
      const social = (domainData.contact_info || []).find(c => c.type === "instagram" && c.followers);
      if (social && social.followers > 10000) {
        observation = `With ${social.followers.toLocaleString()} followers on Instagram, ${brandName} clearly has a strong community — the kind of audience that could translate into a powerful creator sales channel.`;
      } else if (productCount && productCount > 50) {
        observation = `With ${productCount}+ products and a growing catalog, ${brandName} looks like a brand that's ready to scale — and creator partnerships could be a big part of that.`;
      } else if (desc) {
        observation = `I came across ${brandName} — "${desc.slice(0, 120)}". It's the kind of brand creators love to talk about.`;
      } else {
        observation = `I came across ${brandName} and was genuinely impressed by what you've built.`;
      }
    }
  }

  const vars = {
    brandName, firstName, domain: cleanDomain, productType,
    country: domainData.country_code || "", observation,
    productCount: productCount || "", description: desc,
  };
  const subject = renderTemplate(template.subject_template, vars);
  const body = renderTemplate(template.body_template, vars);

  const validation = validateRenderedEmail(subject, body);
  if (!validation.valid) { skipped++; return "skip"; }

  // Ensure contact in CRM
  let contactId = null;
  const { data: existing } = await supabase
    .from("contacts").select("id").eq("team_id", TEAM_ID).eq("domain", cleanDomain).single();

  if (existing) {
    contactId = existing.id;
    await supabase.from("contacts").update({ email }).eq("id", contactId);
  } else {
    const { data: newContact } = await supabase.from("contacts")
      .insert({ team_id: TEAM_ID, name: brandName, company: brandName, domain: cleanDomain, email, stage: "Lead", source: "storeleads", country: domainData.country_code || "", created_at: new Date().toISOString() })
      .select().single();
    contactId = newContact?.id;
  }

  // Save + send
  const { data: sendRecord } = await supabase.from("email_sends")
    .insert({ campaign_id: campaignId, team_id: TEAM_ID, contact_id: contactId, template_variant: template.variant, to_email: email, to_name: brandName, subject, body, status: "pending" })
    .select().single();

  const result = await sendEmail({ to: email, toName: brandName, subject, body, from: FROM, replyTo: REPLY_TO, resendApiKey: process.env.RESEND_API_KEY });

  if (result.success) {
    sent++;
    console.log(`  SENT ✓`);
    await supabase.from("email_sends").update({ status: "sent", resend_id: result.resendId, sent_at: new Date().toISOString() }).eq("id", sendRecord.id);
    await supabase.from("contacts").update({ stage: "Contacted" }).eq("id", contactId);
    await supabase.from("storeleads_brands").update({ emailed: true, emailed_at: new Date().toISOString() }).eq("domain", cleanDomain);
    await supabase.from("activities").insert({ contact_id: contactId, team_id: TEAM_ID, type: "email_sent", description: `Outreach email sent (Template ${template.variant})`, created_at: new Date().toISOString() });
  } else {
    failed++;
    console.log(`  FAILED: ${result.error}`);
    await supabase.from("email_sends").update({ status: "failed", error: result.error }).eq("id", sendRecord.id);
  }

  if ((sent + failed) % 10 === 0) {
    await supabase.from("email_campaigns").update({ emails_sent: sent, emails_failed: failed, emails_skipped: skipped, total_contacts: sent + failed + skipped }).eq("id", campaignId);
  }

  await delay(DELAY_MS);
  return result.success ? "sent" : "failed";
}

async function main() {
  console.log("=== Linkable Outreach — StoreLeads ===\n");

  if (!process.env.RESEND_API_KEY) { console.error("RESEND_API_KEY not set"); process.exit(1); }

  // Count already sent
  const { count } = await supabase.from("email_sends").select("id", { count: "exact", head: true }).eq("team_id", TEAM_ID).eq("status", "sent");
  totalAlreadySent = count || 0;
  const remaining = MAX_EMAILS - totalAlreadySent;

  console.log(`Already sent: ${totalAlreadySent}`);
  console.log(`Need: ${remaining} more`);
  console.log(`Deadline: ${DEADLINE.toISOString()}\n`);

  if (remaining <= 0) { console.log("Target reached."); process.exit(0); }

  // Create campaign
  const { data: campaign } = await supabase.from("email_campaigns")
    .insert({ team_id: TEAM_ID, name: `StoreLeads Outreach ${new Date().toISOString().split("T")[0]}`, status: "running", source: "storeleads", started_at: new Date().toISOString() })
    .select().single();
  campaignId = campaign.id;

  // Fetch from StoreLeads using cursor pagination
  let batch = 1;
  let index = 0;

  while (totalAlreadySent + sent < MAX_EMAILS && !pastDeadline()) {
    console.log(`--- StoreLeads batch ${batch} ---`);
    let result;
    try {
      result = await fetchStoreLeadsNext();
    } catch (e) {
      console.log(`  API error: ${e.message}`);
      break;
    }

    if (result.domains.length === 0) {
      console.log("  No more domains from StoreLeads.");
      break;
    }

    console.log(`  Got ${result.domains.length} brands (hasMore: ${result.hasMore})`);

    for (const domainData of result.domains) {
      if (totalAlreadySent + sent >= MAX_EMAILS || pastDeadline()) break;
      const res = await processBrand(domainData, index);
      if (res === "sent" || res === "failed") index++;
    }

    if (!result.hasMore) {
      console.log("  Reached end of StoreLeads list.");
      break;
    }

    batch++;
  }

  // Final
  await supabase.from("email_campaigns").update({
    status: "complete", emails_sent: sent, emails_failed: failed, emails_skipped: skipped,
    total_contacts: sent + failed + skipped, completed_at: new Date().toISOString(),
  }).eq("id", campaignId);

  console.log("\n=== COMPLETE ===");
  console.log(`Sent: ${sent} | Failed: ${failed} | Skipped: ${skipped}`);
  console.log(`Grand total: ${totalAlreadySent + sent}`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
