-- Warmup agent: per-team list of friendly inboxes the warmup agent sends to.
--
-- For 2 weeks before a sender_inboxes row graduates (is_warming=false), the
-- agent rotates daily sends across these addresses to build conversational
-- signals — opens, replies, "not spam" recoveries. Recipient diversity
-- matters: aim for 8-15 seeds across 3+ mail providers (Gmail, Outlook,
-- iCloud, ProtonMail), so the warming domain looks like it's reaching real
-- humans, not a single inbox.

CREATE TABLE IF NOT EXISTS warmup_seeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT,                              -- optional friendly name (used as To name)
  notes TEXT,                                     -- free-form (e.g. 'co-founder gmail', 'family')
  is_active BOOLEAN NOT NULL DEFAULT true,        -- flip false to retire a seed without deleting
  bounced_at TIMESTAMPTZ,                         -- set by webhook if a send to this seed bounces
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_warmup_seeds_team_email_unique
  ON warmup_seeds(team_id, lower(email));

CREATE INDEX IF NOT EXISTS idx_warmup_seeds_team_active
  ON warmup_seeds(team_id, is_active)
  WHERE is_active = true;
