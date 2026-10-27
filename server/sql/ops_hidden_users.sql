-- ops_hidden_users: creators an operator took off the ops Impersonation page
-- (test accounts, brands signed up as creators, junk). Ops-only: the main app
-- never reads it, so hiding someone here changes nothing for them or for
-- brands — Rule out is the action that does.
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
