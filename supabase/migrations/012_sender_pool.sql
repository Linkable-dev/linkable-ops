-- Multi-domain sender pool for cold outbound.
--
-- The single brand@linkable.link sender mixes cold + transactional on the
-- production domain — one bad campaign and the same domain that signs
-- people up for trials lands in spam. This table is the source of truth
-- for which lookalike-domain inboxes are eligible to send cold today,
-- with per-inbox daily caps and a warming flag.
--
-- Send-time picker (sender-pool.js getNextInbox) reads this table plus
-- today's email_sends rows to choose the least-used active inbox under
-- its cap. Empty table = legacy behaviour (campaign.sender_from is used).
--
-- Onboarding new inboxes: insert with is_warming=true and warming_cap=10.
-- After 2-3 weeks of human-grade replies (real conversations seeded from
-- friendly inboxes), flip is_warming=false to graduate to daily_cap.

CREATE TABLE IF NOT EXISTS sender_inboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email TEXT NOT NULL,                       -- e.g. 'federico@trylinkable.com'
  from_name TEXT NOT NULL,                   -- e.g. 'Federico from Linkable'
  reply_to TEXT,                             -- defaults to email when NULL
  domain TEXT NOT NULL,                      -- e.g. 'trylinkable.com'
  daily_cap INTEGER NOT NULL DEFAULT 40,     -- max sends/day once graduated
  warming_cap INTEGER NOT NULL DEFAULT 10,   -- max sends/day while is_warming
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_warming BOOLEAN NOT NULL DEFAULT true,  -- new inboxes start in warmup
  warming_started_at TIMESTAMPTZ DEFAULT now(),
  notes TEXT,                                -- free-form context (which Workspace, who owns reply triage, etc.)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness lives in an index, not an inline constraint —
-- Postgres rejects function expressions inside CREATE TABLE UNIQUE clauses.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sender_inboxes_team_email_unique
  ON sender_inboxes(team_id, lower(email));

CREATE INDEX IF NOT EXISTS idx_sender_inboxes_active
  ON sender_inboxes(team_id, is_active)
  WHERE is_active = true;

-- Per-send tracking: which inbox actually sent each email. Populated by
-- sendDueRow when the pool is in use. NULL for sends that went through
-- the legacy single-sender path (pre-pool campaigns).
ALTER TABLE email_sends
  ADD COLUMN IF NOT EXISTS sender_email TEXT;

-- Index drives the "today's count per inbox" query in sender-pool.js.
-- Partial — only sent rows in the last day are relevant — but Postgres
-- can't use NOW() in a partial index predicate, so we index unconditionally
-- and rely on the BTREE on sent_at to range-scan.
CREATE INDEX IF NOT EXISTS idx_email_sends_inbox_sent
  ON email_sends(team_id, sender_email, sent_at)
  WHERE sender_email IS NOT NULL AND sent_at IS NOT NULL;
