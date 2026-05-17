-- Inbox: manual-triage replies on email_sends.
--
-- Reply bodies for daily-200 (manual triage, auto_reply=false) lands as
-- email_sends.replied_at + the raw payload in ai_raw_events. The unified
-- inbox surfaces those rows alongside ai_conversations threads. To let
-- operators clear a reply once they've responded out-of-band (or opted
-- the prospect out), we stamp a handled_at + handled_by_email here so
-- the inbox can show an "unhandled" filter without re-reading raw events.

ALTER TABLE email_sends
  ADD COLUMN IF NOT EXISTS handled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS handled_by_email TEXT;

-- Partial index for the inbox query: replies that haven't been cleared
-- yet. Keeps the default view (unhandled, newest first) cheap as the
-- email_sends table grows.
CREATE INDEX IF NOT EXISTS idx_email_sends_inbox_unhandled
  ON email_sends(team_id, replied_at DESC)
  WHERE replied_at IS NOT NULL AND handled_at IS NULL;
