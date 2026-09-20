-- Prospecting leads: Shopify brands that look like candidates to install
-- Linkable, produced by the linkable-prospector pipeline.
--
-- This lives in the ops database rather than the product database on purpose.
-- It is tooling data - who we might approach and what a human decided about
-- them - not anything the app itself reads, and it sits next to the outbound
-- tables it feeds.
--
-- The pipeline owns every column except `decision` and `ops_note`. Those two
-- are owned by whoever is looking at the list, and a re-sync must never
-- overwrite them.
CREATE TABLE IF NOT EXISTS prospector_leads (
    id                      BIGSERIAL PRIMARY KEY,
    handle                  TEXT NOT NULL UNIQUE,
    tier                    TEXT,

    -- A human's verdict: pending | send | hold | hide
    decision                TEXT NOT NULL DEFAULT 'pending',
    ops_note                TEXT,
    decided_at              TIMESTAMPTZ,

    brand_name              TEXT,
    domain                  TEXT,
    contact_email           TEXT,
    founder_name            TEXT,
    country                 TEXT,

    affiliate_app           TEXT,
    product_count           INTEGER,
    creator_activity_score  REAL,
    store_maturity_score    REAL,
    distinct_creators_90d   INTEGER,
    top_creators            TEXT,

    intent_signal           TEXT,
    intent_post_url         TEXT,

    entity_type             TEXT,
    entity_verified         BOOLEAN DEFAULT FALSE,
    company_number          TEXT,

    status                  TEXT,
    tier_reason             TEXT,
    review_reason           TEXT,
    source                  TEXT,
    seed_creator            TEXT,
    instagram_url           TEXT,

    pushed_at               TIMESTAMPTZ,
    first_seen_at           TIMESTAMPTZ,
    synced_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prospector_leads_tier     ON prospector_leads(tier);
CREATE INDEX IF NOT EXISTS idx_prospector_leads_decision ON prospector_leads(decision);
CREATE INDEX IF NOT EXISTS idx_prospector_leads_status   ON prospector_leads(status);

-- Stamp decided_at whenever a person actually changes the verdict, so the page
-- can show when a call was made without the sync having to care.
CREATE OR REPLACE FUNCTION prospector_leads_stamp_decision() RETURNS trigger AS $$
BEGIN
  IF NEW.decision IS DISTINCT FROM OLD.decision THEN
    NEW.decided_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prospector_leads_decision ON prospector_leads;
CREATE TRIGGER trg_prospector_leads_decision
  BEFORE UPDATE ON prospector_leads
  FOR EACH ROW EXECUTE FUNCTION prospector_leads_stamp_decision();

-- Service-role only, like the rest of the ops tables: nothing here should be
-- reachable with an anon key.
ALTER TABLE prospector_leads ENABLE ROW LEVEL SECURITY;
