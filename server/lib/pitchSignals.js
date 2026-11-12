// Pitch signals (main app QA 172, 12 Nov 2026): a brand that asked for
// creators on Instagram without a Google Form (DM us, email us, comment
// below). The main app's agent reads the prospector's creator-call posts,
// keeps the brands' calls that have an email, and shows each brand first in
// Brands to pitch to the creators the post fits; her pitch answers the post.
//
// Here: the list of signals, the manual add (paste the Instagram post link;
// the main app reads it, finds the email and saves a draft), edits, Approve
// (live, under the same 30 day rule and daily check), Hide, Read again, and
// the reply rate of signal pitches against normal ones. All through the main
// app (ListPitchSignals, DraftPitchSignal, UpdatePitchSignal,
// ApprovePitchSignal, HidePitchSignal, RereadPitchSignal,
// GetPitchSignalStats in proto/pitch_signals.proto), signed with ops' own
// service key (lib/mainAppGrpc.js). No SQL fallback: the main app owns the
// read, the picture copy and the email checks.
import { mainAppGrpcConfigured, unaryCall, encodeFields, decodeMessage, GrpcError, GRPC } from "./mainAppGrpc.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// An Instagram post or reel link (with or without the handle, a query string).
const POST_URL = /^https?:\/\/(www\.)?instagram\.com\/([A-Za-z0-9._]+\/)?(p|reel|reels|tv)\/[A-Za-z0-9_-]+/i;
const NOT_CONFIGURED = "Pitch signals need the ops service key (MAIN_APP_SERVICE_KEY) on this server.";

export const SIGNAL_STATUSES = ["live", "draft", "hidden", "dropped"];

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// PitchSignalAdmin (proto/pitch_signals.proto) field numbers.
export const SIGNAL = {
  1: ["id", "string"], 2: ["status", "string"], 3: ["source", "string"], 4: ["hidden_reason", "string"],
  5: ["post_url", "string"], 6: ["posted_at", "string"], 7: ["caption", "string"], 8: ["image_url", "string"],
  9: ["brand_id", "string"], 10: ["brand_name", "string"], 11: ["instagram", "string"], 12: ["website", "string"],
  13: ["wants", "string"], 14: ["spots", "string"], 15: ["asks", "string"], 16: ["offers", "string"],
  17: ["how_to_apply", "string"], 18: ["apply_text", "string"], 19: ["keyword", "string"], 20: ["checklist", ["string"]],
  21: ["contact_email", "string"], 22: ["contact_from", "string"], 23: ["regions", ["string"]], 24: ["niches", ["string"]],
  25: ["min_followers", "int"], 26: ["max_followers", "int"], 27: ["deadline", "string"], 28: ["live_until", "string"],
  29: ["approved_at", "string"], 30: ["approved_by", "string"], 31: ["created", "string"],
  32: ["pitches_sent", "int"], 33: ["replies", "int"], 34: ["note", "string"],
};
export const SIGNAL_LIST = { 1: ["signals", { repeated: true, schema: SIGNAL }], 2: ["total", "int"] };
export const STATS = {
  1: ["rows", { repeated: true, schema: { 1: ["label", "string"], 2: ["sent", "int"], 3: ["replied", "int"], 4: ["reply_rate", "double"] } }],
  2: ["live", "int"],
};

const HTTP_FOR_GRPC = {
  [GRPC.INVALID_ARGUMENT]: 400, [GRPC.NOT_FOUND]: 404, [GRPC.FAILED_PRECONDITION]: 409,
};

async function call(method, body, target) {
  if (!mainAppGrpcConfigured()) throw fail(503, NOT_CONFIGURED);
  try {
    // A manual add reads the post with the model and copies its picture:
    // give it longer than a list.
    return await unaryCall(`/proto.UsersService/${method}`, body, { target, timeoutMs: 90_000 });
  } catch (err) {
    if (!(err instanceof GrpcError)) throw err;
    if (err.grpcCode === GRPC.UNIMPLEMENTED) {
      throw fail(409, `The main app on ${target} doesn’t have pitch signals yet. They arrive with its next deploy.`);
    }
    if (HTTP_FOR_GRPC[err.grpcCode]) throw fail(HTTP_FOR_GRPC[err.grpcCode], err.message);
    if (err.grpcCode === GRPC.UNAUTHENTICATED || err.grpcCode === GRPC.PERMISSION_DENIED) {
      throw fail(502, "The main app refused ops’ service token for pitch signals. The gRPC service must be on a version with pitch signals, and MAIN_APP_SERVICE_KEY must be the ops private key.");
    }
    throw fail(502, err.message || "The main app could not do that. Try again.");
  }
}

const clean = (v, max = 2000) => String(v ?? "").trim().slice(0, max);
const list = (v) => (Array.isArray(v) ? v : String(v ?? "").split(","))
  .map((x) => String(x).trim()).filter(Boolean);
const count = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

// The list, newest first, server-paged. status "" is every signal.
export async function listPitchSignals({ status = "", limit = 25, offset = 0 } = {}, target) {
  if (!mainAppGrpcConfigured()) return { available: false, reason: NOT_CONFIGURED, items: [], total: 0 };
  const s = SIGNAL_STATUSES.includes(status) ? status : "";
  const bytes = await call("ListPitchSignals", encodeFields({ 1: s, 2: limit, 3: offset }), target);
  const res = decodeMessage(bytes, SIGNAL_LIST);
  return { available: true, items: res.signals, total: res.total };
}

// Manual add: the post link (and what the admin pasted when the prospector
// never read the post). The main app answers with a draft, or the signal it
// already has for that post.
export async function draftPitchSignal(input = {}, { admin } = {}, target) {
  const postUrl = clean(input.post_url, 500);
  if (!POST_URL.test(postUrl)) throw fail(400, "Paste the link to the Instagram post, like https://www.instagram.com/p/…");
  const email = clean(input.contact_email, 200).toLowerCase();
  if (email && !EMAIL.test(email)) throw fail(400, "That contact email doesn't look right.");
  const image = clean(input.image_url, 2000);
  if (image && !/^https?:\/\//i.test(image)) throw fail(400, "The picture link must start with https://.");
  // DraftPitchSignalRequest: post_url 1, caption 2, image_url 3, brand_name 4,
  // instagram 5, website 6, contact_email 7, actor 8.
  const bytes = await call("DraftPitchSignal", encodeFields({
    1: postUrl, 2: clean(input.caption, 5000), 3: image, 4: clean(input.brand_name, 200),
    5: clean(input.instagram, 100).replace(/^@/, ""), 6: clean(input.website, 300), 7: email, 8: admin?.email || "",
  }), target);
  const signal = decodeMessage(bytes, SIGNAL);
  console.log(`[pitch-signals] draft target=${target} admin=${admin?.email} post=${postUrl} id=${signal.id} status=${signal.status}`);
  return signal;
}

// The editable fields, encoded as a PitchSignalAdmin (the main app ignores
// every other one).
export function encodeSignalEdit(id, s = {}) {
  const email = clean(s.contact_email, 200).toLowerCase();
  if (email && !EMAIL.test(email)) throw fail(400, "That contact email doesn't look right.");
  const deadline = clean(s.deadline, 10);
  if (deadline && !DATE.test(deadline)) throw fail(400, "Write the deadline as a date, like 2026-11-30.");
  const regions = list(s.regions).map((r) => r.toUpperCase());
  if (regions.some((r) => !/^[A-Z]{2}$/.test(r))) throw fail(400, "Write regions as two-letter country codes, like GB, US.");
  const niches = list(s.niches).map((n) => n.toUpperCase());
  if (niches.some((n) => !/^[A-Z_]+$/.test(n))) throw fail(400, "Write niches as keys, like BEAUTY_SKINCARE, PETS.");
  const min = count(s.min_followers), max = count(s.max_followers);
  if (min && max && min > max) throw fail(400, "The smallest audience is bigger than the largest.");
  const image = clean(s.image_url, 2000);
  if (image && !/^https?:\/\//i.test(image)) throw fail(400, "The picture link must start with https://.");
  return encodeFields({
    1: id, 7: clean(s.caption, 5000), 8: image, 10: clean(s.brand_name, 200),
    11: clean(s.instagram, 100).replace(/^@/, ""), 12: clean(s.website, 300),
    13: clean(s.wants, 300), 14: clean(s.spots, 100), 15: clean(s.asks, 300), 16: clean(s.offers, 300),
    17: clean(s.how_to_apply, 20), 18: clean(s.apply_text, 500), 19: clean(s.keyword, 80),
    20: list(s.checklist).slice(0, 10), 21: email, 23: regions, 24: niches,
    25: min, 26: max, 27: deadline,
  });
}

export async function updatePitchSignal(id, signal, { admin } = {}, target) {
  if (!UUID.test(String(id || ""))) throw fail(404, "That signal doesn't exist.");
  // PitchSignalUpdate: signal 1, actor 2.
  const bytes = await call("UpdatePitchSignal", encodeFields({ 1: encodeSignalEdit(id, signal), 2: admin?.email || "" }), target);
  console.log(`[pitch-signals] update target=${target} admin=${admin?.email} id=${id}`);
  return decodeMessage(bytes, SIGNAL);
}

// PitchSignalAction: id 1, actor 2, reason 3, caption 4, image_url 5.
async function act(method, id, fields, admin, target) {
  if (!UUID.test(String(id || ""))) throw fail(404, "That signal doesn't exist.");
  const bytes = await call(method, encodeFields({ 1: id, 2: admin?.email || "", ...fields }), target);
  const signal = decodeMessage(bytes, SIGNAL);
  console.log(`[pitch-signals] ${method} target=${target} admin=${admin?.email} id=${id} status=${signal.status}`);
  return signal;
}

export const approvePitchSignal = (id, { admin } = {}, target) => act("ApprovePitchSignal", id, {}, admin, target);

export async function hidePitchSignal(id, { reason = "", admin } = {}, target) {
  const why = clean(reason, 600);
  if (!why) throw fail(400, "Write why it's hidden, for the record.");
  if ([...why].length > 300) throw fail(400, "Keep the reason under 300 characters.");
  return act("HidePitchSignal", id, { 3: why }, admin, target);
}

export async function rereadPitchSignal(id, { caption = "", imageUrl = "", admin } = {}, target) {
  const image = clean(imageUrl, 2000);
  if (image && !/^https?:\/\//i.test(image)) throw fail(400, "The picture link must start with https://.");
  return act("RereadPitchSignal", id, { 4: clean(caption, 5000), 5: image }, admin, target);
}

// Reply rate: normal pitches against signal pitches by the signal's age.
export async function pitchSignalStats({ since = "" } = {}, target) {
  if (!mainAppGrpcConfigured()) return { available: false, reason: NOT_CONFIGURED, rows: [], live: 0 };
  const s = DATE.test(String(since)) ? since : "";
  const bytes = await call("GetPitchSignalStats", encodeFields({ 1: s }), target);
  return { available: true, ...decodeMessage(bytes, STATS) };
}

export const pitchSignalsClient = {
  list: listPitchSignals, draft: draftPitchSignal, update: updatePitchSignal, approve: approvePitchSignal,
  hide: hidePitchSignal, reread: rereadPitchSignal, stats: pitchSignalStats,
};
