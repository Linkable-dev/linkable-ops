-- People the sender decides not to write to after all (26 Nov 2026): a
-- customer-service inbox, a placeholder address, a country we do not write
-- to, a talent agency, a creator call too old to mention. Not a failure, and
-- not finished either, so it has its own status. Reason in stop_reason.
ALTER TABLE prospector_outbox DROP CONSTRAINT IF EXISTS prospector_outbox_status_check;
ALTER TABLE prospector_outbox ADD CONSTRAINT prospector_outbox_status_check
  CHECK (status IN ('active', 'done', 'replied', 'unsubscribed', 'bounced', 'failed', 'skipped'));
