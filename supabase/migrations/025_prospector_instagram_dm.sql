-- The Instagram DM queue on /gtm/brands/instagram.
--
-- Instagram's API cannot open a conversation with an account that has not
-- written to us first, so a cold DM is sent by a person. What this removes is
-- everything around the send: finding the brand, reading what it asked for,
-- writing the message. The page drafts it; a person copies it, opens the
-- conversation and presses send.
--
-- Two groups of columns, with the same ownership rule as the rest of the table.
--
-- Pipeline-owned (linkable-prospector writes these on every sync): what the
-- message is written from - the creator call the brand posted, and how its
-- Instagram profile describes it.
--
-- Ops-owned (the pipeline never writes these): the draft, and what happened to
-- it. dm_sent_at is read back by the pipeline, so a brand written to here is
-- never also started on the cold email sequence.
ALTER TABLE prospector_leads
    ADD COLUMN IF NOT EXISTS intent_caption TEXT,
    ADD COLUMN IF NOT EXISTS ig_full_name   TEXT,
    ADD COLUMN IF NOT EXISTS ig_biography   TEXT,
    ADD COLUMN IF NOT EXISTS ig_category    TEXT,
    ADD COLUMN IF NOT EXISTS ig_followers   INTEGER,

    -- none | drafted | sent | replied | skipped
    ADD COLUMN IF NOT EXISTS dm_state       TEXT NOT NULL DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS dm_text        TEXT,
    ADD COLUMN IF NOT EXISTS dm_language    TEXT,
    ADD COLUMN IF NOT EXISTS dm_drafted_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS dm_sent_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS dm_sent_by     TEXT,
    ADD COLUMN IF NOT EXISTS dm_replied_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_prospector_leads_dm_state ON prospector_leads(dm_state);
CREATE INDEX IF NOT EXISTS idx_prospector_leads_dm_sent  ON prospector_leads(dm_sent_at DESC);
