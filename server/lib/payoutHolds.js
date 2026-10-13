// Holding and releasing a creator's payouts (main app payments part 2, #377:
// eng_payouts_page 2). While a hold is open the main app transfers nothing
// more to her: commission payouts are not charged and fees the brand already
// paid wait with the platform. Releasing lets the next runs pay as usual.
//
// The main app owns this, so ops asks it: HoldCreatorPayouts /
// ReleaseCreatorPayouts on UsersService, signed with the service token
// (lib/mainAppGrpc.js), which those RPCs accept from "our own server
// (linkable-ops)" and record under the actor we pass. Release in particular
// does more than flip a row: it settles the fees that were waiting straight
// away.
//
// Where the service key is not configured, the same rows are written here
// with the RPCs' own SQL (service-grpc/services/payments_holds.go), with the
// ops admin's email as held_by / released_by. The one difference: the RPC
// settles waiting fees during the call, while here they are only marked due
// (next_attempt_at = now) and the main app's fee tick (RunFeeTick) pays them
// on its next run.
import { cloudSqlQuery, getCloudSqlPool, currentDbTarget } from "./cloudsql.js";
import { mainAppSchema } from "./mainAppSchema.js";
import { mainAppGrpcConfigured, unaryCall, encodeStrings, decodeStrings, GrpcError, GRPC } from "./mainAppGrpc.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function requireHolds(target) {
  const schema = await mainAppSchema(target);
  if (!schema.payoutHolds) {
    throw fail(409, "This database has no payout holds yet. They arrive with the next promotion.");
  }
}

// The select holdRow() uses in payments_holds.go, so both paths return the same shape.
const HOLD_SELECT = `
  SELECT h.id::text, h.creator_user_id::text,
         COALESCE(NULLIF(TRIM(COALESCE(i.first_name, '') || ' ' || COALESCE(i.last_name, '')), ''),
                  NULLIF(i.instagram_username, ''), u.email, '') AS creator_name,
         h.reason, h.held_by, h.held_at, h.released_by, h.released_at
    FROM payout_holds h
    JOIN users u ON u.id = h.creator_user_id
    LEFT JOIN influencers i ON i.user_id = h.creator_user_id AND i.deleted = '-infinity'`;

const iso = (v) => (v ? new Date(v).toISOString() : null);
const shapeRow = (r) => ({
  id: r.id, creator_user_id: r.creator_user_id, creator_name: r.creator_name,
  reason: r.reason, held_by: r.held_by, held_at: iso(r.held_at),
  released_by: r.released_by || "", released_at: iso(r.released_at),
});

// PayoutHold (proto/payments.proto) field numbers.
const fromProto = (m) => ({
  id: m[1] || "", creator_user_id: m[2] || "", creator_name: m[3] || "", reason: m[4] || "",
  held_by: m[5] || "", held_at: m[6] || null, released_by: m[7] || "", released_at: m[8] || null,
});

const HTTP_FOR_GRPC = {
  [GRPC.INVALID_ARGUMENT]: 400, [GRPC.NOT_FOUND]: 404, [GRPC.FAILED_PRECONDITION]: 409, [GRPC.PERMISSION_DENIED]: 403,
};

async function callRpc(method, creatorUserId, reason, actor, target) {
  // PayoutHoldRequest: creator_user_id = 1, reason = 2, actor = 3.
  const body = encodeStrings({ 1: creatorUserId, 2: reason, 3: actor });
  try {
    const bytes = await unaryCall(`/proto.UsersService/${method}`, body, { target });
    return fromProto(decodeStrings(bytes));
  } catch (err) {
    if (err instanceof GrpcError) {
      if (err.grpcCode === GRPC.UNIMPLEMENTED) return null; // that deployment predates holds: use SQL
      if (HTTP_FOR_GRPC[err.grpcCode]) throw fail(HTTP_FOR_GRPC[err.grpcCode], err.message);
      if (err.grpcCode === GRPC.UNAUTHENTICATED) {
        throw fail(502, "The main app refused ops' service token. Check MAIN_APP_SERVICE_KEY.");
      }
      throw fail(502, err.message || "The main app could not do that. Try again.");
    }
    throw err;
  }
}

// The creator's open hold (or null) and her recent holds, newest first.
export async function payoutHoldState(creatorUserId, target = currentDbTarget()) {
  if (!UUID.test(creatorUserId)) throw fail(400, "Choose a creator to hold or release.");
  const schema = await mainAppSchema(target);
  if (!schema.payoutHolds) return { available: false, on_hold: false, hold: null, history: [] };
  const { rows } = await cloudSqlQuery(
    `${HOLD_SELECT} WHERE h.creator_user_id = $1::uuid
      ORDER BY (h.released_at IS NULL) DESC, h.held_at DESC LIMIT 10`,
    [creatorUserId], target,
  );
  const history = rows.map(shapeRow);
  const hold = history.find((h) => !h.released_at) || null;
  return { available: true, on_hold: !!hold, hold, history, via: mainAppGrpcConfigured() ? "rpc" : "sql" };
}

export async function holdCreatorPayouts(creatorUserId, reason, admin, target = currentDbTarget()) {
  if (!UUID.test(creatorUserId)) throw fail(400, "Choose a creator to hold or release.");
  await requireHolds(target);
  const actor = admin?.email || "linkable-ops";
  const why = String(reason || "").trim();
  if (!why) throw fail(400, "Say why the payouts are held. The reason is kept with the hold.");

  if (mainAppGrpcConfigured()) {
    const hold = await callRpc("HoldCreatorPayouts", creatorUserId, why, actor, target);
    if (hold) {
      console.log(`[payout-hold] via=rpc target=${target} admin=${actor} creator=${creatorUserId} hold=${hold.id}`);
      return { ...hold, via: "rpc" };
    }
  }

  // HoldCreatorPayouts' SQL: one open hold at a time, holding again returns it.
  const { rows: found } = await cloudSqlQuery(
    `SELECT EXISTS (SELECT 1 FROM users WHERE id::text = $1) AS ok`, [creatorUserId], target,
  );
  if (!found[0]?.ok) throw fail(404, "We couldn’t find this creator.");
  await cloudSqlQuery(
    `INSERT INTO payout_holds (creator_user_id, reason, held_by)
     VALUES ($1::uuid, $2, $3)
     ON CONFLICT (creator_user_id) WHERE released_at IS NULL DO NOTHING`,
    [creatorUserId, why, actor], target,
  );
  const { rows } = await cloudSqlQuery(
    `${HOLD_SELECT} WHERE h.creator_user_id::text = $1 AND h.released_at IS NULL`, [creatorUserId], target,
  );
  const hold = shapeRow(rows[0]);
  console.log(`[payout-hold] via=sql target=${target} admin=${actor} creator=${creatorUserId} hold=${hold.id}`);
  return { ...hold, via: "sql" };
}

export async function releaseCreatorPayouts(creatorUserId, admin, target = currentDbTarget()) {
  if (!UUID.test(creatorUserId)) throw fail(400, "Choose a creator to hold or release.");
  await requireHolds(target);
  const actor = admin?.email || "linkable-ops";

  if (mainAppGrpcConfigured()) {
    const hold = await callRpc("ReleaseCreatorPayouts", creatorUserId, "", actor, target);
    if (hold) {
      console.log(`[payout-release] via=rpc target=${target} admin=${actor} creator=${creatorUserId} hold=${hold.id}`);
      return { ...hold, via: "rpc" };
    }
  }

  // ReleaseCreatorPayouts' SQL, in one transaction. The RPC then settles each
  // waiting fee during the call; here they are marked due now and the main
  // app's fee tick settles them on its next run.
  const schema = await mainAppSchema(target);
  const pool = await getCloudSqlPool(target);
  const client = await pool.connect();
  let holdId, feesDue = 0;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE payout_holds SET released_at = current_timestamp, released_by = $2
        WHERE creator_user_id::text = $1 AND released_at IS NULL RETURNING id::text`,
      [creatorUserId, actor],
    );
    if (!rows.length) throw fail(409, "This creator’s payouts aren’t on hold.");
    holdId = rows[0].id;
    if (schema.creatorFeeCharges) {
      const fees = await client.query(
        `UPDATE creator_fee_charges SET next_attempt_at = current_timestamp, updated = current_timestamp
          WHERE creator_user_id::text = $1 AND status = 'charged'`,
        [creatorUserId],
      );
      feesDue = fees.rowCount;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  const { rows } = await cloudSqlQuery(`${HOLD_SELECT} WHERE h.id::text = $1`, [holdId], target);
  console.log(`[payout-release] via=sql target=${target} admin=${actor} creator=${creatorUserId} hold=${holdId} fees_due=${feesDue}`);
  return { ...shapeRow(rows[0]), via: "sql", fees_due: feesDue };
}
