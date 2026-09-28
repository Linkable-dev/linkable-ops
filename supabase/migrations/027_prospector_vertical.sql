-- What each brand sells, as one of Linkable's creator niches.
--
-- Pipeline-owned: linkable-prospector classifies it on every sync from the
-- store's product titles, the Instagram category, the bio and the creator call
-- (prospector/verticals.py), so a better classifier re-labels old leads. NULL
-- means the evidence was too thin to say.
--
-- Used twice in ops: the DM queue filters on it, and the admin setting
-- search_verticals (prospector_settings) chooses which verticals' phrases the
-- worker searches Instagram for.
ALTER TABLE prospector_leads ADD COLUMN IF NOT EXISTS vertical TEXT;
CREATE INDEX IF NOT EXISTS idx_prospector_leads_vertical ON prospector_leads(vertical);
