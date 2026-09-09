// The filter grammar from tableQuery.js, applied to a PostgREST query builder.
//
// The Cloud SQL tables and the Supabase tables are filtered by the same UI
// control, so they have to understand the same value strings ("last:30",
// ">=100", "starts:acme"). tableQuery.js compiles them to SQL; this compiles
// them to Supabase query-builder calls. Keep the two in step.

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const endOfDay = (d) => `${d}T23:59:59.999Z`;

// Returns the query builder with the filter applied. An unparseable value
// leaves the query untouched rather than erroring — same as the SQL side,
// where a builder returning null is skipped.
export function applyFilter(q, column, raw, type = "text") {
  const value = String(raw ?? "").trim();
  if (!value) return q;

  if (value === "empty") {
    return type === "text" ? q.or(`${column}.is.null,${column}.eq.`) : q.is(column, null);
  }
  if (value === "notempty") {
    return type === "text" ? q.not(column, "is", null).neq(column, "") : q.not(column, "is", null);
  }

  if (type === "boolean") {
    if (value === "yes" || value === "true") return q.eq(column, true);
    if (value === "no" || value === "false") return q.eq(column, false);
    return q;
  }

  if (type === "text") {
    const m = value.match(/^(contains|is|starts|ends):([\s\S]*)$/i);
    const op = m ? m[1].toLowerCase() : "contains";
    const term = m ? m[2] : value;
    if (!term) return q;
    if (op === "is") return q.ilike(column, term);
    if (op === "starts") return q.ilike(column, `${term}%`);
    if (op === "ends") return q.ilike(column, `%${term}`);
    return q.ilike(column, `%${term}%`);
  }

  if (type === "number") {
    const range = value.match(/^(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)$/);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return q;
      return q.gte(column, Math.min(lo, hi)).lte(column, Math.max(lo, hi));
    }
    const cmp = value.match(/^(>=|<=|>|<|=)?\s*(-?[\d.]+)$/);
    if (!cmp) return q;
    const n = Number(cmp[2]);
    if (!Number.isFinite(n)) return q;
    switch (cmp[1]) {
      case "<=": return q.lte(column, n);
      case ">":  return q.gt(column, n);
      case "<":  return q.lt(column, n);
      case "=":  return q.eq(column, n);
      default:   return q.gte(column, n);
    }
  }

  if (type === "date") {
    const rel = value.match(/^(last|before):(\d{1,5})$/i);
    if (rel) {
      const n = Number(rel[2]);
      if (!Number.isFinite(n)) return q;
      return rel[1].toLowerCase() === "last" ? q.gte(column, daysAgo(n)) : q.lt(column, daysAgo(n));
    }
    const range = value.match(/^(\d{4}-\d{2}-\d{2})\s*\.\.\s*(\d{4}-\d{2}-\d{2})$/);
    if (range) return q.gte(column, range[1]).lte(column, endOfDay(range[2]));
    const cmp = value.match(/^(>=|<=|>|<)?\s*(\d{4}-\d{2}-\d{2})$/);
    if (!cmp || !DAY.test(cmp[2])) return q;
    switch (cmp[1]) {
      case "<=": return q.lte(column, endOfDay(cmp[2]));
      case "<":  return q.lt(column, cmp[2]);
      case ">":  return q.gt(column, endOfDay(cmp[2]));
      default:   return q.gte(column, cmp[2]);
    }
  }

  return q;
}

// Applies every filter in `filters` whose column appears in `spec`
// ({ column: type }). Unknown columns are ignored.
export function applyFilters(q, filters, spec) {
  for (const [col, raw] of Object.entries(filters || {})) {
    if (!spec[col]) continue;
    q = applyFilter(q, col, raw, spec[col]);
  }
  return q;
}
