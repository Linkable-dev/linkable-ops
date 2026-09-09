// A health score for every brand, and the two rankings it makes possible.
//
// The console could show the activation funnel dropping and never name the
// brand that was sliding. Outbound has scored 60,000 strangers 0-10 since May
// and only enrols 7+, which is why it works; nothing scored a single customer.
//
// Two outputs, both of which are lists of names an operator can work through:
//   churn radar   — paying brands whose score is low or falling
//   trial ranking — trials most likely to convert, so limited hours go to the
//                   ten worth calling rather than all sixty equally
//
// Scoring is in JS for the same reason as campaign matchmaking: the weights are
// the arguable part and belong somewhere readable and testable.

import { cloudSqlQuery } from "./cloudsql.js";

export const HEALTH_WEIGHTS = {
  loggedIn: 20,   // are they still turning up
  launched: 20,   // is there a live campaign at all
  supply: 20,     // did creators actually join it
  fulfilment: 15  , // are accepted samples going out
  results: 25,    // is any of it producing clicks and sales
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const daysSince = (iso) => {
  if (!iso) return null;
  const d = (Date.now() - new Date(iso).getTime()) / 86_400_000;
  return Number.isFinite(d) ? d : null;
};

// Returns { score, reasons, risks } for one brand row from loadBrandFacts().
// `reasons` explain the score; `risks` are the subset an operator should act on.
export function scoreBrand(b) {
  const reasons = [];
  const risks = [];
  let score = 0;
  const W = HEALTH_WEIGHTS;

  const seen = daysSince(b.last_sign_in);
  if (seen == null) {
    risks.push("Has never signed in");
  } else if (seen <= 7) {
    score += W.loggedIn;
    reasons.push(seen < 1 ? "Signed in today" : `Signed in ${Math.round(seen)} days ago`);
  } else if (seen <= 30) {
    score += W.loggedIn * 0.6;
    reasons.push(`Last signed in ${Math.round(seen)} days ago`);
  } else {
    risks.push(`Not signed in for ${Math.round(seen)} days`);
  }

  const campaigns = num(b.active_campaigns);
  if (campaigns > 0) {
    score += W.launched;
    reasons.push(`${campaigns} live campaign${campaigns === 1 ? "" : "s"}`);
  } else {
    risks.push("No live campaign");
  }

  const accepted = num(b.creators_accepted);
  if (accepted >= 3) {
    score += W.supply;
    reasons.push(`${accepted} creators on board`);
  } else if (accepted > 0) {
    score += W.supply * 0.5;
    reasons.push(`Only ${accepted} creator${accepted === 1 ? "" : "s"} on board`);
  } else if (campaigns > 0) {
    risks.push("Launched but no creator has been accepted");
  }

  // Fulfilment only means anything once creators are waiting on something.
  const shipped = num(b.samples_shipped);
  const owed = num(b.samples_accepted);
  if (owed === 0) {
    score += W.fulfilment; // nothing outstanding is not a failure
  } else if (shipped >= owed) {
    score += W.fulfilment;
    reasons.push("Samples all shipped");
  } else {
    score += W.fulfilment * (shipped / owed);
    risks.push(`${owed - shipped} accepted sample${owed - shipped === 1 ? "" : "s"} not shipped`);
  }

  const recentOrders = num(b.orders_30d);
  const priorOrders = num(b.orders_prev_30d);
  const clicks = num(b.clicks_30d);
  if (recentOrders > 0) {
    score += W.results;
    reasons.push(`${recentOrders} sale${recentOrders === 1 ? "" : "s"} in the last 30 days`);
    if (priorOrders > recentOrders) risks.push(`Sales down from ${priorOrders} to ${recentOrders}`);
  } else if (clicks > 0) {
    score += W.results * 0.4;
    reasons.push(`${clicks} link clicks but no sales in 30 days`);
    if (priorOrders > 0) risks.push(`Sold ${priorOrders} last month, nothing this month`);
  } else if (accepted > 0) {
    risks.push("No clicks or sales in the last 30 days");
  }

  // Billing trumps everything else: a frozen charge locks the app.
  if (b.sub_status === "FROZEN") risks.unshift("Payment failed — the app is locked for them");

  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons, risks };
}

const ND = (a) => `${a}.deleted = '-infinity'::timestamptz`;

// One row per active brand with everything the scorer needs.
export async function loadBrandFacts() {
  const { rows } = await cloudSqlQuery(`
    SELECT u.id AS user_id, u.email, b.store_name, u.created AS signed_up_at,
           u.account_id, b.trial_expiration_date, b.trial_plan_name,
           asub.status AS sub_status, asub.price_amount, asub.price_currency,
           asub.interval AS sub_interval, COALESCE(asub.test, false) AS sub_test,
           sig.last_sign_in,
           COALESCE(camp.n, 0) AS active_campaigns,
           COALESCE(acc.n, 0) AS creators_accepted,
           COALESCE(sr.accepted, 0) AS samples_accepted,
           COALESCE(sr.shipped, 0) AS samples_shipped,
           COALESCE(o.orders_30d, 0) AS orders_30d,
           COALESCE(o.orders_prev_30d, 0) AS orders_prev_30d,
           COALESCE(lk.clicks, 0) AS clicks_30d
    FROM users u
    JOIN brands b ON b.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT status, price_amount, price_currency, interval, test
      FROM app_subscriptions WHERE user_id = u.id
      ORDER BY (status = 'ACTIVE' AND cancelled_at IS NULL) DESC,
               shopify_created_at DESC NULLS LAST, synced_at DESC NULLS LAST LIMIT 1
    ) asub ON true
    LEFT JOIN LATERAL (
      SELECT MAX(t.created) AS last_sign_in FROM tokens t
      WHERE ((COALESCE(u.sub, '') <> '' AND t.sub = u.sub) OR t.email = u.email)
        AND (t.state IS NULL OR t.state NOT LIKE 'admin_impersonation:%')
    ) sig ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS n FROM products p
      WHERE p.user_id = u.id AND p.status = 2 AND ${ND("p")}
    ) camp ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT l.influencer_user_id) AS n FROM links l
      WHERE l.brand_user_id = u.id AND l.status = 3 AND ${ND("l")}
    ) acc ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT sr2.influencer_user_id) FILTER (WHERE sr2.status IN ('accepted','shipped')) AS accepted,
             COUNT(DISTINCT sr2.influencer_user_id) FILTER (WHERE sr2.status = 'shipped') AS shipped
      FROM sample_requests sr2 JOIN products p2 ON p2.id = sr2.product_id
      WHERE p2.user_id = u.id AND ${ND("sr2")} AND ${ND("p2")}
    ) sr ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) FILTER (WHERE o2.created >= NOW() - INTERVAL '30 days') AS orders_30d,
             COUNT(*) FILTER (WHERE o2.created >= NOW() - INTERVAL '60 days'
                                AND o2.created <  NOW() - INTERVAL '30 days') AS orders_prev_30d
      FROM orders o2 JOIN links l2 ON l2.id = o2.link_id
      WHERE l2.brand_user_id = u.id AND ${ND("o2")} AND ${ND("l2")}
    ) o ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(l3.clicks_counter), 0) AS clicks FROM links l3
      WHERE l3.brand_user_id = u.id AND ${ND("l3")}
        AND l3.updated >= NOW() - INTERVAL '30 days'
    ) lk ON true
    WHERE u.role = 2 AND u.deleted = 'infinity'::timestamptz AND ${ND("b")}`);
  return rows;
}

// Paying means the same thing here as on the Home tiles: a real Shopify plan,
// not a test charge, not still inside a trial.
function planState(b) {
  const inTrial = b.trial_expiration_date && new Date(b.trial_expiration_date) > new Date();
  const hasPlan = /^shopify_[0-9]+/.test(b.account_id || "");
  const paying = hasPlan && !inTrial && !b.sub_test && (!b.sub_status || b.sub_status === "ACTIVE");
  return { inTrial: !!inTrial, hasPlan, paying, granted: !!(b.trial_plan_name || "").trim() };
}

/* ---------------------------------------------------------------- snapshots */

const snapshotReady = {};
async function ensureSnapshotTable() {
  if (!snapshotReady.done) {
    snapshotReady.done = cloudSqlQuery(`
      CREATE TABLE IF NOT EXISTS ops_brand_health (
        day date NOT NULL,
        user_id uuid NOT NULL,
        score smallint NOT NULL,
        paying boolean,
        PRIMARY KEY (day, user_id)
      )`).catch((e) => { delete snapshotReady.done; throw e; });
  }
  return snapshotReady.done;
}

// One row per brand per day. A falling score is the signal, not the level, and
// there is nowhere else to read yesterday's from.
export async function snapshotHealth(scored) {
  await ensureSnapshotTable();
  for (const b of scored) {
    await cloudSqlQuery(`
      INSERT INTO ops_brand_health (day, user_id, score, paying)
      VALUES (CURRENT_DATE, $1, $2, $3)
      ON CONFLICT (day, user_id) DO UPDATE SET score = EXCLUDED.score, paying = EXCLUDED.paying`,
      [b.user_id, b.score, b.paying]);
  }
  return { snapshotted: scored.length };
}

async function loadTrend() {
  await ensureSnapshotTable();
  const { rows } = await cloudSqlQuery(`
    SELECT DISTINCT ON (user_id) user_id, score, day
    FROM ops_brand_health WHERE day < CURRENT_DATE
    ORDER BY user_id, day DESC`);
  return new Map(rows.map((r) => [r.user_id, r]));
}

/* ------------------------------------------------------------------ reading */

export async function brandHealth({ limit = 25 } = {}) {
  const [facts, trend] = await Promise.all([loadBrandFacts(), loadTrend().catch(() => new Map())]);

  const scored = facts.map((b) => {
    const { score, reasons, risks } = scoreBrand(b);
    const state = planState(b);
    const prev = trend.get(b.user_id);
    return {
      user_id: b.user_id,
      email: b.email,
      store_name: b.store_name,
      score,
      previous_score: prev ? prev.score : null,
      delta: prev ? score - prev.score : null,
      reasons,
      risks,
      paying: state.paying,
      in_trial: state.inTrial,
      granted_trial: state.granted,
      trial_ends: b.trial_expiration_date || null,
      sub_status: b.sub_status || null,
      last_sign_in: b.last_sign_in || null,
      active_campaigns: num(b.active_campaigns),
      creators_accepted: num(b.creators_accepted),
      orders_30d: num(b.orders_30d),
    };
  });

  const bandOf = (s) => (s >= 70 ? "healthy" : s >= 45 ? "watch" : "at risk");

  // Worst first, and a falling score outranks a merely low one.
  const churnRadar = scored
    .filter((b) => b.paying)
    .sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0) || a.score - b.score)
    .slice(0, limit);

  // Best first: these are the trials worth an hour of somebody's day.
  const trialRanking = scored
    .filter((b) => b.in_trial)
    .sort((a, b) => b.score - a.score || new Date(a.trial_ends || 0) - new Date(b.trial_ends || 0))
    .slice(0, limit);

  const bands = { healthy: 0, watch: 0, "at risk": 0 };
  for (const b of scored) bands[bandOf(b.score)] += 1;

  return {
    totals: {
      brands: scored.length,
      paying: scored.filter((b) => b.paying).length,
      inTrial: scored.filter((b) => b.in_trial).length,
      averageScore: scored.length
        ? Math.round(scored.reduce((a, b) => a + b.score, 0) / scored.length)
        : 0,
      bands,
      hasTrend: trend.size > 0,
    },
    churnRadar: churnRadar.map((b) => ({ ...b, band: bandOf(b.score) })),
    trialRanking: trialRanking.map((b) => ({ ...b, band: bandOf(b.score) })),
    all: scored.map((b) => ({ ...b, band: bandOf(b.score) })),
  };
}
