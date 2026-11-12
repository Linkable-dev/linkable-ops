-- Open creator calls: one row per Instagram post in which a brand asks
-- creators to get in touch ("we're looking for UGC creators", "apply via the
-- form"), with what the prospector knows about the account that posted it.
--
-- Written by linkable-prospector (creator_calls_publish.py) on every worker
-- tick: every open call posted in the last 30 days is upserted on post_id, and
-- rows older than that are deleted. Read by the main Linkable app's two agents
-- (QA 171/172, 12 Nov 2026) over PostgREST with the service key:
--   - a call that links a Google Form (form_url) becomes a campaign on Linkable;
--   - every other call becomes a pitch signal in Brands to pitch.
--
-- prospector_leads has one row per brand that became a lead; most accounts
-- that post a call never do (64 of 486 in the 30 days to 12 Nov), so this is
-- per post and keeps the account facts that exist alongside: the lead's, a
-- rejected candidate's profile, or none (is_brand NULL = never judged).
--
-- Pipeline-owned, every column. Nothing here is a human decision, so a
-- re-publish overwrites the whole row.
CREATE TABLE IF NOT EXISTS prospector_creator_calls (
    post_id           TEXT PRIMARY KEY,           -- Instagram media id
    post_url          TEXT,
    owner_handle      TEXT,
    caption           TEXT,
    posted_at         TIMESTAMPTZ,

    -- Instagram CDN address of the post's picture. Expires within about a
    -- day (the `oe` parameter); the app copies the bytes when it reads a row.
    -- Published only while still valid.
    image_url         TEXT,
    -- The first Google Form link (forms.gle/... or docs.google.com/forms/...)
    -- in the caption, else in the bio link. Link-in-bio pages are not fetched
    -- here; the app does that.
    form_url          TEXT,

    -- The account, as its Instagram profile describes it.
    bio_link          TEXT,
    ig_full_name      TEXT,
    ig_biography      TEXT,
    ig_category       TEXT,
    ig_followers      INTEGER,
    -- The business contact address, or one written in the bio.
    ig_public_email   TEXT,

    -- The lead, when the account became one (NULL otherwise). lead_id is the
    -- prospector's own leads.id; prospector_leads is keyed on owner_handle.
    lead_id           BIGINT,
    brand_name        TEXT,
    domain            TEXT,
    myshopify_domain  TEXT,
    country           TEXT,
    contact_email     TEXT,
    is_agency         BOOLEAN,                    -- as classified in ops on prospector_leads
    lead_status       TEXT,
    -- true: a lead (the classifier took it for a brand; lead_status says what
    -- happened next). false: a rejected candidate - a person, an agency, a
    -- platform. NULL: the account was never judged.
    is_brand          BOOLEAN,

    -- When the row's content last changed (stamped by the trigger below, not
    -- by the publisher, so a tick that changes nothing changes no timestamp).
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The app's read: posted_at >= <since> ORDER BY posted_at DESC.
CREATE INDEX IF NOT EXISTS idx_prospector_creator_calls_posted_at
    ON prospector_creator_calls (posted_at DESC);
-- Per-account reads (a signal per brand, the daily check).
CREATE INDEX IF NOT EXISTS idx_prospector_creator_calls_owner
    ON prospector_creator_calls (owner_handle);
-- The single-post lookup is post_url ILIKE '*/<shortcode>*', which no btree
-- can serve; at a few hundred rows a scan is cheaper than a trigram index.

CREATE OR REPLACE FUNCTION prospector_creator_calls_stamp() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    NEW.updated_at := now();
  ELSE
    NEW.updated_at := OLD.updated_at;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prospector_creator_calls_stamp ON prospector_creator_calls;
CREATE TRIGGER trg_prospector_creator_calls_stamp
  BEFORE UPDATE ON prospector_creator_calls
  FOR EACH ROW EXECUTE FUNCTION prospector_creator_calls_stamp();

-- Service-role only, like the rest of the prospector tables: nothing here
-- should be reachable with an anon key.
ALTER TABLE prospector_creator_calls ENABLE ROW LEVEL SECURITY;
