-- Blog articles for www.linkable.link, managed from the ops app.
-- Lives in its own Supabase project (BLOG_SUPABASE_URL); apply with the
-- Supabase SQL editor or the Management API, not `supabase db push`.
--
-- blog_posts is the source of truth for every article on the marketing site.
-- The landing-page repo (Linkable-dev/linkable-landing-page) renders
-- published rows into static pages on a schedule and on demand; the daily
-- cron in this server writes one new AI-drafted article per day.
-- Rows with source = 'framer' mirror the posts that still live in Framer:
-- they are listed here so the admin UI shows the whole blog and so the
-- writer avoids duplicating them, but their pages are not rendered from
-- this table.

CREATE TABLE IF NOT EXISTS blog_posts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             TEXT NOT NULL UNIQUE,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',        -- meta description
  excerpt          TEXT NOT NULL DEFAULT '',        -- card / under-title teaser
  category         TEXT NOT NULL DEFAULT 'Guide',
  keyword          TEXT,                            -- target search phrase
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'published', 'archived')),
  source           TEXT NOT NULL DEFAULT 'manual'
                   CHECK (source IN ('ai', 'manual', 'framer')),
  author_name      TEXT NOT NULL DEFAULT 'Linkable Team',
  hero_image_id    TEXT,                            -- id in the landing site's image pool
  hero_image_alt   TEXT,
  blocks           JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{type:p|h2|h3|ul|ol|quote, text, items}]
  faqs             JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{q, a}]
  word_count       INTEGER NOT NULL DEFAULT 0,
  read_minutes     INTEGER NOT NULL DEFAULT 5,
  published_at     DATE,
  generation       JSONB,                           -- model, attempts, validation notes
  created_by       TEXT,                            -- ops admin email
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_blog_posts_status_date ON blog_posts(status, published_at DESC);

CREATE OR REPLACE FUNCTION blog_posts_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_blog_posts_updated_at ON blog_posts;
CREATE TRIGGER trg_blog_posts_updated_at
  BEFORE UPDATE ON blog_posts
  FOR EACH ROW EXECUTE FUNCTION blog_posts_set_updated_at();

-- Topic backlog the daily writer draws from. status: queued -> used.
CREATE TABLE IF NOT EXISTS blog_topics (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword     TEXT NOT NULL UNIQUE,
  angle       TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT 'Guide',
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'used', 'skipped')),
  position    INTEGER NOT NULL DEFAULT 0,
  post_id     UUID REFERENCES blog_posts(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only the service role (ops server, landing-site renderer) touches these.
ALTER TABLE blog_posts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE blog_topics ENABLE ROW LEVEL SECURITY;

-- Seed: the posts currently published from Framer (not rendered from here).
INSERT INTO blog_posts (slug, title, description, excerpt, published_at, hero_image_id, word_count, status, source)
VALUES
  ('creator-activation-playbook', 'How to activate creators and drive your first sales on Linkable', 'Linkable helps ecommerce brands collaborate with creators more effectively, from discovering the right partners to sending products, launching campaigns, and tracking real performance in one place.', 'A step-by-step playbook to turn accepted creators into active promoters and drive your first sales.', '2025-02-27', '', 706, 'published', 'framer'),
  ('creator-partnerships-that-sell', 'How Ecommerce Brands Can Build Creator Partnerships That Actually Drive Revenue', 'Linkable helps ecommerce brands collaborate with creators more effectively, from discovering the right partners to sending products, launching campaigns, and tracking real performance in one place.', 'A simple breakdown of what actually makes creator partnerships work, how to pick the right creators, track real performance, and turn content into sales.', '2025-11-28', '', 1063, 'published', 'framer'),
  ('launch-campaign-linkable', 'How to Launch Your First Creator Campaign on Linkable', 'Linkable helps ecommerce brands collaborate with creators more effectively, from discovering the right partners to sending products, launching campaigns, and tracking real performance in one place.', 'A step-by-step guide for Shopify brands launching their first creator campaign on Linkable.', '2025-12-05', '', 1212, 'published', 'framer'),
  ('leaked-discount-codes', 'The Hidden Cost of Uncontrolled Discount Codes', 'Linkable helps ecommerce brands collaborate with creators more effectively, from discovering the right partners to sending products, launching campaigns, and tracking real performance in one place.', 'A look at the hidden costs of traditional discount codes and the systems modern ecommerce brands are using to regain control.', '2025-01-15', '', 797, 'published', 'framer'),
  ('onboard-first-creators', 'How to Onboard Your First 10 Creators on Linkable', 'Linkable helps ecommerce brands collaborate with creators more effectively, from discovering the right partners to sending products, launching campaigns, and tracking real performance in one place.', 'This guide walks Shopify brands through the step-by-step process of onboarding their first 10 creators on Linkable.', '2026-02-06', 'ZnqzigwxjMB49H2WwyNeBgiGM', 758, 'published', 'framer'),
  ('tiktok-shop-vs-driving-traffic-to-shopify', 'TikTok Shop vs Driving Traffic to Shopify: What’s the Smarter Play for DTC Brands?', 'Linkable helps ecommerce brands collaborate with creators more effectively, from discovering the right partners to sending products, launching campaigns, and tracking real performance in one place.', 'Discover how to use TikTok as a high-performance distribution engine while maintaining control over margin, data, and creator attribution through Shopify.', '2025-01-18', 'oKC7eyfhhTpy1BKnKx3AXAE53iE', 676, 'published', 'framer')
ON CONFLICT (slug) DO NOTHING;

-- Seed: topic backlog.
INSERT INTO blog_topics (keyword, angle, category, position)
SELECT keyword, angle, category, row_number() OVER ()
FROM (VALUES
  ('how to find creators for your shopify brand', 'A repeatable sourcing process: applications first, then targeted discovery, then invitations; what to look for beyond follower counts.', 'Sourcing'),
  ('gifted vs paid creator collaborations', 'When free product is enough, when to add a fee, and how to move a creator from gifted to paid without overpaying.', 'Strategy'),
  ('creator brief template for ecommerce', 'What a one-page brief must contain so creators deliver usable content the first time; common mistakes that cause reshoots.', 'Playbook'),
  ('affiliate commission rates for creators', 'How to set a commission that creators take seriously while protecting margin; flat fee plus commission structures.', 'Strategy'),
  ('micro influencers for ecommerce brands', 'Why smaller creators often convert better, how many you need, and how to manage 20 of them without a spreadsheet.', 'Sourcing'),
  ('how to measure creator marketing roi', 'Separate content value, reach and tracked sales; what to attribute, what to accept you cannot, and what to compare against.', 'Measurement'),
  ('ugc vs influencer content for ads', 'The difference between content you licence for paid ads and posts on a creator''s own channel; how to ask for both.', 'Strategy'),
  ('product seeding campaign strategy', 'Seeding that produces posts instead of silence: selection, expectations, timing, follow-up.', 'Playbook'),
  ('creator marketing for skincare brands', 'Category specifics: routines, before-and-after rules, ingredient claims, which creators actually sell skincare.', 'By category'),
  ('creator marketing for supplement brands', 'Working within advertising rules, choosing credible creators, framing benefits without medical claims.', 'By category'),
  ('how many creators should a brand work with', 'A sizing model based on order volume and content needs rather than budget alone.', 'Strategy'),
  ('creator contract essentials for small brands', 'The handful of terms that matter (usage rights, exclusivity, deliverables, payment timing) explained without legalese; not legal advice.', 'Playbook'),
  ('q4 creator campaign timeline', 'Working back from Black Friday: when to recruit, ship product, approve content and turn on affiliate links.', 'Playbook'),
  ('how to get creators to actually post', 'Activation after acceptance: clear asks, deadlines, product arrival, gentle nudges, and knowing when to move on.', 'Playbook'),
  ('tiktok creators vs instagram creators for ecommerce', 'Which platform fits which product and goal; how creator behaviour differs; running both without doubling work.', 'Strategy'),
  ('creator whitelisting and spark ads explained', 'Running paid ads through a creator''s handle: what it is, what to agree upfront, when it beats brand ads.', 'Strategy'),
  ('discount codes vs affiliate links for creators', 'Tracking, leakage, customer experience and how to use both without cannibalising margin.', 'Measurement'),
  ('how to write a creator outreach message', 'Short, specific, respectful outreach that gets replies; what to include, what to leave out; examples written as templates.', 'Playbook'),
  ('creator marketing budget for small ecommerce brands', 'Where the money actually goes (product, fees, commission, tooling, time) and how to start under a fixed monthly amount.', 'Strategy'),
  ('repurposing creator content across channels', 'Turning one collaboration into product page content, emails, ads and social posts; rights and etiquette.', 'Playbook'),
  ('creator marketing for coffee and food brands', 'Consumables: repeat purchase, recipe content, sampling logistics, subscription hooks.', 'By category'),
  ('how to evaluate a creator before working with them', 'A 10-minute review: audience fit, past brand work, engagement quality, comment sentiment, red flags.', 'Sourcing'),
  ('long term creator partnerships vs one off posts', 'Why repeated collaborations compound, how to structure an ambassador arrangement, and when one-off still makes sense.', 'Strategy'),
  ('creator marketing mistakes ecommerce brands make', 'The recurring failures we see: vague briefs, follower obsession, no tracking, slow product, ghosting creators.', 'Strategy'),
  ('how to run a creator campaign on a shopify store', 'End to end for a first-timer: pick a product, define the offer, recruit, ship, approve, track, pay.', 'Playbook'),
  ('creator marketing for fashion and activewear brands', 'Fit and sizing content, styling videos, returns, seasonal drops, and which creators drive sales in apparel.', 'By category'),
  ('how to pay creators for ecommerce campaigns', 'Payment models compared, timing, what creators expect, and how to keep payouts painless.', 'Strategy'),
  ('creator content approval process', 'Approve fast without losing control: what to check, what to let go, turnaround expectations.', 'Playbook'),
  ('creator marketing kpis for ecommerce', 'A short list of metrics that matter at each stage, and the vanity metrics to stop reporting.', 'Measurement'),
  ('how to scale creator marketing without an agency', 'Systems over headcount: templates, tiers, automation, and when a managed service is the better call.', 'Strategy'),
  ('creator gifting etiquette for brands', 'What creators find respectful, what makes them decline, and how to make gifted product feel like a partnership.', 'Playbook'),
  ('creator marketing for home and lifestyle brands', 'Unboxing, room tours, seasonal moments, and slower purchase cycles.', 'By category'),
  ('how to brief creators on product claims', 'Keeping content accurate and compliant without writing scripts; disclosure basics; category-specific cautions.', 'Playbook'),
  ('creator applications vs outbound recruiting', 'Letting creators come to you versus going to them: cost, speed, quality and how to combine them.', 'Sourcing'),
  ('what creators want from ecommerce brands', 'The creator side: clear asks, fair pay, fast product, usage rights respected, a human to talk to.', 'Strategy'),
  ('creator marketing attribution problems', 'Why last-click undercounts creators, what tracked sales show, and how to make decisions with imperfect data.', 'Measurement')
) AS t(keyword, angle, category)
ON CONFLICT (keyword) DO NOTHING;
