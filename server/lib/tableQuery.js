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

// ---------------------------------------------------------------- operators
//
// A filter value stays ONE string on the wire (filter[col]=…), so adding
// operators needed no new endpoint params and old links keep working: a bare
// value still means "contains" for text and ">=" for numbers, exactly as
// before. The column-filter popover in the UI writes these forms.
//
//   text    contains:foo | is:foo | starts:foo | ends:foo | empty | notempty
//           (a bare value is "contains")
//   number  >=10 | <=10 | >10 | <10 | =10 | 10..20   (a bare value is ">=")
//   date    last:30 | before:30 | >=2026-01-01 | <=2026-01-01
//           | 2026-01-01..2026-02-01 | empty | notempty

const TEXT_OPS = new Set(["contains", "is", "starts", "ends"]);

// Splits "op:value" into [op, value]; anything else is [null, raw].
function splitOp(raw, allowed) {
  const m = String(raw).match(/^([a-z]+):([\s\S]*)$/i);
  if (!m) return [null, String(raw)];
  const op = m[1].toLowerCase();
  return allowed.has(op) ? [op, m[2]] : [null, String(raw)];
}

const isBlank = (exprs) =>
  `(${exprs.map((e) => `COALESCE(${e}::text, '') = ''`).join(" AND ")})`;

// Case-insensitive text match across one or more SQL expressions.
// Bare input keeps the original "contains" behaviour.
export const textFilter = (...exprs) => (params, raw) => {
  const value = String(raw);
  if (value === "empty") return isBlank(exprs);
  if (value === "notempty") return `NOT ${isBlank(exprs)}`;

  const [op, term] = splitOp(value, TEXT_OPS);
  if (!term) return null;

  // "is" is a true equality test, so a term containing % or _ can't act as a
  // wildcard the way it would through ILIKE.
  if (op === "is") {
    params.push(term);
    const ph = `$${params.length}`;
    return `(${exprs.map((e) => `LOWER(${e}::text) = LOWER(${ph})`).join(" OR ")})`;
  }

  const pattern = op === "starts" ? `${term}%` : op === "ends" ? `%${term}` : `%${term}%`;
  params.push(pattern);
  const ph = `$${params.length}`;
  return `(${exprs.map((e) => `${e} ILIKE ${ph}`).join(" OR ")})`;
};

// Numeric filter with comparison operators and ranges.
// Ignores input that carries no usable number.
export const numberFilter = (expr) => (params, raw) => {
  const value = String(raw).trim();

  const range = value.match(/^(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)$/);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    params.push(Math.min(lo, hi), Math.max(lo, hi));
    return `${expr} BETWEEN $${params.length - 1} AND $${params.length}`;
  }

  const cmp = value.match(/^(>=|<=|>|<|=)?\s*(-?[\d.]+)$/);
  if (!cmp) {
    // Legacy tolerance: strip stray characters ("≥ 1,000") and treat as ">=".
    const n = Number(value.replace(/[^\d.-]/g, ""));
    if (!Number.isFinite(n) || value.replace(/[^\d]/g, "") === "") return null;
    params.push(n);
    return `${expr} >= $${params.length}`;
  }
  const n = Number(cmp[2]);
  if (!Number.isFinite(n)) return null;
  params.push(n);
  return `${expr} ${cmp[1] || ">="} $${params.length}`;
};

// Kept as the original name so existing endpoint whitelists don't have to
// change; a bare number still means ">= N".
export const minNumberFilter = numberFilter;

// Date/timestamp filter. `expr` must be a timestamptz/date SQL expression.
// "last:N" and "before:N" are relative to NOW(), which is what an operator
// actually wants ("not signed in for 30 days").
export const dateFilter = (expr) => (params, raw) => {
  const value = String(raw).trim();

  if (value === "empty") return `${expr} IS NULL`;
  if (value === "notempty") return `${expr} IS NOT NULL`;

  const rel = value.match(/^(last|before):(\d{1,5})$/i);
  if (rel) {
    const days = Number(rel[2]);
    if (!Number.isFinite(days)) return null;
    params.push(days);
    return rel[1].toLowerCase() === "last"
      ? `${expr} >= NOW() - ($${params.length} || ' days')::interval`
      : `(${expr} IS NULL OR ${expr} < NOW() - ($${params.length} || ' days')::interval)`;
  }

  const DAY = /\d{4}-\d{2}-\d{2}/;
  const range = value.match(new RegExp(`^(${DAY.source})\\s*\\.\\.\\s*(${DAY.source})$`));
  if (range) {
    params.push(range[1], range[2]);
    // End of the closing day, so "to 3 March" includes 3 March.
    return `(${expr} >= $${params.length - 1}::date AND ${expr} < ($${params.length}::date + INTERVAL '1 day'))`;
  }

  const cmp = value.match(new RegExp(`^(>=|<=|>|<)?\\s*(${DAY.source})$`));
  if (!cmp) return null;
  params.push(cmp[2]);
  const ph = `$${params.length}`;
  switch (cmp[1]) {
    case "<=": return `${expr} < (${ph}::date + INTERVAL '1 day')`;
    case "<":  return `${expr} < ${ph}::date`;
    case ">":  return `${expr} >= (${ph}::date + INTERVAL '1 day')`;
    default:   return `${expr} >= ${ph}::date`;
  }
};

// Boolean filter: "yes" / "no" against a boolean SQL expression.
export const boolFilter = (expr) => (_params, raw) => {
  const v = String(raw).toLowerCase();
  if (v === "yes" || v === "true") return `COALESCE(${expr}, false) = true`;
  if (v === "no" || v === "false") return `COALESCE(${expr}, false) = false`;
  return null;
};

// Fixed-choice filter: maps an option value to a constant SQL condition.
// Unknown options are ignored. No bind params — conditions are server-authored.
export const enumFilter = (cases) => (_params, raw) => cases[raw] || null;
