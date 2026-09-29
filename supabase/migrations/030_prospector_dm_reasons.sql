-- Why a brand sits where it does in the DM queue (pipeline-owned).
--
-- dm_priority became a conversion-potential score on 29 Sep 2026 (market,
-- vertical, offer fit, store, size, how fresh the creator call is; see
-- dm_priority_and_reasons in linkable-prospector's ops_sync.py). dm_reasons is
-- the same score in words, "UK · health · asked for gifted creators 2d ago ·
-- Shopify, no affiliate app · 12k followers", shown on the brand's card so a
-- person can see why it is first and disagree.
ALTER TABLE prospector_leads ADD COLUMN IF NOT EXISTS dm_reasons TEXT;
