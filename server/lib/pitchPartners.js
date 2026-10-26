// Pitch Partners (main app QA 132, 26 Oct): creators apply to promote Pitch.
// The main app owns the programme, so ops asks it: ListPitchPartners (the
// queue: applications, videos to check, payouts waiting for the team,
// partners, rejected, removed), DecidePitchPartner (approve gives her 30
// days of Pitch Pro; reject's reason is what she reads; approve_payout lets
// her first or an unusual payout go; remove ends the partnership) and
// VerifyPitchPartnerVideo (live: Pitch Pro to 3 months in all; not found:
// back to her with the reason). Each is signed with ops'
// own service key (lib/mainAppGrpc.js), which the gRPC server accepts for
// these RPCs, the pitch review queue and the payments admin only.
//
// No SQL fallback: approving gives Pitch Pro and can move a paid plan's next
// payment at Stripe, which only the main app may do.
import { mainAppGrpcConfigured, unaryCall, encodeFields, decodeMessage, GrpcError, GRPC } from "./mainAppGrpc.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// PitchPartnerApplication (proto/pitch_partners.proto) field numbers.
export const APPLICATION = {
  1: ["user_id", "string"], 2: ["name", "string"], 3: ["email", "string"], 4: ["main_platform", "string"],
  5: ["main_handle", "string"], 6: ["main_followers", "int"], 7: ["instagram_handle", "string"],
  8: ["tiktok_handle", "string"], 9: ["post_idea", "string"], 10: ["usage_rights", "bool"], 11: ["status", "string"],
  12: ["applied_at", "string"], 13: ["decided_at", "string"], 14: ["decided_by", "string"],
  15: ["reject_reason", "string"], 16: ["video_url", "string"], 17: ["video_status", "string"],
  18: ["video_submitted_at", "string"], 19: ["pro_until", "string"], 20: ["signups", "int"], 21: ["on_pro", "int"],
  22: ["video_note", "string"], 23: ["blocked_earnings", "int"], 24: ["blocked_reason", "string"],
  25: ["payout_review_reason", "string"], 26: ["payout_review_since", "string"], 27: ["payout_review_amount", "string"],
  28: ["payout_review_currency", "string"], 29: ["payout_review_minor", "int"],
};
const LIST = { 1: ["partners", { repeated: true, schema: APPLICATION }], 2: ["total", "int"] };
const DECISION_RESPONSE = { 1: ["status", "string"], 2: ["video_status", "string"], 3: ["pro_until", "string"] };

export const QUEUES = ["applications", "videos", "payouts", "approved", "rejected", "removed"];
// What a decision can be: an application (approve, reject), a payout that
// waits for the team (approve_payout), a partner (remove, with a reason).
export const DECISIONS = ["approve", "reject", "approve_payout", "remove"];

const HTTP_FOR_GRPC = {
  [GRPC.INVALID_ARGUMENT]: 400, [GRPC.NOT_FOUND]: 404, [GRPC.FAILED_PRECONDITION]: 409, [GRPC.UNAVAILABLE]: 503,
};

const NO_KEY = "Pitch Partners needs the ops service key (MAIN_APP_SERVICE_KEY) on this server.";

async function call(method, body, target) {
  if (!mainAppGrpcConfigured()) throw fail(503, NO_KEY);
  try {
    return await unaryCall(`/proto.UsersService/${method}`, body, { target });
  } catch (err) {
    if (!(err instanceof GrpcError)) throw err;
    if (err.grpcCode === GRPC.UNIMPLEMENTED) {
      throw fail(409, `The main app on ${target} doesn’t have Pitch Partners yet. It arrives with its next deploy.`);
    }
    if (HTTP_FOR_GRPC[err.grpcCode]) throw fail(HTTP_FOR_GRPC[err.grpcCode], err.message);
    if (err.grpcCode === GRPC.UNAUTHENTICATED || err.grpcCode === GRPC.PERMISSION_DENIED) {
      throw fail(502, "The main app refused ops’ service token for Pitch Partners. MAIN_APP_SERVICE_KEY must be the ops private key whose public half is in the gRPC service’s SERVICE_PUBLIC_KEYS (ops=…), and the gRPC service must be on a version with Pitch Partners.");
    }
    throw fail(502, err.message || "The main app could not do that. Try again.");
  }
}

// One queue, server-paged: applications and videos oldest first.
export async function listPitchPartners({ queue = "applications", limit = 25, offset = 0 } = {}, target) {
  if (!mainAppGrpcConfigured()) return { available: false, reason: NO_KEY, queue, items: [], total: 0 };
  const q = QUEUES.includes(queue) ? queue : "applications";
  // ListPitchPartnersRequest: queue 1, limit 2, offset 3.
  const bytes = await call("ListPitchPartners", encodeFields({ 1: q, 2: limit, 3: offset }), target);
  const list = decodeMessage(bytes, LIST);
  return { available: true, queue: q, items: list.partners, total: list.total };
}

function reasonOf(decision, reason) {
  const why = String(reason || "").trim();
  if (decision !== "reject" && decision !== "remove") return "";
  if (!why) throw fail(400, "Write the reason the creator will read.");
  if ([...why].length > 500) throw fail(400, "Keep the reason under 500 characters.");
  return why;
}

// Approve (30 days of Pitch Pro) or reject (with the reason she reads) an
// application; approve a payout waiting for the team; remove a partner (no
// new earnings, her ledger is kept; the reason is emailed nowhere, it is
// what her page says).
//
// approve_payout sends the payout as the admin saw it (currency and amount in
// minor units, one per currency waiting); the main app refuses it when the
// amount waiting has changed since.
export async function decidePitchPartner(userId, { decision, reason = "", currency = "", amountMinor = 0, admin } = {}, target) {
  if (!UUID.test(String(userId || ""))) throw fail(404, "That application doesn't exist.");
  if (!DECISIONS.includes(decision)) throw fail(400, "Choose approve or reject.");
  const why = reasonOf(decision, reason);
  const cur = String(currency || "").trim().toLowerCase();
  const amount = Number(amountMinor);
  if (decision === "approve_payout" && (!/^[a-z]{3}$/.test(cur) || !Number.isInteger(amount) || amount <= 0)) {
    throw fail(400, "Reload the queue: this payout's amount is missing.");
  }
  // PitchPartnerDecision: user_id 1, decision 2, reason 3, actor 4, currency 5, amount_minor 6.
  const fields = { 1: userId, 2: decision, 3: why, 4: admin?.email || "" };
  if (decision === "approve_payout") Object.assign(fields, { 5: cur, 6: amount });
  const bytes = await call("DecidePitchPartner", encodeFields(fields), target);
  const res = decodeMessage(bytes, DECISION_RESPONSE);
  console.log(`[pitch-partners] ${decision} target=${target} admin=${admin?.email} user=${userId} status=${res.status}`);
  return res;
}

// Her video: live (verify: Pitch Pro to 3 months in all) or not found
// (reject, with the reason she reads; she can paste another link).
export async function verifyPitchPartnerVideo(userId, { decision, reason = "", admin } = {}, target) {
  if (!UUID.test(String(userId || ""))) throw fail(404, "That partner doesn't exist.");
  if (decision !== "verify" && decision !== "reject") throw fail(400, "Choose live or not found.");
  const why = reasonOf(decision, reason);
  const bytes = await call("VerifyPitchPartnerVideo", encodeFields({ 1: userId, 2: decision, 3: why, 4: admin?.email || "" }), target);
  const res = decodeMessage(bytes, DECISION_RESPONSE);
  console.log(`[pitch-partners] video ${decision} target=${target} admin=${admin?.email} user=${userId} video=${res.video_status}`);
  return res;
}

export const pitchPartnersClient = { list: listPitchPartners, decide: decidePitchPartner, video: verifyPitchPartnerVideo };
