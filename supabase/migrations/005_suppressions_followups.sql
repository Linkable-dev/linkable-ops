-- Suppression list (global opt-outs / bounces / complaints).
-- Checked before EVERY outbound. Inserts on opt-out, bounce, complaint.
CREATE TABLE IF NOT EXISTS ai_suppressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  reason TEXT NOT NULL,           -- 'opt_out', 'bounce', 'complaint', 'manual'
  detail TEXT,                    -- bounce message, opt-out phrase, etc.
  source_conversation_id UUID REFERENCES ai_conversations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, email)
);
CREATE INDEX IF NOT EXISTS idx_ai_suppressions_team_email ON ai_suppressions(team_id, lower(email));

-- Follow-up tracking on conversations.
ALTER TABLE ai_conversations
  ADD COLUMN IF NOT EXISTS follow_up_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_follow_up_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS max_follow_ups INTEGER NOT NULL DEFAULT 4;

-- Raw event log: every inbound + Resend status webhook lands here BEFORE
-- handler logic runs. Lets us replay parsing changes against historical
-- payloads and debug "why didn't this reply land" issues.
CREATE TABLE IF NOT EXISTS ai_raw_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
  source TEXT NOT NULL,                  -- 'resend', 'cloudflare', etc.
  event_type TEXT,                       -- 'email.received', 'email.bounced', ...
  signature_valid BOOLEAN,
  payload JSONB NOT NULL,
  headers JSONB,
  handler_result JSONB,
  handler_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_raw_events_type ON ai_raw_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_raw_events_created ON ai_raw_events(created_at DESC);

-- Bulk-run progress (so the UI can show "200/500 sent, 3 failed").
CREATE TABLE IF NOT EXISTS ai_bulk_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES ai_campaigns(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'running',  -- running, complete, failed, stopped
  source TEXT NOT NULL,                    -- 'scraper_results', 'contacts', 'manual'
  filters JSONB DEFAULT '{}',
  total INTEGER DEFAULT 0,
  processed INTEGER DEFAULT 0,
  sent INTEGER DEFAULT 0,
  skipped INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_bulk_runs_team ON ai_bulk_runs(team_id, created_at DESC);

ALTER TABLE ai_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_raw_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_bulk_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members manage suppressions"
  ON ai_suppressions FOR ALL
  USING (team_id IN (SELECT team_id FROM profiles WHERE id = auth.uid()));

CREATE POLICY "Team members read raw events"
  ON ai_raw_events FOR ALL
  USING (team_id IN (SELECT team_id FROM profiles WHERE id = auth.uid()));

CREATE POLICY "Team members manage bulk runs"
  ON ai_bulk_runs FOR ALL
  USING (team_id IN (SELECT team_id FROM profiles WHERE id = auth.uid()));
