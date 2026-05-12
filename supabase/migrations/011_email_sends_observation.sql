-- Store the rendered observation on each email_sends row so we can query
-- "which openers actually converted" without parsing the body.
--
-- Populated by sequencer.enrollProspect at insert time. Same value across
-- all touches in a sequence (the observation is generated once per prospect
-- and only G3-T1 uses {{observation}} today, but storing on every touch
-- lets analytics queries skip the JOIN to find the T1 row).
--
-- Read pattern: `WHERE observation IS NOT NULL AND replied_at IS NOT NULL`
-- to find which observation text drove replies.

ALTER TABLE email_sends
  ADD COLUMN IF NOT EXISTS observation TEXT;

-- Partial index on observed + replied rows so the analytics query is fast
-- even at 100k+ sends. Most rows will have observation NULL initially
-- (legacy sends), so a partial index keeps the size sane.
CREATE INDEX IF NOT EXISTS idx_email_sends_observation_replied
  ON email_sends(team_id, replied_at)
  WHERE observation IS NOT NULL AND replied_at IS NOT NULL;
