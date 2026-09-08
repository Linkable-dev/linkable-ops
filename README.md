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
  publishes it (`?draft=1` to save as draft instead).
- The website is rendered from the database by the landing-page repo
  (`Linkable-dev/linkable-landing-page`, workflow `blog-sync.yml`, every two hours). "Publish to site" and every
  publish trigger an immediate rebuild when `GITHUB_TOKEN` (a token with `repo` scope on that repo) is set on this
  server; otherwise changes go live at the next scheduled sync.
- Hero photos: each article gets a topical stock photo from Pexels (`PEXELS_API_KEY`; `server/lib/blog-images.js`),
  chosen by the writer's image query or searched in the editor. Without the key the static pool in
  `server/data/blog/images.json` is used. Schema addition: `server/sql/blog/002_hero_image.sql`.
- Environment variables: `BLOG_SUPABASE_URL`, `BLOG_SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `CRON_SECRET`,
  `PEXELS_API_KEY`, optional `GITHUB_TOKEN` and `LANDING_REPO`.
