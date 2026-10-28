// Pitch's words and colours, in one module of plain values: a file that
// exports components and constants together breaks fast refresh for every
// page importing it.

// The Pitch section's tabs. Pitches first: who sent what is the question an
// admin opens Pitch with.
export const PITCH_TABS = [
  { to: "/ops/pitch", label: "Pitches", match: (p) => p === "/ops/pitch" },
  { to: "/ops/pitch/review", label: "In review", match: (p) => p.startsWith("/ops/pitch/review") },
  { to: "/ops/pitch/partners", label: "Partners", match: (p) => p.startsWith("/ops/pitch/partners") },
  { to: "/ops/pitch/creators", label: "Creators", match: (p) => p.startsWith("/ops/pitch/creators") },
  { to: "/ops/pitch/brands", label: "Brands", match: (p) => p.startsWith("/ops/pitch/brands") },
  { to: "/ops/pitch/pro", label: "Pitch Pro", match: (p) => p.startsWith("/ops/pitch/pro") },
];

// pitches.status, as an admin says it.
const STATUS = {
  ready: { label: "Draft", color: "#737C9A" },
  in_review: { label: "In review", color: "#B45309" },
  scheduled: { label: "Sending", color: "#2563EB" },
  sent: { label: "Sent", color: "#0D9488" },
  viewed: { label: "Viewed", color: "#7C3AED" },
  accepted: { label: "Accepted", color: "#16A34A" },
  changes_requested: { label: "Changes asked", color: "#B45309" },
  declined: { label: "Declined", color: "#B91C1C" },
  expired: { label: "Expired", color: "#9CA3AF" },
  skipped: { label: "Skipped", color: "#9CA3AF" },
};

export const STATUS_OPTIONS = [
  { value: "in_review", label: "In review" },
  { value: "scheduled", label: "Sending" },
  { value: "sent", label: "Sent" },
  { value: "viewed", label: "Viewed" },
  { value: "replied", label: "Replied" },
  { value: "accepted", label: "Accepted" },
  { value: "changes_requested", label: "Changes asked" },
  { value: "declined", label: "Declined" },
  { value: "ready", label: "Draft" },
  { value: "no_contact", label: "No contact found" },
  { value: "expired", label: "Expired" },
  { value: "skipped", label: "Skipped" },
];

export const CHANNEL_LABEL = { lemlist: "Lemlist", email: "Linkable email", in_app: "Linkable Messages" };
export const CHANNEL_OPTIONS = Object.entries(CHANNEL_LABEL).map(([value, label]) => ({ value, label }));

// Where a Lemlist pitch is in its sequence (pitches.lemlist_state).
const LEMLIST_NOTE = {
  pending: "Finding the brand's contact",
  queued: "Waiting for another creator's pitch to that contact to finish",
  enrolled: "In the Lemlist sequence",
  ended: "Sequence finished",
};

// The status tag and the line under it.
export function pitchStatus(p) {
  if (p.status === "ready" && p.lemlist_state === "failed") {
    return { label: "No contact found", color: "#B91C1C", note: p.lemlist_error || "Back with the creator to send again" };
  }
  const s = STATUS[p.status] || { label: p.status, color: "#737C9A" };
  let note = "";
  if (p.delivery === "lemlist" && p.status !== "ready") note = p.lemlist_error || LEMLIST_NOTE[p.lemlist_state] || "";
  if (p.status === "viewed" && p.view_count > 1) note = `${p.view_count} views`;
  return { ...s, note };
}

// pitch_events, in words, for the timeline. Unknown events fall back to their
// own name with the underscores out.
const EVENT = {
  created: "Linkable wrote the pitch",
  idea_saved: "Creator saved the idea",
  idea_regenerated: "Creator asked for a new idea",
  email_regenerated: "Creator asked for a new email",
  scheduled: "Creator pressed Send",
  enrolled: "Added to the Lemlist sequence",
  sent: "Sent",
  lemlist_failed: "No contact found for the brand",
  bounced: "The address bounced",
  opened: "Brand opened the email",
  viewed: "Brand opened the proposal",
  view_ignored: "Proposal visit not counted (a link preview or mail scanner)",
  followup_1_sent: "Follow up 1 sent to the brand",
  followup_2_sent: "Follow up 2 sent to the brand",
  creator_nudge_sent: "Creator reminded to nudge the brand",
  bump_sent: "Creator's nudge sent to the brand",
  notify_viewed_sent: "Creator told the brand viewed it",
  notify_accepted_sent: "Creator told the brand accepted",
  notify_changes_sent: "Creator told the brand asked for changes",
  notify_declined_sent: "Creator told the brand declined",
  replied: "Brand replied",
  creator_replied: "Creator answered the brand",
  changes_requested: "Brand asked for changes",
  declined: "Brand declined",
  accept_started: "Brand started accepting",
  terms_confirmed: "Brand confirmed the terms",
  campaign_created: "Campaign created",
  trial_started: "Brand's trial started",
  accepted: "Accepted",
  needs_manual: "Needs a person to finish the accept",
  brand_paid: "Brand paid",
};

export function eventLabel(e) {
  const step = /^lemlist_step_(\d+)_sent$/.exec(e.event);
  if (step) return `Lemlist sent email ${Number(step[1]) + 1} of 3`;
  const d = e.detail || {};
  if (e.event === "sent") return d.in_app ? "Delivered in Linkable Messages" : d.via === "lemlist" ? "Marked Sent" : "Sent by Linkable email";
  if (e.event === "viewed" && d.first) return "Brand opened the proposal for the first time";
  if (e.event === "idea_saved" && d.edited) return "Creator edited and saved the idea";
  const base = EVENT[e.event] || e.event.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  return base;
}

// The small print after an event: what its detail adds.
export function eventNote(e) {
  const d = e.detail || {};
  const parts = [];
  if (e.event === "created") {
    if (d.tier) parts.push(`tier ${d.tier}`);
    if (d.source) parts.push(d.source === "claude" ? "written by AI" : "from the template");
  }
  if (e.event === "enrolled" && d.contact_source) parts.push(`contact from ${d.contact_source.replace(/_/g, " ")}`);
  if (d.sandboxed) parts.push("to a tester, not the brand");
  if (d.to) parts.push(String(d.to));
  if (d.error) parts.push(String(d.error));
  return parts.join(" · ");
}

// What the creator offers in return, in words.
export function pitchTerms(p) {
  const parts = [];
  if (p.gifted) parts.push("Gifted product");
  if (p.paid) parts.push(p.fee_amount ? `Paid ${p.fee_currency || ""} ${p.fee_amount}`.replace(/\s+/g, " ") : "Paid (fee to agree)");
  if (p.affiliate) parts.push("Commission");
  if (p.open_to_discuss) parts.push("Open to discuss");
  return parts.length ? parts.join(" · ") : "Nothing chosen";
}

// 120000 -> "120K"; "" when not known.
export function count(n) {
  const v = Number(n) || 0;
  if (v <= 0) return "";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 100_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(v);
}

const PLATFORM = { instagram: "Instagram", tiktok: "TikTok" };

// Her main account's platform: main_platform, or from a main app before it,
// Instagram when she has a handle.
function mainPlatform(r) {
  return !r.main_platform ? (r.creator_handle ? "instagram" : "") : r.main_platform;
}

// The In review card's account line: her main account (Instagram when she
// has one, else TikTok) and that account's own numbers, never Instagram and
// TikTok added up. "TikTok · 8K followers · 6.2% engagement on views". A main
// app from before main_platform sends Instagram's numbers only, and they are
// hers only when she has an Instagram handle (else they are left over).
export function reviewAccount(r) {
  const legacy = !r.main_platform;
  const platform = mainPlatform(r);
  if (!PLATFORM[platform]) return { handle: "", line: "No stats yet" };
  const handle = (legacy ? r.creator_handle : r.main_handle) || "";
  const n = legacy ? r.creator_followers : r.main_followers;
  const rate = legacy ? r.creator_engagement : r.main_engagement;
  const stats = [
    count(n) && `${count(n)} followers`,
    rate ? `${rate}% engagement${platform === "tiktok" ? " on views" : ""}` : "",
  ].filter(Boolean);
  return {
    handle: handle || r.creator_handle || "",
    line: [PLATFORM[platform], ...(stats.length ? stats : ["No stats yet"])].join(" · "),
  };
}

function profileUrl(platform, handle) {
  const h = encodeURIComponent(String(handle).trim().replace(/^@+/, ""));
  return platform === "tiktok" ? `https://www.tiktok.com/@${h}` : `https://www.instagram.com/${h}/`;
}

// The In review card's links to her (QA 123): her main account (the handle,
// as reviewAccount picks it) and every account she has connected, Instagram
// first. An Instagram is always her main one (TikTok is main only without
// one), so a TikTok main means no Instagram. A main app from before
// tiktok_handle sends her TikTok only when it is her main account.
export function reviewProfiles(r) {
  const platform = mainPlatform(r);
  const { handle } = reviewAccount(r);
  const accounts = [];
  if (platform === "instagram" && handle) accounts.push({ platform: "instagram", label: "Instagram", handle });
  const tiktok = r.tiktok_handle || (platform === "tiktok" ? handle : "");
  if (tiktok) accounts.push({ platform: "tiktok", label: "TikTok", handle: tiktok });
  for (const a of accounts) a.url = profileUrl(a.platform, a.handle);
  const main = accounts.find((a) => a.platform === platform) || null;
  return { main, accounts };
}

// "5 Oct, 16:15" — the timeline wants the moment, not "2h ago".
export function when(v) {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

// Pitch Partners (main app QA 132): the queue's tabs, as an admin says them.
export const PARTNER_QUEUES = [
  { value: "applications", label: "Applications", empty: "No applications waiting. New ones show up here as creators apply on linkable.link/partners.",
    count: (n) => `${n} ${n === 1 ? "application" : "applications"} waiting` },
  { value: "videos", label: "Videos to check", empty: "No videos waiting. A partner's video shows up here once she pastes its link.",
    count: (n) => `${n} ${n === 1 ? "video" : "videos"} to check` },
  { value: "payouts", label: "Payouts to approve", empty: "No payouts waiting. A partner's first payout and unusual ones wait here.",
    count: (n) => `${n} ${n === 1 ? "payout" : "payouts"} waiting for you` },
  { value: "approved", label: "Partners", empty: "No Pitch Partners yet.",
    count: (n) => `${n} Pitch ${n === 1 ? "Partner" : "Partners"}` },
  { value: "rejected", label: "Rejected", empty: "Nobody rejected.",
    count: (n) => `${n} rejected` },
  { value: "removed", label: "Removed", empty: "Nobody removed.",
    count: (n) => `${n} removed` },
];

// How long ago a stuck payout was started: "75 min", "5 h", "3 days".
export function stuckAge(minutes) {
  const m = Math.max(0, Math.floor(Number(minutes) || 0));
  if (m < 120) return `${m} min`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h`;
  return `${Math.floor(m / (24 * 60))} days`;
}

// Why a payout waits for the team, and why an earning was blocked.
export const PAYOUT_REVIEW = {
  first_payout: "Her first payout",
  large_payout: "Larger than usual (PITCH_PARTNER_PAYOUT_REVIEW_MINOR)",
  many_signups: "Many sign ups with her link this week (PITCH_PARTNER_REVIEW_SIGNUPS)",
};
export const BLOCKED = {
  same_card: "a creator paid with a card she has used",
  same_domain: "a creator signed up with her company email domain",
};

// A partner's main account (as she applied: Instagram when she has one, else
// TikTok) and a button to each account she has. "Instagram · @mel · 33.3K
// followers".
export function partnerAccount(r) {
  const handle = String(r.main_handle || "").replace(/^@/, "");
  const name = PLATFORM[r.main_platform];
  const line = name ? [name, handle && `@${handle}`, count(r.main_followers) && `${count(r.main_followers)} followers`].filter(Boolean).join(" · ") : "";
  const links = [];
  const ig = String(r.instagram_handle || "").replace(/^@/, "").trim();
  const tt = String(r.tiktok_handle || "").replace(/^@/, "").trim();
  if (/^[A-Za-z0-9._]{1,30}$/.test(ig)) links.push({ label: "Instagram", href: `https://www.instagram.com/${ig}/` });
  if (/^[A-Za-z0-9._]{1,30}$/.test(tt)) links.push({ label: "TikTok", href: `https://www.tiktok.com/@${tt}` });
  return { line, links };
}

// --- Pitch Pro: who pays (creator_plans, one line per creator) ---------------

// "26 Nov 2026" — a billing date wants the day, not "in 3d".
export function day(v) {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

// 1900, "gbp" -> "£19"; 1950 -> "£19.50". The currency's own symbol, never
// converted.
export function money(minor, currency) {
  const cur = String(currency || "").toUpperCase();
  const amount = (Number(minor) || 0) / 100;
  if (!/^[A-Z]{3}$/.test(cur)) return String(amount);
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency", currency: cur, minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${cur} ${amount}`;
  }
}

// What she is on (the server's kind).
export const PLAN_KIND_LABEL = {
  pro_monthly: "Pro monthly",
  pro_yearly: "Pro yearly",
  founding: "Founding",
  partner_trial: "Partner trial",
  gift: "Gift",
};
export const PLAN_KIND_OPTIONS = Object.entries(PLAN_KIND_LABEL).map(([value, label]) => ({ value, label }));

// Where her plan is (the server's state), as the filter and the summary say it.
export const PLAN_STATE_LABEL = {
  paying: "Paying",
  trial: "Trial",
  free: "Gift running",
  cancels: "Cancels",
  past_due: "Past due",
  ended: "Ended",
  refunded: "Refunded",
  disputed: "Disputed",
};
export const PLAN_STATE_OPTIONS = Object.entries(PLAN_STATE_LABEL).map(([value, label]) => ({ value, label }));
const PLAN_STATE_COLOR = {
  paying: "#16A34A", trial: "#2563EB", free: "#7C3AED", cancels: "#B45309",
  past_due: "#B91C1C", ended: "#9CA3AF", refunded: "#9CA3AF", disputed: "#B91C1C",
};

export const PLAN_SOURCE_LABEL = {
  pitch_partner: "Pitch Partner link",
  creator_referral: "Creator referral",
  partner_programme: "Is a Pitch Partner",
  direct: "Direct",
};
export const PLAN_SOURCE_OPTIONS = Object.entries(PLAN_SOURCE_LABEL).map(([value, label]) => ({ value, label }));

export const CURRENCY_OPTIONS = [
  { value: "gbp", label: "GBP" }, { value: "usd", label: "USD" }, { value: "eur", label: "EUR" },
];

const REFUND_REASON = {
  second_pro: "A second Pitch Pro",
  already_founding: "Already a Founding Creator",
  sold_out: "Founding was sold out",
};

// Stripe gives up on a failing card after its retries; the main app stops
// counting a plan as Pro 14 days after it went past due either way.
const PAST_DUE_GRACE_MS = 14 * 24 * 3600 * 1000;

// The status tag and the line under it. "Cancels on 26 Nov 2026".
export function planStatus(r, now = Date.now()) {
  const color = PLAN_STATE_COLOR[r.state] || "#737C9A";
  switch (r.state) {
    case "paying":
      return { label: "Paying", color, note: r.plan === "founding" ? "Paid once, Pitch Pro for good" : "" };
    case "trial": {
      const note = r.kind === "partner_trial" ? "A Pitch Partner's free first month"
        : r.trial_kind === "deferred" ? "Payment moved past her gift"
        : r.kind === "gift" ? "Free while her gift runs"
        : "";
      return { label: "Trial", color, note };
    }
    case "free":
      return { label: "Gift running", color, note: "Given by Pitch Partners, no card" };
    case "cancels":
      return { label: `Cancels on ${day(r.current_period_end) || "period end"}`, color,
               note: r.status === "trialing" ? "Cancelled in her trial: never charged" : "Paid up to then, won't renew" };
    case "past_due": {
      const since = r.past_due_since ? new Date(r.past_due_since).getTime() : NaN;
      const lapsed = Number.isFinite(since) && now - since > PAST_DUE_GRACE_MS;
      const label = r.status === "unpaid" ? "Unpaid" : r.status === "incomplete" ? "First payment incomplete" : "Past due";
      const note = lapsed ? `Failing since ${day(r.past_due_since)}: back on Free`
        : r.past_due_since ? `Card failing since ${day(r.past_due_since)}` : "Stripe is retrying her card";
      return { label, color, note };
    }
    case "ended":
      return { label: "Ended", color, note: r.status === "granted" ? "Her gift ran out" : "" };
    case "refunded":
      return { label: r.refunded_at ? "Refunded" : "Refund due", color, note: REFUND_REASON[r.refund_reason] || "" };
    case "disputed":
      return { label: "Disputed", color, note: "She disputed the payment with her bank" };
    default:
      return { label: r.status || "Unknown", color, note: "" };
  }
}

// "£19 / month", "$190 / year", "£99 once", "Free".
export function planPrice(r) {
  if (r.status === "granted" || !(Number(r.amount_minor) > 0)) return "Free";
  const amount = money(r.amount_minor, r.currency);
  if (r.plan === "founding") return `${amount} once`;
  return `${amount} / ${r.billing_interval === "year" ? "year" : "month"}`;
}

// The date that matters next and what it is: "Renews", "First payment",
// "Ends", "Ended", "Refunded". Founding never ends.
export function planNext(r) {
  if (r.state === "paying" && r.plan === "founding") return { verb: "Never ends", at: "" };
  const verb = {
    paying: "Renews", trial: "First payment", cancels: "Ends", free: "Ends",
    past_due: "Period ends", ended: "Ended", refunded: "Refunded", disputed: "",
  }[r.state] || "";
  return { verb, at: r.next_at || "" };
}

// The plan's own page in Stripe: the subscription, or Founding's payment.
// None for Pitch Pro given (nothing in Stripe).
export function stripeLinks(r, base) {
  if (!base) return { plan: "", customer: "" };
  const plan = r.stripe_subscription_id ? `${base}/subscriptions/${encodeURIComponent(r.stripe_subscription_id)}`
    : r.stripe_payment_intent_id ? `${base}/payments/${encodeURIComponent(r.stripe_payment_intent_id)}`
    : "";
  const customer = r.stripe_customer_id ? `${base}/customers/${encodeURIComponent(r.stripe_customer_id)}` : "";
  return { plan, customer };
}
