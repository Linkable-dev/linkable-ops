# Brand Outbound — Status & Operating Notes

Last updated: 2026-05-12

## What changed (May 2026 rewrite)

Four shipping priorities executed end-to-end. Reply-rate diagnosis identified three compounding issues: wrong target band, generic personalisation, no breakup touch, and cold/transactional mixing on the production domain. All four addressed.

### 1. ICP scoring at ingestion
Every brand pulled from Storeleads now gets a `brand_score` (0–10) on insert, based on revenue tier, vertical fit, creator-stack signal, recency, and email quality. The daily orchestrator only enrolls brands scoring **≥ 7**. Storeleads ingestion band widened from $50k–$100k/mo to **$80k–$2M/mo** (better fit for both active campaigns).

### 2. Sharper personalisation
Claude prompt rewritten to forbid LLM tells ("I came across", "I noticed", "love what you've built") and require a concrete reference per opener. Returns `NEEDS_REVIEW` when brand context is too thin. Generated observation stored on every `email_sends` row for reply-pattern analytics.

### 3. 4-touch sequence with T+12 breakup
Each prospect now receives 4 touches: T+0 / T+3 / T+7 / **T+12 (breakup)**. The breakup removes pressure ("I'll stop here — reply 'later' if it becomes a priority"). Historically the highest reply-rate-per-send slot. Sender inbox is **pinned at enrollment** so all 4 touches come from the same address — Gmail threads correctly, prospect sees one coherent sender.

### 4. Multi-domain sender pool
Cold outbound moves off `brand@linkable.link` onto a pool of lookalike-domain inboxes. First domain: **trylinkable.link** (Zoho mailboxes, Resend send, SPF/DKIM/DMARC pass). Replies route back to `brand@linkable.link` via Reply-To header — existing inbound parser unchanged. Per-inbox daily caps with least-used rotation.

### 5. Warmup agent
Custom 2-week ramp agent sends 3 → 10 conversational emails/day per warming inbox to a seed list of friendly addresses. Claude generates varied content (topics rotate per send), templates as fallback. Piggybacks on the existing `auto-discover` cron (no new Vercel slot needed). Idempotent — re-runs same day top up to target.

---

## Current state (2026-05-12)

| Component | Status |
|-----------|--------|
| All 4 priorities + warmup agent | **Deployed to main** (Vercel) |
| Migrations 010 / 011 / 012 / 013 | Applied |
| Brand pool scored | 43,486 brands |
| T4 templates seeded into campaigns | Both active campaigns |
| trylinkable.link DNS (SPF/DKIM/DMARC/MX) | All passing |
| 4 Zoho mailboxes (luca / federico / growth / brand) | Created with display names |
| Resend trylinkable.link domain | Verified |
| Sender pool seeded | 4 inboxes, all `is_warming=true`, `is_active=false` |
| Warmup ramp Day 0 | Fired 2026-05-12 (12 emails out) |
| Outbound cron Mon–Fri 09:00 UTC | Scheduled, currently still using legacy `brand@linkable.link` |
| AI auto-reply (UK Beauty 100k-500k) | Active, replies as Federico Soressi from `brand@linkable.link` |

## Timeline

- **2026-05-12 → 2026-05-26** — Warmup window. Daily replies required (~5–30 min/day depending on day-of-ramp).
- **2026-05-26** — Graduation day. Flip all 4 inboxes to `is_active=true`. Real cold outbound starts routing through them at 160/day total capacity.
- **+2 weeks post-graduation** — first meaningful reply-rate data on the new system.

## Known open issues (pre-graduation work)

1. **Brand pool currently starved.** Pre-rewrite ingestion only pulled $50k–$100k/mo, which doesn't match either campaign's target. Run `node server/automation/run-storeleads.js` during warmup to refresh.
2. **US Beauty 1M-3.5M campaign** — ingestion caps at $2M; campaign wants $1M–$3.5M. Decide whether to widen ingestion to $5M or tighten the campaign to $1M–$2M.
3. **`CRON_SECRET` pending rotation.**

## How to operate

- **New cold campaigns** — create via existing UI; G1/G2/G3 templates auto-seed including T4. Set `target_filters` revenue band within $80k–$2M to match ingestion (or widen ingestion further).
- **Pause an inbox** — `UPDATE sender_inboxes SET is_active=false WHERE email='...'`. In-flight pinned sequences finish on whatever they were pinned to.
- **Watch deliverability** — bounce rate per inbox via `email_sends.status='bounced' GROUP BY sender_email`. Above 5% → take that inbox offline.
- **Reply triage** — UK campaign auto-replies via existing conversation runner. US campaign is manual. Both land in `brand@linkable.link`.
- **Warmup is automated** — runs daily via the auto-discover cron. Team's only job is replying to the warmup emails landing in seed accounts.

## Architecture reference

- Score gate: `server/automation/brand-scoring.js`
- Sender rotation: `server/automation/sender-pool.js`
- 4-touch enrollment: `server/automation/sequencer.js`
- Personalisation prompt: `server/automation/personalize.js`
- Warmup agent: `server/automation/warmup-agent.js`
- Domain setup runbook: `docs/SENDER_SETUP.md`
