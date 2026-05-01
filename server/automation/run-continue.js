#!/usr/bin/env node
// Continue outreach: discover new Shopify brands, then send up to 1000 total
// Spreads sends over 12 hours with adaptive delay

import { supabase } from "../lib/supabase.js";
import { TEMPLATES, getPrimaryProductType, pickTemplate } from "./templates.js";
import { generateObservation, renderTemplate, validateRenderedEmail } from "./personalize.js";
import { sendEmail } from "./send.js";
import { scrapeBrand } from "./scrape-brand.js";
import { CURATED_BRANDS } from "./discover-brands.js";
import { BRANDS_BATCH2 } from "./brands-batch2.js";
import { BRANDS_BATCH3 } from "./brands-batch3.js";
import { discoverLive } from "./discover-live.js";

const TEAM_ID = "a0000000-0000-0000-0000-000000000001";
const MAX_EMAILS = 1890; // 890 already sent + 1000 new = 1890
const DEADLINE = new Date(Date.now() + 6 * 3600000); // 6 hours
const FROM = "Federico from Linkable <brand@linkable.link>";
const REPLY_TO = "federico@linkable.link";
const MIN_DELAY = 10000; // minimum 10s between sends

const processedDomains = new Set();
const processedEmails = new Set();
let sent = 0;
let failed = 0;
let skipped = 0;
let totalAlreadySent = 0;
let campaignId = null;

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function pastDeadline() { return new Date() >= DEADLINE; }

function calcDelay() {
  const remaining = MAX_EMAILS - totalAlreadySent - sent;
  if (remaining <= 0) return 0;
  const msLeft = DEADLINE - new Date();
  if (msLeft <= 0) return 0;
  return Math.max(MIN_DELAY, Math.floor(msLeft / remaining));
}

async function init() {
  const { data: existingSends } = await supabase
    .from("email_sends").select("to_email, contact_id")
    .eq("team_id", TEAM_ID).eq("status", "sent");

  totalAlreadySent = (existingSends || []).length;

  // Extract domains from BOTH the email address AND the contact's domain field
  for (const s of (existingSends || [])) {
    if (s.to_email) {
      processedEmails.add(s.to_email.toLowerCase());
      // Extract domain from email (most reliable)
      const emailDomain = s.to_email.split("@")[1]?.toLowerCase();
      if (emailDomain) {
        // Strip common subdomain prefixes to get the root brand domain
        const rootDomain = emailDomain.replace(/^(mail\.|smtp\.|email\.)/, "");
        processedDomains.add(rootDomain);
      }
    }
  }

  // Also add domains from linked contacts
  const sentContactIds = [...new Set((existingSends || []).map(s => s.contact_id).filter(Boolean))];
  if (sentContactIds.length > 0) {
    // Batch in chunks of 100 to avoid URL length issues
    for (let i = 0; i < sentContactIds.length; i += 100) {
      const chunk = sentContactIds.slice(i, i + 100);
      const { data: sentContactDomains } = await supabase
        .from("contacts").select("domain").in("id", chunk);
      for (const c of (sentContactDomains || [])) {
        if (c.domain) processedDomains.add(c.domain.replace(/^www\./, "").toLowerCase());
      }
    }
  }

  console.log(`Loaded ${processedEmails.size} emails and ${processedDomains.size} domains already sent.`);

  const { data: campaign } = await supabase
    .from("email_campaigns")
    .insert({ team_id: TEAM_ID, name: `Outreach Continue ${new Date().toISOString().split("T")[0]}`, status: "running", source: "discovery", config: { maxEmails: MAX_EMAILS, deadline: DEADLINE.toISOString() }, started_at: new Date().toISOString() })
    .select().single();

  campaignId = campaign.id;
}

// Check if a domain (or its root brand name) was already contacted
function isDomainSent(domain) {
  if (processedDomains.has(domain)) return true;
  // Check root brand name (e.g. "twinings" matches "twinings.com" and "twinings.co.uk")
  const root = domain.split(".")[0];
  for (const d of processedDomains) {
    if (d.split(".")[0] === root) return true;
  }
  return false;
}

async function processBrand(domain, index) {
  const cleanDomain = domain.replace(/^www\./, "").replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase();

  if (isDomainSent(cleanDomain)) return "skip_duplicate";
  // Don't add to processedDomains yet — add after email domain check below

  if (pastDeadline()) return "deadline";
  if (totalAlreadySent + sent >= MAX_EMAILS) return "limit";

  const template = pickTemplate(index, TEMPLATES);
  const currentDelay = calcDelay();

  console.log(`[${totalAlreadySent + sent + 1}/${MAX_EMAILS}] ${cleanDomain} — Template ${template.variant} (${Math.round(currentDelay/1000)}s delay)`);

  // Scrape brand
  let brandData = null;
  try {
    brandData = await scrapeBrand(cleanDomain);
  } catch (e) {
    console.log(`  Scrape failed: ${e.message}`);
  }

  // Get email — prefer real ones found on site, fall back to common patterns
  let email = null;
  if (brandData?.bestEmail) email = brandData.bestEmail;

  if (!email) { skipped++; console.log(`  SKIP: no email`); return "skip"; }

  // HARD CHECK: query DB directly to see if ANY email was ever sent to this email domain
  const emailDomain = email.split("@")[1]?.toLowerCase();
  const emailRoot = emailDomain?.split(".")[0];
  const { data: existingForDomain } = await supabase
    .from("email_sends")
    .select("to_email")
    .eq("team_id", TEAM_ID)
    .eq("status", "sent")
    .ilike("to_email", `%${emailRoot}%`)
    .limit(1);

  if (existingForDomain?.length > 0) {
    skipped++;
    processedDomains.add(cleanDomain);
    if (emailDomain) processedDomains.add(emailDomain);
    console.log(`  SKIP: ${emailDomain} already in DB (${existingForDomain[0].to_email})`);
    return "skip";
  }

  // All checks passed — mark as processed
  processedEmails.add(email.toLowerCase());
  processedDomains.add(cleanDomain);
  if (emailDomain) processedDomains.add(emailDomain);

  // CRM
  let contactId = null;
  const { data: existing } = await supabase
    .from("contacts").select("id").eq("team_id", TEAM_ID).eq("domain", cleanDomain).single();

  if (existing) {
    contactId = existing.id;
    await supabase.from("contacts").update({ email }).eq("id", contactId);
  } else {
    const brandName = cleanDomain.split(".")[0].replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    const { data: newContact } = await supabase
      .from("contacts")
      .insert({ team_id: TEAM_ID, name: brandName, company: brandName, domain: cleanDomain, email, stage: "Lead", source: "scraper", created_at: new Date().toISOString() })
      .select().single();
    contactId = newContact?.id;
  }

  // Personalize — use scraped brand data to determine product type
  const bi = brandData?.brandInfo || {};
  const brandText = [bi.brandStory || "", bi.usp || "", cleanDomain].join(" ");
  const productType = getPrimaryProductType([], [], brandText);
  const brandName = cleanDomain.split(".")[0].replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const founderName = brandData?.brandInfo?.founderName;
  let firstName = "there";
  if (founderName) firstName = founderName.split(/\s+/)[0];

  let observation = "";
  if (template.variant === "D") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      try {
        observation = await generateObservation({
          storeName: brandName, domain: cleanDomain, sampleTypes: [], matchedKeywords: [],
          productCount: null, country: null, brandInfo: brandData?.brandInfo || {},
        }, apiKey);
      } catch { observation = ""; }
    }
    if (!observation) {
      const bi = brandData?.brandInfo || {};
      observation = bi.hasCreators || bi.hasAffiliates || bi.hasInfluencers
        ? `I noticed ${brandName} already works with creators — have you been able to see which ones actually bring in sales?`
        : `I came across ${brandName} and really liked what you've built — seems like the kind of brand creators would love to talk about.`;
    }
  }

  const vars = { brandName, firstName, domain: cleanDomain, productType, country: "", observation };
  const subject = renderTemplate(template.subject_template, vars);
  const body = renderTemplate(template.body_template, vars);

  const validation = validateRenderedEmail(subject, body);
  if (!validation.valid) { skipped++; console.log(`  SKIP: ${validation.issues.join(", ")}`); return "skip"; }

  // Send
  const { data: sendRecord } = await supabase
    .from("email_sends")
    .insert({ campaign_id: campaignId, team_id: TEAM_ID, contact_id: contactId, template_variant: template.variant, to_email: email, to_name: brandName, subject, body, status: "pending" })
    .select().single();

  const result = await sendEmail({ to: email, toName: brandName, subject, body, from: FROM, replyTo: REPLY_TO, resendApiKey: process.env.RESEND_API_KEY });

  if (result.success) {
    sent++;
    console.log(`  SENT → ${email}`);
    await supabase.from("email_sends").update({ status: "sent", resend_id: result.resendId, sent_at: new Date().toISOString() }).eq("id", sendRecord.id);
    await supabase.from("contacts").update({ stage: "Contacted" }).eq("id", contactId);
    await supabase.from("activities").insert({ contact_id: contactId, team_id: TEAM_ID, type: "email_sent", description: `Outreach email sent (Template ${template.variant})`, created_at: new Date().toISOString() });
  } else {
    failed++;
    console.log(`  FAILED: ${result.error}`);
    await supabase.from("email_sends").update({ status: "failed", error: result.error }).eq("id", sendRecord.id);
  }

  if ((sent + failed) % 10 === 0) {
    await supabase.from("email_campaigns").update({ emails_sent: sent, emails_failed: failed, emails_skipped: skipped, total_contacts: sent + failed + skipped }).eq("id", campaignId);
  }

  if (currentDelay > 0) await delay(currentDelay);
  return result.success ? "sent" : "failed";
}

async function main() {
  console.log("=== Linkable Outreach — Discover & Send ===");
  console.log(`Deadline: ${DEADLINE.toISOString()}`);
  console.log(`Max emails: ${MAX_EMAILS}`);
  console.log(`Started: ${new Date().toISOString()}\n`);

  if (!process.env.RESEND_API_KEY) { console.error("RESEND_API_KEY not set"); process.exit(1); }

  await init();

  const remaining = MAX_EMAILS - totalAlreadySent;
  console.log(`Already sent: ${totalAlreadySent}`);
  console.log(`Need: ${remaining} more`);
  console.log(`Delay: ~${Math.round(calcDelay()/1000)}s between sends\n`);

  if (remaining <= 0) {
    console.log("Already at target. Done.");
    process.exit(0);
  }

  // Load all brand domains directly — no slow discovery phase
  const newDomains = [];
  const seen = new Set();

  // Add from curated list (instant)
  for (const d of CURATED_BRANDS) {
    const clean = d.replace(/^www\./, "").toLowerCase();
    if (!processedDomains.has(clean) && !seen.has(clean)) { newDomains.push(clean); seen.add(clean); }
  }

  // Add from batch 2 + 3 (instant)
  for (const d of [...BRANDS_BATCH2, ...BRANDS_BATCH3]) {
    const clean = d.replace(/^www\./, "").toLowerCase();
    if (!processedDomains.has(clean) && !seen.has(clean)) { newDomains.push(clean); seen.add(clean); }
  }

  // Also discover live via search engines
  console.log("--- Live discovery ---");
  const liveDomains = await discoverLive(processedDomains, remaining);
  for (const d of liveDomains) {
    if (!seen.has(d)) { newDomains.push(d); seen.add(d); }
  }

  console.log(`Total: ${newDomains.length} brands to process\n`);
  console.log(`--- Sending ---\n`);

  let index = 0;
  for (const domain of newDomains) {
    if (pastDeadline() || totalAlreadySent + sent >= MAX_EMAILS) break;
    const res = await processBrand(domain, index);
    if (res === "sent" || res === "failed") index++;
  }

  // Final
  await supabase.from("email_campaigns").update({
    status: "complete", emails_sent: sent, emails_failed: failed, emails_skipped: skipped,
    total_contacts: sent + failed + skipped, completed_at: new Date().toISOString(),
  }).eq("id", campaignId);

  console.log("\n=== COMPLETE ===");
  console.log(`New sends: ${sent} | Failed: ${failed} | Skipped: ${skipped}`);
  console.log(`Grand total: ${totalAlreadySent + sent}`);
  console.log(`Finished: ${new Date().toISOString()}`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
