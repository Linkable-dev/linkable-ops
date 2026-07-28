-- Per-brand creator outreach agent (pilot).
--
-- Lets an influencer-audience campaign run "on behalf of" a specific brand:
-- the AI reply agent answers creator questions from a per-brand knowledge
-- base and steers interested creators to the brand's campaign page on
-- Linkable (goal_link). Creator lists can be uploaded via CSV and segmented
-- per brand with creator_prospects.list_tag, which campaigns target via
-- target_filters.list_tag.
--
-- Field ownership: the operator edits brand_name / knowledge_base /
-- campaign_page_url on email_campaigns (single UI surface); the campaigns
-- API mirrors them onto the linked ai_campaigns row, which is what the
-- reply agent reads at generation time.

-- ---------- ai_campaigns: audience + per-brand knowledge ----------
ALTER TABLE ai_campaigns
  ADD COLUMN IF NOT EXISTS audience_type TEXT NOT NULL DEFAULT 'brand'
    CHECK (audience_type IN ('brand', 'influencer')),
  ADD COLUMN IF NOT EXISTS brand_name TEXT,
  ADD COLUMN IF NOT EXISTS knowledge_base TEXT;

-- ---------- email_campaigns: operator-facing per-brand fields ----------
ALTER TABLE email_campaigns
  ADD COLUMN IF NOT EXISTS brand_name TEXT,
  ADD COLUMN IF NOT EXISTS knowledge_base TEXT,
  ADD COLUMN IF NOT EXISTS campaign_page_url TEXT;

-- ---------- creator_prospects: CSV list segmentation ----------
ALTER TABLE creator_prospects
  ADD COLUMN IF NOT EXISTS list_tag TEXT;

CREATE INDEX IF NOT EXISTS idx_creator_prospects_list_tag
  ON creator_prospects(team_id, list_tag)
  WHERE list_tag IS NOT NULL;
