-- What came back after the send.
--
-- Everything else in the prospector schema is a prediction: this brand looks
-- like it runs influencer marketing without tracking it, this creator looks
-- worth inviting. This table is the first thing in it that is a fact.
--
-- Written only by the prospector worker. Nobody edits it in ops - unlike
-- `decision` on the lead tables, there is no human column here, because a reply
-- is not an opinion.
CREATE TABLE IF NOT EXISTS prospector_outreach_events (
    id              BIGSERIAL PRIMARY KEY,
    activity_id     TEXT NOT NULL UNIQUE,   -- Lemlist's own id: the idempotency key
    kind            TEXT NOT NULL,          -- 'brand' | 'creator'
    handle          TEXT,
    email           TEXT NOT NULL,
    event           TEXT NOT NULL,
    campaign_id     TEXT,
    campaign_name   TEXT,
    subject         TEXT,
    preview         TEXT,
    interest_score  REAL,
    occurred_at     TIMESTAMPTZ NOT NULL,
    ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outreach_events_target ON prospector_outreach_events(kind, handle);
CREATE INDEX IF NOT EXISTS idx_outreach_events_when   ON prospector_outreach_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_events_event  ON prospector_outreach_events(event);

-- The summary, denormalised onto each side so a queue can sort by it.
ALTER TABLE prospector_leads
    ADD COLUMN IF NOT EXISTS reply_state   TEXT,
    ADD COLUMN IF NOT EXISTS replied_at    TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_event_at TIMESTAMPTZ;

ALTER TABLE prospector_creators
    ADD COLUMN IF NOT EXISTS reply_state   TEXT,
    ADD COLUMN IF NOT EXISTS replied_at    TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_event_at TIMESTAMPTZ;
