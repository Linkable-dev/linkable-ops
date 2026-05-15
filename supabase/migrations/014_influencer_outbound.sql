-- Influencer outbound module.
--
-- Reuses email_campaigns / email_sends / email_templates / sender_inboxes
-- with an `audience_type` discriminator so brand and influencer outbound
-- run side by side without forking the schema. Adds a sender_pool_tag so
-- the inbox rotation partitions cleanly: brand campaigns send from the
-- shared (NULL-tagged) trylinkable.link inboxes; influencer campaigns
-- send from a dedicated influencer-tagged inbox without cross-bleed.
--
-- Prospect pool lives in a new `creator_prospects` table (mirror of
-- storeleads_brands but for creators). v1 source = main-app `influencers`
-- table via CloudSQL sync (server/automation/sync-creators.js); a future
-- scraper can plug into the same upsert path via the `source` column.

-- ---------- Audience discriminator ----------
ALTER TABLE email_campaigns
  ADD COLUMN IF NOT EXISTS audience_type TEXT NOT NULL DEFAULT 'brand'
    CHECK (audience_type IN ('brand', 'influencer')),
  -- NULL = shared / legacy single-pool. Specific tag (e.g. 'influencer')
  -- restricts the campaign to inboxes with the same tag, keeping reply
  -- triage and sender reputation isolated by audience.
  ADD COLUMN IF NOT EXISTS sender_pool_tag TEXT;

ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS audience_type TEXT NOT NULL DEFAULT 'brand'
    CHECK (audience_type IN ('brand', 'influencer'));

ALTER TABLE email_sends
  ADD COLUMN IF NOT EXISTS audience_type TEXT NOT NULL DEFAULT 'brand'
    CHECK (audience_type IN ('brand', 'influencer'));

ALTER TABLE sender_inboxes
  ADD COLUMN IF NOT EXISTS sender_pool_tag TEXT;

CREATE INDEX IF NOT EXISTS idx_sender_inboxes_pool_tag
  ON sender_inboxes(team_id, sender_pool_tag, is_active)
  WHERE is_active = true;

-- Partial index keeps the audience filter cheap on the analytics rollups
-- (campaign metrics, daily counts) without bloating the broader email_sends
-- index footprint.
CREATE INDEX IF NOT EXISTS idx_email_sends_audience_sent
  ON email_sends(team_id, audience_type, sent_at)
  WHERE status = 'sent' AND sent_at IS NOT NULL;

-- ---------- creator_prospects ----------
-- One row per (source, source_id) creator. Synced from main-app influencers
-- by sync-creators.js; future scrapers (Modash/HypeAuditor/etc) drop in by
-- using a different `source` value.
CREATE TABLE IF NOT EXISTS creator_prospects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,

  -- Provenance — uniqueness is on (source, source_id) so the sync can upsert
  -- without re-importing existing rows or stomping cross-source duplicates.
  source TEXT NOT NULL DEFAULT 'main_app',     -- 'main_app' | 'modash' | 'hypeauditor' | ...
  source_id TEXT NOT NULL,                     -- main app: users.id (uuid as text)

  -- Contact
  email TEXT,
  first_name TEXT,
  last_name TEXT,

  -- Instagram (the only platform the main-app influencers table tracks today;
  -- nullable so future scrapers can populate other platforms via raw_data).
  instagram_username TEXT,
  instagram_name TEXT,
  followers_count INTEGER,                     -- platform-agnostic primary follower number
  engagement_rate NUMERIC(6,4),                -- 0.0345 = 3.45%
  profile_pic_name TEXT,                       -- GCS object name for signed url lookups

  -- Targeting attributes
  niche TEXT,
  country TEXT,                                -- ISO-2 if known; free-form otherwise
  city TEXT,

  -- Full payload from the source for future re-derivation without re-syncing.
  raw_data JSONB,

  -- ICP scoring — set at sync time by creator-scoring.js. The orchestrator
  -- gates enrollment on `creator_score >= MIN_SEND_SCORE` (currently 6).
  creator_score SMALLINT,
  creator_score_breakdown JSONB,
  scored_at TIMESTAMPTZ,

  -- Lifecycle flags — mirror storeleads_brands semantics so the same
  -- "is this prospect still cold?" question reads the same way.
  contact_used BOOLEAN NOT NULL DEFAULT false,
  emailed BOOLEAN NOT NULL DEFAULT false,
  emailed_at TIMESTAMPTZ,

  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_creator_prospects_source_unique
  ON creator_prospects(team_id, source, source_id);

-- Score-first sendable index (analogue of idx_storeleads_brand_score_sendable).
-- Most creators won't qualify; we only index the ones the orchestrator can
-- actually enroll, keeping the partial small.
CREATE INDEX IF NOT EXISTS idx_creator_prospects_sendable
  ON creator_prospects(team_id, creator_score DESC, imported_at DESC)
  WHERE creator_score >= 6
    AND contact_used = false
    AND email IS NOT NULL
    AND first_name IS NOT NULL;

-- Email-side dedupe lookup (sequencer's "already enrolled?" guard hits
-- email_sends by to_email; this keeps the reverse — "given an email, find
-- the prospect" — fast for sync-time conflict resolution).
CREATE INDEX IF NOT EXISTS idx_creator_prospects_email
  ON creator_prospects(team_id, lower(email))
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_creator_prospects_imported
  ON creator_prospects(team_id, imported_at DESC);
