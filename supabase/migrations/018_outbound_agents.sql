-- GTM outreach as an agent, the same shape as the creator Autopilot.
--
-- What it replaces: a campaign was a set of filters, nine templates, a daily
-- cap and a person who pressed send every morning. Everything about whether it
-- was working, whether it had done enough, and whether to keep spending lived
-- in somebody's head. The cron ran the same 200 sends whether the campaign had
-- produced forty replies or none.
--
-- An agent instead has the three things that make autonomy safe rather than
-- expensive, and they are the interesting columns here:
--
--   a goal    — it STOPS when it is met. An agent that cannot finish is a
--               cron job with extra steps.
--   a budget  — how many people it may contact in total. Not a daily rate: a
--               rate limits how fast money leaves, a budget limits how much.
--   a mode    — off / assisted / autonomous, so an admin can have it do all
--               the work up to the point where mail leaves the building.
--
-- It does NOT replace the sending machinery. Enrolment, the four touches, the
-- daily cap and reply cancellation stay exactly where they are in sequencer.js:
-- this is the layer that decides whether to run them today, and when to stop.
CREATE TABLE IF NOT EXISTS outbound_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  -- brand | influencer. The same split email_campaigns already makes: two
  -- prospect pools, two scoring functions, one sequencer.
  audience_type TEXT NOT NULL DEFAULT 'brand',

  -- The campaign it drives. Templates, sender and filters stay there, so an
  -- agent can be put in front of a campaign that already works rather than
  -- everything being rebuilt to try one.
  email_campaign_id UUID REFERENCES email_campaigns(id) ON DELETE CASCADE,

  -- off        : does nothing. The kill switch, and the default.
  -- assisted   : enrols and drafts, sends nothing. The list is there to look at.
  -- autonomous : enrols, sends, follows up, and stops when it is done.
  mode TEXT NOT NULL DEFAULT 'off',
  -- idle | working | waiting | done | paused | failed
  status TEXT NOT NULL DEFAULT 'idle',

  -- The goal, in replies. Replies rather than sends, because sends are what it
  -- spends and replies are what it is for.
  goal_replies INTEGER NOT NULL DEFAULT 20,
  -- The budget, in people. Every one costs an enrichment credit and a slice of
  -- the sending domain's reputation, so this is the number that makes it safe.
  max_prospects INTEGER NOT NULL DEFAULT 500,
  prospects_used INTEGER NOT NULL DEFAULT 0,
  -- How fast, not how much. Kept per agent so two can share a sender pool
  -- without one starving the other.
  daily_cap INTEGER NOT NULL DEFAULT 40,

  last_acted_at TIMESTAMPTZ,
  -- Its own clock: an agent that re-decides every minute is a busy loop, and
  -- one with no next action never runs again. Every stop sets this to NULL and
  -- every start sets it to now.
  next_action_at TIMESTAMPTZ,
  stopped_reason TEXT NOT NULL DEFAULT '',

  CONSTRAINT chk_outbound_agent_mode CHECK (mode IN ('off', 'assisted', 'autonomous')),
  CONSTRAINT chk_outbound_agent_status
    CHECK (status IN ('idle', 'working', 'waiting', 'done', 'paused', 'failed')),
  CONSTRAINT chk_outbound_agent_audience CHECK (audience_type IN ('brand', 'influencer'))
);

-- The loop's read: who is due to act. Partial, because the whole point is that
-- most agents are off or finished most of the time.
CREATE INDEX IF NOT EXISTS idx_outbound_agents_due
  ON outbound_agents (next_action_at)
  WHERE mode <> 'off' AND status IN ('idle', 'working', 'waiting');

-- One agent per campaign. Two would both spend the same budget.
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_agents_campaign
  ON outbound_agents (email_campaign_id)
  WHERE email_campaign_id IS NOT NULL;

-- What it did, in sentences a person reads.
--
-- Not a debug log. Something that spends money and emails strangers in the
-- company's name is only tolerable if you can read back exactly what it did and
-- why it stopped, so this is written for whoever is asking that question rather
-- than for whoever is on call.
CREATE TABLE IF NOT EXISTS outbound_agent_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent_id UUID NOT NULL REFERENCES outbound_agents(id) ON DELETE CASCADE,
  -- enrolled | sent | replied | waiting | stopped | failed
  action TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_outbound_agent_events_agent
  ON outbound_agent_events (agent_id, created_at DESC);
