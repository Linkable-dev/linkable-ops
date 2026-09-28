-- Two small things the DM loop needs.
--
-- myshopify_domain (pipeline-owned): the store's *.myshopify.com address. A
-- brand that signs up to Linkable is recorded by that address
-- (users.shopify_shop), not by its storefront domain, so matching a DMed brand
-- to a signup needs both.
--
-- vertical_effective: the keyword classifier's vertical, or Claude's when the
-- keywords could not tell. Generated, so filters and counts use one column and
-- neither half can overwrite the other.
ALTER TABLE prospector_leads ADD COLUMN IF NOT EXISTS myshopify_domain TEXT;
ALTER TABLE prospector_leads ADD COLUMN IF NOT EXISTS vertical_effective TEXT
    GENERATED ALWAYS AS (COALESCE(vertical, vertical_ai)) STORED;
CREATE INDEX IF NOT EXISTS idx_prospector_leads_vertical_effective ON prospector_leads(vertical_effective);
