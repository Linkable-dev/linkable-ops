-- Answering replies by itself (server/lib/outreach-answers.js).
--
-- The whole exchange with a person is kept on their row, in order: every
-- email of ours, every message of theirs, every answer written for them.
ALTER TABLE prospector_outbox
    -- [{from: 'us'|'them', at, subject, text, message_id, auto, resend_id}]
    ADD COLUMN IF NOT EXISTS conversation  JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- What the last message from them was: interested | question |
    -- not_interested | not_now | wrong_person | other.
    ADD COLUMN IF NOT EXISTS intent        TEXT,
    -- Answers sent without a person, so far.
    ADD COLUMN IF NOT EXISTS auto_answers  INT NOT NULL DEFAULT 0,
    -- True when their last message was passed to a person instead of answered.
    ADD COLUMN IF NOT EXISTS needs_person  BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS needs_person_reason TEXT,
    -- Set when a message of theirs is waiting for an answer; cleared when it
    -- has been answered or passed on. The send job sweeps what is left.
    ADD COLUMN IF NOT EXISTS answer_pending_since TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS answer_cost_usd NUMERIC NOT NULL DEFAULT 0;

-- An answer is an email too, kept with the others. 'sequence' is a planned
-- step, 'answer' is one written in reply.
ALTER TABLE prospector_outbox_emails ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'sequence';

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
       o.variables,
       o.intent, o.auto_answers, o.needs_person, o.needs_person_reason, o.conversation
FROM prospector_outbox o;

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
       count(*) FILTER (WHERE activated)                 AS activated,
       count(*) FILTER (WHERE intent = 'interested')     AS interested,
       count(*) FILTER (WHERE auto_answers > 0)          AS answered_by_itself,
       count(*) FILTER (WHERE needs_person)              AS passed_to_a_person
FROM prospector_outbox_people
WHERE first_sent_at IS NOT NULL
GROUP BY audience, sequence, week;

ALTER VIEW prospector_outbox_people SET (security_invoker = true);
ALTER VIEW prospector_outbox_results SET (security_invoker = true);
