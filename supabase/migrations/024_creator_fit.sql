-- What the creator ranking produces, so ops can sort and explain a queue.
--
-- brands_seen is the evidence: the brands this creator actually posted about,
-- by name. prospector_creators carried a count and one example handle chosen by
-- MAX(), neither of which can answer "has this creator posted about anything
-- like what this campaign sells" - the only question that makes a ranking
-- campaign-specific.
--
-- fit_* is the last answer, not a property of the creator: one score, and as
-- many fits as there are campaigns.
ALTER TABLE prospector_creators
    ADD COLUMN IF NOT EXISTS brands_seen  TEXT,
    ADD COLUMN IF NOT EXISTS fit_score    REAL,
    ADD COLUMN IF NOT EXISTS fit_campaign TEXT,
    ADD COLUMN IF NOT EXISTS fit_reason   TEXT;

CREATE INDEX IF NOT EXISTS idx_prospector_creators_fit
    ON prospector_creators(fit_campaign, fit_score DESC);
