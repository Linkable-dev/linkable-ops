import { Router } from "express";
import fs from "fs";
import path from "path";

function readCRM(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, "crm.json"), "utf-8"));
  } catch {
    return { contacts: [], deals: [] };
  }
}

function writeCRM(dataDir, data) {
  fs.writeFileSync(path.join(dataDir, "crm.json"), JSON.stringify(data, null, 2));
}

export function crmRoutes(dataDir) {
  const router = Router();

  // --- Contacts ---
  router.get("/contacts", (req, res) => {
    const crm = readCRM(dataDir);
    let contacts = crm.contacts;
    const { search, tag, stage, source } = req.query;
    if (search) {
      const q = search.toLowerCase();
      contacts = contacts.filter(c =>
        (c.name || "").toLowerCase().includes(q) ||
        (c.company || "").toLowerCase().includes(q) ||
        (c.domain || "").toLowerCase().includes(q) ||
        (c.email || "").toLowerCase().includes(q)
      );
    }
    if (tag) contacts = contacts.filter(c => (c.tags || []).includes(tag));
    if (stage) contacts = contacts.filter(c => c.stage === stage);
    if (source) contacts = contacts.filter(c => c.source === source);
    res.json(contacts);
  });

  router.post("/contacts", (req, res) => {
    const crm = readCRM(dataDir);
    const contact = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: req.body.name || "",
      company: req.body.company || "",
      domain: req.body.domain || "",
      email: req.body.email || "",
      phone: req.body.phone || "",
      role: req.body.role || "",
      tags: req.body.tags || [],
      stage: req.body.stage || "Lead",
      estimatedRevenue: req.body.estimatedRevenue || null,
      productCount: req.body.productCount || null,
      category: req.body.category || "",
      country: req.body.country || "",
      source: req.body.source || "manual",
      notes: [],
      activities: [{ id: Date.now().toString(), type: "created", description: `Contact created from ${req.body.source || "manual"} entry`, timestamp: new Date().toISOString() }],
      createdAt: new Date().toISOString(),
    };
    crm.contacts.push(contact);
    writeCRM(dataDir, crm);
    res.json(contact);
  });

  router.put("/contacts/:id", (req, res) => {
    const crm = readCRM(dataDir);
    const idx = crm.contacts.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Contact not found" });
    const old = crm.contacts[idx];
    const updated = { ...old, ...req.body, id: old.id, createdAt: old.createdAt };
    // Track stage changes
    if (req.body.stage && req.body.stage !== old.stage) {
      updated.activities = [...(updated.activities || []), {
        id: Date.now().toString(), type: "stage_change",
        description: `Stage changed from ${old.stage} to ${req.body.stage}`,
        timestamp: new Date().toISOString(),
      }];
    }
    crm.contacts[idx] = updated;
    writeCRM(dataDir, crm);
    res.json(updated);
  });

  router.delete("/contacts/:id", (req, res) => {
    const crm = readCRM(dataDir);
    crm.contacts = crm.contacts.filter(c => c.id !== req.params.id);
    crm.deals = crm.deals.filter(d => d.contactId !== req.params.id);
    writeCRM(dataDir, crm);
    res.json({ ok: true });
  });

  router.post("/contacts/:id/notes", (req, res) => {
    const crm = readCRM(dataDir);
    const contact = crm.contacts.find(c => c.id === req.params.id);
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    const note = { id: Date.now().toString(), text: req.body.text, timestamp: new Date().toISOString() };
    contact.notes.push(note);
    contact.activities.push({ id: (Date.now() + 1).toString(), type: "note_added", description: "Note added", timestamp: new Date().toISOString() });
    writeCRM(dataDir, crm);
    res.json(note);
  });

  router.post("/contacts/import", (req, res) => {
    const crm = readCRM(dataDir);
    const { scraperResult } = req.body;
    if (!scraperResult) return res.status(400).json({ error: "Missing scraperResult" });

    // Check for duplicate
    if (crm.contacts.some(c => c.domain === scraperResult.domain)) {
      return res.status(409).json({ error: "Contact with this domain already exists" });
    }

    const contact = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: scraperResult.storeName || "",
      company: scraperResult.storeName || "",
      domain: scraperResult.domain,
      email: "",
      phone: "",
      role: "",
      tags: ["shopify", "beauty", scraperResult.country?.toLowerCase() || ""].filter(Boolean),
      stage: "Lead",
      estimatedRevenue: scraperResult.estimatedRevenue,
      productCount: scraperResult.productCount,
      category: (scraperResult.matchedKeywords || []).slice(0, 3).join(", "),
      country: scraperResult.country || "",
      source: "scraper",
      beautyScore: scraperResult.beautyScore,
      aov: scraperResult.aov,
      notes: [],
      activities: [{ id: Date.now().toString(), type: "imported", description: `Imported from Shopify scraper (beauty score: ${scraperResult.beautyScore}, est. revenue: $${scraperResult.estimatedRevenue?.toLocaleString()})`, timestamp: new Date().toISOString() }],
      createdAt: new Date().toISOString(),
    };
    crm.contacts.push(contact);

    // Auto-create a deal
    const deal = {
      id: Date.now().toString(36) + "d" + Math.random().toString(36).slice(2, 6),
      contactId: contact.id,
      value: scraperResult.estimatedRevenue || 0,
      stage: "Lead",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    crm.deals.push(deal);

    writeCRM(dataDir, crm);
    res.json({ contact, deal });
  });

  // --- Deals ---
  router.get("/deals", (req, res) => {
    const crm = readCRM(dataDir);
    // Enrich deals with contact info
    const deals = crm.deals.map(d => {
      const contact = crm.contacts.find(c => c.id === d.contactId);
      return { ...d, contactName: contact?.name, contactCompany: contact?.company, contactDomain: contact?.domain };
    });
    res.json(deals);
  });

  router.post("/deals", (req, res) => {
    const crm = readCRM(dataDir);
    const deal = {
      id: Date.now().toString(36) + "d" + Math.random().toString(36).slice(2, 6),
      contactId: req.body.contactId,
      value: req.body.value || 0,
      stage: req.body.stage || "Lead",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    crm.deals.push(deal);
    writeCRM(dataDir, crm);
    res.json(deal);
  });

  router.put("/deals/:id", (req, res) => {
    const crm = readCRM(dataDir);
    const idx = crm.deals.findIndex(d => d.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Deal not found" });
    crm.deals[idx] = { ...crm.deals[idx], ...req.body, id: crm.deals[idx].id, createdAt: crm.deals[idx].createdAt, updatedAt: new Date().toISOString() };
    writeCRM(dataDir, crm);
    res.json(crm.deals[idx]);
  });

  return router;
}
