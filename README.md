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
