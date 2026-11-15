// "Hide from Discover" / "Show in Discover" on a campaign (Federico, 15 Nov
// 2026: "is there a button in admin to remove campaigns?"). A hidden
// campaign leaves every creator-facing listing in the main app (Discover and
// its search and filters, the brand's page, launch alert emails, the Pitch
// emails' live campaigns) and creators can no longer apply to it on their
// own. Nothing else changes: its status, billing, links and collaborations
// stay as they are, and the brand still sees and runs it.
//
// The main app owns the switch (SetCampaignOpsHidden in proto/main.proto,
// services/campaign_ops_hidden.go), signed with ops' own service key
// (lib/mainAppGrpc.js). Ops only reads ops_hidden_campaigns for the badge
// and the filter on the Campaigns page (routes/ops.js).
import { mainAppGrpcConfigured, unaryCall, encodeFields, decodeMessage, GrpcError, GRPC } from "./mainAppGrpc.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_CONFIGURED = "Hiding campaigns needs the ops service key (MAIN_APP_SERVICE_KEY) on this server.";

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// CampaignOpsVisibility (proto/products.proto) field numbers.
export const VISIBILITY = {
  1: ["product_id", "string"], 2: ["hidden", "bool"], 3: ["hidden_by", "string"],
  4: ["hidden_at", "string"], 5: ["title", "string"],
};

const HTTP_FOR_GRPC = {
  [GRPC.INVALID_ARGUMENT]: 400, [GRPC.NOT_FOUND]: 404, [GRPC.FAILED_PRECONDITION]: 409,
};

// SetCampaignOpsHiddenRequest: 1 product_id, 2 hidden (a bool: 1, or left
// out for false, as proto3 does), 3 actor (the signed-in admin's email).
export function encodeSetHidden(productId, hidden, actor) {
  return encodeFields({ 1: productId, 2: hidden ? 1 : 0, 3: actor || "" });
}

export async function setCampaignHidden(productId, hidden, { admin } = {}, target) {
  const id = String(productId || "").trim();
  if (!UUID.test(id)) throw fail(404, "We couldn’t find that campaign.");
  if (typeof hidden !== "boolean") throw fail(400, "Say whether to hide the campaign or show it.");
  if (!mainAppGrpcConfigured()) throw fail(503, NOT_CONFIGURED);
  let bytes;
  try {
    bytes = await unaryCall("/proto.UsersService/SetCampaignOpsHidden", encodeSetHidden(id, hidden, admin?.email), { target });
  } catch (err) {
    if (!(err instanceof GrpcError)) throw err;
    if (err.grpcCode === GRPC.UNIMPLEMENTED) {
      throw fail(409, `The main app on ${target} can’t hide campaigns yet. It arrives with its next deploy.`);
    }
    if (HTTP_FOR_GRPC[err.grpcCode]) throw fail(HTTP_FOR_GRPC[err.grpcCode], err.message);
    if (err.grpcCode === GRPC.UNAUTHENTICATED || err.grpcCode === GRPC.PERMISSION_DENIED) {
      throw fail(502, "The main app refused ops’ service token. It must be on a version that can hide campaigns, and MAIN_APP_SERVICE_KEY must be the ops private key.");
    }
    throw fail(502, err.message || "The main app couldn’t do that. Try again.");
  }
  const out = decodeMessage(bytes, VISIBILITY);
  console.info("[ops] campaign visibility changed", { admin: admin?.email, productId: id, hidden: out.hidden, target });
  return out;
}
