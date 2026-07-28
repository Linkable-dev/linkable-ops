// Shared server-side sort/filter plumbing for list endpoints.
//
// Every list endpoint that wants sortable/filterable columns declares two
// whitelists — { sortKey: "sql expression" } and { filterKey: builderFn } —
// and passes req.query through. Nothing from the client ever reaches the SQL
// string directly: sort keys resolve through the whitelist, directions are
// normalized to ASC/DESC, and filter values only ever travel as bind params.
//
// Filter params arrive as filter[column]=value (same convention tables.js
// already uses), so the client can add columns without new endpoint params.

// Extract { column: value } from filter[column]=value query params.
// Express 4's default ("extended"/qs) parser turns those keys into a nested
// object — req.query.filter = { column: value } — so read that form first;
// the flat-key fallback covers servers configured with the simple parser.
export function parseColumnFilters(reqQuery) {
  const filters = {};
  const nested = reqQuery?.filter;
  if (nested && typeof nested === "object") {
    for (const [col, val] of Object.entries(nested)) {
      if (val !== "" && val != null && typeof val !== "object") filters[col] = String(val);
    }
  }
  for (const key of Object.keys(reqQuery || {})) {
    const m = key.match(/^filter\[(.+)\]$/);
    if (m && reqQuery[key] !== "" && reqQuery[key] != null) {
      filters[m[1]] = String(reqQuery[key]);
    }
  }
  return filters;
}

// ORDER BY clause from a whitelisted sort key. `fallback` is the endpoint's
// existing default ordering and doubles as the stable tie-breaker.
// NULLS FIRST on ASC / NULLS LAST on DESC mirrors "null sorts like the
// smallest value" (what the old client-side sorts did with `?? 0`).
export function orderBySql({ sortBy, sortDir } = {}, sorts, fallback) {
  const expr = sorts[sortBy];
  if (!expr) return fallback;
  const dir = String(sortDir).toLowerCase() === "asc" ? "ASC" : "DESC";
  const nulls = dir === "ASC" ? "NULLS FIRST" : "NULLS LAST";
  return `${expr} ${dir} ${nulls}, ${fallback}`;
}

// Turn parsed filters into SQL conditions. Unknown filter keys are ignored
// (an old client build asking for a removed column must not 500). Builders
// push bind values onto `params` and return a condition string, or null to
// skip (e.g. unparseable number input).
export function filterConditions(filters, spec, params) {
  const conds = [];
  for (const [key, raw] of Object.entries(filters)) {
    const build = spec[key];
    if (!build) continue;
    const cond = build(params, raw);
    if (cond) conds.push(cond);
  }
  return conds;
}

// Case-insensitive substring match across one or more SQL expressions.
export const textFilter = (...exprs) => (params, raw) => {
  params.push(`%${raw}%`);
  const ph = `$${params.length}`;
  return `(${exprs.map((e) => `${e} ILIKE ${ph}`).join(" OR ")})`;
};

// Numeric ">= N" filter; ignores input with no digits.
export const minNumberFilter = (expr) => (params, raw) => {
  const n = Number(String(raw).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n)) return null;
  params.push(n);
  return `${expr} >= $${params.length}`;
};

// Fixed-choice filter: maps an option value to a constant SQL condition.
// Unknown options are ignored. No bind params — conditions are server-authored.
export const enumFilter = (cases) => (_params, raw) => cases[raw] || null;
