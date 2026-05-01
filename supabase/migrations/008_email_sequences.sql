-- Multi-touch sequencing on email_sends.
-- Each prospect gets a sequence of 3 touches (T+0, T+3, T+7) tied together by
-- sequence_id. The daily orchestrator picks due rows up to a daily cap; the
-- conversation-runner cancels pending touches when an inbound reply lands.

ALTER TABLE email_sends
  ADD COLUMN IF NOT EXISTS sequence_id UUID,
  ADD COLUMN IF NOT EXISTS touch_number SMALLINT,           -- 1, 2, 3
  ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ,         -- when this touch is due to send
  ADD COLUMN IF NOT EXISTS sender_domain TEXT,               -- which from-domain was used
  ADD COLUMN IF NOT EXISTS brand_group TEXT,                 -- G1 | G2 | G3
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT;               -- 'replied' | 'opted_out' | 'bounced' | 'manual'

-- Status values now extended:
--   pending    — created, not yet due (touch_number = 1 or scheduled_at > now())
--   scheduled  — created with a future scheduled_at (T+3, T+7)
--   sent       — Resend accepted it
--   failed     — Resend rejected
--   bounced    — webhook reported bounce
--   cancelled  — superseded by a reply or opt-out before send
-- Existing rows (status='pending'/'sent'/'failed'/'bounced') stay valid.

-- Index for the orchestrator's "what's due now?" query.
CREATE INDEX IF NOT EXISTS idx_email_sends_due
  ON email_sends(scheduled_at, status)
  WHERE status IN ('pending', 'scheduled');

-- Index for cancel-on-reply: find pending touches for a contact fast.
CREATE INDEX IF NOT EXISTS idx_email_sends_contact_pending
  ON email_sends(contact_id, status)
  WHERE status IN ('pending', 'scheduled');

-- Index to pull all touches in a sequence (for cancel + audit).
CREATE INDEX IF NOT EXISTS idx_email_sends_sequence
  ON email_sends(sequence_id)
  WHERE sequence_id IS NOT NULL;
