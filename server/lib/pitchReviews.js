// Pitch review (main app QA 112, 22 Oct): a creator's first three pitches
// wait for the Linkable team before they go out. The main app owns the
// queue and the send, so ops asks it: ListPitchReviews, ApprovePitchReview
// (sends the pitch at once, through the same path and daily cap as every
// pitch) and RejectPitchReview (the reason is what the creator reads), each
// signed with ops' own service key (lib/mainAppGrpc.js), which the gRPC
// server accepts for these RPCs and the payments admin only.
//
// There is no SQL fallback: approving sends an email to a brand, which only
// the main app may do. Without the key the tab says so.
//
// Never link to the brand's proposal (/p/<token>): the main app counts any
// browser visit there as the brand viewing it and emails the creator.
import { mainAppGrpcConfigured, unaryCall, encodeFields, decodeMessage, GrpcError, GRPC } from "./mainAppGrpc.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// PitchReview (proto/pitch.proto) field numbers.
const REVIEW = {
  1: ["pitch_id", "string"], 2: ["submitted_at", "string"], 3: ["creator_user_id", "string"],
  4: ["creator_name", "string"], 5: ["creator_handle", "string"], 6: ["creator_email", "string"],
  7: ["creator_followers", "int"], 8: ["creator_engagement", "double"], 9: ["creator_about", "string"],
  10: ["creator_media_kit", "string"], 11: ["creator_reviews_passed", "int"], 12: ["creator_review_reset", "string"],
  13: ["brand_id", "string"], 14: ["brand_name", "string"], 15: ["brand_domain", "string"],
  16: ["brand_on_linkable", "bool"], 17: ["contact_email", "string"], 18: ["contact_verified", "bool"],
  19: ["idea", "string"], 20: ["idea_description", "string"], 21: ["product_title", "string"],
  22: ["product_url", "string"], 23: ["product_image", "string"], 24: ["offers", "string"],
  25: ["asks", "string"], 26: ["problems", ["string"]], 27: ["creator_pitches_sent", "int"],
};
const REVIEW_LIST = { 1: ["reviews", { repeated: true, schema: REVIEW }], 2: ["total", "int"] };
const DECISION_RESPONSE = { 1: ["status", "string"] };

const HTTP_FOR_GRPC = {
  [GRPC.INVALID_ARGUMENT]: 400, [GRPC.NOT_FOUND]: 404, [GRPC.FAILED_PRECONDITION]: 409,
};

async function call(method, body, target) {
  if (!mainAppGrpcConfigured()) {
    throw fail(503, "Pitch review needs the ops service key (MAIN_APP_SERVICE_KEY) on this server.");
  }
  try {
    return await unaryCall(`/proto.UsersService/${method}`, body, { target });
  } catch (err) {
    if (!(err instanceof GrpcError)) throw err;
    if (err.grpcCode === GRPC.UNIMPLEMENTED) {
      throw fail(409, `The main app on ${target} doesn’t have pitch review yet. It arrives with its next deploy.`);
    }
    if (HTTP_FOR_GRPC[err.grpcCode]) throw fail(HTTP_FOR_GRPC[err.grpcCode], err.message);
    if (err.grpcCode === GRPC.UNAUTHENTICATED || err.grpcCode === GRPC.PERMISSION_DENIED) {
      throw fail(502, "The main app refused ops’ service token for pitch review. MAIN_APP_SERVICE_KEY must be the ops private key whose public half is in the gRPC service’s SERVICE_PUBLIC_KEYS (ops=…), and the gRPC service must be on a version with pitch review.");
    }
    throw fail(502, err.message || "The main app could not do that. Try again.");
  }
}

// The queue, oldest first, server-paged.
export async function listPitchReviews({ limit = 25, offset = 0 } = {}, target) {
  if (!mainAppGrpcConfigured()) {
    return { available: false, reason: "Pitch review needs the ops service key (MAIN_APP_SERVICE_KEY) on this server.", items: [], total: 0 };
  }
  const bytes = await call("ListPitchReviews", encodeFields({ 1: limit, 2: offset }), target);
  const list = decodeMessage(bytes, REVIEW_LIST);
  return { available: true, items: list.reviews, total: list.total };
}

// Approve: sends the pitch now. contactEmail, when the admin changed it, is
// where it goes and becomes the brand's contact.
export async function approvePitchReview(pitchId, { contactEmail = "", admin } = {}, target) {
  if (!UUID.test(String(pitchId || ""))) throw fail(404, "That pitch doesn't exist.");
  const email = String(contactEmail || "").trim().toLowerCase();
  if (email && !EMAIL.test(email)) throw fail(400, "That contact email doesn't look right.");
  // PitchReviewDecision: pitch_id 1, contact_email 2, reason 3, actor 4.
  const bytes = await call("ApprovePitchReview", encodeFields({ 1: pitchId, 2: email, 4: admin?.email || "" }), target);
  const res = decodeMessage(bytes, DECISION_RESPONSE);
  console.log(`[pitch-review] approve target=${target} admin=${admin?.email} pitch=${pitchId} status=${res.status} contact_changed=${!!email}`);
  return res;
}

// Reject: back to the creator with the reason, which she reads.
export async function rejectPitchReview(pitchId, { reason = "", admin } = {}, target) {
  if (!UUID.test(String(pitchId || ""))) throw fail(404, "That pitch doesn't exist.");
  const why = String(reason || "").trim();
  if (!why) throw fail(400, "Write the reason the creator will read.");
  if ([...why].length > 500) throw fail(400, "Keep the reason under 500 characters.");
  const bytes = await call("RejectPitchReview", encodeFields({ 1: pitchId, 3: why, 4: admin?.email || "" }), target);
  const res = decodeMessage(bytes, DECISION_RESPONSE);
  console.log(`[pitch-review] reject target=${target} admin=${admin?.email} pitch=${pitchId}`);
  return res;
}

export const pitchReviewsClient = { list: listPitchReviews, approve: approvePitchReview, reject: rejectPitchReview };
