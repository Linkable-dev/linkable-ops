// What the Instagram DMs did, counted over people rather than messages: of the
// brands written to, how many got a follow-up, answered, and became customers.
// Broken down every way a decision could turn on - vertical, country, which
// variant of the first message, and the week it went - so "is this working,
// and where" has an answer that is not a feeling.

import { supabase } from "./supabase.js";
import { VERTICALS } from "./verticals.js";

const TABLE = "prospector_leads";

function weekOf(iso) {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function funnel(rows) {
  const sent = rows.length;
  const followedUp = rows.filter((r) => r.dm_followup_sent_at).length;
  const replied = rows.filter((r) => r.dm_state === "replied").length;
  const converted = rows.filter((r) => r.converted_at).length;
  const rate = (n) => (sent ? Math.round((n / sent) * 1000) / 10 : 0);
  return { sent, followedUp, replied, converted, replyRate: rate(replied), conversionRate: rate(converted) };
}

function groupBy(rows, keyOf, labelOf = (k) => k) {
  const groups = new Map();
  for (const r of rows) {
    const key = keyOf(r) || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.entries()]
    .map(([key, list]) => ({ key, label: labelOf(key), ...funnel(list) }))
    .sort((a, b) => b.sent - a.sent);
}

const SCORE_BANDS = [
  { key: "1", min: 70, label: "Score 70+" },
  { key: "2", min: 50, label: "Score 50-69" },
  { key: "3", min: 30, label: "Score 30-49" },
  { key: "4", min: 0, label: "Score under 30" },
];
function scoreBand(r) {
  if (r.dm_priority == null) return null;
  return SCORE_BANDS.find((b) => Number(r.dm_priority) >= b.min)?.key || null;
}

export async function dmResults() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("handle,vertical_effective,country,dm_variant,dm_sent_at,dm_followup_sent_at,dm_state,converted_at,dm_priority")
    .not("dm_sent_at", "is", null);
  if (error) throw error;
  const rows = data || [];
  return {
    total: funnel(rows),
    byVertical: groupBy(rows, (r) => r.vertical_effective, (k) => VERTICALS[k] || "Not classified"),
    byCountry: groupBy(rows, (r) => r.country, (k) => (k === "unknown" ? "Unknown" : k)),
    // Replies and sign-ups by conversion-potential score: whether the score
    // predicts anything, and where to move its weights when it does not.
    byScore: groupBy(rows, scoreBand, (k) => SCORE_BANDS.find((b) => b.key === k)?.label || "Not scored")
      .sort((a, b) => a.key.localeCompare(b.key)),
    byVariant: groupBy(rows, (r) => r.dm_variant, (k) => ({ A: "A: Federico's format", B: "B: three lines" }[k] || "Before variants")),
    byWeek: groupBy(rows, (r) => weekOf(r.dm_sent_at), (k) => `Week of ${k}`)
      .sort((a, b) => b.key.localeCompare(a.key)),
    // The brands that became customers, by name: the only line that pays.
    converted: rows.filter((r) => r.converted_at)
      .map((r) => ({ handle: r.handle, converted_at: r.converted_at })),
  };
}
