// Standalone email outreach automation
// Flow: Load contacts → Scrape brand website → Enrich email → Personalize → Send → Update CRM
//
// Can be run as:
//   1. API call from the web app (via routes/outreach.js)
//   2. Standalone CLI: node server/automation/run.js

import { supabase } from "../lib/supabase.js";
import { TEMPLATES, getPrimaryProductType, pickTemplate } from "./templates.js";
import { generateObservation, renderTemplate, validateRenderedEmail } from "./personalize.js";
import { sendEmail, delaySend, getRateLimitStatus } from "./send.js";
import { scrapeBrand } from "./scrape-brand.js";

let currentRun = null;

// Default sender config — override via config param
const DEFAULT_SENDER = {
  name: "Federico",
  title: "Founder",
  from: "Federico from Linkable <brand@linkable.link>",
  replyTo: "federico@linkable.link",
};

// Load env keys
function getKeys() {
  return {
    resendApiKey: process.env.RESEND_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || process.env.VITE_ANTHROPIC_API_KEY,
  };
}

/**
 * Fetch contacts eligible for outreach
 * - Must have an email
 * - Must not have been emailed already (no email_sends record)
 * - Stage = "Lead" (haven't been contacted yet)
 */
async function fetchEligibleContacts(teamId, { limit = 50, source, country } = {}) {
  let query = supabase
    .from("contacts")
    .select("*")
    .eq("team_id", teamId)
    .eq("stage", "Lead")
    .not("email", "is", null)
    .neq("email", "")
    .order("created_at", { ascending: false });

  if (source) query = query.eq("source", source);
  if (country) query = query.eq("country", country);
  if (limit) query = query.limit(limit);

  const { data: contacts, error } = await query;
  if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);

  // Filter out contacts that already received an email
  const { data: sentEmails } = await supabase
    .from("email_sends")
    .select("contact_id")
    .eq("team_id", teamId)
    .in("status", ["sent", "pending"]);

  const sentContactIds = new Set((sentEmails || []).map(s => s.contact_id));
  return (contacts || []).filter(c => !sentContactIds.has(c.id));
}

/**
 * Fetch contacts from scraper_results that haven't been imported to CRM yet
 * Scrape → Enrich → Import to CRM → Send
 */
async function fetchFromScraper(teamId, { limit = 50 } = {}) {
  const { data: results, error } = await supabase
    .from("scraper_results")
    .select("*")
    .eq("team_id", teamId)
    .eq("qualified", true)
    .not("contact_email", "is", null)
    .neq("contact_email", "")
    .order("scraped_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to fetch scraper results: ${error.message}`);

  // Filter out already-imported domains
  const { data: existingContacts } = await supabase
    .from("contacts")
    .select("domain")
    .eq("team_id", teamId);

  const existingDomains = new Set((existingContacts || []).map(c => c.domain));
  return (results || []).filter(r => !existingDomains.has(r.domain));
}

/**
 * Import a scraper result into the CRM as a contact
 */
async function importToCRM(result, teamId) {
  const contact = {
    team_id: teamId,
    name: result.store_name || result.domain,
    company: result.store_name || result.domain,
    domain: result.domain,
    email: result.contact_email,
    stage: "Lead",
    source: "scraper",
    estimated_revenue: result.estimated_revenue,
    product_count: result.product_count,
    beauty_score: result.beauty_score,
    aov: result.aov,
    category: (result.matched_keywords || []).slice(0, 3).join(", "),
    country: result.country || "",
    created_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("contacts")
    .insert(contact)
    .select()
    .single();

  if (error) throw new Error(`Failed to import contact: ${error.message}`);

  // Log activity
  await supabase.from("activities").insert({
    contact_id: data.id,
    team_id: teamId,
    type: "imported",
    description: `Auto-imported from scraper (beauty score: ${result.beauty_score}, est. revenue: $${result.estimated_revenue?.toLocaleString()})`,
    created_at: new Date().toISOString(),
  });

  // Mark as imported in scraper_results
  await supabase
    .from("scraper_results")
    .update({ imported_to_crm: true, lead_status: "added" })
    .eq("team_id", teamId)
    .eq("domain", result.domain);

  return data;
}

/**
 * Main outreach automation
 */
export async function runOutreach(teamId, config = {}) {
  const {
    limit = 50,
    source = "all",        // "crm", "scraper", or "all"
    country,
    sender = DEFAULT_SENDER,
    dryRun = false,        // if true, generate emails but don't send
    templateVariants,      // optional: array of variants to use, e.g. ["A", "C"]
  } = config;

  const keys = getKeys();
  if (!dryRun && !keys.resendApiKey) {
    throw new Error("RESEND_API_KEY is required. Add it to server/.env");
  }

  // Create campaign record
  const { data: campaign, error: campError } = await supabase
    .from("email_campaigns")
    .insert({
      team_id: teamId,
      name: `Outreach ${new Date().toISOString().split("T")[0]}`,
      status: "running",
      source,
      config: { limit, source, country, dryRun, templateVariants },
      started_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (campError) throw new Error(`Failed to create campaign: ${campError.message}`);

  currentRun = {
    campaignId: campaign.id,
    teamId,
    status: "running",
    total: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    results: [],
    startedAt: new Date().toISOString(),
    stopped: false,
  };

  // Collect contacts from all sources
  let contacts = [];

  if (source === "scraper" || source === "all") {
    const scraperResults = await fetchFromScraper(teamId, { limit });
    for (const result of scraperResults) {
      try {
        const contact = await importToCRM(result, teamId);
        // Attach scraper metadata for personalization
        contact._scraperData = result;
        contacts.push(contact);
      } catch (err) {
        console.error(`Failed to import ${result.domain}:`, err.message);
      }
    }
  }

  if (source === "crm" || source === "all") {
    const crmContacts = await fetchEligibleContacts(teamId, { limit: limit - contacts.length, source: source === "crm" ? undefined : undefined, country });
    contacts.push(...crmContacts);
  }

  // Deduplicate by email
  const seen = new Set();
  contacts = contacts.filter(c => {
    if (seen.has(c.email)) return false;
    seen.add(c.email);
    return true;
  });

  currentRun.total = contacts.length;

  // Update campaign total
  await supabase.from("email_campaigns").update({ total_contacts: contacts.length }).eq("id", campaign.id);

  // Filter active templates
  let activeTemplates = TEMPLATES;
  if (templateVariants?.length) {
    activeTemplates = TEMPLATES.filter(t => templateVariants.includes(t.variant));
  }
  if (!activeTemplates.length) activeTemplates = TEMPLATES;

  // Process each contact
  for (let i = 0; i < contacts.length; i++) {
    if (currentRun.stopped) {
      currentRun.status = "stopped";
      break;
    }

    const contact = contacts[i];
    const template = pickTemplate(i, activeTemplates);

    try {
      // Step 1: Scrape brand website for context + better email
      let brandData = null;
      if (contact.domain) {
        try {
          console.log(`  Scraping ${contact.domain}...`);
          brandData = await scrapeBrand(contact.domain);

          // Update email if we found a better one
          if (brandData.bestEmail && brandData.emailCount > 0 && (!contact.email || contact.email.startsWith("hello@") || contact.email.startsWith("info@") || contact.email.startsWith("contact@"))) {
            const oldEmail = contact.email;
            contact.email = brandData.bestEmail;
            // Persist better email to CRM
            await supabase.from("contacts").update({ email: brandData.bestEmail }).eq("id", contact.id);
            if (oldEmail !== brandData.bestEmail) {
              console.log(`    Email upgraded: ${oldEmail || "(none)"} → ${brandData.bestEmail}`);
            }
          }

          // Fill missing email from scrape — only if actually found on website
          if (!contact.email && brandData.bestEmail && brandData.emailCount > 0) {
            contact.email = brandData.bestEmail;
            await supabase.from("contacts").update({ email: brandData.bestEmail }).eq("id", contact.id);
            console.log(`    Email found: ${brandData.bestEmail}`);
          }
        } catch (err) {
          console.warn(`    Scrape failed for ${contact.domain}: ${err.message}`);
        }
      }

      // Skip if still no email
      if (!contact.email) {
        console.warn(`  Skipping ${contact.domain}: no email found`);
        currentRun.skipped++;
        currentRun.results.push({ email: contact.domain, status: "skipped", reason: "No email found" });
        continue;
      }

      // Step 2: Determine product type using all available data
      const matchedKeywords = contact._scraperData?.matched_keywords || contact.category?.split(", ") || [];
      const sampleTypes = contact._scraperData?.sample_types || [];
      const bi = brandData?.brandInfo || {};
      const brandText = [bi.brandStory || "", bi.usp || "", contact.domain || ""].join(" ");
      const productType = getPrimaryProductType(matchedKeywords, sampleTypes, brandText);

      // Step 3: Generate AI observation (Template D) using scraped brand context
      let observation = "";
      if (template.variant === "D" && keys.anthropicApiKey) {
        observation = await generateObservation({
          storeName: contact.company || contact.name,
          domain: contact.domain,
          sampleTypes,
          matchedKeywords,
          productCount: contact.product_count,
          country: contact.country,
          brandInfo: brandData?.brandInfo || {},
        }, keys.anthropicApiKey);
      } else if (template.variant === "D") {
        // Fallback observation using scraped data
        const bi = brandData?.brandInfo || {};
        if (bi.hasCreators || bi.hasAffiliates || bi.hasInfluencers) {
          observation = `I noticed ${contact.company || contact.name} already works with creators — have you been able to track which partnerships actually drive sales?`;
        } else {
          observation = `I came across ${contact.company || contact.name} and really liked what you've built — seems like a great fit for creator partnerships.`;
        }
      }

      // Step 4: Build template variables
      const firstName = extractFirstName(contact.name, contact.email, brandData?.brandInfo?.founderName);

      const vars = {
        brandName: contact.company || contact.name || contact.domain,
        firstName,
        domain: contact.domain,
        productType,
        country: contact.country || "",
        observation,
      };

      // Render
      const subject = renderTemplate(template.subject_template, vars);
      const body = renderTemplate(template.body_template, vars);

      // Validate
      const validation = validateRenderedEmail(subject, body);
      if (!validation.valid) {
        console.warn(`Skipping ${contact.email}: ${validation.issues.join(", ")}`);
        currentRun.skipped++;
        currentRun.results.push({ email: contact.email, status: "skipped", reason: validation.issues.join(", ") });
        continue;
      }

      // Create email_sends record
      const { data: sendRecord } = await supabase
        .from("email_sends")
        .insert({
          campaign_id: campaign.id,
          team_id: teamId,
          contact_id: contact.id,
          template_id: null, // templates are in-code, not DB yet
          template_variant: template.variant,
          to_email: contact.email,
          to_name: contact.name,
          subject,
          body,
          status: dryRun ? "draft" : "pending",
        })
        .select()
        .single();

      if (dryRun) {
        currentRun.sent++;
        currentRun.results.push({ email: contact.email, status: "draft", subject, variant: template.variant });
        continue;
      }

      // Send via Resend
      const result = await sendEmail({
        to: contact.email,
        toName: contact.name,
        subject,
        body,
        from: sender.from,
        replyTo: sender.replyTo,
        resendApiKey: keys.resendApiKey,
      });

      if (result.success) {
        currentRun.sent++;
        currentRun.results.push({ email: contact.email, status: "sent", resendId: result.resendId, variant: template.variant });

        // Update email_sends
        await supabase.from("email_sends").update({
          status: "sent",
          resend_id: result.resendId,
          sent_at: new Date().toISOString(),
        }).eq("id", sendRecord.id);

        // Update contact stage to "Contacted"
        await supabase.from("contacts").update({ stage: "Contacted" }).eq("id", contact.id);

        // Log activity
        await supabase.from("activities").insert({
          contact_id: contact.id,
          team_id: teamId,
          type: "email_sent",
          description: `Outreach email sent (Template ${template.variant}: ${template.name})`,
          created_at: new Date().toISOString(),
        });

        // Update template send count
        await supabase.from("email_templates")
          .update({ send_count: supabase.rpc ? undefined : 0 }) // Will use RPC or manual increment
          .eq("team_id", teamId)
          .eq("variant", template.variant);

      } else {
        currentRun.failed++;
        currentRun.results.push({ email: contact.email, status: "failed", error: result.error, variant: template.variant });

        await supabase.from("email_sends").update({
          status: "failed",
          error: result.error,
        }).eq("id", sendRecord.id);
      }

      // Rate-limit delay between sends
      await delaySend();

    } catch (err) {
      console.error(`Error processing ${contact.email}:`, err.message);
      currentRun.failed++;
      currentRun.results.push({ email: contact.email, status: "error", error: err.message });
    }

    // Update campaign progress every 5 contacts
    if ((i + 1) % 5 === 0) {
      await supabase.from("email_campaigns").update({
        emails_sent: currentRun.sent,
        emails_failed: currentRun.failed,
        emails_skipped: currentRun.skipped,
      }).eq("id", campaign.id);
    }
  }

  // Final campaign update
  currentRun.status = currentRun.stopped ? "stopped" : "complete";
  await supabase.from("email_campaigns").update({
    status: currentRun.status,
    emails_sent: currentRun.sent,
    emails_failed: currentRun.failed,
    emails_skipped: currentRun.skipped,
    completed_at: new Date().toISOString(),
  }).eq("id", campaign.id);

  const summary = {
    campaignId: campaign.id,
    status: currentRun.status,
    total: currentRun.total,
    sent: currentRun.sent,
    failed: currentRun.failed,
    skipped: currentRun.skipped,
  };

  currentRun = null;
  return summary;
}

export function getOutreachStatus() {
  if (!currentRun) return { status: "idle" };
  return {
    campaignId: currentRun.campaignId,
    status: currentRun.status,
    total: currentRun.total,
    sent: currentRun.sent,
    failed: currentRun.failed,
    skipped: currentRun.skipped,
    results: currentRun.results,
    rateLimit: getRateLimitStatus(),
  };
}

export function stopOutreach() {
  if (!currentRun || currentRun.status !== "running") {
    return { error: "No running outreach to stop" };
  }
  currentRun.stopped = true;
  return { status: "stopping" };
}

// Extract a first name from contact name, email, or scraped founder name
// For brand outreach, if we only have a brand name (not a person's name), use "there"
function extractFirstName(name, email, founderName) {
  // Use scraped founder name if available
  if (founderName) {
    const parts = founderName.trim().split(/\s+/);
    if (parts[0] && parts[0].length >= 2) return parts[0];
  }

  if (name) {
    const trimmed = name.trim();
    // Check if it looks like a person's name (has first + last, not all caps, not a brand)
    const parts = trimmed.split(/\s+/);
    const looksLikePersonName = parts.length >= 2
      && parts[0].length >= 2
      && parts[0] !== parts[0].toUpperCase()
      && !/^(the|dr\.|mr\.|ms\.|mrs\.)\s/i.test(trimmed)
      && !/[&+]/.test(trimmed); // brands often have "&" or "+"

    if (looksLikePersonName) {
      return parts[0];
    }

    // Single word that's clearly a person's first name (starts lowercase, no special chars)
    if (parts.length === 1 && /^[A-Z][a-z]{2,}$/.test(parts[0])) {
      return parts[0];
    }
  }

  // Try email: only use if local part looks like a personal name
  // Exclude generic prefixes: hello, info, contact, hi, press, marketing, etc.
  if (email) {
    const local = email.split("@")[0].toLowerCase();
    const genericPrefixes = ["hello", "info", "contact", "hi", "press", "marketing", "partnerships", "collab", "brand", "team", "support", "help", "sales", "admin", "privacy", "hola"];
    if (!genericPrefixes.includes(local) && /^[a-z]+$/i.test(local) && local.length >= 3 && local.length <= 12) {
      return local.charAt(0).toUpperCase() + local.slice(1);
    }
  }

  return "there";
}
