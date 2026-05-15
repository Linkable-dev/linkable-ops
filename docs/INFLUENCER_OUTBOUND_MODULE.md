# Influencer Outbound — How It Works

Mirror of the brand outbound module, retargeted at creators. Pulls creator
prospects from the main-app `influencers` table (or a future scraper),
scores them, runs a 4-touch sequence on a tier-aware template matrix, and
isolates the sender pool so brand and creator outbound never share inboxes.

## The flow

**1. Find creators.** A sync job copies eligible creators from the main-app
`influencers` table into `creator_prospects`. Each row gets a 0–10 score
based on followers, engagement, completeness, and email quality. Only score
6+ goes anywhere near the send pipeline.

**2. Tier them.** Each creator falls into one of three tiers by follower
count: C1 Macro (200k+), C2 Mid (10k–200k), C3 Micro (<10k). Tier sets the
language register; the campaign's brief sets the pitch (acquisition / brand
collab / re-activation).

**3. Write the email.** Claude looks at the creator's niche, scale, and
geography, then writes a one-sentence observation that proves a human
looked at them. The rest of the email is templated by tier and touch.

**4. Send a 4-touch sequence.** Each prospect gets four emails over 12
days: T+0 (hook), T+3 (different angle), T+7 (final ask), T+12 (breakup).
All four come from the same sender so the prospect sees one coherent
thread. Sender comes from the influencer-tagged pool — separate from the
brand sender pool, separate reputation.

**5. Reply triage.** When a creator replies, the sequence stops
automatically. Reply routing is the same as brand outbound — webhook
parses the inbound, `cancelPendingTouches` halts future sends.

## Where things live

- **Daily orchestrator:** `server/automation/run-daily-influencer.js`
- **Sync from main app:** `node server/automation/sync-creators.js` (CLI)
  or `POST /api/outbound/creators/sync`
- **Prospect pool:** `creator_prospects` table
- **Templates:** `server/automation/creator-templates.js`
  (12 default templates: C1/C2/C3 × T1-T4)
- **Tier classifier:** `server/automation/creator-groups.js`
- **Scoring:** `server/automation/creator-scoring.js` (source-aware:
  main-app rows score on followers/engagement, bio-mined rows score on
  email + completeness)
- **Sender pool partitioning:** new `sender_inboxes.sender_pool_tag`
  column. Influencer campaigns get `sender_pool_tag='influencer'`; brand
  campaigns stay `NULL`.
- **Web-search bio mining:** `server/automation/creator-search.js`
  (search-backend abstraction; default = DuckDuckGo HTML scrape, no key
  required) + `server/automation/creator-bio-extract.js` (Linktree/Beacons
  → email + IG handle + display name).

## Sources

The sync layer is pluggable — every source yields the same `creator_prospects`
shape, scored at insert time. Today there are two:

| Source | Provider | Coverage | Email yield | Cost |
|--------|----------|----------|-------------|------|
| `main_app` | `mainAppProvider` (CloudSQL → `influencers` table) | Existing platform creators | 100% (only synced when present) | Free |
| `bio_mining` | `bioMiningProvider` (search → Linktree/Beacons → bio extract) | Public web | ~10-20% per candidate URL | DuckDuckGo HTML (free, no key) |

**Adding a new source:** drop a new `xxxProvider({...})` factory into
`server/automation/creator-source.js` that returns
`{ name, async fetch({ limit, offset, sinceTs }) → { rows, hasMore } }`,
register it in `getProvider()`, and call
`node sync-creators.js --source xxx`. Each row needs at minimum
`{ source, source_id, email }` — the rest fall into the optional bucket.

## Bio mining — quick start

Discovers creators by searching Linktree / Beacons / similar bio
platforms for public pages in your target niches, fetches each page, and
extracts the email + IG handle. Bio-mined creators land in
`creator_prospects` with `source='bio_mining'` and score 6-8 when basic
data extracts cleanly, so they're enrollable through the same daily runner.

**Setup:** none — default backend is DuckDuckGo HTML scraping (no key,
no signup). To swap in Brave Search API instead (paid), set
`BRAVE_SEARCH_API_KEY` in `server/.env` and pass `--search-backend brave`.

**Run:**
```bash
# Smallest useful run: 1 niche × 4 default sites × 1 page = up to 80 URLs to fetch
node server/automation/sync-creators.js --source bio_mining \
  --niche "beauty creator" --limit 50

# Wider sweep: multiple niches, 2 pages per (niche × site) = up to 320 URLs/niche
node server/automation/sync-creators.js --source bio_mining \
  --niche "beauty creator" --niche "skincare blogger" --niche "fashion micro influencer" \
  --search-pages 2 --limit 300

# Restrict the bio sites to mine
node server/automation/sync-creators.js --source bio_mining \
  --niche "wellness coach" \
  --site-pattern linktr.ee --site-pattern beacons.ai \
  --limit 100
```

**What you'll see in the pool:** rows with `source='bio_mining'`,
`followers_count=NULL`, `engagement_rate=NULL`,
`creator_score_breakdown.mode='bio_mined'`. The bio-mined scoring path
gives them 6-8 (vs 4-7 for typical main-app rows), so they pass the gate
on email-validity + first-name + niche alone.

**Quality watch-outs:**
- The same Linktree URL may surface under multiple niches — the upsert
  on `(source, source_id)` dedupes; only the first niche to find them sticks.
- Email extraction yield is roughly 10-20% per candidate URL (most bios
  link to a contact form, not a mailto). The provider drops the rest.
- No follower / engagement signal — if you want to enroll only mid-tier
  bio-mined creators, you'd need a second-pass enrichment (Apify / Modash)
  to fill `followers_count` before re-scoring.

## Setup checklist (one-time)

1. **Apply migration 014.** Adds `audience_type` to email_campaigns / sends
   / templates, `sender_pool_tag` to email_campaigns / sender_inboxes, and
   creates `creator_prospects`.
2. **Provision the influencer sender inbox.** Verify `influencer@trylinkable.link`
   in Resend, then insert the row:
   ```sql
   INSERT INTO sender_inboxes
     (team_id, email, from_name, reply_to, domain, sender_pool_tag,
      daily_cap, warming_cap, is_active, is_warming)
   VALUES
     ('<team-uuid>', 'influencer@trylinkable.link', 'Federico from Linkable',
      'influencer@linkable.link', 'trylinkable.link', 'influencer',
      40, 10, true, true);
   ```
   Warm for 2 weeks (is_warming=true, warming_cap=10) before flipping
   `is_warming=false`.
3. **Run the first sync.** `node server/automation/sync-creators.js`
   (defaults: source=main_app, target=prod, page_size=500). Watch for
   `inserted` / `updated` counts. Re-running is idempotent — upserts on
   `(team_id, source, source_id)`.
4. **Create the first campaign** via the AI Campaigns UI. Toggle the
   "Influencer outbound" audience pill at the top of the create form.
   Default seed = 12 creator-tier templates (C1/C2/C3 × T1-T4). Edit per-slot
   or hit "AI rewrite" to riff on the campaign brief.

## Two things to know if you touch this

- **Don't email a creator twice.** The system tracks `contact_used` and
  refuses duplicates automatically. The dedupe is on email, not on
  source_id, so a creator who shows up in two source providers (main app +
  scraper) still gets enrolled once.
- **Don't tag the brand inboxes as 'influencer'.** Sender pool partitioning
  is enforced at send time — if you tag the wrong inbox, brand sends will
  silently start going through it (or vice versa) and reply triage will
  mix audiences.

## When something looks wrong

- **No emails going out** → check `creator_prospects` count where
  `creator_score >= 6 AND contact_used = false`. If 0, run the sync.
- **All deferred** → influencer-tagged inboxes hit cap. Add more inboxes
  with `sender_pool_tag='influencer'` or raise their `daily_cap` /
  `warming_cap`.
- **Wrong sender** → check that the campaign's `sender_pool_tag` matches
  at least one inbox's `sender_pool_tag`.
- **Reply rate dropping** → check spam-folder placement on the influencer
  inbox first, not the system.

## Active campaigns

| Campaign | Audience | Notes |
|----------|----------|-------|
| _(create your first influencer campaign in the UI)_ | – | – |

For the full technical breakdown, see the code in `server/automation/`.
