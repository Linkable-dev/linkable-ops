const BASE = "/api";

import { supabase } from "./supabase";

async function request(path, options = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  const headers = { "Content-Type": "application/json", ...options.headers };
  if (session?.access_token) headers["Authorization"] = `Bearer ${session.access_token}`;
  const res = await fetch(`${BASE}${path}`, { headers, ...options });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// Builds query string supporting filter[col]=val syntax
function buildQs(params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (k === "filters" && typeof v === "object") {
      for (const [col, val] of Object.entries(v)) {
        if (val) qs.set(`filter[${col}]`, val);
      }
    } else {
      qs.set(k, v);
    }
  }
  return qs.toString();
}

export const api = {
  getTables: () => request("/tables"),
  getSchema: (table) => request(`/tables/${table}/schema`),
  getRows: (table, params = {}) => request(`/tables/${table}/rows?${buildQs(params)}`),
  getRow: (table, id) => request(`/tables/${table}/rows/${id}`),
  createRow: (table, data) =>
    request(`/tables/${table}/rows`, { method: "POST", body: JSON.stringify(data) }),
  updateRow: (table, id, data) =>
    request(`/tables/${table}/rows/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteRow: (table, id) =>
    request(`/tables/${table}/rows/${id}`, { method: "DELETE" }),

  // FK helpers
  getFkOptions: (table) => request(`/tables/${table}/fk-options`),
  resolveFks: (table, ids) =>
    request(`/tables/${table}/resolve-fks`, { method: "POST", body: JSON.stringify({ ids }) }),
  getDistinct: (table, column) => request(`/tables/${table}/distinct/${column}`),
  getDateRange: (table, column) => request(`/tables/${table}/date-range/${column}`),

  getOverview: () => request("/analytics/overview"),
  getTableAnalytics: (table) => request(`/analytics/${table}`),

  // Operations
  getOpsCampaigns: ({ limit = 25, offset = 0, search = "" } = {}) =>
    request(`/ops/campaigns?${buildQs({ limit, offset, search })}`),
  getOpsCampaignCreators: (id) => request(`/ops/campaigns/${id}/creators`),
};

// Helpers for formatting
export function friendlyName(str) {
  if (!str) return "";
  return str
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function friendlyDate(val) {
  if (!val) return "";
  const d = new Date(val);
  if (isNaN(d)) return String(val);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function friendlyNumber(val) {
  if (val === null || val === undefined) return "";
  const n = Number(val);
  if (isNaN(n)) return String(val);
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
