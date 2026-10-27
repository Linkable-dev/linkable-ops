-- ops_hidden_users: creators an operator took off the ops Impersonation page
-- (test accounts, brands signed up as creators, junk). The main app leaves
-- them out of the brands' Discover too (linkable #542, which also creates this
-- table at boot). They can still apply to campaigns: Rule out stops that.
--
-- Apply against the MAIN-APP Cloud SQL DB (NOT this repo's Supabase), in BOTH
-- prod and dev; the Creators list joins it on whichever target is selected.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS ops_hidden_users (
  user_id    uuid        PRIMARY KEY,
  hidden_by  text        NOT NULL DEFAULT '',
  hidden_at  timestamptz NOT NULL DEFAULT NOW()
);
