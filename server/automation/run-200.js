#!/usr/bin/env node
// Full 200-brand outreach run
// 1. Existing CRM contacts with domains
// 2. Scraper results not yet imported
// 3. Seed domains not yet in CRM
// 4. Expanded Shopify brands beyond beauty/wellness
// Each brand: scrape website → find email → personalize → send
// 10 seconds between each send

import { supabase } from "../lib/supabase.js";
import { TEMPLATES, getPrimaryProductType, pickTemplate } from "./templates.js";
import { generateObservation, renderTemplate, validateRenderedEmail } from "./personalize.js";
import { sendEmail } from "./send.js";
import { scrapeBrand } from "./scrape-brand.js";
import { SEED_DOMAINS } from "../scraper/seeds.js";
import { isShopifyStore } from "../scraper/shopify.js";

const TEAM_ID = "a0000000-0000-0000-0000-000000000001";
const TARGET = 200;
const DELAY_MS = 10000; // 10 seconds between sends
const FROM = "Federico from Linkable <brand@linkable.link>";
const REPLY_TO = "federico@linkable.link";

// Extra Shopify brands beyond beauty/wellness (fashion, food, home, fitness, pets)
const EXPANDED_DOMAINS = [
  // Fashion / Apparel DTC
  "allbirds.com", "rothys.com", "everlane.com", "pfranklinbrand.com",
  "chubbies.com", "untuckit.com", "vuoriclothing.com", "fabletics.com",
  "gymshark.com", "outdoorvoices.com", "girlfriend.com", "pfranklinbrand.com",
  "lacausa.com", "reformationfashion.com", "pfranklinbrand.com",
  // Food / Beverage DTC
  "magicspoon.com", "liquid-iv.com", "mudwtr.com", "drinkolipop.com",
  "poppi.com", "drinkag1.com", "drinkhint.com", "thegoodcandy.com",
  // Home / Lifestyle
  "brooklinen.com", "parachutehome.com", "casper.com", "boll-branch.com",
  "buybuybaby.com", "brightland.co", "materialkitchen.com",
  // Pets
  "bfranklinpets.com", "olliepets.com", "sundays-dog.com", "thefarmersdog.com",
  // Fitness / Sports
  "whoop.com", "hyperice.com", "mirrorfitness.com", "tonal.com",
  // Jewelry / Accessories
  "mejuri.com", "analuisa.com", "gorjana.com", "vitaly.com",
  "kendrascott.com", "baublebar.com", "pfranklinbrand.com",
  // Wellness / Sexual Health
  "dame.com", "getmaude.com", "fur-oil.com", "lovewellness.com",
  // Baby / Kids
  "lovevery.com", "monkesinabag.com", "primaryclothing.com",
  // Men's grooming
  "harrys.com", "manscaped.com", "beardbrand.com", "drSquatch.com",
  "lumin.co", "hims.com",
];

const keys = {
  resendApiKey: process.env.RESEND_API_KEY,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
};

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Track what we've already processed
const processedDomains = new Set();
const processedEmails = new Set();
let sent = 0;
let failed = 0;
let skipped = 0;
let campaignId = null;

async function init() {
  // Load already-sent emails AND domains to avoid duplicates
  const { data: existingSends } = await supabase
    .from("email_sends")
    .select("to_email, contact_id")
    .eq("team_id", TEAM_ID)
    .in("status", ["sent"]);

  for (const s of (existingSends || [])) {
    if (s.to_email) processedEmails.add(s.to_email.toLowerCase());
  }

  // Load domains that already have a sent email — deduplicate by domain
  const { data: sentContacts } = await supabase
    .from("email_sends")
    .select("contact_id")
    .eq("team_id", TEAM_ID)
    .eq("status", "sent");

  const sentContactIds = [...new Set((sentContacts || []).map(s => s.contact_id).filter(Boolean))];
  if (sentContactIds.length > 0) {
    // Batch fetch domains for sent contacts
    const { data: sentContactDomains } = await supabase
      .from("contacts")
      .select("domain")
      .in("id", sentContactIds);

    for (const c of (sentContactDomains || [])) {
      if (c.domain) processedDomains.add(c.domain.replace(/^www\./, ""));
    }
  }

  console.log(`Already sent to ${processedDomains.size} domains, skipping those.\n`);

  // Load already-processed domains from contacts
  const { data: existingContacts } = await supabase
    .from("contacts")
    .select("domain")
    .eq("team_id", TEAM_ID);

  // Create campaign
  const { data: campaign } = await supabase
    .from("email_campaigns")
    .insert({
      team_id: TEAM_ID,
      name: `200-Brand Outreach ${new Date().toISOString().split("T")[0]}`,
      status: "running",
      source: "all",
      config: { target: TARGET, delayMs: DELAY_MS },
      started_at: new Date().toISOString(),
    })
    .select()
    .single();

  campaignId = campaign.id;
  console.log(`Campaign created: ${campaignId}\n`);

  return (existingContacts || []).map(c => c.domain).filter(Boolean);
}

async function processBrand(domain, contactData, index) {
  const cleanDomain = domain.replace(/^www\./, "").replace(/^https?:\/\//, "").replace(/\/$/, "");

  if (processedDomains.has(cleanDomain)) return "skip_duplicate";
  processedDomains.add(cleanDomain);

  const template = pickTemplate(index, TEMPLATES);

  console.log(`[${sent + failed + skipped + 1}/${TARGET}] ${cleanDomain} — Template ${template.variant}`);

  // Scrape brand website
  let brandData = null;
  try {
    brandData = await scrapeBrand(cleanDomain);
  } catch (e) {
    console.log(`  Scrape failed: ${e.message}`);
  }

  // Determine email
  let email = null;
  if (brandData?.bestEmail && brandData.emailCount > 0) {
    email = brandData.bestEmail;
  } else if (contactData?.email && contactData.email.length > 0) {
    email = contactData.email;
  } else if (brandData?.bestEmail) {
    email = brandData.bestEmail; // guessed
  }

  if (!email) {
    console.log(`  SKIP: no email found`);
    skipped++;
    return "skip_no_email";
  }

  if (processedEmails.has(email.toLowerCase())) {
    console.log(`  SKIP: ${email} already sent`);
    skipped++;
    return "skip_already_sent";
  }
  processedEmails.add(email.toLowerCase());

  // Ensure contact exists in CRM
  let contactId = contactData?.id;
  if (!contactId) {
    const { data: existing } = await supabase
      .from("contacts")
      .select("id")
      .eq("team_id", TEAM_ID)
      .eq("domain", cleanDomain)
      .single();

    if (existing) {
      contactId = existing.id;
      // Update email if better
      await supabase.from("contacts").update({ email }).eq("id", contactId);
    } else {
      // Create new contact
      const { data: newContact } = await supabase
        .from("contacts")
        .insert({
          team_id: TEAM_ID,
          name: contactData?.name || cleanDomain.split(".")[0].replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
          company: contactData?.company || cleanDomain.split(".")[0].replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
          domain: cleanDomain,
          email,
          stage: "Lead",
          source: "scraper",
          country: contactData?.country || "",
          category: contactData?.category || "",
          created_at: new Date().toISOString(),
        })
        .select()
        .single();

      contactId = newContact?.id;
    }
  } else {
    // Update email if we found a better one
    if (email && email !== contactData.email) {
      await supabase.from("contacts").update({ email }).eq("id", contactId);
    }
  }

  // Personalize
  const matchedKeywords = contactData?.category?.split(", ") || [];
  const productType = getPrimaryProductType(matchedKeywords, []);
  const brandName = contactData?.company || contactData?.name || cleanDomain.split(".")[0].replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());

  // First name
  const founderName = brandData?.brandInfo?.founderName;
  let firstName = "there";
  if (founderName) firstName = founderName.split(/\s+/)[0];

  // Observation for template D
  let observation = "";
  if (template.variant === "D" && keys.anthropicApiKey) {
    try {
      observation = await generateObservation({
        storeName: brandName,
        domain: cleanDomain,
        sampleTypes: [],
        matchedKeywords,
        productCount: contactData?.product_count,
        country: contactData?.country,
        brandInfo: brandData?.brandInfo || {},
      }, keys.anthropicApiKey);
    } catch (e) {
      observation = `I came across ${brandName} and really liked what you've built — seems like a great fit for creator partnerships.`;
    }
  } else if (template.variant === "D") {
    const bi = brandData?.brandInfo || {};
    if (bi.hasCreators || bi.hasAffiliates || bi.hasInfluencers) {
      observation = `I noticed ${brandName} already works with creators — have you been able to track which partnerships actually drive sales?`;
    } else {
      observation = `I came across ${brandName} and really liked what you've built — seems like a great fit for creator partnerships.`;
    }
  }

  const vars = { brandName, firstName, domain: cleanDomain, productType, country: contactData?.country || "", observation };
  const subject = renderTemplate(template.subject_template, vars);
  const body = renderTemplate(template.body_template, vars);

  const validation = validateRenderedEmail(subject, body);
  if (!validation.valid) {
    console.log(`  SKIP: ${validation.issues.join(", ")}`);
    skipped++;
    return "skip_validation";
  }

  // Save to email_sends
  const { data: sendRecord } = await supabase
    .from("email_sends")
    .insert({
      campaign_id: campaignId,
      team_id: TEAM_ID,
      contact_id: contactId,
      template_variant: template.variant,
      to_email: email,
      to_name: brandName,
      subject,
      body,
      status: "pending",
    })
    .select()
    .single();

  // Send
  const result = await sendEmail({
    to: email,
    toName: brandName,
    subject,
    body,
    from: FROM,
    replyTo: REPLY_TO,
    resendApiKey: keys.resendApiKey,
  });

  if (result.success) {
    sent++;
    console.log(`  SENT → ${email} (${result.resendId})`);

    await supabase.from("email_sends").update({ status: "sent", resend_id: result.resendId, sent_at: new Date().toISOString() }).eq("id", sendRecord.id);
    await supabase.from("contacts").update({ stage: "Contacted" }).eq("id", contactId);
    await supabase.from("activities").insert({
      contact_id: contactId,
      team_id: TEAM_ID,
      type: "email_sent",
      description: `Outreach email sent (Template ${template.variant}: ${template.name})`,
      created_at: new Date().toISOString(),
    });
  } else {
    failed++;
    console.log(`  FAILED: ${result.error}`);
    await supabase.from("email_sends").update({ status: "failed", error: result.error }).eq("id", sendRecord.id);
  }

  // Update campaign progress every 10
  if ((sent + failed) % 10 === 0) {
    await supabase.from("email_campaigns").update({
      emails_sent: sent, emails_failed: failed, emails_skipped: skipped, total_contacts: sent + failed + skipped,
    }).eq("id", campaignId);
  }

  return result.success ? "sent" : "failed";
}

async function main() {
  console.log("=== Linkable 200-Brand Outreach ===\n");

  if (!keys.resendApiKey || keys.resendApiKey.includes("YOUR")) {
    console.error("RESEND_API_KEY not set"); process.exit(1);
  }

  const existingDomains = await init();
  let index = 0;

  // Phase 1: CRM contacts with domains
  console.log("--- Phase 1: CRM contacts ---");
  const { data: crmContacts } = await supabase
    .from("contacts")
    .select("*")
    .eq("team_id", TEAM_ID)
    .neq("domain", "")
    .not("domain", "is", null)
    .order("created_at", { ascending: false });

  for (const contact of (crmContacts || [])) {
    if (sent >= TARGET) break;
    const result = await processBrand(contact.domain, contact, index);
    if (result === "sent" || result === "failed") {
      index++;
      await delay(DELAY_MS);
    }
  }

  // Phase 2: Scraper results not in CRM
  if (sent < TARGET) {
    console.log("\n--- Phase 2: Scraper results ---");
    const { data: scraperResults } = await supabase
      .from("scraper_results")
      .select("*")
      .eq("team_id", TEAM_ID)
      .eq("shopify", true)
      .neq("skip", true)
      .order("beauty_score", { ascending: false });

    for (const result of (scraperResults || [])) {
      if (sent >= TARGET) break;
      if (processedDomains.has(result.domain)) continue;

      const contactData = {
        name: result.store_name,
        company: result.store_name,
        domain: result.domain,
        email: result.contact_email || "",
        country: result.country,
        category: (result.matched_keywords || []).slice(0, 3).join(", "),
        product_count: result.product_count,
      };

      const res = await processBrand(result.domain, contactData, index);
      if (res === "sent" || res === "failed") {
        index++;
        await delay(DELAY_MS);
      }
    }
  }

  // Phase 3: Seed domains not yet processed
  if (sent < TARGET) {
    console.log("\n--- Phase 3: Seed domains (beauty/wellness) ---");
    for (const domain of SEED_DOMAINS) {
      if (sent >= TARGET) break;
      if (processedDomains.has(domain.replace(/^www\./, ""))) continue;

      const res = await processBrand(domain, { domain }, index);
      if (res === "sent" || res === "failed") {
        index++;
        await delay(DELAY_MS);
      }
    }
  }

  // Phase 4: Expanded domains (beyond beauty/wellness)
  if (sent < TARGET) {
    console.log("\n--- Phase 4: Expanded Shopify brands ---");
    for (const domain of EXPANDED_DOMAINS) {
      if (sent >= TARGET) break;
      if (processedDomains.has(domain.replace(/^www\./, ""))) continue;

      // Quick Shopify check
      try {
        const isShopify = await isShopifyStore(domain);
        if (!isShopify) {
          console.log(`[skip] ${domain} — not Shopify`);
          continue;
        }
      } catch {
        continue;
      }

      const res = await processBrand(domain, { domain }, index);
      if (res === "sent" || res === "failed") {
        index++;
        await delay(DELAY_MS);
      }
    }
  }

  // Final update
  await supabase.from("email_campaigns").update({
    status: "complete",
    emails_sent: sent,
    emails_failed: failed,
    emails_skipped: skipped,
    total_contacts: sent + failed + skipped,
    completed_at: new Date().toISOString(),
  }).eq("id", campaignId);

  console.log("\n=== COMPLETE ===");
  console.log(`Campaign: ${campaignId}`);
  console.log(`Sent: ${sent}`);
  console.log(`Failed: ${failed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Total processed: ${sent + failed + skipped}`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
