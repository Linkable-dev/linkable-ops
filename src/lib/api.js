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
  // Prospecting (outbound leads from the linkable-prospector pipeline)
  getProspectingLeads: (params = {}) => request(`/prospecting/leads?${buildQs(params)}`),
  getProspectingStats: () => request("/prospecting/stats"),
  getProspectingLead: (handle) => request(`/prospecting/leads/${encodeURIComponent(handle)}`),
  setProspectingDecision: (handle, decision, note) =>
    request(`/prospecting/leads/${encodeURIComponent(handle)}/decision`, {
      method: "POST", body: JSON.stringify({ decision, note }),
    }),
  setProspectingDecisions: (handles, decision, note) =>
    request("/prospecting/leads/decision", {
      method: "POST", body: JSON.stringify({ handles, decision, note }),
    }),

  getProspectingCreators: (params = {}) => request(`/prospecting/creators?${buildQs(params)}`),
  getProspectingCreatorStats: () => request("/prospecting/creators/stats"),
  getProspectingCreatorOutreach: () => request("/prospecting/creators/outreach"),
  getProspectingReplies: (kind) => request(`/prospecting/replies?kind=${kind}`),
  draftProspectingReply: (activityId) =>
    request(`/prospecting/replies/${encodeURIComponent(activityId)}/draft`, { method: "POST" }),
  setProspectingCreatorDecision: (handle, decision, note) =>
    request(`/prospecting/creators/${encodeURIComponent(handle)}/decision`, {
      method: "POST", body: JSON.stringify({ decision, note }),
    }),

  getProspectingCampaigns: () => request("/prospecting/campaigns"),
  createProspectingCampaign: (data) =>
    request("/prospecting/campaigns", { method: "POST", body: JSON.stringify(data) }),
  getProspectingCampaignRuns: (name) =>
    request(`/prospecting/campaigns/${encodeURIComponent(name)}/runs`),
  setProspectingCampaignState: (name, desired_state) =>
    request(`/prospecting/campaigns/${encodeURIComponent(name)}/state`, {
      method: "POST", body: JSON.stringify({ desired_state }),
    }),

  // Blog (articles on www.linkable.link)
  getBlogPosts: ({ status, limit = 25, offset = 0, q } = {}) => request(`/blog/posts?${buildQs({ status, limit, offset, q })}`),
  searchBlogImages: (q) => request(`/blog/images/search?q=${encodeURIComponent(q)}`),
  getBlogPost: (id) => request(`/blog/posts/${id}`),
  createBlogPost: (data) => request("/blog/posts", { method: "POST", body: JSON.stringify(data) }),
  updateBlogPost: (id, data) => request(`/blog/posts/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteBlogPost: (id) => request(`/blog/posts/${id}`, { method: "DELETE" }),
  validateBlogPost: (data) => request("/blog/posts/validate", { method: "POST", body: JSON.stringify(data) }),
  generateBlogPost: (data) => request("/blog/generate", { method: "POST", body: JSON.stringify(data) }),
  deployBlog: () => request("/blog/deploy", { method: "POST", body: "{}" }),
  getBlogTopics: () => request("/blog/topics"),
  createBlogTopic: (data) => request("/blog/topics", { method: "POST", body: JSON.stringify(data) }),
  proposeBlogTopics: () => request("/blog/topics/propose", { method: "POST", body: "{}" }),
  updateBlogTopic: (id, data) => request(`/blog/topics/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteBlogTopic: (id) => request(`/blog/topics/${id}`, { method: "DELETE" }),
  getBlogImages: () => request("/blog/images"),

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
  getHome: () => request("/analytics/home"),
  // Insights: alerts, Brand 360, Home time series, Ask the data, global search
  getAlerts: ({ all } = {}) => request(`/insights/alerts${all ? "?all=1" : ""}`),
  dismissAlerts: (keys, mode = "done", days) => request("/insights/alerts/dismiss", { method: "POST", body: JSON.stringify({ keys, mode, days }) }),
  restoreAlerts: (keys) => request("/insights/alerts/restore", { method: "POST", body: JSON.stringify({ keys }) }),
  // Writes the nudge email for one alert. Sends nothing — sendNudge does that
  // once the operator has read it.
  // One or many keys; several must belong to the same brand and become one email.
  draftNudge: (keys) => request("/insights/alerts/draft", { method: "POST", body: JSON.stringify({ keys: [].concat(keys) }) }),
  // Which alert kinds chase brands automatically (all off until switched on).
  getNudgeRules: () => request("/insights/nudge-rules"),
  setNudgeRule: (kind, auto, minAgeHours) =>
    request("/insights/nudge-rules", { method: "POST", body: JSON.stringify({ kind, auto, minAgeHours }) }),
  sendNudge: ({ keys, subject, body, alsoDone }) =>
    request("/insights/alerts/send", { method: "POST", body: JSON.stringify({ keys: [].concat(keys), subject, body, alsoDone }) }),
  getSavedMetrics: () => request("/insights/metrics"),
  saveMetric: (body) => request("/insights/metrics", { method: "POST", body: JSON.stringify(body) }),
  deleteMetric: (id) => request(`/insights/metrics/${id}`, { method: "DELETE" }),
  getBrand360: (userId) => request(`/insights/brand/${userId}`),
  // Brand health: score per brand, plus the churn radar and trial ranking.
  getBrandHealth: ({ limit = 50 } = {}) => request(`/insights/health?limit=${limit}`),
  getHomeSeries: (range = "90d") => request(`/insights/series?range=${encodeURIComponent(range)}`),
  askData: (question) => request("/insights/ask", { method: "POST", body: JSON.stringify({ question }) }),
  globalSearch: (q) => request(`/insights/search?q=${encodeURIComponent(q)}`),
  getTableAnalytics: (table) => request(`/analytics/${table}`),

  // Operations
  getOpsCampaigns: ({ limit = 25, offset = 0, search = "", sortBy = "", sortDir = "", filters, quick } = {}) =>
    request(`/ops/campaigns?${buildQs({ limit, offset, search, sortBy, sortDir, filters, quick })}`),
  getOpsCampaignCreators: (id) => request(`/ops/campaigns/${id}/creators`),

  // Autopilot: the recruiting machine. Read-only about the AGENT — starting and
  // stopping one goes through the main app's console, which enforces the budget
  // and the send guards this route deliberately cannot reach.
  getAutopilotCampaigns: ({ limit = 50, offset = 0, filters, sortBy, sortDir } = {}) =>
    request(`/autopilot/campaigns?${buildQs({ limit, offset, filters, sortBy, sortDir })}`),
  getAutopilotEvents: (id, { limit = 50 } = {}) =>
    request(`/autopilot/campaigns/${id}/events?${buildQs({ limit })}`),
  // The results: who the searches found, and what came back from them.
  getAutopilotCreators: (id, { limit = 25, offset = 0, state } = {}) =>
    request(`/autopilot/campaigns/${id}/creators?${buildQs({ limit, offset, state })}`),
  getAutopilotReplies: (id, { limit = 25 } = {}) =>
    request(`/autopilot/campaigns/${id}/replies?${buildQs({ limit })}`),
  // The send-side of outreach (sent/opened/clicked), separate from a person
  // writing back.
  getAutopilotEmails: (id, { limit = 25, offset = 0, type } = {}) =>
    request(`/autopilot/campaigns/${id}/emails?${buildQs({ limit, offset, type })}`),
  // The Autopilot conversation that set this campaign up, kept for training —
  // see autopilot_chats. Not the same conversation as outreach: this is the
  // brand talking to Autopilot, before any creator was ever found.
  getAutopilotChats: (id) => request(`/autopilot/campaigns/${id}/chats`),
  // How far the agent may go, and bringing its next check forward. Neither
  // makes it act — the tick still checks the campaign, the allowance and the
  // budget before it spends anything.
  setAutopilotAgent: (id, { mode, goal_applications, max_runs }) =>
    request(`/autopilot/campaigns/${id}/agent`, {
      method: "PUT",
      body: JSON.stringify({ mode, goal_applications, max_runs }),
    }),
  wakeAutopilotAgent: (id) => request(`/autopilot/campaigns/${id}/wake`, { method: "POST" }),

  // The synthetic creator roster. Both writes spend: casting is a model call,
  // rendering is three GPU jobs that change the face on everything generated
  // afterwards.
  getAiCreators: () => request("/ai-creators"),
  castAiCreator: ({ archetype_id, gender }) =>
    request("/ai-creators/cast", {
      method: "POST",
      body: JSON.stringify({ archetype_id, gender }),
    }),
  renderAiCreatorPlates: (id) => request(`/ai-creators/${id}/plates`, { method: "POST" }),

  // What creators delivered, across every brand. Each file comes back with an
  // hour-long signed URL, so the grid can render it directly.
  getContent: ({ q, type, days, brand, product, limit = 24, offset = 0 } = {}) =>
    request(`/content?${buildQs({ q, type, days, brand, product, limit, offset })}`),
  getContentFilters: () => request("/content/filters"),
  // The other half: what the machine made for a campaign, with how the
  // generating went — failures and cost included.
  getGeneratedContent: ({ q, days, brand, product, limit = 24, offset = 0 } = {}) =>
    request(`/content/generated?${buildQs({ q, days, brand, product, limit, offset })}`),

  // Putting content in, on a brand's behalf. The upload is two steps because
  // the bytes go straight to storage — this server never sees them.
  getContentLinks: ({ product, q } = {}) => request(`/content/links?${buildQs({ product, q })}`),
  getContentUploadUrl: ({ link_id, file_name, content_type }) =>
    request("/content/upload-url", {
      method: "POST",
      body: JSON.stringify({ link_id, file_name, content_type }),
    }),
  recordContentUpload: ({ link_id, file_name, size_bytes }) =>
    request("/content/record", {
      method: "POST",
      body: JSON.stringify({ link_id, file_name, size_bytes }),
    }),
  generateContent: (body) =>
    request("/content/generate", { method: "POST", body: JSON.stringify(body) }),

  // The monthly search limit, which IS ours to change: it is the number the
  // agent reads before it acts, not an action taken on a brand's behalf.
  // `scope` is "default" or a brand's user id.
  getAutopilotAllowances: () => request("/autopilot/allowances"),
  getSearchEconomics: () => request("/autopilot/search-economics"),
  // The outreach knobs that used to be env vars and Go constants.
  getProviderCosts: () => request("/autopilot/provider-costs"),
  setProviderCost: (provider, data) => request(`/autopilot/provider-costs/${encodeURIComponent(provider)}`, {
    method: "PUT", body: JSON.stringify(data),
  }),
  clearProviderCost: (provider) => request(`/autopilot/provider-costs/${encodeURIComponent(provider)}`, { method: "DELETE" }),
  // Anthropic's own billed cost for this month, across every product that
  // calls Claude — not just Autopilot. Reads "available: false" rather than
  // erroring when no Admin API key is configured.
  getAnthropicCost: () => request("/costs/anthropic"),
  // The same total, one line per Anthropic Workspace (the finest split their
  // own API offers — see anthropicCostByScope).
  getAnthropicCostByScope: () => request("/costs/anthropic/by-scope"),
  getOutreachSettings: () => request("/autopilot/settings"),
  setOutreachSetting: (key, data) =>
    request(`/autopilot/settings/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  clearOutreachSetting: (key) =>
    request(`/autopilot/settings/${encodeURIComponent(key)}`, { method: "DELETE" }),
  setAutopilotAllowance: (scope, { monthly_searches, note = "" }) =>
    request(`/autopilot/allowances/${scope}`, {
      method: "PUT",
      body: JSON.stringify({ monthly_searches, note }),
    }),
  clearAutopilotAllowance: (userId) =>
    request(`/autopilot/allowances/${userId}`, { method: "DELETE" }),

  // GTM outreach agents: a goal, a budget, a clock — and the two buttons that
  // let an admin drive one by hand.
  getOutboundAgents: ({ limit = 100, offset = 0 } = {}) => request(`/outbound-agents?${buildQs({ limit, offset })}`),
  getOutboundAgent: (id) => request(`/outbound-agents/${id}`),
  createOutboundAgent: (data) =>
    request("/outbound-agents", { method: "POST", body: JSON.stringify(data) }),
  updateOutboundAgent: (id, data) =>
    request(`/outbound-agents/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  runOutboundAgent: (id, { dry = false } = {}) =>
    request(`/outbound-agents/${id}/run${dry ? "?dry=1" : ""}`, { method: "POST", body: "{}" }),
  adoptOutboundCampaigns: () =>
    request("/outbound-agents/adopt", { method: "POST", body: "{}" }),
  // The creator base ranked against one campaign (read-only shortlist).
  getCreatorMatches: (id, { limit = 25 } = {}) => request(`/ops/campaigns/${id}/creator-matches?limit=${limit}`),

  // AI conversation manager
  getAiCampaign: (id) => request(`/conversations/campaigns/${id}`),
  updateAiCampaign: (id, data) =>
    request(`/conversations/campaigns/${id}`, { method: "PUT", body: JSON.stringify(data) }),
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
  listOutboundSends: ({ group, touch, status, scope, limit, offset, q, campaignId, runDate, sortBy, sortDir } = {}) =>
    request(`/outbound/sends?${buildQs({ group, touch, status, scope, limit, offset, q, campaign_id: campaignId, run_date: runDate, sortBy, sortDir })}`),
  getOutboundSend: (id) => request(`/outbound/sends/${id}`),
  getOutboundStats: ({ scope, campaignId, runDate } = {}) =>
    request(`/outbound/stats?${buildQs({ scope, campaign_id: campaignId, run_date: runDate })}`),
  // Outbound revenue attribution: sends joined to the brands they produced.
  getOutboundAttribution: () => request("/outbound/attribution"),
  refreshOutboundAttribution: () => request("/outbound/attribution/refresh", { method: "POST", body: "{}" }),
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
  listOutboundCampaigns: ({ status, limit, offset, audience, sortBy, sortDir, filters } = {}) =>
    request(`/outbound/campaigns?${buildQs({ status, limit, offset, audience, sortBy, sortDir, filters })}`),
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
  listOutboundLeads: ({ q, qualified, limit, offset, country, minRevenue, maxRevenue, sortBy, sortDir } = {}) =>
    request(`/outbound/leads?${buildQs({ q, qualified, limit, offset, country, minRevenue, maxRevenue, sortBy, sortDir })}`),
  getOutboundLeadCounts: ({ country, minRevenue, maxRevenue } = {}) =>
    request(`/outbound/leads/counts?${buildQs({ country, minRevenue, maxRevenue })}`),

  // Influencer (creator) prospect pool — separate table, but lives under
  // /outbound since it's part of the same campaign system as brand outbound.
  listOutboundCreators: ({ q, qualified, limit, offset, country, minFollowers, maxFollowers, minEngagement, listTag } = {}) =>
    request(`/outbound/creators?${buildQs({ q, qualified, limit, offset, country, minFollowers, maxFollowers, minEngagement, listTag })}`),
  getOutboundCreatorCounts: () => request("/outbound/creators/counts"),
  syncOutboundCreators: (body = {}) =>
    request("/outbound/creators/sync", { method: "POST", body: JSON.stringify(body) }),
  importOutboundCreators: (body) =>
    request("/outbound/creators/import", { method: "POST", body: JSON.stringify(body) }),

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
  listAdminBrands: ({ q, limit, offset, sortBy, sortDir, filters } = {}) =>
    request(`/admin-users/brands?${buildQs({ q, limit, offset, sortBy, sortDir, filters })}`),
  listAdminCreators: ({ q, limit, offset, sortBy, sortDir, filters } = {}) =>
    request(`/admin-users/creators?${buildQs({ q, limit, offset, sortBy, sortDir, filters })}`),
  // Soft-deleted brands still within the 30-day recovery window.
  listDeletedBrands: ({ q, limit, offset } = {}) =>
    request(`/admin-users/deleted-brands?${buildQs({ q, limit, offset })}`),
  // Undo a soft-delete (reactivates the brand + cancels the scheduled purge).
  restoreBrand: (userId) =>
    request(`/admin-users/${userId}/restore`, { method: "POST" }),
  // Rule a creator out of applying anywhere, or lift it. A reason is required
  // to set it and is shown wherever the standing is.
  setCreatorDisqualified: (userId, disqualified, reason) =>
    request(`/admin-users/${userId}/disqualify-creator`, {
      method: "POST",
      body: JSON.stringify({ disqualified, reason }),
    }),
  impersonateUser: (userId) =>
    request(`/admin-users/${userId}/impersonate`, { method: "POST" }),
  grantTrial: (userId, body) =>
    request(`/admin-users/${userId}/grant-trial`, { method: "POST", body: JSON.stringify(body) }),
  setStartupProgramme: (userId, enabled) =>
    request(`/admin-users/${userId}/startup-programme`, { method: "POST", body: JSON.stringify({ enabled }) }),
  // Keeps a brand out of the marketplace without deleting it — demo and test
  // accounts. The main app reads brands.hidden.
  setBrandHidden: (userId, hidden) =>
    request(`/admin-users/${userId}/hidden`, { method: "POST", body: JSON.stringify({ hidden }) }),
  // DEV-ONLY hard wipe of a brand + all its data. Server refuses unless the
  // request targets the dev DB.
  wipeBrand: (userId) =>
    request(`/admin-users/${userId}/wipe`, { method: "POST" }),
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
