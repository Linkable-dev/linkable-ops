-- Bulk-launch hardening:
--   per-campaign daily send cap, business-hour send window, bounce-pause.

ALTER TABLE ai_campaigns
  ADD COLUMN IF NOT EXISTS daily_send_cap INTEGER,
  ADD COLUMN IF NOT EXISTS send_window_start_hour SMALLINT NOT NULL DEFAULT 9,
  ADD COLUMN IF NOT EXISTS send_window_end_hour SMALLINT NOT NULL DEFAULT 18,
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC',
  ADD COLUMN IF NOT EXISTS bounce_pause_pct REAL NOT NULL DEFAULT 5.0,
  ADD COLUMN IF NOT EXISTS auto_paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_pause_reason TEXT;

-- Speeds up daily-cap counts and bounce-rate windows.
CREATE INDEX IF NOT EXISTS idx_ai_messages_team_dir_sent
  ON ai_messages(team_id, direction, sent_at DESC)
  WHERE sent_at IS NOT NULL;

-- Speeds up cross-campaign dedup lookup.
CREATE INDEX IF NOT EXISTS idx_ai_conversations_team_email
  ON ai_conversations(team_id, lower(prospect_email));

-- Idempotent: ensure existing campaigns get sane defaults.
UPDATE ai_campaigns
SET send_window_start_hour = 9
WHERE send_window_start_hour IS NULL;
UPDATE ai_campaigns
SET send_window_end_hour = 18
WHERE send_window_end_hour IS NULL;
UPDATE ai_campaigns
SET timezone = 'UTC'
WHERE timezone IS NULL;
