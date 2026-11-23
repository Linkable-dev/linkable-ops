-- Opens and link clicks, as the mail service reports them.
--
-- An open is a hidden image being loaded. Mail filters load it too, often
-- within minutes of delivery, so an open is a weak sign that a person read
-- the email; replies and sign-ups are the strong ones.

ALTER TABLE prospector_outbox_emails
    ADD COLUMN IF NOT EXISTS opened_at  TIMESTAMPTZ,          -- the first time
    ADD COLUMN IF NOT EXISTS opens      INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS clicks     INT NOT NULL DEFAULT 0;

-- On the person: the first time any of their emails was opened or clicked.
ALTER TABLE prospector_outbox
    ADD COLUMN IF NOT EXISTS opened_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMPTZ;

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
       o.intent, o.auto_answers, o.needs_person, o.needs_person_reason, o.conversation,
       (o.opened_at IS NOT NULL) AS opened, o.opened_at,
       (o.clicked_at IS NOT NULL) AS clicked, o.clicked_at
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
       count(*) FILTER (WHERE needs_person)              AS passed_to_a_person,
       count(*) FILTER (WHERE opened)                    AS opened,
       count(*) FILTER (WHERE clicked)                   AS clicked
FROM prospector_outbox_people
WHERE first_sent_at IS NOT NULL
GROUP BY audience, sequence, week;

ALTER VIEW prospector_outbox_people SET (security_invoker = true);
ALTER VIEW prospector_outbox_results SET (security_invoker = true);
