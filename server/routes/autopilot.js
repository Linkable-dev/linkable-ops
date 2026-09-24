import { Router } from "express";
import { providerCostRoutes } from "./provider-costs.js";
import { cloudSqlQuery } from "../lib/cloudsql.js";
import { signedUrls } from "../lib/gcs.js";
import {
  parseColumnFilters, filterConditions, textFilter, enumFilter, orderBySql,
} from "../lib/tableQuery.js";

// Autopilot: the recruiting machine, watched from here.
//
// The brand-facing app used to show all of this — found, contactable, emailed,
// replied — and it was taken off on the founder's call: a brand buys relevant
// applicants, not a view of the machine that finds them. The machine still
// needs watching, and this is where that happens now.
//
// What this may write, and what it may not.
//
// Writable: the settings the agent READS before it acts — its mode, its goal,
// its search budget, the brand's monthly allowance, and its clock. Each is a
// column the agent consults on its next tick, so every guard still runs, on
// the values set here. The agent-settings write is the same statement gRPC
// issues (UpdateAgentSettings in repository/postgres/sourcing_agent.go), with
// the same clamps, so the two cannot disagree.
//
// Not writable, ever: anything that spends or sends — starting a search,
// pushing a list into a sequence, sending a reply. Those go through gRPC,
// which owns the provider credits and the send guards, and a direct UPDATE
// would walk straight past both. The line is "what it is allowed to do" vs
// "do it now, on the brand's money".
//
// The counts deliberately mirror SourcingRepository.ProgressForAgent in
// service-grpc, because those are the numbers the agent itself acts on. If this
// page and the agent disagreed about how many creators applied, the page would
// be describing a decision the agent never made.
const LINK_APPLIED = 2;
const LINK_ACCEPTED = 3;
const ND = "deleted = '-infinity'";

// products.status 2 = ACTIVE (PRODUCT_STATUS_ACTIVE in proto/products.proto).
// The only campaign an agent will act on: its first move on anything else is
// to stop itself, so it is also the only one worth offering a launch for.
const CAMPAIGN_ACTIVE = 2;

// The numbers a campaign launching today is enrolled with — houseGoalApplications
// and houseMaxRuns in service-grpc/services/products_service.go. Used to fill
// the editor for a campaign that has no agent row to read them from.
const HOUSE_GOAL = 25;
const HOUSE_MAX_RUNS = 2;

// Postgres "undefined_table". Sourcing reached production on 21 Sep 2026 and
// its tables follow the code, but this app deploys on its own schedule and can
// be pointed at a database that has not caught up — a 500 there would read as
// a broken page rather than as a feature that is not there yet.
const UNDEFINED_TABLE = "42P01";

function notPromoted(e) {
  return e?.code === UNDEFINED_TABLE;
}

const isUuid = (v) => /^[0-9a-f-]{36}$/i.test(String(v || ""));

// A creator's picture is either a path we copied the bytes for at discovery
// (the provider's own links die within a day) or, for a candidate never
// re-enriched, still the provider's original URL — mirrors the same branch
// in service-grpc's campaign_matches.go. Only the first needs signing; the
// second is already fetchable, and signing it as if it were our own object
// name would just produce a broken URL.
async function withProfileImages(rows, target) {
  const blobs = rows.map((r) => (r.profile_image?.startsWith("influencer/") ? r.profile_image : ""));
  const signed = await signedUrls(blobs, 3600, target);
  rows.forEach((r, i) => {
    r.profile_image = signed[i] || (blobs[i] ? null : r.profile_image || null);
  });
  return rows;
}

// A whole number inside bounds, or null for something that was never a number.
function clamp(raw, min, max) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, min), max);
}

// The agent's own log, written the way service-grpc writes it. An admin's
// change belongs in the same timeline as the agent's decisions — a mode that
// changed with no line saying who changed it reads as the agent's own doing.
// Takes the router's own `query` rather than reaching for cloudSqlQuery: the
// footnote must land on the same connection as the change it describes, or a
// caller that injected one (a test, a transaction) writes the line somewhere
// the row it points at does not exist.
async function logAgentEvent(query, agentId, productId, action, summary, detail) {
  try {
    await query(
      `INSERT INTO sourcing_agent_events (sourcing_agent_id, product_id, action, summary, detail)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
      [agentId, productId, action, summary, detail],
    );
  } catch (e) {
    // The change itself succeeded; failing the request over its footnote
    // would be worse than the missing line.
    console.error("[autopilot/log]", e);
  }
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
    // Not a mode: a campaign with no agent row at all. Every comparison above
    // is NULL for those rows and so excludes them, which is why this needs to
    // be its own answer rather than falling out of "off".
    none: "a.id IS NULL",
  }),
  status: enumFilter({
    none: "a.id IS NULL",
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

// Sortable columns, whitelisted: nothing from the client reaches the SQL
// string, a key that is not here falls back to the default ordering.
//
// The aggregates are COALESCEd the same way they are selected, so sorting by
// "applied" puts a campaign that has produced nothing at the bottom rather
// than wherever NULL happens to land.
const AGENT_SORTS = {
  campaign_name: "p.title",
  brand_name: "b.store_name",
  // COALESCEd for the same reason the SELECT is: a campaign with no agent has
  // no mode, and sorting it to wherever NULL lands scatters the launchable
  // ones through the table instead of grouping them.
  mode: "COALESCE(a.mode, 'none')",
  status: "COALESCE(a.status, 'none')",
  // Falls back to when the CAMPAIGN went live, which is what the column says
  // and the only date an un-enrolled row has.
  enrolled_at: "COALESCE(a.created, p.activated_at)",
  found: "COALESCE(f.found, 0)",
  contactable: "COALESCE(f.contactable, 0)",
  emailed: "COALESCE(f.emailed, 0)",
  replied: "COALESCE(r.replied, 0)",
  applied: "COALESCE(f.applied, 0)",
  runs_used: "COALESCE(a.runs_used, 0)",
  searches_used: `(SELECT count(*) FROM sourcing_runs sr
                     JOIN products sp ON sp.id = sr.product_id
                    WHERE sp.user_id = p.user_id AND sr.${ND}
                      AND sr.created >= date_trunc('month', current_timestamp))`,
  last_event_at: "ev.created",
  next_action_at: "a.next_action_at",
};

// What it sorts by when nobody has said: whatever is moving, then whatever
// moved most recently. It doubles as the tie-breaker under every other sort,
// so the order inside equal values is stable rather than whatever the planner
// felt like returning.
const DEFAULT_ORDER =
  "COALESCE(a.status, '') = 'working' DESC, ev.created DESC NULLS LAST, " +
  "COALESCE(a.created, p.activated_at) DESC";

export function autopilotRoutes({ query = cloudSqlQuery } = {}) {
  const router = Router();
  router.use("/provider-costs", providerCostRoutes({ query }));

  // GET /api/autopilot/campaigns
  // One row per campaign that has an agent, whatever state it is in — an agent
  // that is off or stopped is exactly what somebody looking at this page needs
  // to see, so nothing is filtered out by default.
  //
  // Plus every ACTIVE campaign that has NO agent, which is the launch list.
  // enrolSourcingAgent only runs at the NEW -> ACTIVE transition, so every
  // campaign that went live before agents existed has no row; and the
  // brand-facing console that could create one is built with
  // PUBLIC_SOURCING_ENABLED=false in production, so it 404s there. Without
  // these rows this page could watch agents but never start one, and an
  // operator asked to "turn Autopilot on for that campaign" had nothing to
  // click.
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
      // The set this page is about, before any filter narrows it: an agent, or
      // a live campaign that could be given one.
      const base = [`p.${ND}`, `(a.id IS NOT NULL OR p.status = ${CAMPAIGN_ACTIVE})`];
      const where = `WHERE ${[...base, ...conds].join(" AND ")}`;
      params.push(limit, offset);
      const limitAt = `$${params.length - 1}`;
      const offsetAt = `$${params.length}`;

      const { rows } = await query(
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
          p.id                                     AS product_id,
          p.title                                  AS campaign_name,
          p.status                                 AS campaign_status,
          b.store_name                             AS brand_name,
          -- 'none' rather than 'off' for a campaign that was never enrolled.
          -- Off is a decision somebody made and the agent honours it; none is
          -- the absence of one, and the difference is the whole point of the
          -- launch button.
          COALESCE(a.mode, 'none')                 AS mode,
          COALESCE(a.status, 'none')               AS status,
          COALESCE(a.stopped_reason, '')           AS stopped_reason,
          -- The house defaults, so the editor opens on the numbers a campaign
          -- launching today would be given rather than on blanks.
          COALESCE(a.goal_applications, ${HOUSE_GOAL})  AS goal_applications,
          COALESCE(a.runs_used, 0)                 AS runs_used,
          COALESCE(a.max_runs, ${HOUSE_MAX_RUNS})  AS max_runs,
          COALESCE(a.lemlist_campaign_id, '') <> '' AS has_sequence,
          COALESCE(a.auto_reply, false)            AS auto_reply,
          a.last_acted_at,
          a.next_action_at,
          COALESCE(a.created, p.activated_at)      AS enrolled_at,
          COALESCE(f.found, 0)                     AS found,
          COALESCE(f.contactable, 0)               AS contactable,
          COALESCE(f.emailed, 0)                   AS emailed,
          -- What the provider says actually LEFT, which is a different number
          -- and a slower one: a push hands the whole list over at once and the
          -- sequence then drips it at its own rate for days. "Emailed 454"
          -- next to a Sent tab reading 7 was one word covering both.
          --
          -- Distinct candidates, not events: the sequence has three steps, so
          -- once the follow-ups start firing an event count would climb past
          -- the number of creators who have heard anything at all. NULL
          -- candidate ids are leads that came from somewhere other than a
          -- search, and are not this campaign's to claim.
          (SELECT count(DISTINCT e.sourcing_candidate_id)::int
             FROM sourcing_outreach_events e
            WHERE e.product_id = p.id AND e.event_type = 'emailsSent'
              AND e.sourcing_candidate_id IS NOT NULL) AS sent,
          COALESCE(r.replied, 0)                   AS replied,
          COALESCE(f.applied, 0)                   AS applied,
          COALESCE(f.accepted, 0)                  AS accepted,
          -- A search the provider is still working through. This is why an
          -- agent can sit at "working" for half an hour and be perfectly fine.
          EXISTS (
            SELECT 1 FROM sourcing_runs sr
            WHERE sr.product_id = p.id AND sr.${ND}
              AND sr.status IN ('planning', 'planned', 'running', 'enriching')
          )                                        AS run_in_flight,
          ev.created                               AS last_event_at,
          ev.action                                AS last_event_action,
          ev.summary                               AS last_event_summary,
          (SELECT COALESCE(SUM(sr.credits_spent), 0) FROM sourcing_runs sr
            WHERE sr.product_id = p.id AND sr.${ND}) AS credits_spent,
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
        -- Campaigns first, agents attached where there is one: the other way
        -- round there is no row to offer a launch on.
        FROM products p
        LEFT JOIN agent a ON a.product_id = p.id
        LEFT JOIN brands b ON b.user_id = p.user_id
        LEFT JOIN funnel f ON f.product_id = p.id
        LEFT JOIN replied r ON r.product_id = p.id
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
        ORDER BY ${orderBySql(req.query, AGENT_SORTS, DEFAULT_ORDER)}
        LIMIT ${limitAt} OFFSET ${offsetAt}
        `,
        params,
      );

      // Two counts, because the footer answers two things: how many matched,
      // and how many there are. One number alone leaves "12" next to a set
      // filter meaning either.
      const countParams = [];
      const countConds = filterConditions(columnFilters, AGENT_FILTERS, countParams);
      const { rows: totals } = await query(
        `SELECT
           count(*) FILTER (WHERE true${countConds.map((c) => ` AND ${c}`).join("")})::int AS total,
           count(*)::int                                                                  AS total_all
         FROM products p
         LEFT JOIN sourcing_agents a ON a.product_id = p.id AND a.${ND}
         LEFT JOIN brands b ON b.user_id = p.user_id
         WHERE p.${ND} AND (a.id IS NOT NULL OR p.status = ${CAMPAIGN_ACTIVE})`,
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
        const { rows: allowances } = await query(
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

  // PUT /api/autopilot/campaigns/:id/agent   { mode, goal_applications, max_runs }
  //
  // How far the agent may go. The same UPDATE gRPC issues, clamps included,
  // because two statements meaning to do the same thing eventually do not: an
  // agent switched off here must land in exactly the state the brand's own
  // console would have left it in, or its next tick reads a row nothing wrote.
  //
  // And, for a campaign that has none, the row itself — the same INSERT gRPC
  // issues (EnsureAgentRecruiting), on the same ACTIVE-only condition. Without
  // it this endpoint answered 404 for every campaign that went live before
  // agents existed, which is most of them, and there was no other way in:
  // UpdateSourcingAgent is the only RPC that creates one and the console that
  // calls it is not built into production.
  //
  // This does not make it act. It sets what it is allowed to do; the tick
  // still checks the campaign, the allowance and the budget before it spends.
  router.put("/campaigns/:id/agent", async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ error: "Invalid campaign id" });
      const mode = String(req.body?.mode || "");
      if (!["off", "assisted", "autonomous"].includes(mode)) {
        return res.status(400).json({ error: "Mode must be off, assisted or autonomous" });
      }
      // Clamped, not rejected — the same ceilings as MaxAgentGoal/MaxAgentRuns
      // in services/sourcing_agent_service.go.
      const goal = clamp(req.body?.goal_applications, 1, 500);
      const maxRuns = clamp(req.body?.max_runs, 1, 10);
      if (goal === null || maxRuns === null) {
        return res.status(400).json({ error: "Goal and budget must be whole numbers" });
      }

      // Enrol, if it has never been. Mirrors EnsureAgentRecruiting in
      // repository/postgres/sourcing_agent.go: same columns, same ON CONFLICT
      // DO NOTHING, and created_by_user_id is the campaign's owner because
      // sourcing_runs.created_by_user_id is NOT NULL and the agent acts for
      // them. ACTIVE only — the agent's first move on anything else is to stop
      // itself, so enrolling a paused campaign would create a row that exists
      // to switch itself off. "off" never creates one: a campaign nobody has
      // launched is already not recruiting, and a row saying so is noise.
      //
      // ON CONFLICT DO NOTHING means a second admin pressing the same button
      // changes nothing here and everything in the UPDATE below, which is the
      // right way round.
      const enrolled = mode === "off" ? { rows: [] } : await query(
        `INSERT INTO sourcing_agents (product_id, created_by_user_id, mode, goal_applications, max_runs)
         SELECT p.id, p.user_id, $2, $3, $4
           FROM products p
          WHERE p.id = $1::uuid AND p.${ND} AND p.status = ${CAMPAIGN_ACTIVE}
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [req.params.id, mode, goal, maxRuns],
      );
      const justLaunched = enrolled.rows.length > 0;

      const { rows } = await query(
        `UPDATE sourcing_agents
            SET mode = $2,
                goal_applications = $3,
                max_runs = $4,
                -- Turning it on, or widening its budget, makes it due again:
                -- an agent given more rope should get back to work rather than
                -- sit finished until somebody notices.
                status = CASE
                    WHEN $2 = 'off' THEN 'paused'
                    WHEN status IN ('done', 'paused', 'failed') THEN 'idle'
                    ELSE status
                END,
                next_action_at = CASE WHEN $2 = 'off' THEN NULL ELSE current_timestamp END,
                stopped_reason = CASE WHEN $2 = 'off' THEN stopped_reason ELSE '' END,
                updated = current_timestamp
          WHERE product_id = $1::uuid AND ${ND}
          RETURNING id, mode, status, goal_applications, max_runs, runs_used, next_action_at`,
        [req.params.id, mode, goal, maxRuns],
      );
      if (!rows.length) {
        // Either the campaign is not there, or it is not ACTIVE and so was not
        // enrolled above. Says which, because "no agent" on a paused campaign
        // read as a bug rather than as the rule it is.
        return res.status(404).json({
          error: "This campaign has no agent, and only an active campaign can be given one",
        });
      }

      // Into the agent's own log, because that is where anybody looking at
      // this campaign in a month will be reading — including the brand.
      const budgetWords = `budget ${maxRuns} ${maxRuns === 1 ? "search" : "searches"}`;
      await logAgentEvent(query, rows[0].id, req.params.id, "settings",
        justLaunched
          ? `An admin switched Autopilot on — ${mode}, goal ${goal}, ${budgetWords}`
          : `An admin set it to ${mode} — goal ${goal}, ${budgetWords}`,
        req.admin?.email || "");
      console.log(
        `[autopilot-agent] admin=${req.admin?.email || "?"} db=${req.dbTarget || "prod"} ` +
        `product=${req.params.id} mode=${mode} goal=${goal} runs=${maxRuns} ` +
        `${justLaunched ? "launched" : "updated"}`,
      );
      res.json({ agent: rows[0], launched: justLaunched });
    } catch (e) {
      if (notPromoted(e)) return res.status(409).json({ error: "Sourcing is not on this database" });
      console.error("[autopilot/agent]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/autopilot/campaigns/:id/wake
  //
  // Bring its next tick forward to now. The agent decides for itself what to
  // do when it wakes — this only stops it sleeping until the date it picked,
  // which is what you want after raising a limit it is parked on.
  router.post("/campaigns/:id/wake", async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ error: "Invalid campaign id" });
      const { rows } = await query(
        `UPDATE sourcing_agents
            SET next_action_at = current_timestamp, updated = current_timestamp
          WHERE product_id = $1::uuid AND ${ND} AND mode <> 'off'
            AND status IN ('idle', 'waiting')
          RETURNING id, status, next_action_at`,
        [req.params.id],
      );
      // Nothing updated means it is off, or working, or stopped — all states
      // where "wake up" is either meaningless or somebody else's business.
      if (!rows.length) {
        return res.status(409).json({ error: "Only a switched-on agent that is idle or waiting can be woken" });
      }
      await logAgentEvent(query, rows[0].id, req.params.id, "settings",
        "An admin brought its next check forward to now", req.admin?.email || "");
      console.log(
        `[autopilot-wake] admin=${req.admin?.email || "?"} db=${req.dbTarget || "prod"} product=${req.params.id}`,
      );
      res.json({ agent: rows[0] });
    } catch (e) {
      if (notPromoted(e)) return res.status(409).json({ error: "Sourcing is not on this database" });
      console.error("[autopilot/wake]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/autopilot/search-economics
  //
  // What one search run actually costs and finds, so the allowance is set
  // against a real number rather than a guess. Read from `credits_spent`,
  // which is not our estimate -- it is copied straight from the field the
  // provider's own API returns on every enrichment call, so this is billed
  // data. Global rather than per-brand: there are not yet enough runs on any
  // one brand for a per-brand figure to mean anything.
  router.get("/search-economics", async (req, res) => {
    try {
      const { rows } = await query(`
        SELECT count(*) AS runs,
               round(avg(credits_spent)::numeric, 1)         AS avg_credits,
               round(min(credits_spent)::numeric, 1)         AS min_credits,
               round(max(credits_spent)::numeric, 1)         AS max_credits,
               round(sum(credits_spent)::numeric, 1)         AS total_credits,
               round(avg(discovered_count)::numeric, 0)      AS avg_found,
               round(avg(enriched_count)::numeric, 0)        AS avg_contactable
          FROM sourcing_runs
         WHERE status <> 'failed' AND discovered_count > 0`,
      );
      const row = rows[0] || {};
      res.json({
        available: true,
        runs: Number(row.runs || 0),
        avg_credits: row.avg_credits != null ? Number(row.avg_credits) : null,
        min_credits: row.min_credits != null ? Number(row.min_credits) : null,
        max_credits: row.max_credits != null ? Number(row.max_credits) : null,
        total_credits: row.total_credits != null ? Number(row.total_credits) : null,
        avg_found: row.avg_found != null ? Number(row.avg_found) : null,
        avg_contactable: row.avg_contactable != null ? Number(row.avg_contactable) : null,
      });
    } catch (e) {
      if (notPromoted(e)) return res.json({ available: false, runs: 0 });
      console.error("[autopilot/search-economics]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/autopilot/allowances
  // The default, and every brand that has been given a number of its own.
  router.get("/allowances", async (req, res) => {
    try {
      const { rows } = await query(
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
      const rawSearches = req.body?.monthly_searches;
      const searches = Number(rawSearches);
      if (!/^[0-9]+$/.test(String(rawSearches)) || !Number.isInteger(searches) || searches < 0 || searches > 1000) {
        return res.status(400).json({ error: "Searches must be a whole number between 0 and 1000" });
      }
      const note = String(req.body?.note || "").slice(0, 500);

      // A brand scope has to be a brand. A typo'd uuid would otherwise sit
      // there as a row that looks like a limit and applies to nobody.
      if (scope !== "default") {
        const { rows } = await query(
          `SELECT 1 FROM users WHERE id = $1 AND role = 2`, [scope],
        );
        if (!rows.length) return res.status(404).json({ error: "No brand with that id" });
      }

      const { rows } = await query(
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

  // --- Outreach settings ----------------------------------------------------
  //
  // The knobs that used to be environment variables and Go constants: which
  // Lemlist sequence a campaign clones, whether copy is written per campaign,
  // how many test sends a push makes, what a new campaign's agent aims for,
  // and the house emails themselves. Every one was a deploy; none of them is a
  // code change.
  //
  // Same rule as the allowance above, and the same reason it is allowed here:
  // this sets numbers the agent reads before it acts, it does not act. Every
  // guard still runs, on whatever is written here.

  // The keys the panel offers, with the sentence that explains each one. Kept
  // here as well as in Go so the page can show a key nobody has set yet — a
  // settings screen that only lists rows that exist is a screen you cannot use
  // to set anything.
  const SETTING_KEYS = [
    {
      key: "lemlist_template_campaign_id",
      label: "Lemlist template sequence",
      kind: "text",
      placeholder: "cam_…",
      help: "The sequence every campaign's own emails are cloned from. Without it, campaigns have nothing to send.",
    },
    {
      key: "outreach_writer",
      label: "Who writes the emails",
      kind: "choice",
      options: [
        { value: "ai", label: "Written for each campaign" },
        { value: "house", label: "The same default emails for everyone" },
      ],
      help: "Written per campaign uses the brand, the product and what the campaign is trying to achieve. If that ever produces nothing, the default emails are sent instead.",
    },
    {
      key: "sandbox_max_leads",
      label: "Test sends per push",
      kind: "number",
      placeholder: "10",
      help: "Outside production nothing reaches a real creator — mail goes to the test inboxes. This is how many per push; the rest wait for the next one.",
    },
    {
      key: "agent_goal_applications",
      max: 500,
      label: "Applications to aim for",
      kind: "number",
      placeholder: "25",
      help: "What a newly launched campaign's agent works towards. It stops when it gets there.",
    },
    {
      key: "agent_max_runs",
      max: 10,
      label: "Searches allowed per campaign",
      kind: "number",
      placeholder: "2",
      help: "How many searches that agent may run to reach the goal. Each one spends credits.",
    },
    {
      key: "agent_patience_hours",
      label: "Wait before checking for replies",
      kind: "number",
      placeholder: "48",
      help: "Hours an agent waits after emailing before it looks at whether anyone replied. A sequence takes days to send, so a short wait is the agent watching an empty inbox.",
    },
    {
      key: "agents_per_tick",
      label: "Agents thinking per tick",
      kind: "number",
      placeholder: "5",
      help: "Each one can start a search, so this is the ceiling on what the platform spends in a single pass.",
    },
    {
      key: "agent_short_wait_minutes",
      label: "Search check and initial retry delay",
      kind: "number",
      placeholder: "10",
      help: "Minutes before checking an in-progress search again, or retrying a failed action. Applies when the next check is scheduled.",
    },
    {
      key: "agent_max_backoff_hours",
      label: "Maximum retry delay",
      kind: "number",
      placeholder: "6",
      help: "Maximum hours between retries after repeated failures. Applies when the next retry is scheduled.",
    },
    {
      key: "test_recipients",
      label: "Test inboxes",
      kind: "text",
      placeholder: "luca@linkable.link;federico@linkable.link",
      help: "Outside production every outreach email goes here instead of to the creator, one address per creator. Semicolon-separated. This can never turn real sending on in production.",
    },
    {
      key: "house_sequence",
      label: "Default emails",
      kind: "steps",
      help: "Sent when the writer is off, and whenever it produces nothing. {{brandName}}, {{campaignName}}, {{firstName}}, {{offerSummary}} and {{applyUrl}} are filled in per creator.",
    },
    {
      key: "sending_schedule",
      label: "Sending hours",
      kind: "schedule",
      help: "When a new campaign's emails are allowed to go out. Without this, Lemlist uses its own default (Europe/Paris, 09:00–18:00, Monday to Friday) — which is why a campaign pushed at 7pm can sit until the next working morning.",
    },
  ];

  const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

  router.get("/settings", async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT key, value, note, updated, updated_by FROM sourcing_settings`,
      );
      const stored = new Map(rows.map((r) => [r.key, r]));
      res.json({
        available: true,
        settings: SETTING_KEYS.map((k) => ({
          ...k,
          value: stored.get(k.key)?.value ?? "",
          note: stored.get(k.key)?.note ?? "",
          updated: stored.get(k.key)?.updated ?? null,
          updated_by: stored.get(k.key)?.updated_by ?? "",
          // An unset key is not an empty setting: the service falls back to the
          // environment variable it replaced and then to the built-in value,
          // and the page should say so rather than imply a blank.
          set: Boolean(stored.get(k.key)?.value?.trim()),
        })),
      });
    } catch (e) {
      if (notPromoted(e)) return res.json({ available: false, settings: [] });
      console.error("[autopilot/settings]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // PUT /api/autopilot/settings/:key   { value, note }
  router.put("/settings/:key", async (req, res) => {
    try {
      const key = String(req.params.key || "");
      const known = SETTING_KEYS.find((k) => k.key === key);
      if (!known) return res.status(400).json({ error: "Unknown setting" });

      const value = String(req.body?.value ?? "").trim();
      if (known.kind === "number" && value !== "") {
        const n = Number(value);
        if (!/^\d+$/.test(value) || !Number.isInteger(n) || n <= 0 || n > (known.max ?? 100000)) {
          return res.status(400).json({ error: `Enter a whole number from 1 to ${known.max ?? 100000}` });
        }
      }
      if (known.kind === "choice" && value !== "") {
        if (!known.options.some((o) => o.value === value)) {
          return res.status(400).json({ error: "Pick one of the offered options" });
        }
      }
      if (known.kind === "schedule" && value !== "") {
        // Checked here too, for the reason the steps below are: a schedule
        // saved broken would look saved and Lemlist would keep whatever hours
        // it already had, which is the confusing half of a safe failure.
        let sched;
        try {
          sched = JSON.parse(value);
        } catch {
          return res.status(400).json({ error: "That is not valid JSON" });
        }
        if (!sched?.timezone || typeof sched.timezone !== "string") {
          return res.status(400).json({ error: "Needs a timezone" });
        }
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: sched.timezone });
        } catch {
          return res.status(400).json({ error: `"${sched.timezone}" is not a timezone name (use the IANA form, e.g. Europe/London)` });
        }
        if (!HHMM.test(sched.start) || !HHMM.test(sched.end)) {
          return res.status(400).json({ error: "Start and end need to be 24-hour times, like 09:00" });
        }
        if (!Array.isArray(sched.weekdays) || !sched.weekdays.length) {
          return res.status(400).json({ error: "Needs at least one day" });
        }
        if (sched.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
          return res.status(400).json({ error: "Days are 1 (Monday) through 7 (Sunday)" });
        }
      }
      if (known.kind === "steps" && value !== "") {
        // Checked here as well as in Go, because the service's fallback is
        // silent by design: a sequence saved broken would look saved and send
        // the built-in emails, which is the confusing half of a safe failure.
        let parsed;
        try {
          parsed = JSON.parse(value);
        } catch {
          return res.status(400).json({ error: "That is not valid JSON" });
        }
        const steps = parsed?.steps;
        if (!Array.isArray(steps) || !steps.length) {
          return res.status(400).json({ error: "Needs a non-empty \"steps\" array" });
        }
        for (const [i, step] of steps.entries()) {
          if (typeof step?.subject !== "string" || typeof step?.message !== "string" || !step.subject.trim() || !step.message.trim()) {
            return res.status(400).json({ error: `Step ${i + 1} needs both a subject and a message` });
          }
          if (!Number.isSafeInteger(step?.delay) || step.delay < 0 || step.delay > 100000) {
            return res.status(400).json({ error: `Step ${i + 1} needs a whole-number delay from 0 to 100000 days` });
          }
        }
      }

      const note = String(req.body?.note || "").slice(0, 500);
      const { rows } = await query(
        `INSERT INTO sourcing_settings (key, value, note, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE
            SET value      = excluded.value,
                note       = excluded.note,
                updated    = current_timestamp,
                updated_by = excluded.updated_by
         RETURNING key, value, note, updated, updated_by`,
        [key, value, note, req.admin?.email || ""],
      );
      console.log(
        `[sourcing-setting] admin=${req.admin?.email || "?"} db=${req.dbTarget || "prod"} ` +
        `key=${key} value=${JSON.stringify(value).slice(0, 200)}`,
      );
      res.json({ setting: rows[0] });
    } catch (e) {
      if (notPromoted(e)) return res.status(409).json({ error: "Sourcing is not on this database" });
      console.error("[autopilot/settings/put]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/autopilot/settings/:key — back to the built-in value.
  router.delete("/settings/:key", async (req, res) => {
    try {
      const key = String(req.params.key || "");
      if (!SETTING_KEYS.some((setting) => setting.key === key)) {
        return res.status(400).json({ error: "Unknown setting" });
      }
      await query(`DELETE FROM sourcing_settings WHERE key = $1`, [key]);
      console.log(
        `[sourcing-setting] admin=${req.admin?.email || "?"} db=${req.dbTarget || "prod"} ` +
        `key=${key} CLEARED`,
      );
      res.json({ cleared: key });
    } catch (e) {
      if (notPromoted(e)) return res.status(409).json({ error: "Sourcing is not on this database" });
      console.error("[autopilot/settings/delete]", e);
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
      await query(`DELETE FROM sourcing_allowances WHERE scope = $1`, [scope]);
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

  // GET /api/autopilot/campaigns/:id/creators
  // What the searches actually turned up — the results, one row per creator,
  // with the state each one reached. Paged: a single run finds five hundred.
  router.get("/campaigns/:id/creators", async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ error: "Invalid campaign id" });
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 100);
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);
      // The funnel in one dimension: where a creator stopped. Reachable means
      // an email was found, which is the difference between a name and a lead.
      const STATES = {
        applied: "c.applied_at IS NOT NULL",
        emailed: "c.push_status IN ('pushed', 'invited')",
        reachable: "c.email <> '' AND c.push_status NOT IN ('pushed', 'invited')",
        unreachable: "c.email = ''",
        filtered: "c.status = 'filtered_out'",
      };
      const state = STATES[req.query.state] ? STATES[req.query.state] : null;
      const where = `c.product_id = $1 AND c.${ND}${state ? ` AND ${state}` : ""}`;

      const { rows } = await query(
        `SELECT c.id, c.created, c.instagram_username, c.full_name, c.followers, c.engagement,
                c.country, c.email <> '' AS reachable, c.status, c.filter_reason,
                c.push_status, c.pushed_at, c.applied_at, c.decision, c.fit_score, c.fit_verdict,
                c.dm_status, c.query_label, c.profile_image
           FROM sourcing_candidates c
          WHERE ${where}
          ORDER BY c.applied_at DESC NULLS LAST, c.followers DESC NULLS LAST, c.created DESC
          LIMIT $2 OFFSET $3`,
        [req.params.id, limit, offset],
      );
      await withProfileImages(rows, req.dbTarget);

      // The breakdown is of the WHOLE campaign, not the filtered page: it is
      // the map you choose a state from, so it cannot itself be narrowed.
      // "matching" (the current state filter's own count) is what pagination
      // counts against — "total" alone would say "load more" past the end of
      // a narrowed list.
      const { rows: counts } = await query(
        `SELECT
           count(*)::int                                                          AS total,
           count(*) FILTER (WHERE c.email <> '')::int                             AS reachable,
           count(*) FILTER (WHERE c.push_status IN ('pushed', 'invited'))::int    AS emailed,
           count(*) FILTER (WHERE c.applied_at IS NOT NULL)::int                  AS applied,
           count(*) FILTER (WHERE c.status = 'filtered_out')::int                 AS filtered
         FROM sourcing_candidates c
         WHERE c.product_id = $1 AND c.${ND}`,
        [req.params.id],
      );
      const { rows: matching } = await query(
        `SELECT count(*)::int AS n FROM sourcing_candidates c WHERE ${where}`,
        [req.params.id],
      );

      res.json({
        available: true, creators: rows, counts: counts[0] || {},
        matching: matching[0]?.n ?? rows.length, limit, offset,
      });
    } catch (e) {
      if (notPromoted(e)) return res.json({ available: false, creators: [], counts: {} });
      console.error("[autopilot/creators]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/autopilot/campaigns/:id/replies
  // What came back, and whether a person still has to answer it.
  router.get("/campaigns/:id/replies", async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ error: "Invalid campaign id" });
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 100);

      const { rows } = await query(
        `SELECT r.id, r.created, r.received_at, r.lead_email, r.intent, r.status, r.needs_human,
                r.escalation_reason, r.channel, r.sent_at, r.error, r.subject,
                -- The reply and the answer, trimmed: this is a list to scan,
                -- and the whole thread lives in the main app.
                left(r.body, 400)  AS body,
                left(r.draft, 400) AS draft,
                c.instagram_username, c.profile_image
           FROM sourcing_replies r
           LEFT JOIN sourcing_candidates c ON c.id = r.sourcing_candidate_id
          WHERE r.product_id = $1
          ORDER BY COALESCE(r.received_at, r.created) DESC
          LIMIT $2`,
        [req.params.id, limit],
      );
      await withProfileImages(rows, req.dbTarget);
      res.json({ available: true, replies: rows });
    } catch (e) {
      if (notPromoted(e)) return res.json({ available: false, replies: [] });
      console.error("[autopilot/replies]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/autopilot/campaigns/:id/emails
  // The send-side of outreach — sent, opened, clicked, bounced — as Lemlist's
  // own webhooks reported it. Distinct from Replies (a person writing back);
  // this is what happened to the messages themselves, and it is where "we
  // emailed forty and nothing came back" gets an answer: did they even open it.
  router.get("/campaigns/:id/emails", async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ error: "Invalid campaign id" });
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 25, 1), 100);
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);
      const type = req.query.type ? String(req.query.type) : null;
      // Two queries, two param counts, so the type placeholder's own index
      // has to be built per query rather than shared as one string — reusing
      // "$4" against the matching-count query (no $2/$3 there) would ask
      // Postgres for a parameter that call never sends.
      const whereAt = (idx) => `e.product_id = $1${type ? ` AND e.event_type = $${idx}` : ""}`;
      const params = type ? [req.params.id, limit, offset, type] : [req.params.id, limit, offset];

      const { rows } = await query(
        `SELECT e.id, e.created, e.occurred_at, e.event_type, e.lead_email,
                c.instagram_username, c.profile_image
           FROM sourcing_outreach_events e
           LEFT JOIN sourcing_candidates c ON c.id = e.sourcing_candidate_id
          WHERE ${whereAt(4)}
          ORDER BY e.occurred_at DESC
          LIMIT $2 OFFSET $3`,
        params,
      );
      await withProfileImages(rows, req.dbTarget);

      const { rows: counts } = await query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE e.event_type = 'emailsSent')::int    AS sent,
                count(*) FILTER (WHERE e.event_type = 'emailsOpened')::int  AS opened,
                count(*) FILTER (WHERE e.event_type = 'emailsClicked')::int AS clicked,
                count(*) FILTER (WHERE e.event_type = 'emailsReplied')::int AS replied
           FROM sourcing_outreach_events e
          WHERE e.product_id = $1`,
        [req.params.id],
      );
      const { rows: matching } = await query(
        `SELECT count(*)::int AS n FROM sourcing_outreach_events e WHERE ${whereAt(2)}`,
        type ? [req.params.id, type] : [req.params.id],
      );

      res.json({
        available: true, emails: rows, counts: counts[0] || {},
        matching: matching[0]?.n ?? rows.length, limit, offset,
      });
    } catch (e) {
      if (notPromoted(e)) return res.json({ available: false, emails: [], counts: {} });
      console.error("[autopilot/emails]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/autopilot/campaigns/:id/chats
  // The Autopilot conversation that set this campaign up in the first place —
  // separate from everything else here, which is about creators, not the
  // brand. One row per model call, transcript-so-far and reply; the client
  // reconstructs the thread rather than replaying each row's growing prefix.
  router.get("/campaigns/:id/chats", async (req, res) => {
    try {
      if (!isUuid(req.params.id)) return res.status(400).json({ error: "Invalid campaign id" });
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 300);

      const { rows } = await query(
        `SELECT id, created, turn_index, transcript, reply, options, ready, plan, provider
           FROM autopilot_chats
          WHERE product_id = $1
          ORDER BY turn_index ASC, created ASC
          LIMIT $2`,
        [req.params.id, limit],
      );
      res.json({ available: true, chats: rows });
    } catch (e) {
      if (notPromoted(e)) return res.json({ available: false, chats: [] });
      console.error("[autopilot/chats]", e);
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

      const { rows: events } = await query(
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
      const { rows: runs } = await query(
        `SELECT
           r.id, r.created, r.status, r.error,
           r.target_creators, r.discovered_count, r.filtered_count, r.enriched_count,
           r.credits_spent,
           -- What it went looking for, and why. Without these a run is a row
           -- of counts and "why did it find forty" has no answer on the page.
           -- The plan is the model's own searches — a handful of labelled
           -- queries with a sentence each — so it travels whole rather than
           -- as columns that would have to be guessed at from its shape.
           r.plan_rationale,
           r.plan,
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
