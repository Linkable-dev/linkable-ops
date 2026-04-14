import { Router } from "express";
import { runOutreach, getOutreachStatus, stopOutreach } from "../automation/outreach.js";
import { getRateLimitStatus } from "../automation/send.js";
import { TEMPLATES } from "../automation/templates.js";
import { supabase } from "../lib/supabase.js";

export function outreachRoutes() {
  const router = Router();

  // Start outreach automation
  router.post("/start", async (req, res) => {
    try {
      const { limit, source, country, dryRun, templateVariants, sender } = req.body;

      // Don't await — run in background and return immediately
      const promise = runOutreach(req.teamId, {
        limit: limit || 50,
        source: source || "all",
        country,
        dryRun: dryRun || false,
        templateVariants,
        sender,
      });

      // Give it a moment to start
      await new Promise(r => setTimeout(r, 500));

      const status = getOutreachStatus();
      res.json({ started: true, ...status });

      // Let it finish in background
      promise.catch(err => console.error("Outreach error:", err.message));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get current run status
  router.get("/status", (req, res) => {
    res.json(getOutreachStatus());
  });

  // Stop current run
  router.post("/stop", (req, res) => {
    res.json(stopOutreach());
  });

  // Get rate limit info
  router.get("/rate-limit", (req, res) => {
    res.json(getRateLimitStatus());
  });

  // Get available templates
  router.get("/templates", (req, res) => {
    res.json(TEMPLATES.map(t => ({
      variant: t.variant,
      name: t.name,
      subject_template: t.subject_template,
      body_preview: t.body_template.slice(0, 200) + "...",
    })));
  });

  // List campaigns for this team
  router.get("/campaigns", async (req, res) => {
    const { data, error } = await supabase
      .from("email_campaigns")
      .select("*")
      .eq("team_id", req.teamId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // Get campaign details with sends
  router.get("/campaigns/:id", async (req, res) => {
    const { data: campaign } = await supabase
      .from("email_campaigns")
      .select("*")
      .eq("id", req.params.id)
      .eq("team_id", req.teamId)
      .single();

    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    const { data: sends } = await supabase
      .from("email_sends")
      .select("*")
      .eq("campaign_id", req.params.id)
      .order("created_at", { ascending: false });

    res.json({ ...campaign, sends: sends || [] });
  });

  // Get A/B test analytics (sends grouped by template variant)
  router.get("/analytics", async (req, res) => {
    const { data: sends, error } = await supabase
      .from("email_sends")
      .select("template_variant, status")
      .eq("team_id", req.teamId);

    if (error) return res.status(500).json({ error: error.message });

    // Aggregate by variant
    const variants = {};
    for (const send of (sends || [])) {
      const v = send.template_variant || "?";
      if (!variants[v]) variants[v] = { variant: v, sent: 0, failed: 0, total: 0 };
      variants[v].total++;
      if (send.status === "sent") variants[v].sent++;
      if (send.status === "failed") variants[v].failed++;
    }

    // Total stats
    const total = {
      campaigns: 0,
      totalSent: (sends || []).filter(s => s.status === "sent").length,
      totalFailed: (sends || []).filter(s => s.status === "failed").length,
      total: (sends || []).length,
    };

    // Get campaign count
    const { count } = await supabase
      .from("email_campaigns")
      .select("id", { count: "exact", head: true })
      .eq("team_id", req.teamId);

    total.campaigns = count || 0;

    res.json({
      variants: Object.values(variants),
      total,
      templates: TEMPLATES.map(t => ({ variant: t.variant, name: t.name })),
    });
  });

  // Preview: generate a single email for a contact without sending
  router.post("/preview", async (req, res) => {
    const { contactId, variant } = req.body;

    const { data: contact } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", contactId)
      .eq("team_id", req.teamId)
      .single();

    if (!contact) return res.status(404).json({ error: "Contact not found" });

    const template = TEMPLATES.find(t => t.variant === (variant || "A")) || TEMPLATES[0];

    // Import personalization inline
    const { renderTemplate, validateRenderedEmail } = await import("../automation/personalize.js");
    const { getPrimaryProductType } = await import("../automation/templates.js");

    const productType = getPrimaryProductType(
      contact.category?.split(", ") || [],
      []
    );

    const firstName = contact.name?.split(/\s+/)[0] || "there";

    const vars = {
      brandName: contact.company || contact.name || contact.domain,
      firstName,
      domain: contact.domain,
      productType,
      country: contact.country || "",
      observation: `I came across ${contact.company || contact.name} and was impressed by your ${productType} products.`,
      senderName: req.body.senderName || "Luca",
      senderTitle: req.body.senderTitle || "Founder",
      unsubscribeUrl: `https://linkable.link/unsubscribe?email=${encodeURIComponent(contact.email)}&cid=${contact.id}`,
    };

    const subject = renderTemplate(template.subject_template, vars);
    const body = renderTemplate(template.body_template, vars);
    const validation = validateRenderedEmail(subject, body);

    res.json({
      variant: template.variant,
      templateName: template.name,
      subject,
      body,
      validation,
    });
  });

  return router;
}
