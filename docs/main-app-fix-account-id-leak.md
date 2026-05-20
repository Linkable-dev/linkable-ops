# Main-app fix: COMPLETED brands with empty `account_id`

Investigation 2026-05-20. Ops query found **17 brands** at `users.status = STATUS_COMPLETED (7)` with `users.account_id = ''` — 59% of the COMPLETED cohort. Two of them signed up in the last 30 days, the most recent on **2026-05-12** (Grace & Co), so the bug is still active.

Of the 17, only **1** has an active Shopify subscription waiting to be linked (Kollektif → `shopify_1990_yearly`). The other 16 reached COMPLETED **without ever creating a Shopify subscription at all** — Shopify's `activeSubscriptions` *and* `allSubscriptions` both return empty. They are not paying anything; the app simply lets them through.

## Root cause

`client/src/routes/brands/onboarding/stage1/intro/+page.server.ts` runs the status promotion to `STATUS_SUBSCRIBED` even when the upstream `UpdateSubscription` gRPC call fails. The `grpcSafe(res)` wrapper resolves the promise either way — the code never reads `.success`, then calls `updateStatus(SUBSCRIBED)` unconditionally:

```ts
await new Promise<Safe<User>>((res) => {
    usersClient.UpdateSubscription({ user_id, account_id }, metadata, grpcSafe(res));
});
// status update fires even if the line above silently failed
await updateStatus(locals.user.id, Status.STATUS_SUBSCRIBED);
```

Compounded by: the code trusts `?status=success&plan=X&billing=Y` query params for the `account_id` value without verifying against Shopify. And `stage2/step7/+page.server.ts` flips status to `STATUS_COMPLETED` with no `account_id` precondition.

## Three changes recommended

### 1. Gate status promotion on the gRPC result

`client/src/routes/brands/onboarding/stage1/intro/+page.server.ts`

```diff
-            await new Promise<Safe<User>>((res) => {
-                usersClient.UpdateSubscription(
-                    { user_id: locals.user.id, account_id: accountId },
-                    metadata,
-                    grpcSafe(res),
-                );
-            });
-
-            // Also update user status to SUBSCRIBED to prevent hooks.server.ts from redirecting
-            await updateStatus(locals.user.id, Status.STATUS_SUBSCRIBED);
+            const subResult = await new Promise<Safe<User>>((res) => {
+                usersClient.UpdateSubscription(
+                    { user_id: locals.user.id, account_id: accountId },
+                    metadata,
+                    grpcSafe(res),
+                );
+            });
+            if (!subResult.success) {
+                logger.error(
+                    `UpdateSubscription gRPC failed; not promoting to SUBSCRIBED. user=${locals.user.id}`,
+                    subResult.error,
+                );
+                return { subscriptionSuccess: false, error: "Failed to record subscription" };
+            }
+            await updateStatus(locals.user.id, Status.STATUS_SUBSCRIBED);
```

Same change applies to the side-effect block in `client/src/routes/brands/settings/subscription/+page.server.ts:87-96` (which has the same pattern).

### 2. Verify against Shopify before trusting the return-URL params

The return URL is reachable without an actual Shopify subscription (tab refresh, manipulated URL, cancelled-then-refunded edge cases). Add a single Shopify query at the top of the `if (status === "success" && plan && billing)` branch in `intro/+page.server.ts`:

```ts
const shopifyToken = locals.user?.shopify_token;
const shopifyShop = locals.user?.shopify_shop;
const subs = shopifyToken && shopifyShop
    ? await fetchActiveShopifySubs(shopifyToken, shopifyShop)
    : [];
if (subs.length === 0) {
    logger.error(`status=success on intro but Shopify has no active subscription. user=${locals.user.id}`);
    return { subscriptionSuccess: false, error: "No Shopify subscription found" };
}
// (optional but cleaner) derive accountId from the actual Shopify sub instead of URL params:
//   const sub = subs[0];
//   const price = Math.round(Number(sub.lineItems[0].plan.pricingDetails.price.amount));
//   const billing = sub.lineItems[0].plan.pricingDetails.interval === "ANNUAL" ? "yearly" : "monthly";
//   const accountId = `shopify_${price}_${billing}`;
```

Reuse the existing `app.installation.activeSubscriptions` query from `plan_detection.ts` / `subscription/+page.server.ts` so the wire format stays consistent.

### 3. Defensive gate on step7

`client/src/routes/brands/onboarding/stage2/step7/+page.server.ts`

```diff
 export const actions = {
-    next: async ({ locals }) => {
+    next: async ({ locals }) => {
+        // Refuse to finalize onboarding for brands who never picked a plan.
+        // They'll be redirected back to /brands/onboarding/stage1/stripe by
+        // hooks.server.ts (status=CONNECTED branch) so they can complete it.
+        if (!locals.user?.account_id) {
+            return fail(400, { error: "Subscription required before completing onboarding." });
+        }
         const r = await updateStatus(locals.user.id, Status.STATUS_COMPLETED);
```

Plus matching defensive checks in `hooks.server.ts` if a stale `STATUS_SUBSCRIBED` state is detected without `account_id`, push the brand back to `/brands/onboarding/stage1/stripe`.

## Backfill (ops side, already shipped)

`scripts/backfill-account-id.js` in this repo. Dry-run reveals only 1 of 17 is recoverable via Shopify lookup. Run with `--apply` to fix Kollektif's row. The other 16 are pre-existing data corruption that needs human outreach (they're using the app without ever subscribing).

## Verification queries

```sql
-- How many COMPLETED brands still have empty account_id
SELECT COUNT(*)
  FROM users
 WHERE role = 2
   AND status = 7
   AND account_id = ''
   AND deleted = 'infinity'::timestamptz;
```

```sql
-- New COMPLETED brands per week with empty account_id (watch this trend down after the fix)
SELECT date_trunc('week', created) AS week, COUNT(*)
  FROM users
 WHERE role = 2
   AND status = 7
   AND account_id = ''
   AND deleted = 'infinity'::timestamptz
 GROUP BY week
 ORDER BY week DESC;
```
