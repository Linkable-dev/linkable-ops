-- Our own outbox: the people linkable-prospector's worker hands over to be
-- written to, and where each one is in their sequence.
--
-- This replaces Lemlist for these emails. The worker inserts a row (one per
-- address, ever) with the values the wording interpolates; ops sends each
-- step from brand@ or influencer@linkable.link (server/lib/direct-outreach.js),
-- stops at a reply, an unsubscribe, a bounce or a complaint, and writes back
-- here what happened. The worker only inserts.
CREATE TABLE IF NOT EXISTS prospector_outbox (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audience    TEXT NOT NULL CHECK (audience IN ('brand', 'creator')),
    -- brand_a | brand_b | creator | creator_cold: which wording they get.
    sequence    TEXT NOT NULL,
    to_email    TEXT NOT NULL,
    handle      TEXT,
    variables   JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- True when no person marked this one `send`.
    auto        BOOLEAN NOT NULL DEFAULT false,

    -- active: more to send. done: every step sent, no answer.
    -- replied | unsubscribed | bounced: they stopped it. failed: we could not send.
    status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'done', 'replied', 'unsubscribed', 'bounced', 'failed')),
    stop_reason TEXT,
    -- Steps sent so far, and when the next one is due.
    step        INT NOT NULL DEFAULT 0,
    next_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts    INT NOT NULL DEFAULT 0,
    subject     TEXT,
    -- One entry per email sent: {step, at, resend_id, message_id}.
    thread      JSONB NOT NULL DEFAULT '[]'::jsonb,
    last_sent_at TIMESTAMPTZ,
    reply_at    TIMESTAMPTZ,
    reply_text  TEXT,
    unsub_token TEXT NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', ''),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One sequence per address, whatever the capitalisation.
CREATE UNIQUE INDEX IF NOT EXISTS prospector_outbox_email_key ON prospector_outbox (lower(to_email));
CREATE INDEX IF NOT EXISTS prospector_outbox_due_idx ON prospector_outbox (status, next_at);
CREATE UNIQUE INDEX IF NOT EXISTS prospector_outbox_token_key ON prospector_outbox (unsub_token);

ALTER TABLE prospector_outbox ENABLE ROW LEVEL SECURITY;
