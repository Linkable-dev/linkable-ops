#!/usr/bin/env node
// Linkable Outreach v3 — StoreLeads → FullEnrich → Claude → Resend
// Flow:
//  1. StoreLeads: fetch targeted Shopify brands
//  2. FullEnrich people search: find decision maker (founder/CEO/CMO)
//  3. FullEnrich enrich: get verified email
//  4. Claude: write personalized email per brand
//  5. Resend: send
//  6. Supabase: track everything

import { supabase } from "../lib/supabase.js";
import { TEMPLATES, getPrimaryProductType, pickTemplate } from "./templates.js";
import { generateObservation, renderTemplate, validateRenderedEmail } from "./personalize.js";
import { sendEmail } from "./send.js";

const TEAM_ID = "a0000000-0000-0000-0000-000000000001";
const STORELEADS_KEY = "991c38bd-e216-456b-5091-50063383";
const FULLENRICH_KEY = "9860e1e7-956f-44fc-a31b-3887f5e9a7b8";
const MAX_LEADS = 15;
const DELAY_BETWEEN_SENDS_MS = 30000; // 30s between sends
const ENRICH_POLL_INTERVAL_MS = 5000;
const ENRICH_POLL_MAX = 18; // 90s max
const FROM = "Federico from Linkable <brand@linkable.link>";
const REPLY_TO = "federico@linkable.link";

// Shopify, US+UK, $500k-$5M/mo, Beauty/Wellness — bigger brands have better email finder coverage
const STORELEADS_BQ = "bq=%7B%22must%22%3A%7B%22conjuncts%22%3A%5B%7B%22field%22%3A%22p%22%2C%22operator%22%3A%22or%22%2C%22analyzer%22%3A%22advanced%22%2C%22match%22%3A%221%22%7D%2C%7B%22field%22%3A%22er%22%2C%22min%22%3A50000000%2C%22max%22%3A500000000%2C%22inclusive_min%22%3Atrue%2C%22inclusive_max%22%3Atrue%7D%2C%7B%22field%22%3A%22cc%22%2C%22operator%22%3A%22or%22%2C%22analyzer%22%3A%22advanced%22%2C%22match%22%3A%22US%20GB%22%7D%2C%7B%22field%22%3A%22cat%22%2C%22operator%22%3A%22or%22%2C%22analyzer%22%3A%22advanced%22%2C%22match%22%3A%22%2FApparel%20%2FBeauty...%26...Fitness%20%2FBeauty...%26...Fitness%2FFace...%26...Body...Care%20%2FBeauty...%26...Fitness%2FFace...%26...Body...Care%2FSkin...%26...Nail...Care%20%2FHealth%2FNutrition%20%2FBeauty...%26...Fitness%2FFace...%26...Body...Care%2FMake-Up...%26...Cosmetics%20%2FBeauty...%26...Fitness%2FFitness%20%2FBeauty...%26...Fitness%2FFace...%26...Body...Care%2FPerfumes...%26...Fragrances%22%7D%5D%7D%7D";

let sent = 0, skipped = 0, failed = 0;
let storeleadsCursor = null;

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- StoreLeads ---
async function fetchStoreLeadsNext() {
  const url = storeleadsCursor
    ? `https://storeleads.app/json/api/v1/all/domain?${STORELEADS_BQ}&cursor=${encodeURIComponent(storeleadsCursor)}`
    : `https://storeleads.app/json/api/v1/all/domain?${STORELEADS_BQ}`;
  const res = await fetch(url, {
    headers: { "Authorization": `Bearer ${STORELEADS_KEY}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`StoreLeads: ${res.status}`);
  const data = await res.json();
  storeleadsCursor = data.has_next_page ? data.next_cursor : null;
  return { domains: data.domains || [], hasMore: !!data.has_next_page };
}

// --- FullEnrich people search ---
async function fullenrichSearchDecisionMaker(domain) {
  try {
    const res = await fetch("https://app.fullenrich.com/api/v2/people/search", {
      method: "POST", redirect: "follow",
      headers: { "Authorization": `Bearer ${FULLENRICH_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        limit: 5,
        current_company_domains: [{ value: domain, exact_match: true }],
        current_position_seniority_level: [
          { value: "Founder" }, { value: "Owner" }, { value: "C-level" },
          { value: "VP" }, { value: "Director" }, { value: "Head" }
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.people?.length) return null;

    // Prefer Founder/CEO over Director
    const ranked = data.people.sort((a, b) => {
      const score = p => {
        const s = (p.employment?.current?.seniority || "").toLowerCase();
        if (/founder|owner/.test(s)) return 10;
        if (/c-level|c_level/.test(s)) return 9;
        if (/vp/.test(s)) return 7;
        if (/head/.test(s)) return 6;
        if (/director/.test(s)) return 5;
        return 1;
      };
      return score(b) - score(a);
    });
    const top = ranked[0];

    // Store in Supabase
    await supabase.from("fullenrich_people").upsert({
      fullenrich_id: top.id,
      domain,
      full_name: top.full_name,
      first_name: top.first_name,
      last_name: top.last_name,
      title: top.employment?.current?.title,
      seniority: top.employment?.current?.seniority,
      linkedin_url: top.social_profiles?.professional_network?.url,
      location_country: top.location?.country_code,
      raw_data: top,
    }, { onConflict: "fullenrich_id" });

    return {
      firstName: top.first_name,
      lastName: top.last_name,
      fullName: top.full_name,
      title: top.employment?.current?.title,
      seniority: top.employment?.current?.seniority,
      linkedinUrl: top.social_profiles?.professional_network?.url,
    };
  } catch (e) {
    console.log(`  Search error: ${e.message}`);
    return null;
  }
}

// --- FullEnrich enrich (find email) ---
async function fullenrichGetEmail(firstName, lastName, domain, linkedinUrl) {
  try {
    // Submit enrich job
    const dataPayload = {
      first_name: firstName,
      last_name: lastName,
      domain,
      enrich_fields: ["contact.work_emails"],
    };
    if (linkedinUrl) dataPayload.linkedin_url = linkedinUrl;

    const sr = await fetch("https://app.fullenrich.com/api/v2/contact/enrich/bulk", {
      method: "POST", redirect: "follow",
      headers: { "Authorization": `Bearer ${FULLENRICH_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: `${firstName} ${lastName} @ ${domain}`, data: [dataPayload] }),
      signal: AbortSignal.timeout(20000),
    });
    if (!sr.ok) return null;
    const sj = await sr.json();
    const enrichmentId = sj.enrichment_id;
    if (!enrichmentId) return null;

    // Track submission
    await supabase.from("fullenrich_enrichments").upsert({
      enrichment_id: enrichmentId, domain, first_name: firstName, last_name: lastName,
      status: "IN_PROGRESS", submitted_at: new Date().toISOString(),
    }, { onConflict: "enrichment_id" });

    // Poll
    for (let i = 0; i < ENRICH_POLL_MAX; i++) {
      await delay(ENRICH_POLL_INTERVAL_MS);
      const pr = await fetch(`https://app.fullenrich.com/api/v2/contact/enrich/bulk/${enrichmentId}`, {
        headers: { "Authorization": `Bearer ${FULLENRICH_KEY}` }, redirect: "follow",
        signal: AbortSignal.timeout(15000),
      });
      if (!pr.ok) continue;
      const pd = await pr.json();
      if (pd.status === "FINISHED") {
        const result = pd.data?.[0];
        const emails = result?.contact?.emails || [];
        const best = emails.find(e => e.qualification === "VALID") || emails[0];

        // Update Supabase
        await supabase.from("fullenrich_enrichments").update({
          status: "FINISHED",
          email: best?.email || null,
          email_qualification: best?.qualification || null,
          emails,
          credits_used: pd.cost?.credits || null,
          raw_data: pd,
          finished_at: new Date().toISOString(),
        }).eq("enrichment_id", enrichmentId);

        return best?.email ? { email: best.email, qualification: best.qualification } : null;
      }
    }
    return null;
  } catch (e) {
    console.log(`  Enrich error: ${e.message}`);
    return null;
  }
}

// --- Already contacted ---
async function wasAlreadyContacted(domain) {
  const root = domain.split(".")[0];
  const { data } = await supabase.from("email_sends")
    .select("id").eq("team_id", TEAM_ID).in("status", ["sent", "pending"])
    .ilike("to_email", `%${root}%`).limit(1);
  return (data?.length || 0) > 0;
}

// --- Process one brand ---
async function processBrand(brand, index) {
  const domain = (brand.name || "").replace(/^www\./, "").toLowerCase();
  if (!domain) return "skip";

  console.log(`[${index + 1}] ${domain} (${brand.merchant_name || "?"})`);

  if (await wasAlreadyContacted(domain)) {
    skipped++;
    console.log(`  SKIP: already contacted`);
    return "skip";
  }

  // Step 1: Find decision maker
  const dm = await fullenrichSearchDecisionMaker(domain);
  if (!dm) {
    skipped++;
    console.log(`  SKIP: no decision maker found`);
    return "skip";
  }
  console.log(`  Found: ${dm.fullName} | ${dm.title}`);

  // Step 2: Get email
  const emailResult = await fullenrichGetEmail(dm.firstName, dm.lastName, domain, dm.linkedinUrl);
  if (!emailResult) {
    skipped++;
    console.log(`  SKIP: no email found by FullEnrich`);
    return "skip";
  }
  console.log(`  Email: ${emailResult.email} (${emailResult.qualification})`);

  // Step 3: Build personalized email with Claude
  const brandName = brand.merchant_name || domain.split(".")[0].replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const desc = brand.description || "";
  const productType = getPrimaryProductType([], [], desc + " " + (brand.categories || []).join(" "));
  const template = pickTemplate(index, TEMPLATES);

  let observation = "";
  if (template.variant === "A" || template.variant === "D") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      try {
        observation = await generateObservation({
          storeName: brandName, domain, sampleTypes: [], matchedKeywords: [],
          productCount: brand.product_count, country: brand.country_code,
          brandInfo: { brandStory: desc },
        }, apiKey);
      } catch {}
    }
  }

  const vars = {
    brandName, firstName: dm.firstName, domain, productType,
    country: brand.country_code || "", observation,
    productCount: brand.product_count || "", description: desc,
  };
  const subject = renderTemplate(template.subject_template, vars);
  const body = renderTemplate(template.body_template, vars);

  const validation = validateRenderedEmail(subject, body);
  if (!validation.valid) {
    skipped++;
    console.log(`  SKIP: validation: ${validation.issues.join(", ")}`);
    return "skip";
  }

  // Step 4: Ensure CRM contact
  let contactId = null;
  const { data: existing } = await supabase.from("contacts").select("id")
    .eq("team_id", TEAM_ID).eq("domain", domain).single();
  if (existing) {
    contactId = existing.id;
    await supabase.from("contacts").update({
      email: emailResult.email, name: dm.fullName, stage: "Contacted",
    }).eq("id", contactId);
  } else {
    const { data: newC } = await supabase.from("contacts").insert({
      team_id: TEAM_ID, name: dm.fullName, company: brandName, domain,
      email: emailResult.email, stage: "Contacted", source: "fullenrich",
      country: brand.country_code || "", created_at: new Date().toISOString(),
    }).select().single();
    contactId = newC?.id;
  }

  // Step 5: Send via Resend
  const { data: sendRecord } = await supabase.from("email_sends").insert({
    team_id: TEAM_ID, contact_id: contactId, template_variant: template.variant,
    to_email: emailResult.email, to_name: dm.fullName, subject, body,
    status: "pending",
  }).select().single();

  const sendResult = await sendEmail({
    to: emailResult.email, toName: dm.fullName, subject, body,
    from: FROM, replyTo: REPLY_TO, resendApiKey: process.env.RESEND_API_KEY,
  });

  if (sendResult.success) {
    sent++;
    await supabase.from("email_sends").update({
      status: "sent", resend_id: sendResult.resendId, sent_at: new Date().toISOString(),
    }).eq("id", sendRecord.id);
    console.log(`  SENT ✓ → ${emailResult.email}`);
  } else {
    failed++;
    await supabase.from("email_sends").update({
      status: "failed", error: sendResult.error,
    }).eq("id", sendRecord.id);
    console.log(`  FAILED: ${sendResult.error}`);
  }

  await delay(DELAY_BETWEEN_SENDS_MS);
  return sendResult.success ? "sent" : "failed";
}

// --- Main ---
async function main() {
  console.log("=== Linkable Outreach v3 — FullEnrich ===");
  console.log(`Target: ${MAX_LEADS} sends`);
  console.log();

  if (!process.env.RESEND_API_KEY) { console.error("RESEND_API_KEY required"); process.exit(1); }

  // Check FullEnrich credits
  const cr = await fetch("https://app.fullenrich.com/api/v2/account/credits", {
    headers: { "Authorization": `Bearer ${FULLENRICH_KEY}` }, redirect: "follow",
  });
  const credits = (await cr.json()).balance;
  console.log(`FullEnrich credits: ${credits}`);
  console.log();

  let index = 0;
  let batch = 1;

  while (sent < MAX_LEADS) {
    console.log(`--- StoreLeads batch ${batch} ---`);
    let result;
    try { result = await fetchStoreLeadsNext(); }
    catch (e) { console.log(`StoreLeads error: ${e.message}`); break; }

    if (!result.domains.length) { console.log("No more brands"); break; }
    console.log(`Got ${result.domains.length} brands`);

    for (const b of result.domains) {
      if (sent >= MAX_LEADS) break;
      await processBrand(b, index);
      index++;
    }

    if (!result.hasMore) { console.log("End of list"); break; }
    batch++;
  }

  console.log("\n=== COMPLETE ===");
  console.log(`Sent: ${sent} | Failed: ${failed} | Skipped: ${skipped}`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
