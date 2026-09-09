# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

## Blog (articles on www.linkable.link)

Articles live in their own Supabase project (`BLOG_SUPABASE_URL`, tables `blog_posts` and `blog_topics`; schema in
`server/sql/blog/001_blog_posts.sql`, apply it with the Supabase SQL editor or Management API). The **Blog** section of
the ops app (CMS module) lists, edits, creates, publishes and deletes articles, keeps a topic backlog, and can draft an
article with Claude (`server/lib/blog-writer.js`: voice rules in `server/data/blog/style.md`, allowed facts in
`server/data/blog/facts.md`, hero images in `server/data/blog/images.json`). Every draft is validated against those
rules before it is saved.

- Daily article: Vercel cron hits `GET /api/cron/blog-daily` at 07:00 UTC, writes one article from the backlog and
  publishes it (`?draft=1` to save as draft instead). Model `BLOG_MODEL` (default `claude-sonnet-5`), budget
  `BLOG_MAX_COST_USD` (default 0.10) per article including retries; if the budget runs out before a draft passes
  validation, the best draft is saved unpublished for review. Articles are capped at a six-minute read.
- The website is rendered from the database by the landing-page repo
  (`Linkable-dev/linkable-landing-page`, workflow `blog-sync.yml`, every two hours). "Publish to site" and every
  publish trigger an immediate rebuild when `GITHUB_TOKEN` (a token with `repo` scope on that repo) is set on this
  server; otherwise changes go live at the next scheduled sync.
- Hero photos: each article gets a topical stock photo from Pexels (`PEXELS_API_KEY`; `server/lib/blog-images.js`),
  chosen by the writer's image query or searched in the editor. Without the key the static pool in
  `server/data/blog/images.json` is used. Schema addition: `server/sql/blog/002_hero_image.sql`.
- Environment variables: `BLOG_SUPABASE_URL`, `BLOG_SUPABASE_SERVICE_ROLE_KEY`, `BLOG_ANTHROPIC_API_KEY` (dedicated key
  for article generation; falls back to `ANTHROPIC_API_KEY`), `CRON_SECRET`, `PEXELS_API_KEY`, optional `GITHUB_TOKEN`
  (fine-grained token with Contents: read/write on the landing repo, used for `repository_dispatch`) and `LANDING_REPO`.

## Alerts: sending the nudge

The **Alerts** page can write and send the chase email for an alert instead of
just handing the operator an address to copy. **Send nudge** on any alert row
drafts the email server-side from the alert's own facts plus a slice of Brand
360 (`server/lib/nudge-writer.js`), shows it for review, and sends it on
approval through Resend (`server/lib/nudge-mailer.js`). Sending marks the alert
done by default; it returns on its own if the brand still hasn't acted and the
situation changes.

- Nothing the browser sends reaches the prompt or the recipient: the alert is
  re-derived from its key on both `POST /api/insights/alerts/draft` and
  `/send`, so a forged alert body cannot send mail from a linkable.link
  address. The operator's edits to the subject and body are trusted — a human
  wrote them — but the recipient never is.
- Sent nudges are recorded in `ops_brand_nudges` (created on first use, beside
  `ops_alert_dismissals`) and shown on the alert, so the whole team can see a
  brand has already been chased today.
- The mailer is deliberately separate from `server/automation/send.js`: that
  one is built for cold outreach and rewrites links into a "Book a demo" CTA,
  stamps `List-Unsubscribe`, and suppresses Gmail threading — all wrong for a
  service email to an existing customer.
- Environment variables: `NUDGE_FROM` (default `Linkable <brand@linkable.link>`)
  and `NUDGE_REPLY_TO`. Both must be on a Resend-verified domain; the default
  is the address the team already triages replies in. Drafting uses
  `ANTHROPIC_API_KEY` at roughly half a cent per draft.
## Outbound revenue attribution

`server/lib/outbound-attribution.js` joins the outbound machine to the revenue
it produced. Prospects and sends live in Supabase, customers and subscriptions
in Cloud SQL, and there is no key between them, so the join is made on the two
things both sides record: the shop's domain and the contact's email address. A
signup counts only when it came *after* the first email to that brand;
everything else is reported separately as "already customers".

- `GET /api/outbound/attribution` — the funnel (sends → contacted → signed up →
  paying → MRR) plus splits by segment, sender and template. Shown at the top of
  the Outbound page.
- `POST /api/outbound/attribution/refresh` — recompute now. Also runs on the
  daily outbound cron tick, where a failure is logged rather than raised so it
  can never block a send.
- Results are cached in `ops_outbound_conversions` (Cloud SQL, created on first
  use beside the app's other ops-owned tables).
- `normalizeDomain()` is the join. Its behaviour is pinned by unit tests, since
  a drift there would report zero conversions with nothing else failing.
## Filling an empty campaign

`server/lib/campaign-matchmaking.js` ranks the creator base against one
campaign. "No applications" is one of the three quick filters on Campaign
Operations — a known way for a campaign to die, and the only one the console
could find but not act on.

`GET /api/ops/campaigns/:id/creator-matches` scores every creator not already
attached to that campaign out of 100: niche fit (35, brands and creators pick
from the same vocabulary), track record (25, accepted before / has sold),
audience (20, reach discounted at the dead-follower end and weighted by
engagement), whether a sample can physically reach them (10) and how recently
they signed in (10). Every ranking carries the reasons behind it. The **Find
creators** button in the Bottleneck column opens the shortlist.

It is read-only and invites nobody: sending invitations writes to `links` and
notifies creators, so that stays a deliberate, separate step.

Two things the data makes non-obvious, both pinned by tests:
`brands.location` is not a country but the pipe-separated list of ISO-2 codes
the brand ships to (sometimes thousands of characters, `*` for everywhere),
while creators store a full country name — comparing them directly awards
nothing on the 12 of 13 active campaigns that ship a sample.
## Brand health, churn radar and trial ranking

`server/lib/brand-health.js` scores every active brand out of 100 — do they log
in, is there a live campaign, did creators join it, are accepted samples going
out, is any of it selling — and turns that into the two lists on **Brand
health** (`/health`):

- **Churn radar** — the paying base, worst first, with a falling score ranked
  above a merely low one.
- **Trial ranking** — trials most likely to convert first, so limited hours go
  to the right ten rather than to all of them equally.

`GET /api/insights/health` computes it live. `POST /api/insights/health/snapshot`
records the day's scores into `ops_brand_health`, which the daily
`auto-discover` cron also does: a direction needs yesterday's number, and the
level alone says much less than the change.

A missing signal never counts against a brand — nothing outstanding to ship
scores as fulfilled, not as failed — and a frozen payment is always the first
risk an operator is shown, because it locks the app for the customer.
## Sender deliverability

`server/lib/deliverability.js` replaces the runbook line "watch bounce rate per
inbox, above 5% take it offline" — a human remembering to run a query — with a
check on the outbound cron. It runs **before** senders are picked, so a burning
inbox is out of the pool for that tick rather than after it.

Thresholds over a 14-day window: bounce rate above 5%, or complaint rate above
0.3% (mailbox providers start filtering there, well before bounces look
alarming). An inbox with fewer than 25 sends in the window is never judged — one
bounce out of three is 33% and means nothing.

The asymmetry is the safety property, and is covered by tests: this pauses an
inbox on its own and **never** resumes one. Pausing costs part of a day's send
capacity; resuming into a reputation problem costs the domain. Turning an inbox
back on is deliberate and manual.

`GET /api/outbound/inbox-health` reports every inbox with its verdict, and both
an at-risk and an auto-paused inbox raise an alert under **Sending** — a log
nobody reads is not a safeguard.

## The morning brief

`server/lib/morning-brief.js` is the one push in an otherwise pull-only
console: everything else waits for somebody to remember to open it. Emailed to
every `ops_admins` address (or `BRIEF_TO` if set) at 06:30 UTC on weekdays.

The rule it follows is that every line names something — a brand, a campaign,
a number that moved. Danger alerts with the brand attached, creators waiting on
a sample nobody sent, paying brands whose health score fell overnight, what
arrived in the last 24 hours, and any sending inbox in trouble. A digest of
totals with no names in it is the kind nobody reads twice.

Links point at `OPS_URL`, falling back to Vercel's injected production domain.
With neither set the brief prints no links rather than guessing a host.
`GET /api/cron/morning-brief?dry=1` renders it without sending.

## Chasing brands automatically

`server/lib/auto-nudge.js` lets the safe alert kinds chase a brand with no
operator in the loop. **Everything is off until somebody turns it on**, per
kind, from *Automatic* on the Alerts page — a fresh database sends nothing.

Only `shipping`, `applications` and `sales` can ever be automated; anything
touching money, a trial or an account is not offered, and the emailable
allow-list refuses it a second time inside the selector. Ceilings that apply
whatever the rules say: at most 10 brands a run, a brand hears from it at most
once every 7 days however many alerts it accumulates, and an alert is only
chased once it has been open long enough for a human to have got there first.
Marking an alert done or snoozing it stops the robot on that alert.

An automatic nudge is indistinguishable from a hand-sent one afterwards except
by `by_email` on `ops_brand_nudges` — both go through the same
`sendBrandNudge()`, land in the same log, and close the same alerts.
