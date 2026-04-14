-- Email outreach automation tables
-- Supports A/B testing, personalization, and CRM integration

-- Email templates for A/B testing
CREATE TABLE IF NOT EXISTS email_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id),
  name TEXT NOT NULL,                    -- e.g. "Template A - Direct Value"
  variant CHAR(1) NOT NULL,              -- A, B, C, D, E
  subject_template TEXT NOT NULL,        -- Subject line with {{placeholders}}
  body_template TEXT NOT NULL,           -- Plain text body with {{placeholders}}
  is_active BOOLEAN DEFAULT true,
  send_count INTEGER DEFAULT 0,
  open_count INTEGER DEFAULT 0,         -- future: track opens
  reply_count INTEGER DEFAULT 0,        -- future: track replies
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Email campaigns (each automation run)
CREATE TABLE IF NOT EXISTS email_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id),
  name TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, running, complete, failed, stopped
  total_contacts INTEGER DEFAULT 0,
  emails_sent INTEGER DEFAULT 0,
  emails_failed INTEGER DEFAULT 0,
  emails_skipped INTEGER DEFAULT 0,      -- already contacted, no email, etc.
  source TEXT DEFAULT 'scraper',         -- scraper, manual, crm
  config JSONB DEFAULT '{}',             -- filters, limits, template selection
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Individual email sends (one per contact per campaign)
CREATE TABLE IF NOT EXISTS email_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES email_campaigns(id),
  team_id UUID NOT NULL REFERENCES teams(id),
  contact_id UUID REFERENCES contacts(id),
  template_id UUID REFERENCES email_templates(id),
  template_variant CHAR(1),
  to_email TEXT NOT NULL,
  to_name TEXT,
  subject TEXT NOT NULL,                 -- final rendered subject
  body TEXT NOT NULL,                    -- final rendered body
  status TEXT NOT NULL DEFAULT 'pending', -- pending, sent, failed, bounced
  resend_id TEXT,                        -- Resend message ID for tracking
  error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_email_sends_campaign ON email_sends(campaign_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_contact ON email_sends(contact_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_team ON email_sends(team_id);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_team ON email_campaigns(team_id);
CREATE INDEX IF NOT EXISTS idx_email_templates_team ON email_templates(team_id);

-- RLS policies
ALTER TABLE email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_sends ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Team members can manage their templates"
  ON email_templates FOR ALL
  USING (team_id IN (SELECT team_id FROM profiles WHERE id = auth.uid()));

CREATE POLICY "Team members can manage their campaigns"
  ON email_campaigns FOR ALL
  USING (team_id IN (SELECT team_id FROM profiles WHERE id = auth.uid()));

CREATE POLICY "Team members can view their sends"
  ON email_sends FOR ALL
  USING (team_id IN (SELECT team_id FROM profiles WHERE id = auth.uid()));
