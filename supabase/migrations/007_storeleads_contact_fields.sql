-- Lead-discovery integration: storeleads_brands grows contact-person fields
-- so the AI bulk runner can pick a verified decision-maker straight from
-- this table without a second enrichment pass.

ALTER TABLE storeleads_brands
  ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contact_first_name TEXT,
  ADD COLUMN IF NOT EXISTS contact_last_name TEXT,
  ADD COLUMN IF NOT EXISTS contact_position TEXT,
  ADD COLUMN IF NOT EXISTS contact_source TEXT,                -- apollo / hunter / storeleads
  ADD COLUMN IF NOT EXISTS contact_used BOOLEAN DEFAULT false;  -- flipped true after first AI campaign uses this lead

CREATE INDEX IF NOT EXISTS idx_storeleads_team_email
  ON storeleads_brands(team_id, lower(email))
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_storeleads_used
  ON storeleads_brands(contact_used);
