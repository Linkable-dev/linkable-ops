// Instagram's messaging API, for the one thing it allows us: answering a
// brand that wrote to us, within 24 hours of its message. A cold first DM is
// not possible through it, which is why the queue is sent by hand.
//
// Configured with an Instagram API access token for the account the DMs are
// sent from ("Instagram API with Instagram Login", permission
// instagram_business_manage_messages). Unset, every function here says so and
// the page hides the buttons that need it. Setup: docs/instagram-replies.md.
//
// The token lives 60 days. IG_ACCESS_TOKEN is where it starts; the morning
// cron exchanges it for a fresh one every week and keeps that in
// prospector_settings, because a serverless function cannot rewrite its own
// environment. Pasting a new IG_ACCESS_TOKEN still wins: the stored token
// remembers which environment token it grew from.

import crypto from "node:crypto";
import { supabase } from "./supabase.js";

const version = () => process.env.IG_GRAPH_VERSION || "v21.0";
const envToken = () => (process.env.IG_ACCESS_TOKEN || "").trim();

export const TOKEN_KEY = "instagram_token";
export const REFRESH_EVERY_DAYS = 7;
const DAY = 24 * 3600 * 1000;

export const instagramConfigured = () => Boolean(envToken());

export const fingerprint = (token) =>
  crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);

// Which token to use, from the stored record and the environment's token. The
// stored one only counts while it descends from the token set in Vercel now.
export function pickToken(stored, env) {
  if (stored?.token && env && stored.from === fingerprint(env)) return stored.token;
  return env || stored?.token || "";
}

export async function readStoredToken() {
  const { data } = await supabase.from("prospector_settings").select("value")
    .eq("key", TOKEN_KEY).maybeSingle().then((r) => r, () => ({ data: null }));
  return data?.value || null;
}

let cached = null;
async function token() {
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.token;
  const value = pickToken(await readStoredToken(), envToken());
  cached = { token: value, at: Date.now() };
  return value;
}

async function graph(path, { method = "GET", body } = {}) {
  const current = await token();
  if (!current) throw new Error("IG_ACCESS_TOKEN is not set on the ops server");
  const res = await fetch(`https://graph.instagram.com/${version()}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${current}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Instagram ${res.status}: ${json?.error?.message || "request failed"}`);
  return json;
}

// Whether the stored token is due for an exchange: never done, grown from an
// older environment token, or done more than a week ago.
export function refreshDue(stored, env, now = Date.now()) {
  if (!stored?.token || stored.from !== fingerprint(env)) return true;
  const last = Date.parse(stored.refreshed_at || "");
  return !(last && now - last < REFRESH_EVERY_DAYS * DAY);
}

// Exchange the token for one that lives another 60 days. Instagram refuses a
// token younger than a day; that failure is kept and retried the next morning.
export async function refreshInstagramToken({ force = false } = {}) {
  const env = envToken();
  if (!env) return { skipped: "not configured" };
  const stored = await readStoredToken();
  if (!force && !refreshDue(stored, env)) return { skipped: "fresh", expires_at: stored.expires_at };

  const current = pickToken(stored, env);
  const url = `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(current)}`;
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  const keep = stored?.from === fingerprint(env) ? stored : null;
  const value = res.ok && json.access_token
    ? {
      token: json.access_token, from: fingerprint(env), refreshed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + Number(json.expires_in || 0) * 1000).toISOString(), error: null,
    }
    : {
      ...(keep || {}), from: fingerprint(env), error: json?.error?.message || `HTTP ${res.status}`,
      failing_since: keep?.error ? keep.failing_since : new Date().toISOString(),
    };
  const { error } = await supabase.from("prospector_settings")
    .upsert({ key: TOKEN_KEY, value, updated_by: "cron" });
  if (error) throw error;
  cached = null;
  return value.error ? { error: value.error } : { refreshed: true, expires_at: value.expires_at };
}

// Something a person has to do about the token, or null: renewals failing for
// three days, or less than ten days left on it.
export function tokenProblem(stored, now = Date.now()) {
  if (!stored) return null;
  const left = Date.parse(stored.expires_at || "") - now;
  if (left < 10 * DAY) return `the Instagram token expires in ${Math.max(0, Math.floor(left / DAY))} days`;
  const since = Date.parse(stored.failing_since || "");
  if (stored.error && since && now - since > 3 * DAY) return `the Instagram token cannot be renewed (${stored.error})`;
  return null;
}

// The username behind an Instagram-scoped user id, which is all a webhook
// gives us about who wrote.
export async function usernameOf(igsid) {
  const json = await graph(`${encodeURIComponent(igsid)}?fields=username`);
  return String(json.username || "").toLowerCase() || null;
}

export async function sendInstagramMessage(igsid, text) {
  return graph("me/messages", { method: "POST", body: { recipient: { id: igsid }, message: { text } } });
}
