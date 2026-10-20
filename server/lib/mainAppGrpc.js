// A minimal client for the main app's gRPC service, for the few calls ops
// makes through the app instead of writing rows itself.
//
// No @grpc/grpc-js and no .proto files: the messages ops sends and reads are
// a handful of string fields, so they are encoded here by hand, and gRPC is
// plain HTTP/2 (node:http2).
//
// Auth: ops has its OWN key pair (main app PR #388,
// service-grpc/utils/utils_service_keys.go). Every call carries a fresh
// RS256 JWT in x-service-authorization with {"service":"ops", iat: now,
// exp: now + 5 min}, signed with the ops private key. The gRPC server knows
// the public half from SERVICE_PUBLIC_KEYS ("ops=<base64 PEM>") and accepts
// such a token only for the payments-admin RPCs (HoldCreatorPayouts,
// ReleaseCreatorPayouts, ListPayoutHolds, ListPayoutReports,
// ResolvePayoutReport), and only if exp is at most 15 minutes after iat.
//
// NEVER put the main app's own private key (client/src/lib/server/private.key)
// here: it signs user tokens and would give ops full access to every RPC.
//
// Configuration (server env, Vercel for the deployed panel):
//   MAIN_APP_SERVICE_KEY    the OPS private key (RSA, PEM; "\n" escapes are
//                           accepted so it fits one env line). One key pair per
//                           environment. Unset = no gRPC; callers fall back to
//                           their SQL path.
//   MAIN_APP_GRPC_URL       prod gRPC origin (default: the Cloud Run service)
//   MAIN_APP_GRPC_URL_DEV   dev gRPC origin (default: the dev Cloud Run service)
import http2 from "node:http2";
import crypto from "node:crypto";
import { currentDbTarget } from "./cloudsql.js";

const DEFAULT_URLS = {
  prod: "https://grpc-injxm4ogfq-nw.a.run.app",
  dev: "https://grpc-dev-injxm4ogfq-nw.a.run.app",
};

function serviceKey() {
  const raw = process.env.MAIN_APP_SERVICE_KEY || "";
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

export function mainAppGrpcConfigured() {
  return serviceKey().includes("PRIVATE KEY");
}

function grpcUrl(target) {
  const url = target === "dev"
    ? process.env.MAIN_APP_GRPC_URL_DEV || DEFAULT_URLS.dev
    : process.env.MAIN_APP_GRPC_URL || DEFAULT_URLS.prod;
  return url.replace(/\/+$/, "");
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

// The scoped-key contract caps a token at 15 minutes; ops signs a fresh one
// for every call, valid for 5.
export const SERVICE_NAME = "ops";
export const TOKEN_TTL_SECONDS = 5 * 60;

export function serviceToken(now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ service: SERVICE_NAME, iat: now, exp: now + TOKEN_TTL_SECONDS }));
  const signature = crypto.createSign("RSA-SHA256").update(`${header}.${payload}`).sign(serviceKey());
  return `${header}.${payload}.${b64url(signature)}`;
}

/* ------------------------------------------------------- protobuf, strings */

function varint(n) {
  const out = [];
  let v = n >>> 0;
  while (v > 127) { out.push((v & 127) | 128); v >>>= 7; }
  out.push(v);
  return Buffer.from(out);
}

// Encodes { fieldNumber: string } as a protobuf message (proto3 skips "").
export function encodeStrings(fields) {
  const parts = [];
  for (const [num, value] of Object.entries(fields)) {
    if (value == null || value === "") continue;
    const bytes = Buffer.from(String(value), "utf8");
    parts.push(varint((Number(num) << 3) | 2), varint(bytes.length), bytes);
  }
  return Buffer.concat(parts);
}

function readVarint(buf, pos) {
  let result = 0, shift = 0, b;
  do {
    b = buf[pos++];
    result += (b & 127) * 2 ** shift;
    shift += 7;
  } while (b & 128);
  return [result, pos];
}

// Decodes the string fields of a message to { fieldNumber: string }; other
// wire types are skipped.
export function decodeStrings(buf) {
  const out = {};
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const field = Math.floor(key / 8), wire = key & 7;
    if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      out[field] = buf.subarray(pos, pos + len).toString("utf8");
      pos += len;
    } else if (wire === 0) {
      [, pos] = readVarint(buf, pos);
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------- calls */

// gRPC status codes ops reacts to.
export const GRPC = { INVALID_ARGUMENT: 3, NOT_FOUND: 5, PERMISSION_DENIED: 7, FAILED_PRECONDITION: 9, UNIMPLEMENTED: 12, UNAVAILABLE: 14, UNAUTHENTICATED: 16 };

export class GrpcError extends Error {
  constructor(code, message) {
    super(message || `gRPC status ${code}`);
    this.grpcCode = code;
  }
}

// One unary call: path like "/proto.UsersService/HoldCreatorPayouts", body
// the encoded request. Resolves with the response message bytes.
export function unaryCall(path, body, { target = currentDbTarget(), timeoutMs = 20_000 } = {}) {
  if (!mainAppGrpcConfigured()) return Promise.reject(new Error("MAIN_APP_SERVICE_KEY is not set"));
  return new Promise((resolve, reject) => {
    const session = http2.connect(grpcUrl(target));
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      session.close();
      if (err) reject(err); else resolve(value);
    };
    session.on("error", (err) => finish(new GrpcError(GRPC.UNAVAILABLE, `Could not reach the main app: ${err.message}`)));
    session.setTimeout(timeoutMs, () => finish(new GrpcError(GRPC.UNAVAILABLE, "The main app did not answer in time.")));

    const req = session.request({
      ":method": "POST",
      ":path": path,
      "content-type": "application/grpc",
      te: "trailers",
      "grpc-timeout": `${Math.ceil(timeoutMs / 1000)}S`,
      "x-service-authorization": `bearer ${serviceToken()}`,
    });
    const chunks = [];
    let status = null, message = "";
    const readStatus = (headers) => {
      if (headers["grpc-status"] != null) {
        status = Number(headers["grpc-status"]);
        message = decodeURIComponent(String(headers["grpc-message"] || ""));
      }
    };
    req.on("response", (headers) => {
      readStatus(headers);
      if (headers[":status"] && Number(headers[":status"]) !== 200) {
        finish(new GrpcError(GRPC.UNAVAILABLE, `The main app answered HTTP ${headers[":status"]}.`));
      }
    });
    req.on("trailers", readStatus);
    req.on("data", (c) => chunks.push(c));
    req.on("error", (err) => finish(new GrpcError(GRPC.UNAVAILABLE, err.message)));
    req.on("end", () => {
      if (status == null) return finish(new GrpcError(GRPC.UNAVAILABLE, "The main app closed the call without a status."));
      if (status !== 0) return finish(new GrpcError(status, message));
      const data = Buffer.concat(chunks);
      // One length-prefixed message: flag byte (0 = not compressed), 4-byte length.
      if (data.length < 5) return finish(null, Buffer.alloc(0));
      if (data[0] !== 0) return finish(new GrpcError(GRPC.UNAVAILABLE, "Compressed gRPC responses are not supported."));
      finish(null, data.subarray(5, 5 + data.readUInt32BE(1)));
    });

    const frame = Buffer.alloc(5);
    frame.writeUInt32BE(body.length, 1);
    req.end(Buffer.concat([frame, body]));
  });
}
