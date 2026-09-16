import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import {
  AGENT_MODES,
  agentProgress,
  dueAgents,
  logAgentEvent,
  tickAgent,
} from "../lib/outbound-agent.js";

// GTM outreach, as agents rather than campaigns you drive by hand.
//
// Mounted at /api/outbound-agents. The old /api/outbound/campaigns routes are
// untouched and still own templates, senders and metrics — an agent points at
// one of those campaigns and decides whether it runs today, not how it sends.
//
// "Runnable by Linkable admins" is the whole point of the run endpoint: the
// cron is the thing that keeps it going, and the button is how somebody starts
// it, watches one pass, and stops it if it looks wrong.

// Postgres "undefined_table". The agent tables arrive with a migration, and a
// deploy that lands before somebody applies it should say so rather than
// showing a red error on a page nobody can act on.
const UNDEFINED_TABLE = "42P01";
const notMigrated = (e) => e?.code === UNDEFINED_TABLE;

const SETTABLE = [
  "name",
  "audience_type",
  "email_campaign_id",
  "goal_replies",
  "max_prospects",
  "daily_cap",
  "mode",
];

function clean(body) {
  const out = {};
  for (const key of SETTABLE) {
    if (body[key] === undefined) continue;
    if (key === "mode" && !AGENT_MODES.includes(body[key])) continue;
    if (["goal_replies", "max_prospects", "daily_cap"].includes(key)) {
      const n = Math.floor(Number(body[key]));
      if (!Number.isFinite(n) || n < 0) continue;
      out[key] = n;
      continue;
    }
    out[key] = body[key];
  }
  return out;
}

export function outboundAgentsRoutes() {
  const router = Router();

  // GET /api/outbound-agents — one row per agent, with what it has produced.
  router.get("/", async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("outbound_agents")
        .select("*, email_campaigns(id, name, status, audience_type)")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;

      // Progress is read per agent rather than joined: it counts distinct
      // people across email_sends, which is not a thing a join returns.
      const agents = [];
      for (const agent of data || []) {
        agents.push({ ...agent, ...(await agentProgress(agent)) });
      }
      res.json({ available: true, agents });
    } catch (e) {
      if (notMigrated(e)) return res.json({ available: false, agents: [] });
      console.error("[outbound-agents/list]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/outbound-agents/:id — the agent, and what it has been doing.
  router.get("/:id", async (req, res) => {
    try {
      const { data: agent, error } = await supabase
        .from("outbound_agents")
        .select("*, email_campaigns(id, name, status, audience_type, daily_cap)")
        .eq("id", req.params.id)
        .maybeSingle();
      if (error) throw error;
      if (!agent) return res.status(404).json({ error: "No such agent" });

      const { data: events } = await supabase
        .from("outbound_agent_events")
        .select("created_at, action, summary, detail")
        .eq("agent_id", agent.id)
        .order("created_at", { ascending: false })
        .limit(50);

      res.json({ agent: { ...agent, ...(await agentProgress(agent)) }, events: events || [] });
    } catch (e) {
      console.error("[outbound-agents/get]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/outbound-agents — created off, always. Something that emails
  // strangers does not start because a form was submitted.
  router.post("/", async (req, res) => {
    try {
      const body = clean(req.body || {});
      if (!body.name) return res.status(400).json({ error: "Give it a name" });
      if (!body.email_campaign_id) {
        return res.status(400).json({ error: "Point it at a campaign to send from" });
      }
      const { data, error } = await supabase
        .from("outbound_agents")
        .insert({
          ...body,
          mode: "off",
          status: "idle",
          team_id: req.body?.team_id || process.env.TEAM_ID,
        })
        .select()
        .single();
      if (error) throw error;
      await logAgentEvent(data.id, "waiting", "Created, switched off");
      res.json({ agent: data });
    } catch (e) {
      console.error("[outbound-agents/create]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // PATCH /api/outbound-agents/:id — settings. Turning it on, or widening its
  // budget, makes it due immediately: an agent given more rope should get back
  // to work rather than sit finished until somebody notices.
  router.patch("/:id", async (req, res) => {
    try {
      const body = clean(req.body || {});
      if (!Object.keys(body).length) return res.status(400).json({ error: "Nothing to change" });

      const patch = { ...body, updated_at: new Date().toISOString() };
      if (body.mode === "off") {
        patch.status = "paused";
        patch.next_action_at = null;
        patch.stopped_reason = "Switched off";
      } else if (body.mode) {
        patch.status = "idle";
        patch.next_action_at = new Date().toISOString();
        patch.stopped_reason = "";
      }

      const { data, error } = await supabase
        .from("outbound_agents")
        .update(patch)
        .eq("id", req.params.id)
        .select()
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: "No such agent" });

      if (body.mode) {
        await logAgentEvent(
          data.id,
          body.mode === "off" ? "stopped" : "waiting",
          body.mode === "off" ? "Switched off" : `Switched to ${body.mode}`,
        );
      }
      res.json({ agent: data });
    } catch (e) {
      console.error("[outbound-agents/patch]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/outbound-agents/:id/run — one pass, now, because somebody asked.
  // `dry=1` prepares without sending, which is how you look before you leap.
  router.post("/:id/run", async (req, res) => {
    try {
      const { data: agent, error } = await supabase
        .from("outbound_agents")
        .select("*")
        .eq("id", req.params.id)
        .maybeSingle();
      if (error) throw error;
      if (!agent) return res.status(404).json({ error: "No such agent" });
      if (agent.mode === "off") {
        return res.status(400).json({ error: "This agent is switched off — turn it on first" });
      }

      const lines = [];
      const result = await tickAgent(agent, {
        dryRun: req.query.dry === "1",
        log: (s) => lines.push(String(s)),
      });
      res.json({ result, log: lines.slice(-50) });
    } catch (e) {
      console.error("[outbound-agents/run]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/outbound-agents/due/list — what the cron would pick up next.
  // Read-only, and the quickest way to answer "why has nothing happened".
  router.get("/due/list", async (req, res) => {
    try {
      res.json({ due: await dueAgents({}) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
