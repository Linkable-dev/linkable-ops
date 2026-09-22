-- What kind of creator a prospecting campaign wants.
--
-- Creator discovery never saw a campaign: it scored creators on reach, post
-- count and how many brands they had been seen with, so the same ranking came
-- out whether a campaign sold skincare or menswear. The worker can rank per
-- campaign now, and these are the two fields it ranks against - set here,
-- because this is where a person names a campaign and tells it what to do.
--
-- Unlike goal_leads and budget_usd, these do cross back to a campaign that is
-- already running. They reorder a queue and nothing else: which creators get
-- invited first. They cannot spend money, move the finish line, or change what
-- counts as a lead, so getting one wrong costs an invite order and is undone by
-- typing a different word.
ALTER TABLE prospector_campaigns
    ADD COLUMN IF NOT EXISTS creator_niches   TEXT,
    ADD COLUMN IF NOT EXISTS creator_keywords TEXT;
