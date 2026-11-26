import { cloudSqlQuery } from "./cloudsql.js";

// The creator sign up, step by step (main app hooks.server.ts, C1): she signs
// in with a code or Google, gives her name (C1c), her main account, Instagram
// or TikTok (C1d to C1f), then "Almost done" (C1g) finishes the sign up
// (users.status 7). After it the sign up checks let her in or keep her on
// "You're on the list" (creator_gate).
//
// Who counts: creators who signed in themselves in the period, dated by their
// first own sign in. Impersonation tokens are not hers. An account a brand's
// invite or our outreach made that she never took up (status 1, no sign in)
// is not a sign up at all and is counted apart (`invited`); once she signs in
// it joins the funnel on that day, already carrying the name and handle the
// invite copied in.
//
// Each creator has reached one step, the furthest she got. A step's count is
// everyone who got at least that far.

export const FUNNEL_STEPS = [
  { key: "signed_in", label: "Signed in", hint: "With a code or Google" },
  { key: "named", label: "Name", hint: "Gave her name" },
  { key: "account", label: "Main account", hint: "Instagram or TikTok handle" },
  { key: "finished", label: "Almost done", hint: "Sign up finished" },
  { key: "let_in", label: "Let in", hint: "Passed the sign up checks, or approved by us" },
];

// The step after the one she reached is where she stopped.
export const STOPPED_AT = { named: 1, account: 2, finished: 3, let_in: 4 };

export const FUNNEL_PERIODS = [7, 30, 90];

export function funnelDays(raw) {
  const n = Number(raw);
  return FUNNEL_PERIODS.includes(n) ? n : 30;
}

// $1 = days. One row per creator in the funnel, with the step she reached.
// Her first own sign in, read once per sub and per email (hash joins), not
// once per creator: the correlated form took 4 s on prod.
const OWN_TOKENS = `(t.state IS NULL OR t.state NOT LIKE 'admin_impersonation:%')`;
const COHORT_SQL = `
  WITH by_sub AS (
    SELECT t.sub, MIN(t.created) AS first FROM tokens t
     WHERE COALESCE(t.sub, '') <> '' AND ${OWN_TOKENS} GROUP BY t.sub
  ), by_email AS (
    SELECT t.email, MIN(t.created) AS first FROM tokens t
     WHERE COALESCE(t.email, '') <> '' AND ${OWN_TOKENS} GROUP BY t.email
  ), base AS (
    SELECT u.id AS user_id, u.email, u.status, u.created,
           LEAST(bs.first, be.first) AS first_sign_in,
           COALESCE(TRIM(i.first_name), '') AS first_name,
           COALESCE(TRIM(i.last_name), '') AS last_name,
           NULLIF(NULLIF(REGEXP_REPLACE(TRIM(COALESCE(i.instagram_username, '')), '^@+', ''), ''), 'undefined') AS instagram_username,
           (SELECT NULLIF(TRIM(s.username), '') FROM creator_social_accounts s
             WHERE s.creator_user_id::text = u.id::text AND s.platform = 'tiktok' LIMIT 1) AS tiktok_username,
           COALESCE(cg.verdict = 'failed' OR (cg.gated AND cg.verdict <> 'passed'), false) AS held,
           COALESCE(cg.checks, '[]'::jsonb) AS gate_checks
      FROM users u
      LEFT JOIN influencers i ON i.user_id = u.id AND i.deleted = '-infinity'::timestamptz
      LEFT JOIN creator_gate cg ON cg.user_id = u.id
      LEFT JOIN by_sub bs ON COALESCE(u.sub, '') <> '' AND bs.sub = u.sub
      LEFT JOIN by_email be ON be.email = u.email
     WHERE u.role = 3 AND u.deleted = 'infinity'::timestamptz
  ), cohort AS (
    SELECT b.*,
           COALESCE(b.first_sign_in, b.created) AS started_at,
           CASE
             WHEN b.status = 7 AND NOT b.held THEN 5
             WHEN b.status = 7 THEN 4
             WHEN b.instagram_username IS NOT NULL OR b.tiktok_username IS NOT NULL THEN 3
             WHEN b.first_name <> '' THEN 2
             ELSE 1
           END AS reached
      FROM base b
     WHERE b.first_sign_in IS NOT NULL OR b.status = 7
  )`;

const IN_PERIOD = `started_at >= now() - make_interval(days => $1::int)`;

// The sign up checks she failed, by title ("1,000 followers"). The category
// check no longer holds anyone back (main app #576), so it is left out.
const FAILED_CHECKS = `jsonb_array_elements(gate_checks) c
  WHERE c ->> 'state' = 'fail' AND c ->> 'key' <> 'category'`;

export async function signupFunnel(days) {
  const [steps, invited, held] = await Promise.all([
    cloudSqlQuery(
      `${COHORT_SQL}
       SELECT COUNT(*)::int AS signed_in,
              COUNT(*) FILTER (WHERE reached >= 2)::int AS named,
              COUNT(*) FILTER (WHERE reached >= 3)::int AS account,
              COUNT(*) FILTER (WHERE reached >= 4)::int AS finished,
              COUNT(*) FILTER (WHERE reached >= 5)::int AS let_in
         FROM cohort WHERE ${IN_PERIOD}`,
      [days],
    ),
    cloudSqlQuery(
      `${COHORT_SQL}
       SELECT COUNT(*)::int AS n FROM base
        WHERE status = 1 AND first_sign_in IS NULL
          AND created >= now() - make_interval(days => $1::int)`,
      [days],
    ),
    // Why the checks held them back. One creator can fail several.
    cloudSqlQuery(
      `${COHORT_SQL}
       SELECT c ->> 'title' AS title, COUNT(*)::int AS count
         FROM cohort CROSS JOIN LATERAL ${FAILED_CHECKS}
          AND ${IN_PERIOD} AND reached = 4
        GROUP BY 1 ORDER BY 2 DESC, 1`,
      [days],
    ),
  ]);
  const row = steps.rows[0] || {};
  return {
    days,
    steps: FUNNEL_STEPS.map((s) => ({ ...s, count: row[s.key] || 0 })),
    invited: invited.rows[0]?.n || 0,
    held_reasons: held.rows,
  };
}

// The creators who stopped before `step` (named, account, finished, let_in),
// most recent first, a page at a time.
export async function signupFunnelStopped(days, step, limit, offset) {
  const reached = STOPPED_AT[step];
  if (!reached) return null;
  const res = await cloudSqlQuery(
    `${COHORT_SQL}
     SELECT COUNT(*) OVER()::int AS total_count, user_id, email, first_name, last_name,
            instagram_username, tiktok_username, started_at,
            COALESCE((SELECT jsonb_agg(c ->> 'title') FROM ${FAILED_CHECKS}), '[]'::jsonb) AS failed_checks
       FROM cohort
      WHERE ${IN_PERIOD} AND reached = $2
      ORDER BY started_at DESC
      LIMIT $3 OFFSET $4`,
    [days, reached, limit, offset],
  );
  return { total: res.rows[0]?.total_count || 0, rows: res.rows.map(({ total_count: _t, ...r }) => r) };
}
