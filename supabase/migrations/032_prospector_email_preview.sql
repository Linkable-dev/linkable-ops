-- What the email would say, before anybody says Send (pipeline-owned).
--
-- linkable-prospector publishes, per lead, the Lemlist campaign the worker
-- would hand it to (NULL for Tier C, which is never emailed) and the variables
-- it would be pushed with. The Email tab renders that campaign's sequence with
-- them, which is exactly what Lemlist does when it sends.
ALTER TABLE prospector_leads ADD COLUMN IF NOT EXISTS email_campaign TEXT;
ALTER TABLE prospector_leads ADD COLUMN IF NOT EXISTS email_variables JSONB;
