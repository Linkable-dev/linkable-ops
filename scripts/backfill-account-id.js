#!/usr/bin/env node
// Backfill users.account_id for brands whose Shopify subscription exists but
// our DB never recorded it.
//
// Why: see investigation 2026-05-20. Status=COMPLETED brands frequently sit
// with empty account_id because intro/+page.server.ts runs updateStatus
// without checking that UpdateSubscription actually succeeded. The Shopify
// sub still exists; our DB is just out of sync.
//
// What it does:
//   1. Find every active brand with status=COMPLETED AND account_id=''
//   2. For each, query their Shopify shop for activeSubscriptions
//   3. If exactly one active sub:
//        derive account_id = shopify_<price>_<billing> and UPDATE users
//   4. If zero active subs → log as "manual follow-up needed"
//   5. If more than one active sub → log + skip (ambiguous, do not guess)
//
// Usage:
//   node scripts/backfill-account-id.js             # dry-run by default
//   node scripts/backfill-account-id.js --apply     # actually write to DB
//   node scripts/backfill-account-id.js --apply --limit=5   # cap rows

import { cloudSqlQuery, runWithDbTarget } from "../server/lib/cloudsql.js";

const APPLY = process.argv.includes("--apply");
const LIMIT_FLAG = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = LIMIT_FLAG ? Number(LIMIT_FLAG.split("=")[1]) || 0 : 0;

const SHOPIFY_QUERY = `
  query {
    app {
      installation {
        activeSubscriptions {
          id name status createdAt trialDays
          lineItems {
            plan {
              pricingDetails {
                ... on AppRecurringPricing {
                  price { amount currencyCode }
                  interval
                }
              }
            }
          }
        }
      }
    }
  }`;

// Shopify gives interval as "ANNUAL" / "EVERY_30_DAYS". account_id stores
// "yearly" / "monthly" (matches the main app's billingPeriod form field).
function intervalToBilling(interval) {
  return interval === "ANNUAL" ? "yearly" : "monthly";
}

// Round to int. Main app stores the *list* price in account_id (e.g.
// shopify_199_monthly), so we mirror that exactly — Shopify returns the
// charged amount as a string like "199.00".
function priceToAccountIdPrice(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

async function fetchShopifySubs(shop, token) {
  const resp = await fetch(`https://${shop}/admin/api/2025-04/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query: SHOPIFY_QUERY }),
  });
  if (!resp.ok) {
    return { error: `HTTP ${resp.status}: ${await resp.text().catch(() => "")}` };
  }
  const data = await resp.json();
  return {
    subs: data?.data?.app?.installation?.activeSubscriptions || [],
    raw: data,
  };
}

function deriveAccountId(sub) {
  const line = sub.lineItems?.[0]?.plan?.pricingDetails;
  if (!line) return null;
  const price = priceToAccountIdPrice(line.price?.amount);
  if (!price) return null;
  return `shopify_${price}_${intervalToBilling(line.interval)}`;
}

const summary = {
  scanned: 0,
  backfilled: [],
  no_subscription: [],
  ambiguous: [],
  fetch_error: [],
};

await runWithDbTarget("prod", async () => {
  console.log(`Mode: ${APPLY ? "APPLY (writes enabled)" : "DRY RUN (no writes)"}`);
  if (LIMIT) console.log(`Limit: ${LIMIT}`);

  const { rows } = await cloudSqlQuery(
    `SELECT u.id, u.email, u.shopify_shop, u.shopify_token, b.store_name
       FROM users u
       LEFT JOIN brands b ON b.user_id = u.id AND b.deleted = '-infinity'::timestamptz
      WHERE u.role = 2
        AND u.status = 7
        AND u.account_id = ''
        AND u.deleted = 'infinity'::timestamptz
        AND u.shopify_token IS NOT NULL AND u.shopify_token <> ''
        AND u.shopify_shop IS NOT NULL  AND u.shopify_shop  <> ''
      ORDER BY u.created DESC
      ${LIMIT ? `LIMIT ${Number(LIMIT)}` : ""}`,
    [],
  );

  console.log(`Found ${rows.length} candidate brands`);

  for (const r of rows) {
    summary.scanned++;
    const tag = `${r.email} (${r.store_name || "—"})`;

    const { subs, error } = await fetchShopifySubs(r.shopify_shop, r.shopify_token);
    if (error) {
      console.log(`  [FETCH ERR] ${tag} — ${error}`);
      summary.fetch_error.push({ ...r, error });
      continue;
    }

    if (subs.length === 0) {
      console.log(`  [NO SUB ]  ${tag} — no Shopify subscription. Manual follow-up.`);
      summary.no_subscription.push({ user_id: r.id, email: r.email, shop: r.shopify_shop });
      continue;
    }

    if (subs.length > 1) {
      console.log(`  [AMBIG  ]  ${tag} — ${subs.length} active subs; skipping.`);
      summary.ambiguous.push({ user_id: r.id, email: r.email, subs: subs.map((s) => ({ id: s.id, name: s.name })) });
      continue;
    }

    const sub = subs[0];
    const accountId = deriveAccountId(sub);
    if (!accountId) {
      console.log(`  [PARSE ERR] ${tag} — couldn't derive account_id from sub ${sub.id}`);
      summary.fetch_error.push({ ...r, error: "could not derive account_id", sub });
      continue;
    }

    if (APPLY) {
      await cloudSqlQuery(
        `UPDATE users SET account_id = $1 WHERE id = $2 AND account_id = ''`,
        [accountId, r.id],
      );
      console.log(`  [BACKFILL] ${tag} → ${accountId}`);
    } else {
      console.log(`  [DRY-RUN ] ${tag} → would set account_id = ${accountId}`);
    }
    summary.backfilled.push({ user_id: r.id, email: r.email, account_id: accountId, sub_id: sub.id });
  }
});

console.log("\n=== SUMMARY ===");
console.log(`Scanned:        ${summary.scanned}`);
console.log(`Backfilled:     ${summary.backfilled.length}${APPLY ? "" : " (dry-run)"}`);
console.log(`No subscription:${summary.no_subscription.length}`);
console.log(`Ambiguous:      ${summary.ambiguous.length}`);
console.log(`Fetch errors:   ${summary.fetch_error.length}`);

if (summary.no_subscription.length) {
  console.log("\n--- Brands with NO Shopify subscription (manual follow-up) ---");
  for (const r of summary.no_subscription) {
    console.log(`  ${r.email}  shop=${r.shop}`);
  }
}

process.exit(0);
