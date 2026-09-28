-- Closing the Instagram DM loop: what happened after a DM, and the machinery
-- that keeps the queue fed.

ALTER TABLE prospector_leads
    -- Pipeline-owned. When the brand posted the call we found (not when we
    -- found it), and the queue's ordering score built from it.
    ADD COLUMN IF NOT EXISTS intent_posted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS dm_priority      REAL,

    -- Ops-owned. A vertical from Claude for brands the keyword classifier
    -- could not place, and whether the account is an agency or a platform
    -- rather than a brand. Kept apart from `vertical`, which the pipeline
    -- rewrites on every sync.
    ADD COLUMN IF NOT EXISTS vertical_ai      TEXT,
    ADD COLUMN IF NOT EXISTS is_agency        BOOLEAN,
    ADD COLUMN IF NOT EXISTS classified_at    TIMESTAMPTZ,

    -- Ops-owned. Which way the first message was written, so reply rates can
    -- be compared between variants.
    ADD COLUMN IF NOT EXISTS dm_variant       TEXT,

    -- Ops-owned. One follow-up, drafted when the first DM has gone unanswered.
    ADD COLUMN IF NOT EXISTS dm_followup_text     TEXT,
    ADD COLUMN IF NOT EXISTS dm_followup_sent_at  TIMESTAMPTZ,

    -- Ops-owned. The brand became a Linkable customer after it was DMed,
    -- matched against the product database by shop domain or email.
    ADD COLUMN IF NOT EXISTS converted_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS converted_match  TEXT,

    -- Ops-owned. The brand's reply, when Instagram delivered it to us.
    ADD COLUMN IF NOT EXISTS dm_reply_text    TEXT,
    ADD COLUMN IF NOT EXISTS ig_user_id       TEXT;

CREATE INDEX IF NOT EXISTS idx_prospector_leads_dm_priority ON prospector_leads(dm_priority DESC);
CREATE INDEX IF NOT EXISTS idx_prospector_leads_ig_user_id  ON prospector_leads(ig_user_id);

-- The logged-in Instagram read, as the worker last saw it. One row, written
-- by the prospector every tick, read by the DM page (a banner) and by the
-- morning brief, so an expired session is noticed the same day rather than
-- when somebody wonders why the queue stopped growing.
CREATE TABLE IF NOT EXISTS prospector_feed_status (
    id               INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_scraped_at  TIMESTAMPTZ,
    last_error       TEXT,
    session_saved_at TIMESTAMPTZ,
    new_open_calls   INTEGER,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE prospector_feed_status ENABLE ROW LEVEL SECURITY;

-- Messages brands sent back on Instagram, delivered by Meta's webhook. Kept
-- whole rather than folded into the lead, because a conversation is more
-- than one reply.
CREATE TABLE IF NOT EXISTS prospector_dm_messages (
    id           BIGSERIAL PRIMARY KEY,
    mid          TEXT UNIQUE,              -- Meta's message id: a redelivery is a no-op
    ig_user_id   TEXT NOT NULL,            -- the brand's Instagram-scoped id
    handle       TEXT,                     -- matched lead, when we know it
    direction    TEXT NOT NULL,            -- in | out
    text         TEXT,
    sent_at      TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prospector_dm_messages_handle ON prospector_dm_messages(handle, sent_at DESC);
ALTER TABLE prospector_dm_messages ENABLE ROW LEVEL SECURITY;
