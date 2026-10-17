// Stopping one creator fee in its 48 hour hold (main app PR #446, decision 16).
//
// A promotion fee is charged to the brand's card and waits 48 hours after the
// creator's post link before it is sent to her, so a wrong link can be caught.
// Stopping a fee in that window means nothing goes to her and the brand's
// card is refunded in full (fee + 5% service fee).
//
// The main app owns this: StopCreatorFee on UsersService, signed with ops' own
// short-lived service token (lib/mainAppGrpc.js), like Hold / Release payouts.
// Unlike those there is NO SQL fallback: the refund is a Stripe call only the
// main app makes, so without MAIN_APP_SERVICE_KEY ops refuses with a sentence.
//
// The RPC accepts any fee that is charged and not sent to her (status
// 'charged', transferred_minor = 0), including one whose 48 hours are over
// but that is still waiting (her payouts are held, or the next fee run has
// not reached it yet), so the list below shows those too.
import { cloudSqlQuery, currentDbTarget } from "./cloudsql.js";
import { mainAppSchema } from "./mainAppSchema.js";
import { mainAppGrpcConfigured, unaryCall, encodeStrings, decodeFields, GrpcError, GRPC } from "./mainAppGrpc.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const NEEDS_SERVICE_KEY = "Stopping a fee needs the main app connection (MAIN_APP_SERVICE_KEY).";

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const iso = (v) => (v ? new Date(v).toISOString() : null);

// A creator's fees that can be stopped (held), then the ones already stopped.
// Server-side paging; { available: false } where the target's schema predates
// the hold (prod until the promotion).
export async function listCreatorFees(creatorUserId, { limit = 25, offset = 0 } = {}, target = currentDbTarget()) {
  if (!UUID.test(creatorUserId)) throw fail(400, "Choose a creator to see her fees.");
  const schema = await mainAppSchema(target);
  if (!schema.feeStop) return { available: false, can_stop: false, items: [], total: 0 };
  const lim = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const off = Math.max(Number(offset) || 0, 0);
  const reportCols = schema.feeReports
    ? `rep.reason AS report_reason, rep.note AS report_note, rep.created AS reported_at`
    : `NULL::text AS report_reason, NULL::text AS report_note, NULL::timestamptz AS reported_at`;
  const reportJoin = schema.feeReports
    ? `LEFT JOIN LATERAL (
         SELECT r.reason, r.note, r.created FROM payout_reports r
          WHERE r.fee_id = f.id AND r.status = 'open'
          ORDER BY r.created DESC LIMIT 1
       ) rep ON true`
    : "";
  const { rows } = await cloudSqlQuery(
    `SELECT COUNT(*) OVER()::int AS total_count,
            f.id::text AS id, f.link_id::text AS link_id, UPPER(f.currency) AS currency,
            f.fee_minor, f.total_minor, f.transferred_minor, f.status,
            f.charged_at, f.release_at, f.stopped_at, f.stopped_by, f.stop_reason, f.stop_refund_id,
            COALESCE(p.title, '') AS campaign,
            COALESCE(NULLIF(b.store_name, ''), bu.email, '') AS brand_name,
            ${reportCols}
       FROM creator_fee_charges f
       LEFT JOIN links l ON l.id = f.link_id
       LEFT JOIN products p ON p.id = l.product_id
       LEFT JOIN users bu ON bu.id = f.brand_user_id
       LEFT JOIN LATERAL (SELECT store_name FROM brands WHERE user_id = f.brand_user_id LIMIT 1) b ON true
       ${reportJoin}
      WHERE f.creator_user_id = $1::uuid
        AND ((f.status = 'charged' AND f.transferred_minor = 0 AND f.stopped_at IS NULL)
             OR f.stopped_at IS NOT NULL)
      ORDER BY (f.stopped_at IS NULL) DESC, f.release_at ASC NULLS LAST, f.stopped_at DESC
      LIMIT $2 OFFSET $3`,
    [creatorUserId, lim, off], target,
  );
  const items = rows.map((r) => ({
    id: r.id, link_id: r.link_id, currency: r.currency || "",
    fee_minor: Number(r.fee_minor) || 0, total_minor: Number(r.total_minor) || 0,
    status: r.status,
    // held: can be stopped; stopping: stopped, refund retried; stopped: refunded.
    state: !r.stopped_at ? "held" : r.status === "refunded" ? "stopped" : "stopping",
    charged_at: iso(r.charged_at), release_at: iso(r.release_at),
    stopped_at: iso(r.stopped_at), stopped_by: r.stopped_by || "", stop_reason: r.stop_reason || "",
    stop_refund_id: r.stop_refund_id || "",
    campaign: r.campaign, brand_name: r.brand_name,
    report: r.report_reason ? { reason: r.report_reason, note: r.report_note || "", created: iso(r.reported_at) } : null,
  }));
  return {
    available: true,
    can_stop: mainAppGrpcConfigured(),
    items,
    total: rows[0]?.total_count ?? 0,
  };
}

const HTTP_FOR_GRPC = {
  [GRPC.INVALID_ARGUMENT]: 400, [GRPC.NOT_FOUND]: 404, [GRPC.FAILED_PRECONDITION]: 409,
  [GRPC.ABORTED]: 409, [GRPC.PERMISSION_DENIED]: 403,
};

// StopCreatorFeeResponse: fee_id = 1, status = 2 ("refunded" | "stopping"),
// refund_id = 3, refunded_minor = 4 (int64), currency = 5.
export function stopResponseFromProto(m) {
  return {
    fee_id: m[1] || "",
    status: m[2] || "",
    refund_id: m[3] || "",
    refunded_minor: Number(m[4]) || 0,
    currency: (m[5] || "").toUpperCase(),
  };
}

// StopCreatorFeeRequest: fee_id = 1, reason = 2, actor = 3. The main app
// records the authenticated caller as stopped_by; actor is sent for its log.
export function stopRequestBody(feeId, reason, actor) {
  return encodeStrings({ 1: feeId, 2: reason, 3: actor });
}

export async function stopCreatorFee(feeId, reason, actorEmail, target = currentDbTarget()) {
  if (!UUID.test(String(feeId || ""))) throw fail(400, "Choose a fee to stop.");
  if (!mainAppGrpcConfigured()) throw fail(503, NEEDS_SERVICE_KEY);
  const actor = actorEmail || "linkable-ops";
  const why = String(reason || "").trim().slice(0, 600);
  let out;
  try {
    const bytes = await unaryCall("/proto.UsersService/StopCreatorFee", stopRequestBody(feeId, why, actor), { target });
    out = stopResponseFromProto(decodeFields(bytes));
  } catch (err) {
    if (err instanceof GrpcError) {
      // FailedPrecondition / Aborted carry the main app's own sentence.
      if (HTTP_FOR_GRPC[err.grpcCode]) throw fail(HTTP_FOR_GRPC[err.grpcCode], err.message);
      if (err.grpcCode === GRPC.UNIMPLEMENTED) {
        throw fail(409, "The main app here can’t stop fees yet. It arrives with its next release.");
      }
      if (err.grpcCode === GRPC.UNAUTHENTICATED) {
        throw fail(502, "The main app refused ops' service token. MAIN_APP_SERVICE_KEY must be the ops private key whose public half is in the gRPC service's SERVICE_PUBLIC_KEYS (ops=…).");
      }
      throw fail(502, err.message || "The main app couldn’t stop this fee. Try again.");
    }
    throw err;
  }
  console.log(`[fee-stop] target=${target} admin=${actor} fee=${feeId} status=${out.status} refund=${out.refund_id || "-"} refunded_minor=${out.refunded_minor}`);
  return out;
}
