-- admin_trial_grants: audit log for trial re-grants issued from the ops admin
-- /users page. Mirrors the shape of admin_impersonations.
--
-- Apply against the MAIN-APP Cloud SQL DB (NOT this repo's Supabase), in BOTH
-- prod and dev — the schema is symmetric so dev can be aligned. The endpoint
-- currently routes the audit insert to the same DB target as the brand UPDATE
-- (req.dbTarget), so dev-targeted grants record in dev, prod in prod.
--
-- No FK to ops_admins: that table only exists in prod, and the app already
-- validates admin identity before insert. admin_email + admin_id are sufficient
-- for the audit trail.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS admin_trial_grants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who granted it
  admin_id            uuid       NOT NULL,
  admin_email         text       NOT NULL,

  -- Target brand
  target_user_id      uuid       NOT NULL,
  target_email        text       NOT NULL,
  target_brand_id     uuid,

  -- Trial values written to brands (the "new" trial)
  plan                text       NOT NULL,
  days                integer    NOT NULL CHECK (days > 0),
  "interval"          text       NOT NULL CHECK ("interval" IN ('monthly','annual')),

  -- Previous trial state (for rollback / observability)
  previous_plan       text,
  previous_days       integer,
  previous_interval   text,
  previous_activation timestamptz,
  previous_expiration timestamptz,

  -- Which DB the brands row was written to (prod/dev). The audit row itself
  -- always lives in prod, matching admin_impersonations.
  target_db           text       NOT NULL CHECK (target_db IN ('prod','dev')),

  -- Free-text reason from the admin (optional)
  note                text,

  granted_at          timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_trial_grants_target_user ON admin_trial_grants(target_user_id);
CREATE INDEX IF NOT EXISTS idx_admin_trial_grants_granted_at  ON admin_trial_grants(granted_at DESC);
