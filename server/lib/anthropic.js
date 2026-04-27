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
  maxTokens = 1024,
  temperature = 0.7,
  apiKey = process.env.ANTHROPIC_API_KEY,
}) {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages,
  };
  if (system) body.system = system;
  if (tools && tools.length) body.tools = tools;

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
