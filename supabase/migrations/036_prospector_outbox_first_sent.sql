-- When each person's first email went (or is timed to go). The sender counts
-- these per day to start slowly: a mailbox that writes to five new people a
-- day in its first week, and to more each week after, is one mail providers
-- learn to trust. See RAMP in server/lib/direct-outreach.js.
ALTER TABLE prospector_outbox ADD COLUMN IF NOT EXISTS first_sent_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS prospector_outbox_first_sent_idx ON prospector_outbox (audience, first_sent_at);
