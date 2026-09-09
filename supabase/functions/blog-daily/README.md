# blog-daily (Supabase Edge Function)

Writes the daily article for www.linkable.link.

## Why it lives here

Vercel's Hobby plan caps a function at 60 seconds. Writing an article takes 30 to
60, so a slow one timed out before anything was saved, and a near miss could
never be retried inside the budget. This function has far more room, so the
writer can use all three attempts plus the repair pass.

It imports `server/lib/blog-core.js`, the same module the ops Express server
uses, so the prompt, the validator and the repair pass exist in exactly one copy.
Only the runtime pieces are injected: the prompt data, `Deno.env`, the Supabase
client and the Pexels lookup.

`server/data/blog/{style.md,facts.md,images.json}` stay the source of truth. Deno
only ships files that something imports, so `npm run blog:build-data` bundles
them into `_shared/prompt-data.json`. A test fails if that bundle goes stale.

## Deploy

Needs a Supabase personal access token with access to the blog project
(`keyvdltgobrctfwnxebf`). Create one at
https://supabase.com/dashboard/account/tokens, then:

```bash
export SUPABASE_ACCESS_TOKEN=sbp_...
cd linkable-ops
npm run blog:deploy          # regenerates prompt-data.json, then deploys
```

Set the function's secrets once (the platform injects `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` already, and they point at the blog project):

```bash
npx supabase secrets set --project-ref keyvdltgobrctfwnxebf \
  BLOG_ANTHROPIC_API_KEY=sk-ant-... \
  PEXELS_API_KEY=... \
  BLOG_CRON_SECRET="$(openssl rand -hex 32)" \
  GITHUB_TOKEN=ghp_...        # optional, re-renders the site immediately
```

Deployed with `--no-verify-jwt` (the `blog:deploy` script does this). Supabase's
gateway otherwise rejects the request before the function runs, because it reads
`Authorization` as a JWT. The function does its own check on `x-blog-secret`.

## Switching generation over

Set these two in Vercel on the ops app, using the same secret:

```
BLOG_EDGE_URL=https://keyvdltgobrctfwnxebf.supabase.co/functions/v1/blog-daily
BLOG_CRON_SECRET=<the same value>
```

That is the whole switch. The existing Vercel cron at 07:00 UTC then only
*triggers* this function, which takes milliseconds, and Supabase does the work.
The "Generate with AI" button in the ops Blog page goes the same way. Unset
either variable and generation runs in the Node server again, which is what the
tests and local development do.

There is nothing to schedule on Supabase and no risk of two articles a day: the
trigger stays where it already is.

## Calling it

```bash
curl -X POST https://keyvdltgobrctfwnxebf.supabase.co/functions/v1/blog-daily \
  -H "x-blog-secret: $BLOG_CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"publish":false,"keyword":"optional, otherwise the next queued topic"}'
```

Body fields are all optional: `publish` (defaults true), `keyword`, `angle`,
`category`, `topicId`, `createdBy`.

## Running it locally

Verified with stock Deno in Docker rather than the Supabase CLI, which wants the
whole local stack:

```bash
docker run --rm -p 8137:8000 --env-file .env.local -v "$PWD":/app -w /app \
  denoland/deno:latest deno run --allow-all \
  --config supabase/functions/deno.json supabase/functions/blog-daily/index.ts
```

A run on 2026-09-09 produced a valid article on the first attempt in 35 seconds
for $0.037. The deployed function did the same in 37 seconds for $0.039.
