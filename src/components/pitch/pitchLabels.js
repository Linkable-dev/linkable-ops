// Pitch's words and colours, in one module of plain values: a file that
// exports components and constants together breaks fast refresh for every
// page importing it.

// The Pitch section's tabs. Pitches first: who sent what is the question an
// admin opens Pitch with.
export const PITCH_TABS = [
  { to: "/ops/pitch", label: "Pitches", match: (p) => p === "/ops/pitch" },
  { to: "/ops/pitch/creators", label: "Creators", match: (p) => p.startsWith("/ops/pitch/creators") },
  { to: "/ops/pitch/brands", label: "Brands", match: (p) => p.startsWith("/ops/pitch/brands") },
];

// pitches.status, as an admin says it.
const STATUS = {
  ready: { label: "Draft", color: "#737C9A" },
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

// "5 Oct, 16:15" — the timeline wants the moment, not "2h ago".
export function when(v) {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
