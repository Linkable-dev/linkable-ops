-- AI conversation manager (Kakiyo-style "conversation design")
-- One offering per campaign. Two prompts (context + first message) drive an LLM
-- that owns every reply across many threads in parallel.

-- A campaign here is the AI agent's full configuration: who it's selling to,
-- as which persona, with which prompts. Replaces template-row picking with
-- instructions-driven generation.
CREATE TABLE IF NOT EXISTS ai_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', -- draft, active, paused

  -- The "offering" — what the AI is selling. Kakiyo's "one offering = one thing" rule.
  offering JSONB NOT NULL DEFAULT '{}',
  -- expected shape:
  --   { problem, audience, why_better, results, description }

  -- The persona the AI plays (per LinkedIn account / sender voice in our case).
  persona JSONB NOT NULL DEFAULT '{}',
  -- expected shape:
  --   { agent_name, team_name, sender_email, language, tone }

  -- The two prompts.
  context_prompt TEXT NOT NULL,
  first_message_prompt TEXT NOT NULL,

  -- Goal config: what the AI is steering toward.
  goal TEXT NOT NULL DEFAULT 'book a 15-min intro call',
  goal_link TEXT,            -- e.g. https://cal.com/luca-linkable

  -- Reply pacing. Kakiyo target: 2-15 min.
  reply_min_seconds INTEGER NOT NULL DEFAULT 120,
  reply_max_seconds INTEGER NOT NULL DEFAULT 900,

  -- Models. Sonnet for replies (smarter), Haiku for first message (volume).
  reply_model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  first_message_model TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One conversation per (campaign, contact). The AI's working memory lives here.
CREATE TABLE IF NOT EXISTS ai_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES ai_campaigns(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,

  -- Denormalized so threads still work if contact is deleted.
  prospect_email TEXT NOT NULL,
  prospect_name TEXT,
  prospect_company TEXT,
  prospect_dossier JSONB NOT NULL DEFAULT '{}',  -- everything we know about them

  status TEXT NOT NULL DEFAULT 'active',
  -- active, qualified, booked, dead, opted_out, escalated

  -- For threading: the Message-ID we set on the first outbound, so inbound
  -- replies (which reference it via In-Reply-To / References) match here.
  thread_root_message_id TEXT,
  thread_subject TEXT,

  -- Scheduling
  next_action_at TIMESTAMPTZ,    -- when reply is due
  last_inbound_at TIMESTAMPTZ,
  last_outbound_at TIMESTAMPTZ,

  -- Surfaced AI judgments
  qualification_score INTEGER NOT NULL DEFAULT 0,  -- 0-100
  ai_notes TEXT,                                   -- AI's running summary

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (campaign_id, prospect_email)
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,

  direction TEXT NOT NULL,    -- 'in' | 'out'
  role TEXT NOT NULL,         -- 'assistant' | 'user' (mirrors LLM roles)

  subject TEXT,
  body TEXT NOT NULL,         -- cleaned plain text (for outbound: what we sent;
                              -- for inbound: reply text with quoted history stripped)
  raw_body TEXT,              -- full raw inbound (so we can re-parse)

  -- Email message IDs for threading
  message_id TEXT,            -- this email's Message-ID
  in_reply_to TEXT,           -- the Message-ID we're replying to
  email_provider_id TEXT,     -- Resend / inbound provider's ID

  -- AI metadata (only on outbound)
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  tool_calls JSONB,           -- [{name, input}]

  scheduled_for TIMESTAMPTZ,  -- if delayed send, when it fires
  sent_at TIMESTAMPTZ,
  error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_conversations_campaign ON ai_conversations(campaign_id);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_team ON ai_conversations(team_id);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_status ON ai_conversations(status);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_next_action ON ai_conversations(next_action_at) WHERE next_action_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_conversations_thread_root ON ai_conversations(thread_root_message_id);

CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation ON ai_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_messages_team ON ai_messages(team_id);
CREATE INDEX IF NOT EXISTS idx_ai_messages_message_id ON ai_messages(message_id);
CREATE INDEX IF NOT EXISTS idx_ai_messages_in_reply_to ON ai_messages(in_reply_to);

ALTER TABLE ai_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can manage AI campaigns"
  ON ai_campaigns FOR ALL
  USING (team_id IN (SELECT team_id FROM profiles WHERE id = auth.uid()));

CREATE POLICY "Team members can view AI conversations"
  ON ai_conversations FOR ALL
  USING (team_id IN (SELECT team_id FROM profiles WHERE id = auth.uid()));

CREATE POLICY "Team members can view AI messages"
  ON ai_messages FOR ALL
  USING (team_id IN (SELECT team_id FROM profiles WHERE id = auth.uid()));

-- Touch updated_at on campaign edits.
CREATE OR REPLACE FUNCTION touch_ai_campaigns_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ai_campaigns_updated ON ai_campaigns;
CREATE TRIGGER trg_ai_campaigns_updated
  BEFORE UPDATE ON ai_campaigns
  FOR EACH ROW EXECUTE FUNCTION touch_ai_campaigns_updated_at();

DROP TRIGGER IF EXISTS trg_ai_conversations_updated ON ai_conversations;
CREATE TRIGGER trg_ai_conversations_updated
  BEFORE UPDATE ON ai_conversations
  FOR EACH ROW EXECUTE FUNCTION touch_ai_campaigns_updated_at();
