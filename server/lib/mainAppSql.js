// SQL fragments for main-app columns whose meaning is not obvious from the
// column name. Shared so the same money never gets computed two different ways
// on two different pages.

// orders.commission is the commission RATE FOR THAT ORDER, as text, in percent
// — not an amount. It is copied from products.sale_commission at order time
// (values seen in prod: 10, 15, 20, 25, 28, 30, 40, 50, 60). Summing the column
// adds up percentages: four orders at 10/10/10/30 read as "£60 earned" when the
// commission actually earned on £162 of GMV was £24.60.
//
// `alias` is the orders table alias ("o" → o.commission), or "" for a bare
// `FROM orders`. Rows whose rate is missing, non-numeric, or outside 0–100
// contribute nothing rather than poisoning the sum.
export function commissionEarnedSql(alias = "") {
  const p = alias ? `${alias}.` : "";
  return `SUM(
    CASE WHEN ${p}commission ~ '^[0-9]+(\\.[0-9]+)?$'
              AND ${p}commission::numeric <= 100
              AND ${p}shopify_amount IS NOT NULL
         THEN ${p}shopify_amount * ${p}commission::numeric / 100.0
         ELSE 0 END)`;
}

// A Shopify subscription created in test mode bills nobody. Shopify keeps the
// row alive and ACTIVE, so revenue that filters only on status counts money
// that will never arrive. Applied wherever subscriptions become revenue.
export const NOT_TEST_SUB = (alias = "asub") => `COALESCE(${alias}.test, false) = false`;
