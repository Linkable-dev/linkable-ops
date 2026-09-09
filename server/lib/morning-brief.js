// The five things that changed overnight, emailed to the team.
//
// Everything in the console is pull: somebody has to remember to open it. This
// is the one push, and the rule it follows is that every line names something
// or someone — a brand, a campaign, a number that moved. A digest of totals
// with no names in it is the kind nobody reads twice.

import { cloudSqlQuery } from "./cloudsql.js";
import { buildAlerts, loadDismissals } from "../routes/insights.js";
import { brandHealth } from "./brand-health.js";
import { inboxHealth } from "./deliverability.js";
import { attributionSummary } from "./outbound-attribution.js";
import { sendNudgeEmail } from "./nudge-mailer.js";

const plural = (n, w) => `${n} ${w}${Number(n) === 1 ? "" : "s"}`;

// Where the console lives, if anything actually knows.
export function opsBaseUrl() {
  const explicit = (process.env.OPS_URL || "").trim().replace(/\/+$/, "");
  if (explicit) return /^https?:\/\//.test(explicit) ? explicit : `https://${explicit}`;
  const vercel = (process.env.VERCEL_PROJECT_PRODUCTION_URL || "").trim();
  return vercel ? `https://${vercel}` : null;
}

// Who gets it. Every ops admin unless BRIEF_TO names addresses explicitly.
export async function briefRecipients() {
  const override = (process.env.BRIEF_TO || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  if (override.length) return override;
  const { rows } = await cloudSqlQuery(`SELECT email FROM ops_admins WHERE COALESCE(email,'') <> ''`);
  return rows.map((r) => r.email);
}

// Gathers the brief. Every section is independently best-effort: one broken
// query should cost that section, not the whole email.
export async function gatherBrief() {
  const safe = (p, fallback) => p.catch((e) => { console.warn("[brief]", e.message); return fallback; });

  const [alerts, dismissals, health, inboxes, attribution, money30] = await Promise.all([
    safe(buildAlerts(), []),
    safe(loadDismissals("prod"), new Map()),
    safe(brandHealth({ limit: 200 }), null),
    safe(inboxHealth(), []),
    safe(attributionSummary("prod"), null),
    safe(cloudSqlQuery(`
      SELECT
        (SELECT COUNT(*) FROM users u JOIN brands b ON b.user_id = u.id
          WHERE u.role = 2 AND u.deleted = 'infinity'::timestamptz AND COALESCE(b.hidden,false) = false
            AND u.created >= NOW() - INTERVAL '1 day') AS new_brands,
        (SELECT COUNT(*) FROM orders WHERE deleted = '-infinity'::timestamptz
            AND created >= NOW() - INTERVAL '1 day') AS orders_today,
        (SELECT COUNT(*) FROM sample_requests WHERE deleted = '-infinity'::timestamptz
            AND status IN ('accepted','shipped')) AS samples_accepted,
        (SELECT COUNT(*) FROM sample_requests WHERE deleted = '-infinity'::timestamptz
            AND status = 'shipped') AS samples_shipped`).then((r) => r.rows[0]), null),
  ]);

  const open = alerts.filter((a) => {
    const d = dismissals.get(a.key);
    if (!d) return true;
    if (d.until) return new Date(d.until) <= new Date();
    return d.fingerprint !== a.fingerprint;
  });

  return {
    open,
    danger: open.filter((a) => a.severity === "danger"),
    health,
    // Only inboxes with something wrong are worth a line.
    inboxTrouble: inboxes.filter((b) => b.breaches.length || (!b.is_active && /auto-paused/.test(b.notes || ""))),
    attribution,
    money30,
  };
}

// Plain text. It is read on a phone at 7am, not printed.
export function renderBrief(b, { date = new Date() } = {}) {
  const lines = [];
  const day = date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  lines.push(`Linkable ops — ${day}`, "");

  // 1. What is on fire, with names.
  if (b.danger.length) {
    lines.push(`${plural(b.danger.length, "thing")} need doing now:`);
    for (const a of b.danger.slice(0, 5)) {
      const who = a.brand?.store_name || a.brand?.email || "unknown brand";
      lines.push(`  · ${a.title} — ${who}${a.campaign?.title ? ` (${a.campaign.title})` : ""}`);
    }
    if (b.danger.length > 5) lines.push(`  · and ${b.danger.length - 5} more`);
  } else {
    lines.push("Nothing is on fire. No danger-level alerts open.");
  }
  lines.push(`${b.open.length} alerts open in total.`, "");

  // 2. Creators waiting on a box — the commonest stall.
  if (b.money30) {
    const owed = Math.max(0, Number(b.money30.samples_accepted) - Number(b.money30.samples_shipped));
    if (owed > 0) lines.push(`${plural(owed, "creator")} accepted a sample that has not been sent.`, "");
  }

  // 3. Brands sliding, by name.
  if (b.health?.churnRadar?.length) {
    const falling = b.health.churnRadar.filter((x) => (x.delta ?? 0) < 0);
    const list = (falling.length ? falling : b.health.churnRadar).slice(0, 3);
    lines.push(falling.length ? "Paying brands whose health fell:" : "Paying brands to watch:");
    for (const x of list) {
      const move = x.delta != null && x.delta !== 0 ? ` (${x.delta > 0 ? "+" : ""}${x.delta} overnight)` : "";
      lines.push(`  · ${x.store_name || x.email} — ${x.score}/100${move}: ${x.risks[0] || x.reasons[0] || "no detail"}`);
    }
    lines.push("");
  }

  // 4. Anything new arriving.
  if (b.money30) {
    const bits = [];
    bits.push(`${plural(Number(b.money30.new_brands), "new brand")} signed up`);
    bits.push(`${plural(Number(b.money30.orders_today), "order")} placed`);
    lines.push(`In the last 24 hours: ${bits.join(", ")}.`);
  }
  if (b.attribution?.totals) {
    const t = b.attribution.totals;
    lines.push(t.signups > 0
      ? `Outbound has produced ${plural(t.signups, "signup")} and ${plural(t.paying, "paying brand")} from ${t.sends} sends.`
      : `Outbound: ${t.sends} sends, still no signup attributed to any of them.`);
  }
  lines.push("");

  // 5. Anything broken in the machinery.
  if (b.inboxTrouble.length) {
    lines.push("Sending inboxes needing attention:");
    for (const i of b.inboxTrouble) {
      lines.push(`  · ${i.email} — ${i.breaches.join("; ") || "paused automatically"}${i.is_active ? "" : " (out of the pool)"}`);
    }
    lines.push("");
  }

  // Vercel injects the production domain; OPS_URL overrides it for a custom
  // one. With neither, print no link at all rather than guess a host and send
  // the team somewhere that does not exist.
  const base = opsBaseUrl();
  if (base) {
    lines.push(`Alerts: ${base}/alerts`);
    lines.push(`Brand health: ${base}/health`);
  }
  return lines.join("\n");
}

// Subject carries the headline, so the brief is triageable without opening it.
export function briefSubject(b) {
  if (b.danger.length) return `Linkable ops — ${plural(b.danger.length, "thing")} need doing`;
  if (b.open.length) return `Linkable ops — ${b.open.length} open, nothing urgent`;
  return "Linkable ops — all clear";
}

export async function sendMorningBrief({ dryRun = false } = {}) {
  const brief = await gatherBrief();
  const body = renderBrief(brief);
  const subject = briefSubject(brief);
  const to = await briefRecipients();

  if (dryRun) return { dryRun: true, to, subject, body, sent: 0 };
  if (!to.length) return { error: "no recipients", sent: 0, subject, body };

  const results = [];
  for (const address of to) {
    const r = await sendNudgeEmail({ to: address, subject, body });
    results.push({ to: address, ok: r.success, error: r.error || null });
  }
  return { sent: results.filter((r) => r.ok).length, results, subject, body };
}
