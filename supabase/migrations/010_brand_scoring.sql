-- ICP scoring for storeleads_brands.
-- brand_score (0..10) is computed at ingestion (run-storeleads.js) and read
-- by the orchestrator (run-daily-200.js) to gate the daily fetch — only
-- brands scoring >= MIN_SEND_SCORE (7) get enrolled into sequences.
--
-- breakdown holds the per-component points so we can debug why a brand
-- scored what it did and tune weights later from real data. scored_at
-- lets us re-score stale rows on a cadence (raw_data evolves as
-- StoreLeads updates merchants).

ALTER TABLE storeleads_brands
  ADD COLUMN IF NOT EXISTS brand_score SMALLINT,
  ADD COLUMN IF NOT EXISTS brand_score_breakdown JSONB,
  ADD COLUMN IF NOT EXISTS scored_at TIMESTAMPTZ;

-- Partial index: only rows that pass the gate need to be ordered by score.
-- Most brands will score < 7; indexing the long tail wastes space.
CREATE INDEX IF NOT EXISTS idx_storeleads_brand_score_sendable
  ON storeleads_brands(team_id, brand_score DESC, imported_at DESC)
  WHERE brand_score >= 7
    AND contact_used = false
    AND email IS NOT NULL
    AND contact_first_name IS NOT NULL;
