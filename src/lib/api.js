const BASE = "/api";

import { supabase } from "./supabase";
import { getDbTarget } from "../contexts/DbTargetContext";

async function request(path, options = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  const headers = {
    "Content-Type": "application/json",
    "x-db-target": getDbTarget(),
    ...options.headers,
  };
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
  deleteRows: (table, ids) =>
    request(`/tables/${table}/rows`, { method: "DELETE", body: JSON.stringify({ ids }) }),

  // FK helpers
  getFkOptions: (table) => request(`/tables/${table}/fk-options`),
  resolveFks: (table, ids) =>
    request(`/tables/${table}/resolve-fks`, { method: "POST", body: JSON.stringify({ ids }) }),
  getDistinct: (table, column) => request(`/tables/${table}/distinct/${column}`),
  getDateRange: (table, column) => request(`/tables/${table}/date-range/${column}`),

  getOverview: () => request("/analytics/overview"),
  getTableAnalytics: (table) => request(`/analytics/${table}`),

  // Operations
  getOpsCampaigns: ({ limit = 25, offset = 0, search = "", sortBy = "", sortDir = "" } = {}) =>
    request(`/ops/campaigns?${buildQs({ limit, offset, search, sortBy, sortDir })}`),
  getOpsCampaignCreators: (id) => request(`/ops/campaigns/${id}/creators`),

  // AI conversation manager
  getAiCampaigns: () => request("/conversations/campaigns"),
  getAiCampaign: (id) => request(`/conversations/campaigns/${id}`),
  createAiCampaign: (data) =>
    request("/conversations/campaigns", { method: "POST", body: JSON.stringify(data) }),
  updateAiCampaign: (id, data) =>
    request(`/conversations/campaigns/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  getAiDefaults: () => request("/conversations/defaults"),
  testLabTurn: (data) =>
    request("/conversations/test-lab/turn", { method: "POST", body: JSON.stringify(data) }),
  startAiConversation: (data) =>
    request("/conversations/start", { method: "POST", body: JSON.stringify(data) }),
  listAiThreads: ({ campaign, status, limit } = {}) =>
    request(`/conversations/threads?${buildQs({ campaign, status, limit })}`),
  getAiThread: (id) => request(`/conversations/threads/${id}`),
  startAiBulk: (data) =>
    request("/conversations/bulk-start", { method: "POST", body: JSON.stringify(data) }),
  stopAiBulkRun: (id) =>
    request(`/conversations/bulk-runs/${id}/stop`, { method: "POST" }),
  listAiBulkRuns: ({ limit } = {}) =>
    request(`/conversations/bulk-runs?${buildQs({ limit })}`),
  listAiSuppressions: ({ limit } = {}) =>
    request(`/conversations/suppressions?${buildQs({ limit })}`),
  listAiEvents: ({ limit } = {}) =>
    request(`/conversations/events?${buildQs({ limit })}`),
  getAiMetrics: () => request("/conversations/metrics"),
  unpauseAiCampaign: (id) =>
    request(`/conversations/campaigns/${id}/unpause`, { method: "POST" }),
  discoverLeads: (data) =>
    request("/conversations/discover", { method: "POST", body: JSON.stringify(data) }),
  listAiLeads: ({ country, unused, limit } = {}) =>
    request(`/conversations/leads?${buildQs({ country, unused, limit })}`),

  // Outbound — daily-200 email sequencer dashboard
  listOutboundSends: ({ group, touch, status, scope, limit, offset, q, campaignId, runDate } = {}) =>
    request(`/outbound/sends?${buildQs({ group, touch, status, scope, limit, offset, q, campaign_id: campaignId, run_date: runDate })}`),
  getOutboundSend: (id) => request(`/outbound/sends/${id}`),
  getOutboundStats: ({ scope, campaignId, runDate } = {}) =>
    request(`/outbound/stats?${buildQs({ scope, campaign_id: campaignId, run_date: runDate })}`),
  listOutboundRuns: ({ campaignId } = {}) =>
    request(`/outbound/runs?${buildQs({ campaign_id: campaignId })}`),
  stopOutbound: ({ emails, reason }) =>
    request("/outbound/stop", { method: "POST", body: JSON.stringify({ emails, reason }) }),

  // Outbound inbox — unified manual-triage replies + AI threads. Used by /ai/inbox.
  listOutboundInbox: ({ mode, status, audience, campaignId, q, limit } = {}) =>
    request(`/outbound/inbox?${buildQs({ mode, status, audience, campaign_id: campaignId, q, limit })}`),
  getOutboundInboxManual: (sendId) => request(`/outbound/inbox/manual/${sendId}`),
  handleOutboundInboxManual: (sendId) =>
    request(`/outbound/inbox/manual/${sendId}/handle`, { method: "POST" }),
  unhandleOutboundInboxManual: (sendId) =>
    request(`/outbound/inbox/manual/${sendId}/unhandle`, { method: "POST" }),
  optOutOutboundInboxManual: (sendId, body = {}) =>
    request(`/outbound/inbox/manual/${sendId}/opt-out`, { method: "POST", body: JSON.stringify(body) }),

  // Outbound campaigns
  listOutboundCampaigns: ({ status, limit, offset, audience } = {}) =>
    request(`/outbound/campaigns?${buildQs({ status, limit, offset, audience })}`),
  getOutboundCampaignStatusCounts: () => request("/outbound/campaigns/status-counts"),
  createOutboundCampaign: (data) =>
    request("/outbound/campaigns", { method: "POST", body: JSON.stringify(data) }),
  getOutboundCampaign: (id) => request(`/outbound/campaigns/${id}`),
  updateOutboundCampaign: (id, data) =>
    request(`/outbound/campaigns/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  pauseOutboundCampaign: (id) =>
    request(`/outbound/campaigns/${id}/pause`, { method: "POST" }),
  resumeOutboundCampaign: (id) =>
    request(`/outbound/campaigns/${id}/resume`, { method: "POST" }),
  archiveOutboundCampaign: (id) =>
    request(`/outbound/campaigns/${id}/archive`, { method: "POST" }),
  getOutboundCampaignMetrics: (id) => request(`/outbound/campaigns/${id}/metrics`),
  discoverForOutboundCampaign: (id, body = {}) =>
    request(`/outbound/campaigns/${id}/discover`, { method: "POST", body: JSON.stringify(body) }),
  listOutboundDiscoveryRuns: (id, { limit } = {}) =>
    request(`/outbound/campaigns/${id}/discovery-runs?${buildQs({ limit })}`),
  stopOutboundDiscoveryRun: (runId) =>
    request(`/outbound/discovery-runs/${runId}/stop`, { method: "POST" }),
  getStoreLeadsCategoryPresets: () =>
    request("/outbound/storeleads/category-presets"),
  getStoreLeadsCategories: ({ q } = {}) =>
    request(`/outbound/storeleads/categories?${buildQs({ q })}`),
  listOutboundLeads: ({ q, qualified, limit, offset, country, minRevenue, maxRevenue } = {}) =>
    request(`/outbound/leads?${buildQs({ q, qualified, limit, offset, country, minRevenue, maxRevenue })}`),
  getOutboundLeadCounts: ({ country, minRevenue, maxRevenue } = {}) =>
    request(`/outbound/leads/counts?${buildQs({ country, minRevenue, maxRevenue })}`),

  // Influencer (creator) prospect pool — separate table, but lives under
  // /outbound since it's part of the same campaign system as brand outbound.
  listOutboundCreators: ({ q, qualified, limit, offset, country, minFollowers, maxFollowers, minEngagement } = {}) =>
    request(`/outbound/creators?${buildQs({ q, qualified, limit, offset, country, minFollowers, maxFollowers, minEngagement })}`),
  getOutboundCreatorCounts: () => request("/outbound/creators/counts"),
  syncOutboundCreators: (body = {}) =>
    request("/outbound/creators/sync", { method: "POST", body: JSON.stringify(body) }),

  // Outbound templates
  listOutboundTemplates: (campaignId) =>
    request(`/outbound/campaigns/${campaignId}/templates`),
  createOutboundTemplate: (campaignId, data) =>
    request(`/outbound/campaigns/${campaignId}/templates`, { method: "POST", body: JSON.stringify(data) }),
  seedDefaultOutboundTemplates: (campaignId) =>
    request(`/outbound/campaigns/${campaignId}/templates/seed-defaults`, { method: "POST" }),
  generateOutboundDrafts: (campaignId, body = {}) =>
    request(`/outbound/campaigns/${campaignId}/templates/generate-drafts`, { method: "POST", body: JSON.stringify(body) }),
  updateOutboundTemplate: (id, data) =>
    request(`/outbound/templates/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteOutboundTemplate: (id) =>
    request(`/outbound/templates/${id}`, { method: "DELETE" }),

  // Admin Users — list real users from prod DB and mint impersonation sessions
  listAdminBrands: ({ q, limit, offset } = {}) =>
    request(`/admin-users/brands?${buildQs({ q, limit, offset })}`),
  listAdminCreators: ({ q, limit, offset } = {}) =>
    request(`/admin-users/creators?${buildQs({ q, limit, offset })}`),
  impersonateUser: (userId) =>
    request(`/admin-users/${userId}/impersonate`, { method: "POST" }),
  grantTrial: (userId, body) =>
    request(`/admin-users/${userId}/grant-trial`, { method: "POST", body: JSON.stringify(body) }),
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
  const diff = new Date() - d;
  // Future timestamp (scheduled_at for not-yet-due rows). Without this branch
  // any future date renders as "Just now" because diff < 60000 also matches
  // small negative diffs.
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < 60000)    return "in <1m";
    if (ahead < 3600000)  return `in ${Math.floor(ahead / 60000)}m`;
    if (ahead < 86400000) return `in ${Math.floor(ahead / 3600000)}h`;
    if (ahead < 604800000) return `in ${Math.floor(ahead / 86400000)}d`;
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  if (diff < 60000)     return "Just now";
  if (diff < 3600000)   return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000)  return `${Math.floor(diff / 3600000)}h ago`;
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
