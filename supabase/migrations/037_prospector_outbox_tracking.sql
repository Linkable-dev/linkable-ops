-- Everything about the emails our own sender sends, kept so it can be
-- analysed: one row per email with what happened to it, the step somebody
-- answered, and whether the person then joined Linkable and used it.

-- One row per email (a person gets up to four).
CREATE TABLE IF NOT EXISTS prospector_outbox_emails (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    outbox_id     UUID NOT NULL REFERENCES prospector_outbox(id) ON DELETE CASCADE,
    audience      TEXT NOT NULL,
    sequence      TEXT NOT NULL,
    step          INT NOT NULL,
    to_email      TEXT NOT NULL,
    from_email    TEXT NOT NULL,
    subject       TEXT,
    resend_id     TEXT UNIQUE,
    -- When it was handed to the mail service, and when it was timed to leave.
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    scheduled_for TIMESTAMPTZ NOT NULL,
    delivered_at  TIMESTAMPTZ,
    bounced_at    TIMESTAMPTZ,
    bounce_reason TEXT,
    complained_at TIMESTAMPTZ,
    -- Called back before it left (the person answered or unsubscribed).
    cancelled_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS prospector_outbox_emails_outbox_idx ON prospector_outbox_emails (outbox_id, step);
CREATE INDEX IF NOT EXISTS prospector_outbox_emails_when_idx ON prospector_outbox_emails (scheduled_for);
ALTER TABLE prospector_outbox_emails ENABLE ROW LEVEL SECURITY;

-- On the person: which email they answered, and what they did afterwards.
ALTER TABLE prospector_outbox
    ADD COLUMN IF NOT EXISTS replied_step      INT,
    ADD COLUMN IF NOT EXISTS signed_up_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS signed_up_user_id TEXT,
    -- Creator: their first pitch sent. Brand: their first campaign live.
    ADD COLUMN IF NOT EXISTS activated_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS outcomes_checked_at TIMESTAMPTZ;

-- One line per person, for analysis: who they are, what they were sent, and
-- how far they went. `variables` carries the rest (tier, niche, followers...).
CREATE OR REPLACE VIEW prospector_outbox_people AS
SELECT o.id, o.audience, o.sequence, o.to_email, o.handle, o.auto, o.status, o.stop_reason,
       o.created_at AS handed_over_at, o.first_sent_at, o.last_sent_at,
       date_trunc('week', o.first_sent_at)::date AS week,
       o.step AS emails_sent,
       (SELECT count(*) FROM prospector_outbox_emails e WHERE e.outbox_id = o.id AND e.delivered_at IS NOT NULL) AS emails_delivered,
       (o.status = 'bounced') AS bounced,
       (o.stop_reason = 'complaint') AS marked_spam,
       (o.status = 'unsubscribed' AND o.stop_reason <> 'complaint') AS unsubscribed,
       (o.reply_at IS NOT NULL AND o.status = 'replied') AS replied,
       o.replied_step, o.reply_at, o.reply_text,
       round(extract(epoch FROM (o.reply_at - o.first_sent_at)) / 3600.0, 1) AS hours_to_reply,
       (o.signed_up_at IS NOT NULL) AS signed_up, o.signed_up_at,
       (o.activated_at IS NOT NULL) AS activated, o.activated_at,
       o.variables
FROM prospector_outbox o;

-- The funnel, by week and wording.
CREATE OR REPLACE VIEW prospector_outbox_results AS
SELECT audience, sequence, week,
       count(*) FILTER (WHERE first_sent_at IS NOT NULL) AS people,
       count(*) FILTER (WHERE emails_delivered > 0)      AS reached,
       count(*) FILTER (WHERE bounced)                   AS bounced,
       count(*) FILTER (WHERE replied)                   AS replied,
       count(*) FILTER (WHERE replied AND replied_step = 1) AS replied_to_first,
       count(*) FILTER (WHERE unsubscribed)              AS unsubscribed,
       count(*) FILTER (WHERE marked_spam)               AS marked_spam,
       count(*) FILTER (WHERE signed_up)                 AS signed_up,
       count(*) FILTER (WHERE activated)                 AS activated
FROM prospector_outbox_people
WHERE first_sent_at IS NOT NULL
GROUP BY audience, sequence, week;

-- A view runs as its owner unless told otherwise, which would let any key read
-- these people past the tables' row security. As the caller, like the tables.
ALTER VIEW prospector_outbox_people SET (security_invoker = true);
ALTER VIEW prospector_outbox_results SET (security_invoker = true);
