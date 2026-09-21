-- Creators worth inviting onto Linkable: the mirror of prospector_leads.
--
-- Seeded from what the brand pipeline already watched. Every one of these
-- posted about a brand, which is the single fact that makes a creator worth
-- approaching, and it was paid for once already.
CREATE TABLE IF NOT EXISTS prospector_creators (
    id                  BIGSERIAL PRIMARY KEY,
    handle              TEXT NOT NULL UNIQUE,
    tier                TEXT,

    -- A person's verdict, owned here and never overwritten by a sync.
    decision            TEXT NOT NULL DEFAULT 'pending',
    ops_note            TEXT,
    decided_at          TIMESTAMPTZ,

    full_name           TEXT,
    biography           TEXT,
    contact_email       TEXT,
    niche               TEXT,
    country             TEXT,

    followers           INTEGER,
    posts_count         INTEGER,
    is_verified         BOOLEAN DEFAULT FALSE,

    brands_posted_about INTEGER NOT NULL DEFAULT 0,
    brand_posts         INTEGER NOT NULL DEFAULT 0,
    example_post_url    TEXT,
    example_brand       TEXT,

    creator_score       REAL,
    tier_reason         TEXT,
    status              TEXT,
    source              TEXT,
    instagram_url       TEXT,

    pushed_at           TIMESTAMPTZ,
    first_seen_at       TIMESTAMPTZ,
    synced_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prospector_creators_tier     ON prospector_creators(tier);
CREATE INDEX IF NOT EXISTS idx_prospector_creators_decision ON prospector_creators(decision);

CREATE OR REPLACE FUNCTION prospector_creators_stamp_decision() RETURNS trigger AS $$
BEGIN
  IF NEW.decision IS DISTINCT FROM OLD.decision THEN
    NEW.decided_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prospector_creators_decision ON prospector_creators;
CREATE TRIGGER trg_prospector_creators_decision
  BEFORE UPDATE ON prospector_creators
  FOR EACH ROW EXECUTE FUNCTION prospector_creators_stamp_decision();

ALTER TABLE prospector_creators ENABLE ROW LEVEL SECURITY;
