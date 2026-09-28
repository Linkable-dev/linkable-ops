-- Two things the Instagram DM queue needed from the prospector.
--
-- 1. Continuous campaigns. A campaign used to finish the first time a pass
--    found nothing new, which is right for "twenty Tier A leads" and wrong for
--    a hashtag that gets new posts every day: both campaigns stopped after one
--    pass and nothing was discovered for a week. A continuous one runs at most
--    once a day, reads a rotating slice of its hashtags, spends at most
--    budget_usd per calendar month, and never finishes on its own.
ALTER TABLE prospector_campaigns
    ADD COLUMN IF NOT EXISTS continuous BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Settings an admin chooses for the whole team, rather than per browser.
--    First key: dm_include_non_shopify - whether brands whose store is not on
--    Shopify appear in the DM queue. They are never emailed either way.
CREATE TABLE IF NOT EXISTS prospector_settings (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  TEXT
);

ALTER TABLE prospector_settings ENABLE ROW LEVEL SECURITY;
