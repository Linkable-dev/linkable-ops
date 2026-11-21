-- Outside agents: what was found outside the platform, the reply or email
-- drafted for it, and what a person did with it.
--
-- Three kinds of row:
--   signal   a public post (LinkedIn, Reddit, TikTok, X, Facebook, Threads,
--            YouTube) where a brand asks for creators or a creator asks for
--            brands. Found by linkable-prospector's worker (outside.py), once
--            a day, through web search.
--   partner  the site of someone who already has the audience (a creator
--            community, a newsletter, an agency, a coach), with a contact
--            address when their site shows one. Same worker.
--   post     a post for Linkable's own accounts, written here from the day's
--            blog article (server/lib/outside-agents.js).
--
-- The worker inserts and never updates: a row that exists keeps its draft and
-- its state, which are written here by ops. Nothing in this table is posted
-- or sent by a machine; a person copies the draft and posts or sends it.
CREATE TABLE IF NOT EXISTS prospector_outside_items (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- The post, the partner's site, or for a post of ours the article it is
    -- from plus "#<platform>". One row each.
    url            TEXT NOT NULL UNIQUE,
    kind           TEXT NOT NULL CHECK (kind IN ('signal', 'partner', 'post')),
    -- brand | creator (who is asking), or partner.
    side           TEXT,
    -- signal/post: the platform. partner: community | newsletter | agency | coach.
    platform       TEXT,
    title          TEXT,
    snippet        TEXT,
    query          TEXT,
    email          TEXT,
    posted_at      TIMESTAMPTZ,
    found_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    draft_subject  TEXT,
    draft_text     TEXT,
    drafted_at     TIMESTAMPTZ,
    draft_cost_usd NUMERIC,

    state          TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'done', 'dismissed')),
    acted_at       TIMESTAMPTZ,
    acted_by       TEXT,
    meta           JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_prospector_outside_items_queue
    ON prospector_outside_items (kind, state, found_at DESC);

ALTER TABLE prospector_outside_items ENABLE ROW LEVEL SECURITY;
