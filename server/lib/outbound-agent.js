import { supabase } from "./supabase.js";
import { runDailyOutbound } from "../automation/run-daily-200.js";
import { runDailyInfluencer } from "../automation/run-daily-influencer.js";

// The GTM agent's tick — the same state machine as the creator Autopilot in
// service-grpc, in the shape a serverless app can hold it.
//
// The difference from what this replaces is not the sending. Enrolment, the
// four touches, the daily cap and reply-cancellation are untouched in
// sequencer.js and run-daily-200.js; they were never the problem. What was
// missing is everything around them: the cron sent its two hundred every
// weekday whether the campaign had produced forty replies or none, nothing
// stopped, and whether to keep spending lived in somebody's head.
//
// So this layer owns exactly three decisions, and nothing else:
//
//   should it act at all   — goal met, budget spent, campaign gone: stop.
//   how much may it do     — the smaller of today's cap and what is left of
//                            the budget, so a cap is a rate and a budget is a
//                            ceiling.
//   when does it look again — its own clock. An agent with no next action
//                            never runs again, which is the failure mode that
//                            hides, so every stop is deliberate and named.
//
// One action per tick, deliberately. A tick that chains enrol → send → follow
// up is one bug away from doing all three for the wrong agent, and the pauses
// between them are where a person gets the chance to stop it.

/** How long to wait before looking again, in hours. */
const NEXT_TICK_HOURS = 24;
// Something to do but nothing spent: look again sooner. A run that sent
// nothing because the pool was momentarily empty should not cost a day.
const SHORT_WAIT_HOURS = 4;

export const AGENT_MODES = ["off", "assisted", "autonomous"];
export const AGENT_LIVE_STATUSES = ["idle", "working", "waiting"];

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

export async function logAgentEvent(agentId, action, summary, detail = "") {
  const { error } = await supabase
    .from("outbound_agent_events")
    .insert({ agent_id: agentId, action, summary, detail });
  if (error) console.error("[outbound-agent] could not log event:", error.message);
}

/**
 * What the agent has actually produced: people contacted, and people who wrote
 * back. Read from email_sends rather than kept on the agent, because the
 * sequencer and the inbound parser both write there and a second copy would be
 * the one that goes stale.
 */
export async function agentProgress(agent) {
  const empty = { contacted: 0, replied: 0 };
  if (!agent.email_campaign_id) return empty;

  const { data, error } = await supabase
    .from("email_sends")
    .select("contact_id, to_email, replied_at, sent_at")
    .eq("campaign_id", agent.email_campaign_id)
    .limit(20000);
  if (error) {
    console.error("[outbound-agent] could not read progress:", error.message);
    return empty;
  }
  // One person, however many touches they were sent — counted by the address,
  // not by contact_id.
  //
  // contact_id is null on every brand send: that path identifies a recipient by
  // email and never writes a contact row. Counting by it read zero against four
  // hundred real sends, which meant prospects_used never moved and the budget
  // ceiling — the thing that makes any of this safe — could never fire.
  const who = (row) => (row.to_email || "").toLowerCase() || row.contact_id || "";
  const contacted = new Set();
  const replied = new Set();
  for (const row of data || []) {
    const key = who(row);
    if (!key) continue;
    if (row.sent_at) contacted.add(key);
    if (row.replied_at) replied.add(key);
  }
  return { contacted: contacted.size, replied: replied.size };
}

async function stop(agent, status, reason, summary) {
  await supabase
    .from("outbound_agents")
    .update({
      status,
      stopped_reason: reason,
      next_action_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", agent.id);
  await logAgentEvent(agent.id, "stopped", summary, reason);
  return { agent: agent.id, action: "stopped", summary };
}

async function wait(agent, hours, summary) {
  await supabase
    .from("outbound_agents")
    .update({
      status: "waiting",
      next_action_at: hoursFromNow(hours),
      last_acted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", agent.id);
  await logAgentEvent(agent.id, "waiting", summary);
  return { agent: agent.id, action: "waiting", summary };
}

/**
 * One tick for one agent: decide the single next thing, do it, and set the
 * clock. Returns a line describing what happened, which is what the cron
 * response and the "Run now" button both show.
 */
export async function tickAgent(agent, { dryRun = false, log = () => {} } = {}) {
  // Claim first. Several ticks can overlap — a cron firing while an admin
  // presses Run now — and two passes on one budget is the one failure mode of
  // an autonomous thing that spends money.
  const { data: claimed, error: claimError } = await supabase
    .from("outbound_agents")
    .update({
      status: "working",
      last_acted_at: new Date().toISOString(),
      next_action_at: hoursFromNow(1),
      updated_at: new Date().toISOString(),
    })
    .eq("id", agent.id)
    .in("status", AGENT_LIVE_STATUSES)
    .neq("mode", "off")
    .select()
    .maybeSingle();
  if (claimError) throw new Error(`claim: ${claimError.message}`);
  if (!claimed) return { agent: agent.id, action: "skipped", summary: "someone else has it" };

  // --- the stopping conditions, before anything is spent -------------------

  if (!claimed.email_campaign_id) {
    return stop(claimed, "failed", "No campaign attached", "Stopped — it has no campaign to send from");
  }

  const { data: campaign } = await supabase
    .from("email_campaigns")
    .select("id, name, status, daily_cap, audience_type")
    .eq("id", claimed.email_campaign_id)
    .maybeSingle();
  if (!campaign || campaign.status === "archived") {
    return stop(claimed, "done", "The campaign is gone", "Stopped — the campaign it sends from was archived");
  }
  // A paused campaign is a condition, not a failure. The sender refuses to run
  // for one — correctly — and the first version treated that as a pass that had
  // gone wrong and retried it every four hours for ever.
  //
  // Waiting rather than stopping, deliberately: nothing in this app tells an
  // agent that its campaign has been resumed, and a stopped agent is not read
  // by the loop again. Waiting a day means resuming the campaign is all anyone
  // has to do — the next tick simply finds it running and carries on.
  if (campaign.status !== "active") {
    return wait(
      claimed,
      NEXT_TICK_HOURS,
      `Waiting — ${campaign.name} is ${campaign.status}. Resume the campaign and this carries on`,
    );
  }

  const progress = await agentProgress(claimed);

  if (progress.replied >= claimed.goal_replies) {
    return stop(
      claimed,
      "done",
      `Reached ${progress.replied} replies`,
      `Done — ${progress.replied} people replied, which was the goal`,
    );
  }
  if (claimed.prospects_used >= claimed.max_prospects) {
    return stop(
      claimed,
      "done",
      `Budget spent after ${claimed.prospects_used} people`,
      `Used all ${claimed.max_prospects} contacts and ${progress.replied} replied. Raise the budget to keep going`,
    );
  }

  // --- how much it may do today -------------------------------------------
  // The cap is a rate and the budget is a ceiling, so the smaller of the two
  // wins. Without the second one, a paused-for-a-week agent would come back and
  // spend everything it had saved up in one morning.
  const budgetLeft = Math.max(0, claimed.max_prospects - claimed.prospects_used);
  const cap = Math.max(0, Math.min(claimed.daily_cap, budgetLeft));
  if (cap === 0) {
    return wait(claimed, SHORT_WAIT_HOURS, "Nothing to send today — the daily cap is zero");
  }

  // Assisted does everything except let mail leave the building. It is the
  // same pass with the send suppressed, so the list a person reviews is the
  // list that would have gone out.
  const holding = claimed.mode !== "autonomous";
  const runner = claimed.audience_type === "influencer" ? runDailyInfluencer : runDailyOutbound;

  let result;
  try {
    result = await runner({
      teamId: claimed.team_id,
      campaignId: claimed.email_campaign_id,
      cap,
      dryRun: dryRun || holding,
      log,
    });
  } catch (err) {
    // A failed pass is not a dead agent: the world may simply have been busy.
    // It waits and tries again rather than stopping, and the reason is on the
    // record either way.
    await logAgentEvent(claimed.id, "failed", "A send pass failed", String(err.message || err));
    return wait(claimed, SHORT_WAIT_HOURS, "A send pass failed — trying again later");
  }

  const sent = Number(result?.sent || 0);

  // The budget is counted from this campaign's own sends, not from what the
  // pass returned. fetchDueRows drains the TEAM's due follow-ups, so a pass can
  // legitimately send for three other campaigns' sequences — adding that number
  // here would spend this agent's budget on somebody else's work, and the error
  // would compound every day. Re-reading is a query; getting it wrong is a
  // budget that means nothing.
  const after = dryRun || holding ? progress : await agentProgress(claimed);

  await supabase
    .from("outbound_agents")
    .update({
      status: "waiting",
      prospects_used: after.contacted,
      next_action_at: hoursFromNow(sent > 0 ? NEXT_TICK_HOURS : SHORT_WAIT_HOURS),
      last_acted_at: new Date().toISOString(),
      stopped_reason: "",
      updated_at: new Date().toISOString(),
    })
    .eq("id", claimed.id);

  const summary = holding
    ? `Prepared ${sent} emails — nothing sent, this agent is on assisted`
    : `Emailed ${sent} ${claimed.audience_type === "influencer" ? "creators" : "brands"}`;
  await logAgentEvent(
    claimed.id,
    holding ? "waiting" : "sent",
    summary,
    `${after.replied}/${claimed.goal_replies} replies · ${after.contacted}/${claimed.max_prospects} contacted`,
  );
  return { agent: claimed.id, action: holding ? "prepared" : "sent", sent, summary };
}

/**
 * How the sending is landing, and who wrote back.
 *
 * The campaign detail page has had this for a year — delivered, opened,
 * replied, bounced — as numbers a person went and looked at. Under an agent
 * they belong next to what it did, because they are the answer to the only
 * question anyone asks of it: is this working, and should it keep going.
 *
 * Read in one pass over the campaign's sends, like rollupCampaignMetrics does,
 * because at a few hundred a day that is cheaper than four count queries.
 */
export async function agentOutcome(agent, { replyLimit = 8 } = {}) {
  const empty = { metrics: null, replies: [] };
  if (!agent.email_campaign_id) return empty;

  const { data, error } = await supabase
    .from("email_sends")
    .select("contact_id, to_email, status, sent_at, delivered_at, opened_at, replied_at, bounced_at")
    .eq("campaign_id", agent.email_campaign_id)
    .limit(50000);
  if (error) {
    console.error("[outbound-agent] could not read outcome:", error.message);
    return empty;
  }

  const rows = data || [];
  const metrics = {
    sent: 0,
    delivered: 0,
    opened: 0,
    replied: 0,
    bounced: 0,
    // Scheduled but not yet gone: what the next passes already have queued.
    pending: 0,
  };
  const replies = [];
  for (const r of rows) {
    if (r.sent_at) metrics.sent++;
    if (r.delivered_at) metrics.delivered++;
    if (r.opened_at) metrics.opened++;
    if (r.bounced_at) metrics.bounced++;
    if (r.status === "scheduled" || r.status === "pending") metrics.pending++;
    if (r.replied_at) {
      metrics.replied++;
      replies.push({ email: r.to_email || r.contact_id, at: r.replied_at });
    }
  }
  // Rates against delivered, the industry convention the campaign page already
  // uses: a bounced email cannot be opened, so it should not drag the rate down.
  const base = metrics.delivered || 0;
  metrics.open_rate = base ? Math.round((metrics.opened / base) * 1000) / 10 : 0;
  metrics.reply_rate = base ? Math.round((metrics.replied / base) * 1000) / 10 : 0;

  replies.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { metrics, replies: replies.slice(0, replyLimit) };
}

/** Every agent whose own clock says it is time — the loop's read. */
export async function dueAgents({ limit = 10 } = {}) {
  const { data, error } = await supabase
    .from("outbound_agents")
    .select("*")
    .neq("mode", "off")
    .in("status", AGENT_LIVE_STATUSES)
    .or(`next_action_at.is.null,next_action_at.lte.${new Date().toISOString()}`)
    .order("next_action_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw new Error(`dueAgents: ${error.message}`);
  return data || [];
}

/** One pass over everything that is due. What the cron calls. */
export async function tickDueAgents({ dryRun = false, log = () => {} } = {}) {
  const agents = await dueAgents({});
  const results = [];
  for (const agent of agents) {
    try {
      results.push(await tickAgent(agent, { dryRun, log }));
    } catch (err) {
      log(`[outbound-agent] ${agent.id} failed: ${err.message}`);
      results.push({ agent: agent.id, action: "failed", summary: err.message });
    }
  }
  return results;
}
