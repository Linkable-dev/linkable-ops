import { cloudSqlQuery } from "./cloudsql.js";

// The main app's feature switches (service-grpc services/feature_switches.go):
// one row per feature in feature_switches, which the app reads again every
// twenty seconds. This is the team's way to turn a whole feature off, or back
// on, on dev or on production, without a deploy. The app writes the rows (and
// their words) when it starts; here they are only read and flipped.

const KEY = /^[a-z][a-z0-9_]{1,60}$/;

// Postgres "undefined_table": this database's app has no switches yet.
const noTable = (e) => e?.code === "42P01";

export async function listFeatureSwitches(dbTarget, { query = cloudSqlQuery } = {}) {
  try {
    const { rows } = await query(
      `SELECT key, enabled, label, about, updated, updated_by
         FROM feature_switches ORDER BY position, key`,
      [], dbTarget,
    );
    return { switches: rows, ready: true };
  } catch (e) {
    if (noTable(e)) return { switches: [], ready: false };
    throw e;
  }
}

export async function setFeatureSwitch(key, enabled, admin, dbTarget, { query = cloudSqlQuery } = {}) {
  if (!KEY.test(String(key || "")) || typeof enabled !== "boolean") {
    const e = new Error("Choose a feature, and on or off."); e.status = 400; throw e;
  }
  let rows;
  try {
    ({ rows } = await query(
      `UPDATE feature_switches
          SET enabled = $2, updated = NOW(), updated_by = $3
        WHERE key = $1
    RETURNING key, enabled, label, about, updated, updated_by`,
      [key, enabled, admin?.email || ""], dbTarget,
    ));
  } catch (e) {
    if (!noTable(e)) throw e;
    rows = [];
  }
  if (!rows.length) {
    const e = new Error("That feature has no switch on this database yet."); e.status = 404; throw e;
  }
  console.info("[ops] feature switched", { admin: admin?.email, key, enabled, dbTarget });
  return rows[0];
}
