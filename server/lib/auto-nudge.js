// Letting the safe alert rules chase a brand without an operator in the loop.
//
// An unanswered sample request and an unanswered creator application are not
// judgement calls — they are clocks running down while a creator loses
// interest. Those are worth automating. Trials, billing and anything touching
// an account are not, and the allow-list in nudge-writer.js already refuses
// most of them.
//
// Every default here is the cautious one. Nothing is enabled until somebody
// turns it on, per kind, deliberately.

import { cloudSqlQuery } from "./cloudsql.js";
import { isEmailable } from "./nudge-writer.js";

// Ceilings that apply whatever the rules say. They exist so a mistake in the
// alert queries costs a handful of emails rather than the whole brand base.
export const LIMITS = {
  brandsPerRun: 10,
  // A brand does not hear from the robot twice inside this window, however
  // many alerts it accumulates.
  quietDays: 7,
  // How long an alert must have been open before it is chased automatically,
  // so an operator always has the chance to get there first.
  minAgeHours: 24,
};

const tableReady = {};
export async function ensureRulesTable() {
  if (!tableReady.done) {
    tableReady.done = cloudSqlQuery(`
      CREATE TABLE IF NOT EXISTS ops_nudge_rules (
        kind text PRIMARY KEY,
        auto boolean NOT NULL DEFAULT false,
        min_age_hours integer NOT NULL DEFAULT ${LIMITS.minAgeHours},
        updated_by text,
        updated timestamptz NOT NULL DEFAULT NOW()
      )`).catch((e) => { delete tableReady.done; throw e; });
  }
  return tableReady.done;
}

// The kinds that may ever be automated, with whatever has been switched on.
// A kind absent from the table reads as off, so a fresh database automates
// nothing.
export async function loadRules() {
  await ensureRulesTable();
  const { rows } = await cloudSqlQuery(`SELECT kind, auto, min_age_hours, updated_by, updated FROM ops_nudge_rules`);
  const saved = new Map(rows.map((r) => [r.kind, r]));
  return ["shipping", "applications", "sales"].map((kind) => ({
    kind,
    auto: saved.get(kind)?.auto === true,
    min_age_hours: saved.get(kind)?.min_age_hours ?? LIMITS.minAgeHours,
    updated_by: saved.get(kind)?.updated_by || null,
    updated: saved.get(kind)?.updated || null,
  }));
}

export async function setRule({ kind, auto, minAgeHours, by }) {
  await ensureRulesTable();
  if (!["shipping", "applications", "sales"].includes(kind)) {
    throw new Error(`${kind} cannot be automated`);
  }
  const hours = Math.min(Math.max(parseInt(minAgeHours, 10) || LIMITS.minAgeHours, 1), 720);
  await cloudSqlQuery(`
    INSERT INTO ops_nudge_rules (kind, auto, min_age_hours, updated_by, updated)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (kind) DO UPDATE
      SET auto = EXCLUDED.auto, min_age_hours = EXCLUDED.min_age_hours,
          updated_by = EXCLUDED.updated_by, updated = NOW()`,
    [kind, auto === true, hours, by || null]);
  return loadRules();
}

// Brands the robot has written to recently, so it does not write again.
async function recentlyNudged() {
  const { rows } = await cloudSqlQuery(`
    SELECT DISTINCT user_id FROM ops_brand_nudges
    WHERE user_id IS NOT NULL AND created >= NOW() - ($1 || ' days')::interval`,
    [LIMITS.quietDays]).catch(() => ({ rows: [] }));
  return new Set(rows.map((r) => r.user_id));
}

const hoursSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 3_600_000 : Infinity);

// Decides who gets chased. Pure enough to test: it takes the alerts, the
// dismissals, the rules and the recent-nudge set, and returns brands with the
// alerts to cover.
export function selectTargets({ alerts, dismissals = new Map(), rules, alreadyNudged = new Set() }) {
  const enabled = new Map(rules.filter((r) => r.auto).map((r) => [r.kind, r]));
  if (!enabled.size) return [];

  const byBrand = new Map();
  for (const a of alerts) {
    const rule = enabled.get(a.kind);
    if (!rule) continue;
    if (!isEmailable(a)) continue;              // belt and braces over the rule set
    if (!a.brand?.email || !a.brand?.user_id) continue;
    if (alreadyNudged.has(a.brand.user_id)) continue;

    // An operator marking it done or snoozing it is an instruction not to chase.
    const d = dismissals.get(a.key);
    if (d) {
      if (d.until && new Date(d.until) > new Date()) continue;
      if (!d.until && d.fingerprint === a.fingerprint) continue;
    }

    // Give a human the chance to get there first.
    if (hoursSince(a.since) < rule.min_age_hours) continue;

    const key = a.brand.user_id;
    if (!byBrand.has(key)) byBrand.set(key, { brand: a.brand, alerts: [] });
    byBrand.get(key).alerts.push(a);
  }

  // Oldest problem first — those are the creators who have waited longest.
  return [...byBrand.values()]
    .sort((x, y) => new Date(x.alerts[0]?.since || 0) - new Date(y.alerts[0]?.since || 0))
    .slice(0, LIMITS.brandsPerRun);
}
