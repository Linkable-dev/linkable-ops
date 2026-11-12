// Campaigns from calls (main app QA 171): the words the page uses, shared
// with the server tests. The field keys mirror the main app's
// externalProfileFieldOrder (services/external_calls_apply.go).

export const CALL_TABS = [
  { value: "draft", label: "To review", empty: "No drafts waiting. New calls the agent finds land here." },
  { value: "live", label: "Live", empty: "No live campaigns from calls." },
  { value: "closed", label: "Closed", empty: "No closed calls yet." },
  { value: "rejected", label: "Rejected", empty: "Nothing rejected." },
  { value: "failed", label: "Couldn’t use", empty: "Every form read so far could be used." },
  { value: "reading", label: "Reading", empty: "Nothing being read right now." },
];

export const STATUS_LABELS = {
  reading: "Reading", draft: "To review", live: "Live", closed: "Closed", rejected: "Rejected", failed: "Couldn’t use",
};

export const SUBMISSION_LABELS = {
  sending: "Sending", sent: "Sent", simulated: "Simulated (not prod)", held: "Held", dismissed: "Dismissed",
};

export const CLOSE_REASONS = {
  form_closed: "The form stopped taking responses",
  post_deleted: "The post was deleted",
  deadline_passed: "The deadline passed",
  "30_days": "30 days since the post",
  closed_by_ops: "Closed by the team",
};

export function sourceLabel(source) {
  return source === "manual" ? "Added manually" : "Found by the agent";
}

export const PROFILE_FIELDS = [
  ["full_name", "Full name"], ["first_name", "First name"], ["last_name", "Last name"], ["email", "Email address"],
  ["phone", "Phone or WhatsApp"], ["instagram_handle", "Instagram @handle"], ["instagram_url", "Instagram link"],
  ["tiktok_handle", "TikTok @handle"], ["tiktok_url", "TikTok link"], ["socials", "All her socials"],
  ["instagram_followers", "Instagram followers"], ["tiktok_followers", "TikTok followers"],
  ["total_followers", "Total followers"], ["country", "Country"], ["city", "City"], ["location", "City and country"],
  ["date_of_birth", "Date of birth"], ["age", "Age"], ["gender", "Gender"], ["niche", "Content niche"],
  ["about", "Her bio"], ["profile_link", "Her Linkable profile link"],
];

export const QUESTION_FIELDS = [
  ...PROFILE_FIELDS.map(([value, label]) => ({ value, label })),
  { value: "pitch", label: "Her pitch" },
  { value: "also_asks", label: "Also asks (she answers)" },
  { value: "skip", label: "Leave blank" },
];

export const NICHES = [
  ["BEAUTY_SKINCARE", "Beauty & Skincare"], ["FASHION_ACCESSORIES", "Fashion & Accessories"],
  ["HEALTH_WELLNESS", "Health & Wellness"], ["FITNESS_SPORTS", "Fitness & Sports"], ["FOOD_BEVERAGE", "Food & Beverage"],
  ["HOME_LIVING", "Home & Living"], ["PETS", "Pets"], ["BABY_PARENTING", "Baby & Parenting"], ["TECHNOLOGY", "Technology"],
  ["TRAVEL", "Travel"], ["OUTDOOR_ADVENTURE", "Outdoor & Adventure"], ["LUXURY", "Luxury"], ["GAMING", "Gaming"],
  ["ENTERTAINMENT", "Entertainment"], ["ART_DESIGN", "Art & Design"], ["DIY_CRAFTS", "DIY & Crafts"],
  ["EDUCATION", "Education"], ["FINANCE", "Finance"], ["SUSTAINABILITY_ECO", "Sustainability & Eco-Friendly"], ["OTHER", "Other"],
];

const quote = (s) => `“${s}”`;

/** What stops a draft going live, as the main app checks it (approveRefusal). */
export function draftProblems(draft, form) {
  const out = [];
  if (!String(draft?.brand_name || "").trim()) out.push("Add the brand’s name.");
  if (!String(draft?.product_title || "").trim()) out.push("Add the product (the campaign’s title).");
  const fields = new Map((draft?.questions || []).map((q) => [q.entry, q.field]));
  for (const f of form?.fields || []) {
    if (f.required && (fields.get(f.entry) || "also_asks") === "skip") {
      out.push(`${quote(f.title)} is required: map it to a profile field or ${quote("also asks")}.`);
    }
  }
  return out;
}

export function parseJSON(raw, fallback) {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

/** "GB, AE" -> ["GB", "AE"]; "uk" reads as GB. */
export function countryList(text) {
  return String(text || "").split(/[\s,|]+/).map((c) => c.trim().toUpperCase()).filter(Boolean)
    .map((c) => (c === "UK" ? "GB" : c)).filter((c) => /^[A-Z]{2}$/.test(c));
}

export function wordList(text) {
  return String(text || "").split(/[,|]+/).map((p) => p.trim().toLowerCase()).filter(Boolean);
}
