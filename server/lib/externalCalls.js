// Campaigns from calls (main app QA 171, 12 Nov 2026): brands' Instagram
// posts asking creators to apply through a Google Form. The main app's agent
// drafts them (or ops adds one from a post link and a form link); ops checks
// and edits the draft, then Approve publishes it as a normal campaign, which
// creators apply to in the app while Linkable fills the brand's form. Held
// applications (Google didn't confirm) wait here to retry; each brand's
// applicants are listed for sales outreach.
//
// Everything goes through the main app (services/external_calls*.go), signed
// with ops' own service key (lib/mainAppGrpc.js). There is no SQL path: a
// publish makes a brand, a campaign and copies photos, which only the main
// app may do. Without the key, or on a main app without these RPCs, the page
// says so.
//
// The draft travels as JSON (draft_json, form_json) so this file stays flat.
import { mainAppGrpcConfigured, unaryCall, encodeFields, decodeMessage, GrpcError, GRPC } from "./mainAppGrpc.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ExternalCall (proto/external_calls.proto) field numbers.
export const CALL = {
  1: ["id", "string"], 2: ["status", "string"], 3: ["source", "string"], 4: ["post_url", "string"],
  5: ["form_url", "string"], 6: ["owner_handle", "string"], 7: ["caption", "string"], 8: ["posted_at", "string"],
  9: ["created", "string"], 10: ["brand_name", "string"], 11: ["product_title", "string"], 12: ["image_url", "string"],
  13: ["deadline", "string"], 14: ["closes_at", "string"], 15: ["close_reason", "string"], 16: ["fail_reason", "string"],
  17: ["reject_reason", "string"], 18: ["draft_json", "string"], 19: ["form_json", "string"], 20: ["product_id", "string"],
  21: ["brand_id", "string"], 22: ["applicants", "int"], 23: ["held", "int"], 24: ["approved_at", "string"],
  25: ["closed_at", "string"], 26: ["approved_by", "string"],
};
const CALL_LIST = { 1: ["calls", { repeated: true, schema: CALL }], 2: ["total", "int"] };

export const SUBMISSION = {
  1: ["id", "string"], 2: ["call_id", "string"], 3: ["brand_name", "string"], 4: ["creator_user_id", "string"],
  5: ["creator_name", "string"], 6: ["creator_handle", "string"], 7: ["creator_email", "string"], 8: ["status", "string"],
  9: ["last_error", "string"], 10: ["created", "string"], 11: ["submitted_at", "string"], 12: ["attempts", "int"],
  13: ["product_title", "string"], 14: ["brand_handle", "string"],
};
const SUBMISSION_LIST = { 1: ["submissions", { repeated: true, schema: SUBMISSION }], 2: ["total", "int"] };

export const BRAND = {
  1: ["handle", "string"], 2: ["brand_name", "string"], 3: ["calls", "int"], 4: ["live_calls", "int"],
  5: ["applicants", "int"], 6: ["last_applied_at", "string"], 7: ["brand_id", "string"], 8: ["website", "string"],
};
const BRAND_LIST = { 1: ["brands", { repeated: true, schema: BRAND }], 2: ["total", "int"] };

export const CALL_STATUSES = ["", "reading", "draft", "live", "closed", "rejected", "failed"];
export const SUBMISSION_STATUSES = ["", "sending", "sent", "simulated", "held", "dismissed"];
export const DECISIONS = ["approve", "reject", "close"];

const HTTP_FOR_GRPC = {
  [GRPC.INVALID_ARGUMENT]: 400, [GRPC.NOT_FOUND]: 404, [GRPC.FAILED_PRECONDITION]: 409, 6: 409, // 6 = ALREADY_EXISTS
};

const NO_KEY = "Campaigns from calls need the ops service key (MAIN_APP_SERVICE_KEY) on this server.";

async function call(method, body, target, timeoutMs = 20_000) {
  if (!mainAppGrpcConfigured()) throw fail(503, NO_KEY);
  try {
    return await unaryCall(`/proto.UsersService/${method}`, body, { target, timeoutMs });
  } catch (err) {
    if (!(err instanceof GrpcError)) throw err;
    if (err.grpcCode === GRPC.UNIMPLEMENTED) {
      throw fail(409, `The main app on ${target} doesn’t have campaigns from calls yet. They arrive with its next deploy.`);
    }
    if (HTTP_FOR_GRPC[err.grpcCode]) throw fail(HTTP_FOR_GRPC[err.grpcCode], err.message);
    if (err.grpcCode === GRPC.UNAUTHENTICATED || err.grpcCode === GRPC.PERMISSION_DENIED) {
      throw fail(502, "The main app refused ops’ service token for campaigns from calls. Its SERVICE_PUBLIC_KEYS must hold the ops key and it must be on a version with these RPCs.");
    }
    throw fail(502, err.message || "The main app could not do that. Try again.");
  }
}

function idOf(id) {
  const v = String(id || "").trim();
  if (!UUID.test(v)) throw fail(404, "We couldn’t find that call.");
  return v;
}

const page = (limit, offset) => ({ limit: Math.max(1, Math.min(100, Number(limit) || 25)), offset: Math.max(0, Number(offset) || 0) });

export async function listExternalCalls({ status = "", source = "", limit = 25, offset = 0 } = {}, target) {
  if (!mainAppGrpcConfigured()) return { available: false, reason: NO_KEY, items: [], total: 0 };
  if (!CALL_STATUSES.includes(status)) throw fail(400, "Pick a list.");
  if (!["", "agent", "manual"].includes(source)) throw fail(400, "Pick a source.");
  const p = page(limit, offset);
  const bytes = await call("ListExternalCalls", encodeFields({ 1: status, 2: p.limit, 3: p.offset, 4: source }), target);
  const list = decodeMessage(bytes, CALL_LIST);
  return { available: true, items: list.calls, total: list.total };
}

export async function getExternalCall(id, target) {
  return decodeMessage(await call("GetExternalCall", encodeFields({ 1: idOf(id) }), target), CALL);
}

// Manual add: the Instagram post link and the Google Form link (and the
// caption when the prospector never read the post). The main app checks the
// form and reads the call in the background: it shows "Reading" until done.
export async function addExternalCall({ postUrl, formUrl, caption = "", ownerHandle = "", admin } = {}, target) {
  const post = String(postUrl || "").trim();
  const form = String(formUrl || "").trim();
  if (!/instagram\.com\//i.test(post)) throw fail(400, "Paste the link of the brand’s Instagram post.");
  if (!/(forms\.gle\/|docs\.google\.com\/forms\/)/i.test(form)) throw fail(400, "Paste the link of the brand’s Google Form.");
  if (String(caption).length > 5000) throw fail(400, "Keep the caption under 5,000 characters.");
  const res = decodeMessage(await call("AddExternalCall", encodeFields({
    1: post, 2: form, 3: String(caption || "").trim(), 4: admin?.email || "", 5: String(ownerHandle || "").trim().replace(/^@/, ""),
  }), target), CALL);
  console.log(`[external-calls] add target=${target} admin=${admin?.email} call=${res.id}`);
  return res;
}

export async function updateExternalCall(id, { draft, admin } = {}, target) {
  if (!draft || typeof draft !== "object") throw fail(400, "Nothing to save.");
  const json = JSON.stringify(draft);
  if (json.length > 100_000) throw fail(400, "The draft is too long.");
  return decodeMessage(await call("UpdateExternalCall", encodeFields({ 1: idOf(id), 2: json, 3: admin?.email || "" }), target), CALL);
}

export async function rereadExternalCall(id, { caption = "", admin } = {}, target) {
  return decodeMessage(await call("RereadExternalCall", encodeFields({ 1: idOf(id), 2: String(caption || "").trim(), 3: admin?.email || "" }), target), CALL);
}

export async function setExternalCallImage(id, { imageUrl = "", admin } = {}, target) {
  const url = String(imageUrl || "").trim();
  if (url && !/^https?:\/\//i.test(url)) throw fail(400, "Paste a photo link that starts with https://");
  return decodeMessage(await call("SetExternalCallImage", encodeFields({ 1: idOf(id), 2: url, 3: admin?.email || "" }), target, 50_000), CALL);
}

export async function decideExternalCall(id, { decision, reason = "", admin } = {}, target) {
  if (!DECISIONS.includes(decision)) throw fail(400, "Choose approve, reject or close.");
  if (String(reason).length > 500) throw fail(400, "Keep the reason under 500 characters.");
  const res = decodeMessage(await call("DecideExternalCall", encodeFields({
    1: idOf(id), 2: decision, 3: String(reason || "").trim(), 4: admin?.email || "",
  }), target, 50_000), CALL);
  console.log(`[external-calls] ${decision} target=${target} admin=${admin?.email} call=${res.id} status=${res.status}`);
  return res;
}

export async function listExternalSubmissions({ status = "", callId = "", brandHandle = "", limit = 25, offset = 0 } = {}, target) {
  if (!mainAppGrpcConfigured()) return { available: false, reason: NO_KEY, items: [], total: 0 };
  if (!SUBMISSION_STATUSES.includes(status)) throw fail(400, "Pick a list.");
  if (callId) idOf(callId);
  const p = page(limit, offset);
  const bytes = await call("ListExternalSubmissions", encodeFields({
    1: status, 2: p.limit, 3: p.offset, 4: callId, 5: String(brandHandle || "").replace(/^@/, ""),
  }), target);
  const list = decodeMessage(bytes, SUBMISSION_LIST);
  return { available: true, items: list.submissions, total: list.total };
}

export async function actOnExternalSubmission(id, { action, admin } = {}, target) {
  if (!["retry", "dismiss"].includes(action)) throw fail(400, "Choose retry or dismiss.");
  const v = String(id || "").trim();
  if (!UUID.test(v)) throw fail(404, "We couldn’t find that application.");
  const res = decodeMessage(await call("ActOnExternalSubmission", encodeFields({ 1: v, 2: action, 3: admin?.email || "" }), target, 50_000), SUBMISSION);
  console.log(`[external-calls] submission ${action} target=${target} admin=${admin?.email} id=${v} status=${res.status}`);
  return res;
}

export async function listExternalCallBrands({ limit = 25, offset = 0 } = {}, target) {
  if (!mainAppGrpcConfigured()) return { available: false, reason: NO_KEY, items: [], total: 0 };
  const p = page(limit, offset);
  const list = decodeMessage(await call("ListExternalCallBrands", encodeFields({ 1: p.limit, 2: p.offset }), target), BRAND_LIST);
  return { available: true, items: list.brands, total: list.total };
}

export const externalCallsClient = {
  list: listExternalCalls,
  get: getExternalCall,
  add: addExternalCall,
  update: updateExternalCall,
  reread: rereadExternalCall,
  image: setExternalCallImage,
  decide: decideExternalCall,
  submissions: listExternalSubmissions,
  act: actOnExternalSubmission,
  brands: listExternalCallBrands,
};
