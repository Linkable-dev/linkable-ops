// Shared Claude client. Raw fetch (matches existing personalize.js pattern,
// avoids adding a dep). Adds prompt caching + tool use, which are the two
// features the conversation manager actually needs.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

// One call. `system` may be a plain string or an array of content blocks
// (use the array form to set cache_control on the system prompt — saves
// real money since the Context Prompt is reused on every reply in a thread).
//
// Returns the parsed Anthropic response with two helpers attached:
//   .text        — the first text block, trimmed (or "" if none)
//   .toolCalls   — [{ name, input, id }] from any tool_use blocks
export async function claudeMessage({
  model,
  system,
  messages,
  tools,
  // e.g. { type: "tool", name: "draft_nudge" } to force structured output
  // instead of hoping the model picks the tool on its own.
  toolChoice,
  maxTokens = 1024,
  // Pass null to omit. The 5-series models reject `temperature` outright
  // ("`temperature` is deprecated for this model", HTTP 400), so a caller on
  // one of those must opt out; the 0.7 default is kept for existing callers
  // on older models.
  temperature = 0.7,
  apiKey = process.env.ANTHROPIC_API_KEY,
}) {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const body = {
    model,
    max_tokens: maxTokens,
    messages,
  };
  if (temperature != null) body.temperature = temperature;
  if (system) body.system = system;
  if (tools && tools.length) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API ${res.status}: ${errText}`);
  }

  const data = await res.json();

  const textBlock = data.content?.find((b) => b.type === "text");
  const toolCalls = (data.content || [])
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ name: b.name, input: b.input, id: b.id }));

  data.text = textBlock?.text?.trim() || "";
  data.toolCalls = toolCalls;

  return data;
}

// Helper: build a system value with prompt caching enabled.
// Anthropic charges 25% more on the cached write but 10% on cache reads,
// and the Context Prompt is identical across every reply in a thread, so
// this pays for itself after a single follow-up.
export function cachedSystem(text) {
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}

export function tokenStats(response) {
  const u = response.usage || {};
  return {
    in: u.input_tokens || 0,
    out: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
  };
}

const ANTHROPIC_ADMIN_BASE = "https://api.anthropic.com/v1/organizations";

async function anthropicAdminGet(path, params, apiKey) {
  const res = await fetch(`${ANTHROPIC_ADMIN_BASE}${path}?${params}`, {
    headers: { "anthropic-version": "2023-06-01", "x-api-key": apiKey },
  });
  if (!res.ok) throw new Error(`Anthropic admin API ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

// The cost_report and usage_report endpoints page with next_page/page.
async function paginateReport(path, baseParams, apiKey, onBucket) {
  let page;
  do {
    const params = new URLSearchParams(baseParams);
    if (page) params.set("page", page);
    const data = await anthropicAdminGet(path, params, apiKey);
    for (const bucket of data.data || []) onBucket(bucket);
    page = data.has_more ? data.next_page : null;
  } while (page);
}

// workspaces/api_keys page with after_id/last_id instead.
async function paginateList(path, baseParams, apiKey, onItem) {
  let after;
  do {
    const params = new URLSearchParams(baseParams);
    if (after) params.set("after_id", after);
    const data = await anthropicAdminGet(path, params, apiKey);
    for (const item of data.data || []) onItem(item);
    after = data.has_more ? data.last_id : null;
  } while (after);
}

function monthWindow() {
  const now = new Date();
  return { monthStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), now };
}

// This month's spend across the whole organization — every workspace, every
// product that calls Claude (Autopilot's chat and plans, content generation,
// even the blog writer this file drives). Real billed cost straight from
// Anthropic's own ledger, in USD already, not tokens times a rate we'd have
// to keep in sync with theirs ourselves.
//
// Needs an Admin API key (sk-ant-admin01-...) — a different credential from
// ANTHROPIC_API_KEY above; a normal API key cannot read this endpoint. An
// unset key reads as "not configured" rather than an error: this is a
// reporting nicety, and it must never be the reason the Costs page breaks.
export async function anthropicCostReport({ apiKey = process.env.ANTHROPIC_ADMIN_KEY } = {}) {
  if (!apiKey) return { available: false, amount: 0, currency: "USD" };
  const { monthStart, now } = monthWindow();
  let total = 0;
  let currency = "USD";
  // One bucket per day of the month so far, well under the endpoint's own
  // 31-bucket ceiling — pagination only matters if Anthropic ever changes
  // that, so it is handled rather than assumed away.
  await paginateReport(
    "/cost_report",
    { starting_at: monthStart.toISOString(), ending_at: now.toISOString(), limit: "31" },
    apiKey,
    (bucket) => {
      for (const r of bucket.results || []) {
        total += Number(r.amount || 0);
        currency = r.currency || currency;
      }
    },
  );
  // amount is lowest-currency-units (cents) as a decimal string — "123.45" is $1.2345.
  return { available: true, amount: total / 100, currency };
}

// This month's spend, one line per Workspace — which is how different keys
// end up distinguishable: the Cost API only groups by workspace_id or
// description, never by the key itself, so a key is "tracked" by whichever
// Workspace it lives in. Each amount is real billed USD, same as above; the
// key names are just labels fetched alongside it so a workspace ID reads as
// "service-content" rather than "wrkspc_01Jw...". Two keys sharing one
// Workspace still show as one combined line — Anthropic has no finer split
// than that without estimating cost from tokens ourselves.
export async function anthropicCostByScope({ apiKey = process.env.ANTHROPIC_ADMIN_KEY } = {}) {
  if (!apiKey) return { available: false, scopes: [] };
  const { monthStart, now } = monthWindow();

  const workspaceNames = new Map(); // workspace_id -> name
  await paginateList("/workspaces", { limit: "1000", include_archived: "false" }, apiKey, (w) => {
    workspaceNames.set(w.id, w.name);
  });

  const keysByWorkspace = new Map(); // workspace_id | "" (default/no workspace) -> [key name, ...]
  await paginateList("/api_keys", { limit: "1000", status: "active" }, apiKey, (k) => {
    const wid = k.scope?.type === "workspace" ? k.scope.workspace_id : "";
    if (!keysByWorkspace.has(wid)) keysByWorkspace.set(wid, []);
    keysByWorkspace.get(wid).push(k.name);
  });

  const byWorkspace = new Map(); // workspace_id | "" -> { amount, currency }
  await paginateReport(
    "/cost_report",
    {
      starting_at: monthStart.toISOString(), ending_at: now.toISOString(),
      limit: "31", "group_by[]": "workspace_id",
    },
    apiKey,
    (bucket) => {
      for (const r of bucket.results || []) {
        const wid = r.workspace_id || "";
        const prev = byWorkspace.get(wid) || { amount: 0, currency: r.currency || "USD" };
        prev.amount += Number(r.amount || 0);
        byWorkspace.set(wid, prev);
      }
    },
  );

  // Every workspace that has EITHER spend this month OR a key pointed at it —
  // a $0 scope with a key assigned still belongs on the list, or "nothing
  // spent yet" would be indistinguishable from "not tracked at all".
  const ids = new Set([...byWorkspace.keys(), ...keysByWorkspace.keys()]);
  const scopes = [...ids].map((wid) => {
    const cost = byWorkspace.get(wid);
    return {
      workspace_id: wid || null,
      label: wid ? (workspaceNames.get(wid) || wid) : "Default workspace",
      keys: keysByWorkspace.get(wid) || [],
      amount: (cost?.amount || 0) / 100,
      currency: cost?.currency || "USD",
    };
  }).sort((a, b) => b.amount - a.amount);

  return { available: true, scopes };
}
