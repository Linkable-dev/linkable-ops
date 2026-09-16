import { Router } from "express";
import { cloudSqlQuery } from "../lib/cloudsql.js";

// Autopilot: the recruiting machine, watched from here.
//
// The brand-facing app used to show all of this — found, contactable, emailed,
// replied — and it was taken off on the founder's call: a brand buys relevant
// applicants, not a view of the machine that finds them. The machine still
// needs watching, and this is where that happens now.
//
// Everything here is READ-ONLY. Starting, stopping and re-planning an agent
// happen in the main app's own console (it writes through gRPC, which enforces
// the budget and the send guards); an UPDATE issued straight at the database
// from here would walk straight past both.
//
// The counts deliberately mirror SourcingRepository.ProgressForAgent in
// service-grpc, because those are the numbers the agent itself acts on. If this
// page and the agent disagreed about how many creators applied, the page would
// be describing a decision the agent never made.
const LINK_APPLIED = 2;
const LINK_ACCEPTED = 3;
const ND = "deleted = '-infinity'";

// Postgres "undefined_table". Sourcing has never been promoted to production,
// so the prod database has none of these tables — a 500 there would read as a
// broken page rather than as a feature that is not there yet.
const UNDEFINED_TABLE = "42P01";

function notPromoted(e) {
  return e?.code === UNDEFINED_TABLE;
}

export function autopilotRoutes() {
  const router = Router();

  // GET /api/autopilot/campaigns
  // One row per campaign that has an agent, whatever state it is in — an agent
  // that is off or stopped is exactly what somebody looking at this page needs
  // to see, so nothing is filtered out by default.
  router.get("/campaigns", async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);

      const { rows } = await cloudSqlQuery(
        `
        WITH agent AS (
          SELECT a.*
          FROM sourcing_agents a
          WHERE a.${ND}
        ),
        funnel AS (
          SELECT
            c.product_id,
            count(DISTINCT c.id)                                                   AS found,
            count(DISTINCT c.id) FILTER (WHERE c.email <> '')                      AS contactable,
            count(DISTINCT c.id) FILTER (WHERE c.push_status IN ('pushed', 'invited')) AS emailed,
            count(DISTINCT c.id) FILTER (WHERE c.applied_at IS NOT NULL
                                           OR l.status = ${LINK_APPLIED})          AS applied,
            count(DISTINCT c.id) FILTER (WHERE c.decision = 'accepted'
                                           OR (l.status = ${LINK_ACCEPTED}
                                               AND c.applied_at IS NOT NULL))      AS accepted
          FROM sourcing_candidates c
          -- The collaboration the invite (or their reply) produced. Status 3
          -- counts only alongside an application: a campaign that lets anyone
          -- join writes an accepted link the moment the brand invites, and that
          -- is not somebody applying.
          LEFT JOIN links l ON l.influencer_user_id = c.user_id
                           AND l.product_id = c.product_id AND l.${ND}
          WHERE c.${ND}
          GROUP BY c.product_id
        ),
        replied AS (
          -- Replies come from the provider's own events, not from the candidate
          -- row, because a creator who answers by mail never touches it.
          SELECT e.product_id, count(DISTINCT e.sourcing_candidate_id) AS replied
          FROM sourcing_outreach_events e
          WHERE e.event_type = 'emailsReplied' AND e.sourcing_candidate_id IS NOT NULL
          GROUP BY e.product_id
        )
        SELECT
          a.id                                     AS agent_id,
          a.product_id,
          p.title                                  AS campaign_name,
          p.status                                 AS campaign_status,
          b.store_name                             AS brand_name,
          a.mode,
          a.status,
          a.stopped_reason,
          a.goal_applications,
          a.runs_used,
          a.max_runs,
          a.lemlist_campaign_id <> ''              AS has_sequence,
          a.auto_reply,
          a.last_acted_at,
          a.next_action_at,
          a.created                                AS enrolled_at,
          COALESCE(f.found, 0)                     AS found,
          COALESCE(f.contactable, 0)               AS contactable,
          COALESCE(f.emailed, 0)                   AS emailed,
          COALESCE(r.replied, 0)                   AS replied,
          COALESCE(f.applied, 0)                   AS applied,
          COALESCE(f.accepted, 0)                  AS accepted,
          -- A search the provider is still working through. This is why an
          -- agent can sit at "working" for half an hour and be perfectly fine.
          EXISTS (
            SELECT 1 FROM sourcing_runs sr
            WHERE sr.product_id = a.product_id AND sr.${ND}
              AND sr.status IN ('planning', 'planned', 'running', 'enriching')
          )                                        AS run_in_flight,
          ev.created                               AS last_event_at,
          ev.action                                AS last_event_action,
          ev.summary                               AS last_event_summary,
          (SELECT COALESCE(SUM(sr.credits_spent), 0) FROM sourcing_runs sr
            WHERE sr.product_id = a.product_id AND sr.${ND}) AS credits_spent
        FROM agent a
        JOIN products p ON p.id = a.product_id AND p.${ND}
        LEFT JOIN brands b ON b.user_id = p.user_id
        LEFT JOIN funnel f ON f.product_id = a.product_id
        LEFT JOIN replied r ON r.product_id = a.product_id
        LEFT JOIN LATERAL (
          SELECT e.created, e.action, e.summary
          FROM sourcing_agent_events e
          WHERE e.sourcing_agent_id = a.id
          ORDER BY e.created DESC
          LIMIT 1
        ) ev ON true
        -- Whatever is moving first: an agent mid-run, then the most recently
        -- active, then the ones that have never done anything.
        ORDER BY a.status = 'working' DESC, ev.created DESC NULLS LAST, a.created DESC
        LIMIT $1 OFFSET $2
        `,
        [limit, offset],
      );

      const { rows: totals } = await cloudSqlQuery(
        `SELECT count(*)::int AS total FROM sourcing_agents WHERE ${ND}`,
      );

      res.json({ available: true, campaigns: rows, total: totals[0]?.total || 0 });
    } catch (e) {
      if (notPromoted(e)) {
        // Not an error: this database has never had sourcing deployed to it.
        return res.json({ available: false, campaigns: [], total: 0 });
      }
      console.error("[autopilot/campaigns]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/autopilot/campaigns/:id/events
  // What the agent did, in its own words — the log it writes for the brand,
  // which is the same log that explains a stall to us.
  router.get("/campaigns/:id/events", async (req, res) => {
    try {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
        return res.status(400).json({ error: "Invalid campaign id" });
      }
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);

      const { rows: events } = await cloudSqlQuery(
        `SELECT e.created, e.action, e.summary, e.detail
         FROM sourcing_agent_events e
         JOIN sourcing_agents a ON a.id = e.sourcing_agent_id
         WHERE a.product_id = $1 AND a.${ND}
         ORDER BY e.created DESC
         LIMIT $2`,
        [req.params.id, limit],
      );

      // The searches themselves: what each one cost and what it found. A stalled
      // enrichment shows up here as a run that is still 'enriching' with a
      // checked count well under what it discovered.
      const { rows: runs } = await cloudSqlQuery(
        `SELECT
           r.id, r.created, r.status, r.error,
           r.target_creators, r.discovered_count, r.filtered_count, r.enriched_count,
           r.credits_spent,
           (SELECT count(*) FROM sourcing_candidates c
             WHERE c.sourcing_run_id = r.id AND c.${ND} AND c.email <> '') AS contactable
         FROM sourcing_runs r
         WHERE r.product_id = $1 AND r.${ND}
         ORDER BY r.created DESC
         LIMIT 20`,
        [req.params.id],
      );

      res.json({ available: true, events, runs });
    } catch (e) {
      if (notPromoted(e)) return res.json({ available: false, events: [], runs: [] });
      console.error("[autopilot/events]", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
