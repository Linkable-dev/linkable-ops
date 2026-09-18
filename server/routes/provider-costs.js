import { Router } from "express";
import { cloudSqlQuery } from "../lib/cloudsql.js";

// Units are fixed to the counters we actually record. A rate cannot silently
// change from cost per credit to cost per thousand credits.
export const COST_PROVIDERS = [
  { provider: "influencers_club", label: "Influencers.club", unit: "credit",
    help: "Recorded credits for sourcing runs started this month, valued at the current rate. Includes deleted runs; excludes enrichment outside sourcing." },
  { provider: "lemlist", label: "Lemlist", unit: "lead",
    help: "Candidate records last pushed to Lemlist this month, valued at the current rate. An allocated cost per lead, not a provider invoice or count of emails sent." },
];

export function providerCostRoutes({ query = cloudSqlQuery } = {}) {
  const router = Router();
  router.get("/", async (_req, res) => {
    try {
      const { rows } = await query(`
        WITH usage AS (
          SELECT 'influencers_club'::text AS provider, COALESCE(SUM(credits_spent), 0) AS quantity
            FROM sourcing_runs WHERE created >= date_trunc('month', current_timestamp)
          UNION ALL
          SELECT 'lemlist', count(*)::numeric FROM sourcing_candidates
            WHERE pushed_at >= date_trunc('month', current_timestamp) AND lemlist_campaign_id <> ''
        )
        SELECT u.provider, u.quantity::text, p.unit_cost::text, p.currency, p.note,
               p.updated, p.updated_by, date_trunc('month', current_timestamp) AS period_start,
               CASE WHEN p.unit = CASE u.provider WHEN 'lemlist' THEN 'lead' ELSE 'credit' END
                    THEN (u.quantity * p.unit_cost)::text ELSE NULL END AS estimated_cost,
               p.unit
          FROM usage u LEFT JOIN provider_costs p ON p.provider = u.provider`);
      res.json({ available: true, providers: COST_PROVIDERS.map((provider) => {
        const row = rows.find((r) => r.provider === provider.provider);
        const configured = row?.unit === provider.unit && row?.unit_cost != null;
        return { ...row, ...provider, configured,
          unit_cost: configured ? row.unit_cost : null,
          estimated_cost: configured ? row.estimated_cost : null };
      }) });
    } catch (e) {
      if (e.code === "42P01") return res.json({ available: false, providers: [] });
      console.error("[provider-costs/get]", e);
      res.status(500).json({ error: "Could not load provider costs" });
    }
  });
  router.put("/:provider", async (req, res) => {
    const provider = COST_PROVIDERS.find((p) => p.provider === req.params.provider);
    if (!provider) return res.status(400).json({ error: "Unknown provider" });
    const raw = req.body?.unit_cost;
    const rate = typeof raw === "string" || typeof raw === "number" ? String(raw).trim() : "";
    const currency = String(req.body?.currency ?? "").trim().toUpperCase();
    if (!/^\d{1,6}(\.\d{1,6})?$/.test(rate)) {
      return res.status(400).json({ error: "Enter a non-negative rate below 1000000, with up to six decimal places" });
    }
    if (!Intl.supportedValuesOf("currency").includes(currency)) {
      return res.status(400).json({ error: "Enter a valid currency code, such as USD, GBP or EUR" });
    }
    try {
      const { rows } = await query(`
        INSERT INTO provider_costs (provider, unit, unit_cost, currency, note, updated_by)
        VALUES ($1, $2, $3::numeric, $4, $5, $6)
        ON CONFLICT (provider) DO UPDATE SET unit = excluded.unit, unit_cost = excluded.unit_cost,
          currency = excluded.currency, note = excluded.note, updated_by = excluded.updated_by,
          updated = current_timestamp
        RETURNING provider, unit, unit_cost::text, currency, note, updated, updated_by`,
      [provider.provider, provider.unit, rate, currency, String(req.body?.note ?? "").slice(0, 500), req.admin?.email || ""]);
      res.json({ rate: rows[0] });
    } catch (e) {
      if (e.code === "42P01") return res.status(409).json({ error: "Provider costs are not available on this database yet" });
      console.error("[provider-costs/put]", e);
      res.status(500).json({ error: "Could not save provider cost" });
    }
  });
  router.delete("/:provider", async (req, res) => {
    if (!COST_PROVIDERS.some((p) => p.provider === req.params.provider)) {
      return res.status(400).json({ error: "Unknown provider" });
    }
    try {
      await query("DELETE FROM provider_costs WHERE provider = $1", [req.params.provider]);
      res.json({ cleared: req.params.provider });
    } catch (e) {
      if (e.code === "42P01") return res.status(409).json({ error: "Provider costs are not available on this database yet" });
      console.error("[provider-costs/delete]", e);
      res.status(500).json({ error: "Could not clear provider cost" });
    }
  });
  return router;
}
