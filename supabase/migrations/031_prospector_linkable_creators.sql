-- Creators already on Linkable who posted about the brand (pipeline-owned).
--
-- Found by linkable-prospector's linkable_creators source, which reads the
-- recent posts of Linkable's own creators and records every brand they tag.
-- The count raises the conversion score; the handles let the first DM say
-- something true and specific: "3 creators on Linkable already post about
-- you, including @ada and @bea".
ALTER TABLE prospector_leads ADD COLUMN IF NOT EXISTS linkable_creator_count INTEGER;
ALTER TABLE prospector_leads ADD COLUMN IF NOT EXISTS linkable_creators TEXT;
