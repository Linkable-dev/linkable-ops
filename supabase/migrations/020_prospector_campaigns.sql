-- Prospecting campaigns: a goal, a budget, and the opinion to stop.
--
-- Same shape as the outbound agents next door, because it is the same problem:
-- a list of filters somebody drives every morning has no view on whether it has
-- already done its job, and a goal does.
--
-- The pipeline owns everything except `desired_state`, which is how someone in
-- ops says start or hold without racing the runner's own state.
CREATE TABLE IF NOT EXISTS prospector_campaigns (
    id               BIGSERIAL PRIMARY KEY,
    name             TEXT NOT NULL UNIQUE,

    -- What the runner reports.
    state            TEXT NOT NULL DEFAULT 'off',   -- off | running | done | failed
    -- What a person asked for. The runner reconciles towards it.
    desired_state    TEXT NOT NULL DEFAULT 'off',   -- off | running

    goal_leads       INTEGER NOT NULL DEFAULT 20,
    goal_tiers       TEXT NOT NULL DEFAULT 'A',
    budget_usd       REAL NOT NULL DEFAULT 5.0,

    source           TEXT NOT NULL DEFAULT 'creator_calls',
    hashtags         TEXT,
    seeds            TEXT,
    countries        TEXT,

    leads_found      INTEGER NOT NULL DEFAULT 0,
    spent_usd        REAL NOT NULL DEFAULT 0.0,
    passes           INTEGER NOT NULL DEFAULT 0,
    last_run_at      TIMESTAMPTZ,
    last_error       TEXT,
    stopped_reason   TEXT,

    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    synced_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prospector_campaigns_state ON prospector_campaigns(state);

-- One row per pass, so the page can show what happened rather than only where
-- things ended up.
CREATE TABLE IF NOT EXISTS prospector_campaign_runs (
    id            BIGSERIAL PRIMARY KEY,
    campaign_name TEXT NOT NULL,
    started_at    TIMESTAMPTZ NOT NULL,
    finished_at   TIMESTAMPTZ,
    found         INTEGER NOT NULL DEFAULT 0,
    spent_usd     REAL NOT NULL DEFAULT 0.0,
    actor_runs    INTEGER NOT NULL DEFAULT 0,
    error         TEXT,
    UNIQUE (campaign_name, started_at)
);

CREATE INDEX IF NOT EXISTS idx_prospector_runs_campaign ON prospector_campaign_runs(campaign_name);

ALTER TABLE prospector_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospector_campaign_runs ENABLE ROW LEVEL SECURITY;
