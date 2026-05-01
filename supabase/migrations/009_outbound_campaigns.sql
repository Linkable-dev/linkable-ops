-- Phase 1: full outbound campaign management.
-- Extends email_campaigns with target-filter config, daily cap, sender, and
-- auto-reply mode. Links email_templates to a campaign with weighted A/B
-- selection and a per-(group, touch) slot. Adds the `weight` so the sequencer
-- can pick variants on a 50/30/20-style split.

ALTER TABLE email_campaigns
  ADD COLUMN IF NOT EXISTS target_filters JSONB NOT NULL DEFAULT '{}',
  -- expected shape:
  --   {
  --     "platforms":   ["shopify"],
  --     "categories":  ["beauty", "wellness"],   // free-form OR StoreLeads paths
  --     "countries":   ["US","GB"],
  --     "min_revenue": 5000000,                  // monthly USD (StoreLeads `er`)
  --     "max_revenue": 10000000,
  --     "groups":      ["G1","G2","G3"],         // optional restriction
  --     "daily_mix":   { "G1": 0.25, "G2": 0.60, "G3": 0.15 } // optional override
  --   }
  ADD COLUMN IF NOT EXISTS daily_cap INTEGER NOT NULL DEFAULT 200,
  ADD COLUMN IF NOT EXISTS sender_from TEXT NOT NULL DEFAULT 'Federico from Linkable <brand@linkable.link>',
  ADD COLUMN IF NOT EXISTS reply_to TEXT NOT NULL DEFAULT 'brand@linkable.link',
  ADD COLUMN IF NOT EXISTS auto_reply BOOLEAN NOT NULL DEFAULT false,    -- false = manual triage; true = AI auto-responds
  ADD COLUMN IF NOT EXISTS ai_campaign_id UUID REFERENCES ai_campaigns(id) ON DELETE SET NULL,  -- if auto_reply, which AI persona handles replies
  ADD COLUMN IF NOT EXISTS brief TEXT,                                   -- free-form description used when generating draft templates
  ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;

-- Make sure status is meaningful for the orchestrator: 'active' | 'paused' | 'archived'.
-- Existing rows default to 'pending' / 'running' / 'complete' — leave them be.

-- email_templates: link to campaign + add brand_group / touch_number / weight + draft flag.
-- The 9 SEQUENCE_TEMPLATES seed in migration 010 will populate these fields.
ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES email_campaigns(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS brand_group TEXT,                       -- 'G1' | 'G2' | 'G3' | NULL (legacy A-F)
  ADD COLUMN IF NOT EXISTS touch_number SMALLINT,                  -- 1, 2, 3 (NULL for legacy A-F)
  ADD COLUMN IF NOT EXISTS weight INTEGER NOT NULL DEFAULT 100,    -- 0..100; 0 disables, picker uses sum-weighted random
  ADD COLUMN IF NOT EXISTS is_draft BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS generated_by_ai BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS template_key TEXT;                      -- stable id like 'G1-T1' for the orchestrator lookup

CREATE INDEX IF NOT EXISTS idx_email_templates_campaign_slot
  ON email_templates(campaign_id, brand_group, touch_number)
  WHERE campaign_id IS NOT NULL AND is_active;

-- email_sends: link to template_id is already there; add campaign_template_key for fast diagnostics
-- (so we can answer "which body got sent" without joining through template_id).
ALTER TABLE email_sends
  ADD COLUMN IF NOT EXISTS template_key TEXT,                      -- copies template.template_key at send time, e.g. 'G2-T1-v1'
  ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ,                  -- email.opened (first open wins)
  ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMPTZ,                 -- email.clicked (first click wins)
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,               -- email.delivered
  ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMPTZ,                 -- email.bounced
  ADD COLUMN IF NOT EXISTS complained_at TIMESTAMPTZ,              -- email.complained
  ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;                 -- set when handleInbound matches a thread

-- Index for fast resend_id → email_sends lookup in the webhook handler.
CREATE INDEX IF NOT EXISTS idx_email_sends_resend_id
  ON email_sends(resend_id)
  WHERE resend_id IS NOT NULL;

-- ai_bulk_runs.campaign_id was NOT NULL FK → ai_campaigns. Now lead-discovery
-- can be triggered from email_campaigns too, so make it nullable. (We keep the
-- FK so it still cascades when an ai_campaigns row is deleted.)
ALTER TABLE ai_bulk_runs ALTER COLUMN campaign_id DROP NOT NULL;

-- email_sends.template_variant was CHAR(1) for the legacy A-F templates. The
-- sequence templates use multi-char keys like 'G2-T1', so widen to TEXT.
ALTER TABLE email_sends ALTER COLUMN template_variant TYPE TEXT;
