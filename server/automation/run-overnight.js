#!/usr/bin/env node
// Overnight outreach: sends up to 1000 emails spread evenly until 9am UK
// Stops automatically at deadline. Deduplicates by domain.
// Discovers new Shopify brands if seed list runs out.

import { supabase } from "../lib/supabase.js";
import { TEMPLATES, getPrimaryProductType, pickTemplate } from "./templates.js";
import { generateObservation, renderTemplate, validateRenderedEmail } from "./personalize.js";
import { sendEmail } from "./send.js";
import { scrapeBrand } from "./scrape-brand.js";
import { SEED_DOMAINS } from "../scraper/seeds.js";
import { isShopifyStore } from "../scraper/shopify.js";

const TEAM_ID = "a0000000-0000-0000-0000-000000000001";
const MAX_EMAILS = 1000;
const DEADLINE = new Date("2026-04-15T08:00:00Z"); // 9am BST
const FROM = "Federico from Linkable <brand@linkable.link>";
const REPLY_TO = "federico@linkable.link";

// Extra Shopify brands beyond beauty/wellness
const EXPANDED_DOMAINS = [
  // Fashion / Apparel
  "allbirds.com", "rothys.com", "everlane.com", "chubbies.com", "untuckit.com",
  "vuoriclothing.com", "fabletics.com", "gymshark.com", "outdoorvoices.com",
  "girlfriend.com", "lacausa.com", "pfranklinbrand.com", "cuts.com",
  "rhone.com", "trueclassictees.com", "mack-weldon.com", "bombas.com",
  "meundies.com", "pfranklinbrand.com", "naadam.co", "kotn.com",
  // Food / Beverage
  "magicspoon.com", "liquid-iv.com", "mudwtr.com", "drinkolipop.com",
  "poppi.com", "drinkag1.com", "drinkhint.com", "oatly.com",
  "drinkbai.com", "rxbar.com", "perfectbar.com", "larabar.com",
  // Home / Lifestyle
  "brooklinen.com", "parachutehome.com", "boll-branch.com",
  "brightland.co", "materialkitchen.com", "greats.com",
  "caraway.com", "ourplace.com", "misen.com",
  // Pets
  "bfranklinpets.com", "olliepets.com", "sundays-dog.com", "thefarmersdog.com",
  "barkbox.com", "wildone.com", "fableobjects.com",
  // Fitness / Sports
  "whoop.com", "hyperice.com", "tonal.com", "mirrorbrands.com",
  "peloton.com", "lululemon.com",
  // Jewelry / Accessories
  "mejuri.com", "analuisa.com", "gorjana.com", "vitaly.com",
  "kendrascott.com", "baublebar.com", "aurate.com", "missoma.com",
  "monicavinader.com", "catbirdnyc.com",
  // Wellness
  "dame.com", "getmaude.com", "fur-oil.com", "lovewellness.com",
  "theragun.com", "calm.com",
  // Baby / Kids
  "lovevery.com", "primaryclothing.com", "monkesinabag.com",
  "hanesbrands.com",
  // Men's grooming
  "harrys.com", "manscaped.com", "beardbrand.com", "drsquatch.com",
  "lumin.co", "hims.com", "supply.co", "bfranklingrooming.com",
  // Skincare / Beauty (extra)
  "peachandlily.com", "soko-glam.com", "110skincare.co.uk",
  "skyn-iceland.com", "purelyageless.com", "hellosunday.co.uk",
  "bymarlo.com", "drunkelephant.com", "versed.com",
  "peaceoutskincare.com", "herocosmetics.us", "youthtothepeople.com",
  "kopari.com", "osea.com", "biossance.com", "kinship.com",
  "freshbeauty.com", "laneige.com", "innisfree.com",
  // More DTC brands
  "away.com", "casperbrand.com", "warbyparker.com", "glossier.com",
  "harrys.com", "dollarshaveclub.com", "nativecos.com",
  "thirdlove.com", "tommy-john.com", "stance.com",
  "publicrec.com", "olivers.com", "tenthousand.cc",
  // EU / UK DTC
  "gymplus.com", "huel.com", "grind.co.uk", "percup.com",
  "papier.com", "toast.co.uk", "finisterre.com", "rapanui.com",
  "pangaia.com", "ganni.com", "arket.com", "cos.com",
  "whistles.com", "reiss.com", "sezane.com", "rouje.com",
  "maje.com", "sandro-paris.com", "apc.fr", "a-p-c.com",
  // Additional wellness / supplements
  "ag1.com", "momentous.com", "legionathletics.com",
  "transparentlabs.com", "bulkpowders.com", "myprotein.com",
  "theproteinworks.com", "form-nutrition.com",
  // Additional beauty
  "typology.com", "augustinus-bader.com", "beautypie.com",
  "volition.com", "summersalt.com", "lilahb.com",
  "westmanatelier.com", "danessa-myricks.com", "onesize.com",
  "lawlessbeauty.com", "jonesroadbeauty.com", "merit.com",
  "saiebeauty.com", "kosas.com", "ilia.com",
];

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
  // Spread remaining emails evenly, minimum 20s between sends
  return Math.max(20000, Math.floor(msLeft / remaining));
}

async function init() {
  // Load already-sent domains
  const { data: existingSends } = await supabase
    .from("email_sends")
    .select("to_email, contact_id")
    .eq("team_id", TEAM_ID)
    .eq("status", "sent");

  totalAlreadySent = (existingSends || []).length;

  for (const s of (existingSends || [])) {
    if (s.to_email) processedEmails.add(s.to_email.toLowerCase());
  }

  // Load domains already sent to
  const sentContactIds = [...new Set((existingSends || []).map(s => s.contact_id).filter(Boolean))];
  if (sentContactIds.length > 0) {
    const { data: sentContactDomains } = await supabase
      .from("contacts")
      .select("domain")
      .in("id", sentContactIds);
    for (const c of (sentContactDomains || [])) {
      if (c.domain) processedDomains.add(c.domain.replace(/^www\./, ""));
    }
  }

  // Create campaign
  const { data: campaign } = await supabase
    .from("email_campaigns")
    .insert({
      team_id: TEAM_ID,
      name: `Overnight Outreach ${new Date().toISOString().split("T")[0]}`,
      status: "running",
      source: "all",
      config: { maxEmails: MAX_EMAILS, deadline: DEADLINE.toISOString() },
      started_at: new Date().toISOString(),
    })
    .select()
    .single();

  campaignId = campaign.id;
}

async function processBrand(domain, contactData, index) {
  const cleanDomain = domain.replace(/^www\./, "").replace(/^https?:\/\//, "").replace(/\/$/, "");

  if (processedDomains.has(cleanDomain)) return "skip_duplicate";
  processedDomains.add(cleanDomain);

  if (pastDeadline()) return "deadline";
  if (totalAlreadySent + sent >= MAX_EMAILS) return "limit";

  const template = pickTemplate(index, TEMPLATES);
  const currentDelay = calcDelay();

  console.log(`[${totalAlreadySent + sent + 1}/${MAX_EMAILS}] ${cleanDomain} — Template ${template.variant} (next in ${Math.round(currentDelay/1000)}s)`);

  // Scrape brand
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
    email = brandData.bestEmail;
  }

  if (!email) { skipped++; console.log(`  SKIP: no email`); return "skip"; }
  if (processedEmails.has(email.toLowerCase())) { skipped++; console.log(`  SKIP: ${email} already sent`); return "skip"; }
  processedEmails.add(email.toLowerCase());

  // Ensure contact in CRM
  let contactId = contactData?.id;
  if (!contactId) {
    const { data: existing } = await supabase
      .from("contacts").select("id").eq("team_id", TEAM_ID).eq("domain", cleanDomain).single();

    if (existing) {
      contactId = existing.id;
      await supabase.from("contacts").update({ email }).eq("id", contactId);
    } else {
      const brandName = contactData?.company || contactData?.name || cleanDomain.split(".")[0].replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      const { data: newContact } = await supabase
        .from("contacts")
        .insert({ team_id: TEAM_ID, name: brandName, company: brandName, domain: cleanDomain, email, stage: "Lead", source: "scraper", country: contactData?.country || "", category: contactData?.category || "", created_at: new Date().toISOString() })
        .select().single();
      contactId = newContact?.id;
    }
  } else if (email && email !== contactData.email) {
    await supabase.from("contacts").update({ email }).eq("id", contactId);
  }

  // Personalize
  const matchedKeywords = contactData?.category?.split(", ") || [];
  const productType = getPrimaryProductType(matchedKeywords, []);
  const brandName = contactData?.company || contactData?.name || cleanDomain.split(".")[0].replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const founderName = brandData?.brandInfo?.founderName;
  let firstName = "there";
  if (founderName) firstName = founderName.split(/\s+/)[0];

  let observation = "";
  if (template.variant === "D") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      try {
        observation = await generateObservation({
          storeName: brandName, domain: cleanDomain, sampleTypes: [], matchedKeywords,
          productCount: contactData?.product_count, country: contactData?.country,
          brandInfo: brandData?.brandInfo || {},
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

  const vars = { brandName, firstName, domain: cleanDomain, productType, country: contactData?.country || "", observation };
  const subject = renderTemplate(template.subject_template, vars);
  const body = renderTemplate(template.body_template, vars);

  const validation = validateRenderedEmail(subject, body);
  if (!validation.valid) { skipped++; console.log(`  SKIP: ${validation.issues.join(", ")}`); return "skip"; }

  // Save + send
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

  // Update campaign every 10
  if ((sent + failed) % 10 === 0) {
    await supabase.from("email_campaigns").update({ emails_sent: sent, emails_failed: failed, emails_skipped: skipped, total_contacts: sent + failed + skipped }).eq("id", campaignId);
  }

  // Wait the calculated delay
  if (currentDelay > 0) await delay(currentDelay);

  return result.success ? "sent" : "failed";
}

async function main() {
  console.log("=== Linkable Overnight Outreach ===");
  console.log(`Deadline: ${DEADLINE.toISOString()} (9am UK)`);
  console.log(`Max emails: ${MAX_EMAILS}`);
  console.log(`Started: ${new Date().toISOString()}\n`);

  if (!process.env.RESEND_API_KEY) { console.error("RESEND_API_KEY not set"); process.exit(1); }

  await init();
  console.log(`Already sent: ${totalAlreadySent}`);
  console.log(`Remaining: ${MAX_EMAILS - totalAlreadySent}`);
  console.log(`Initial delay: ~${Math.round(calcDelay()/1000)}s between sends\n`);

  let index = 0;

  // Phase 1: CRM contacts
  console.log("--- Phase 1: CRM contacts ---");
  const { data: crmContacts } = await supabase
    .from("contacts").select("*").eq("team_id", TEAM_ID)
    .neq("domain", "").not("domain", "is", null);

  for (const c of (crmContacts || [])) {
    if (pastDeadline() || totalAlreadySent + sent >= MAX_EMAILS) break;
    const res = await processBrand(c.domain, c, index);
    if (res === "sent" || res === "failed") index++;
  }

  // Phase 2: Scraper results
  if (!pastDeadline() && totalAlreadySent + sent < MAX_EMAILS) {
    console.log("\n--- Phase 2: Scraper results ---");
    const { data: scraperResults } = await supabase
      .from("scraper_results").select("*").eq("team_id", TEAM_ID)
      .eq("shopify", true).neq("skip", true).order("beauty_score", { ascending: false });

    for (const r of (scraperResults || [])) {
      if (pastDeadline() || totalAlreadySent + sent >= MAX_EMAILS) break;
      if (processedDomains.has(r.domain)) continue;
      const res = await processBrand(r.domain, { name: r.store_name, company: r.store_name, domain: r.domain, email: r.contact_email || "", country: r.country, category: (r.matched_keywords || []).slice(0, 3).join(", "), product_count: r.product_count }, index);
      if (res === "sent" || res === "failed") index++;
    }
  }

  // Phase 3: Seed domains
  if (!pastDeadline() && totalAlreadySent + sent < MAX_EMAILS) {
    console.log("\n--- Phase 3: Seed domains ---");
    for (const d of SEED_DOMAINS) {
      if (pastDeadline() || totalAlreadySent + sent >= MAX_EMAILS) break;
      if (processedDomains.has(d.replace(/^www\./, ""))) continue;
      const res = await processBrand(d, { domain: d }, index);
      if (res === "sent" || res === "failed") index++;
    }
  }

  // Phase 4: Expanded domains
  if (!pastDeadline() && totalAlreadySent + sent < MAX_EMAILS) {
    console.log("\n--- Phase 4: Expanded brands ---");
    for (const d of EXPANDED_DOMAINS) {
      if (pastDeadline() || totalAlreadySent + sent >= MAX_EMAILS) break;
      if (processedDomains.has(d.replace(/^www\./, ""))) continue;
      const res = await processBrand(d, { domain: d }, index);
      if (res === "sent" || res === "failed") index++;
    }
  }

  // Done
  await supabase.from("email_campaigns").update({
    status: "complete", emails_sent: sent, emails_failed: failed, emails_skipped: skipped,
    total_contacts: sent + failed + skipped, completed_at: new Date().toISOString(),
  }).eq("id", campaignId);

  console.log("\n=== COMPLETE ===");
  console.log(`Sent: ${sent} | Failed: ${failed} | Skipped: ${skipped}`);
  console.log(`Total (including previous): ${totalAlreadySent + sent}`);
  console.log(`Finished: ${new Date().toISOString()}`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
