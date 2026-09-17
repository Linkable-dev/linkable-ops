import { Router } from "express";
import { cloudSqlQuery } from "../lib/cloudsql.js";
import { parseColumnFilters, filterConditions, textFilter, enumFilter } from "../lib/tableQuery.js";

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

// Per-column filters (filter[col]=value), server-side like every other table
// in this panel — the count under the table and the empty state stay true,
// which they would not if the rows were sieved in the browser after the fact.
//
// Four, and only four: the page is a list of agents, and the questions an
// operator actually arrives with are "which ones are stuck", "which are
// actually running", and "what is this brand's doing". Text for the two names,
// a fixed choice for the two states, because nobody types "autonomous".
const AGENT_FILTERS = {
  campaign_name: textFilter("p.title"),
  brand_name: textFilter("b.store_name"),
  mode: enumFilter({
    off: "a.mode = 'off'",
    assisted: "a.mode = 'assisted'",
    autonomous: "a.mode = 'autonomous'",
  }),
  status: enumFilter({
    idle: "a.status = 'idle'",
    working: "a.status = 'working'",
    waiting: "a.status = 'waiting'",
    done: "a.status = 'done'",
    paused: "a.status = 'paused'",
    failed: "a.status = 'failed'",
    // Not a column: the two shapes of "supposed to be running, is not".
    //
    // 'paused' is deliberately NOT in here — it means the campaign itself is
    // paused, which is somebody's decision rather than a fault, and on dev it
    // is most of the table. What is left is an agent that fell over, and one
    // that is switched on but has put itself to sleep for days: the shape of
    // an agent parked on a spent search allowance until the 1st.
    stuck: `(
      a.status = 'failed'
      OR (a.mode <> 'off' AND a.status = 'waiting'
          AND a.next_action_at > current_timestamp + interval '3 days')
    )`,
  }),
};

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

      // Conditions embed positional placeholders as they are built, so the
      // filter params go in first and limit/offset take the numbers after
      // them. Each query gets its own array and its own pass.
      const columnFilters = parseColumnFilters(req.query);
      const params = [];
      const conds = filterConditions(columnFilters, AGENT_FILTERS, params);
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      params.push(limit, offset);
      const limitAt = `$${params.length - 1}`;
      const offsetAt = `$${params.length}`;

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
            WHERE sr.product_id = a.product_id AND sr.${ND}) AS credits_spent,
          -- The limit that actually stops an agent, and it is the BRAND's, not
          -- this campaign's: "waiting — this month's searches are all used"
          -- next to "searches: none yet" is the same row telling the truth
          -- twice about two different things. Both numbers belong here.
          p.user_id                                AS brand_user_id,
          (SELECT count(*)::int FROM sourcing_runs sr
             JOIN products sp ON sp.id = sr.product_id
            WHERE sp.user_id = p.user_id AND sr.${ND}
              AND sr.created >= date_trunc('month', current_timestamp)
          )                                        AS searches_used
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
        ${where}
        ORDER BY a.status = 'working' DESC, ev.created DESC NULLS LAST, a.created DESC
        LIMIT ${limitAt} OFFSET ${offsetAt}
        `,
        params,
      );

      // Two counts, because the footer answers two things: how many matched,
      // and how many there are. One number alone leaves "12" next to a set
      // filter meaning either.
      const countParams = [];
      const countConds = filterConditions(columnFilters, AGENT_FILTERS, countParams);
      const { rows: totals } = await cloudSqlQuery(
        `SELECT
           count(*) FILTER (WHERE true${countConds.map((c) => ` AND ${c}`).join("")})::int AS total,
           count(*)::int                                                                  AS total_all
         FROM sourcing_agents a
         JOIN products p ON p.id = a.product_id AND p.${ND}
         LEFT JOIN brands b ON b.user_id = p.user_id
         WHERE a.${ND}`,
        countParams,
      );

      // The limits, read separately and allowed to fail on their own.
      //
      // sourcing_allowances arrives with a service-grpc migration, and this app
      // deploys on its own schedule — so for one deploy window the table can be
      // missing. Postgres resolves table names when it plans, not when it runs,
      // so a subquery for it inside the query above would have taken the whole
      // page down rather than one column of it.
      const limits = new Map();
      try {
        const { rows: allowances } = await cloudSqlQuery(
          `SELECT scope, monthly_searches FROM sourcing_allowances`,
        );
        for (const a of allowances) limits.set(a.scope, a.monthly_searches);
      } catch (limitErr) {
        if (!notPromoted(limitErr)) console.error("[autopilot/allowances-read]", limitErr);
      }
      const fallback = limits.get("default");
      for (const row of rows) {
        const own = limits.get(String(row.brand_user_id));
        row.allowance_is_override = own !== undefined;
        row.search_allowance = own !== undefined ? own : (fallback ?? null);
      }

      res.json({
        available: true,
        campaigns: rows,
        total: totals[0]?.total || 0,
        total_all: totals[0]?.total_all || 0,
      });
    } catch (e) {
      if (notPromoted(e)) {
        // Not an error: this database has never had sourcing deployed to it.
        return res.json({ available: false, campaigns: [], total: 0 });
      }
      console.error("[autopilot/campaigns]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/autopilot/allowances
  // The default, and every brand that has been given a number of its own.
  router.get("/allowances", async (req, res) => {
    try {
      const { rows } = await cloudSqlQuery(
        `SELECT sa.scope, sa.monthly_searches, sa.note, sa.updated, sa.updated_by,
                b.store_name, u.email,
                (SELECT count(*)::int FROM sourcing_runs sr
                   JOIN products p ON p.id = sr.product_id
                  WHERE p.user_id::text = sa.scope AND sr.${ND}
                    AND sr.created >= date_trunc('month', current_timestamp)) AS searches_used
           FROM sourcing_allowances sa
           LEFT JOIN users u ON u.id::text = sa.scope
           LEFT JOIN brands b ON b.user_id::text = sa.scope
          ORDER BY (sa.scope = 'default') DESC, sa.updated DESC`,
      );
      res.json({ available: true, allowances: rows });
    } catch (e) {
      if (notPromoted(e)) return res.json({ available: false, allowances: [] });
      console.error("[autopilot/allowances]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // PUT /api/autopilot/allowances/:scope   { monthly_searches, note }
  //
  // The one write on this page, and the reason it is allowed where starting an
  // agent is not: this does not act for a brand, it sets the number the agent
  // reads before it acts. Every guard still runs, on the value written here.
  // Starting, stopping and re-planning still belong to gRPC, which enforces
  // the budget and the send guards an UPDATE from here would walk past.
  //
  // `scope` is 'default' or a brand's users.id. Raising it un-parks an agent
  // on its next tick — no deploy, and no waiting for the 1st.
  router.put("/allowances/:scope", async (req, res) => {
    try {
      const scope = String(req.params.scope || "");
      if (scope !== "default" && !/^[0-9a-f-]{36}$/i.test(scope)) {
        return res.status(400).json({ error: "Scope must be 'default' or a brand user id" });
      }
      const searches = Math.floor(Number(req.body?.monthly_searches));
      if (!Number.isFinite(searches) || searches < 0 || searches > 1000) {
        return res.status(400).json({ error: "Searches must be a whole number between 0 and 1000" });
      }
      const note = String(req.body?.note || "").slice(0, 500);

      // A brand scope has to be a brand. A typo'd uuid would otherwise sit
      // there as a row that looks like a limit and applies to nobody.
      if (scope !== "default") {
        const { rows } = await cloudSqlQuery(
          `SELECT 1 FROM users WHERE id = $1 AND role = 2`, [scope],
        );
        if (!rows.length) return res.status(404).json({ error: "No brand with that id" });
      }

      const { rows } = await cloudSqlQuery(
        `INSERT INTO sourcing_allowances (scope, monthly_searches, note, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (scope) DO UPDATE
            SET monthly_searches = excluded.monthly_searches,
                note             = excluded.note,
                updated          = current_timestamp,
                updated_by       = excluded.updated_by
         RETURNING scope, monthly_searches, note, updated, updated_by`,
        [scope, searches, note, req.admin?.email || ""],
      );
      console.log(
        `[sourcing-allowance] admin=${req.admin?.email || "?"} db=${req.dbTarget || "prod"} ` +
        `scope=${scope} searches=${searches} note=${JSON.stringify(note)}`,
      );
      res.json({ allowance: rows[0] });
    } catch (e) {
      if (notPromoted(e)) return res.status(409).json({ error: "Sourcing is not on this database" });
      console.error("[autopilot/allowances/put]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/autopilot/allowances/:userId — back to the default. Deleting
  // the default row itself is refused: nothing would be left to fall back to
  // but the number compiled into the binary.
  router.delete("/allowances/:scope", async (req, res) => {
    try {
      const scope = String(req.params.scope || "");
      if (!/^[0-9a-f-]{36}$/i.test(scope)) {
        return res.status(400).json({ error: "Only a brand's own limit can be removed" });
      }
      await cloudSqlQuery(`DELETE FROM sourcing_allowances WHERE scope = $1`, [scope]);
      console.log(
        `[sourcing-allowance] admin=${req.admin?.email || "?"} db=${req.dbTarget || "prod"} ` +
        `scope=${scope} removed`,
      );
      res.json({ ok: true });
    } catch (e) {
      console.error("[autopilot/allowances/delete]", e);
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
