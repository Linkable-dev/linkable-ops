// Card plans (main app PR #371): a brand without Shopify pays by card, billed
// by Stripe in GBP. While the plan runs users.account_id reads
// "stripe_<starter|growth|scale>_<monthly|yearly>" and its app_subscriptions
// row has provider "stripe". The plan names are the ones the app shows.
const TITLES = { starter: "Starter", growth: "Growth", scale: "Scale" };

export function isCardPlan(accountId) {
  return /^stripe_/.test(accountId || "");
}

// "Growth" for stripe_growth_monthly, null for anything that is not a card plan.
export function cardPlanName(accountId) {
  const m = /^stripe_([a-z]+)_/.exec(accountId || "");
  return m ? TITLES[m[1]] || "Card plan" : null;
}

// Stripe statuses as an operator reads them.
export function cardStatusLabel(stripeStatus) {
  switch (stripeStatus) {
    case "trialing": return "Trial";
    case "active": return "Paying";
    case "past_due": return "Card past due";
    case "unpaid": return "Unpaid";
    case "incomplete": return "Awaiting first payment";
    case "canceled": case "incomplete_expired": return "Cancelled";
    case "paused": return "Paused";
    default: return stripeStatus || "";
  }
}
