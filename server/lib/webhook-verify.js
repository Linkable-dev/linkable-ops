// Svix webhook signature verification (Resend uses Svix for signing).
//
// Spec: https://docs.svix.com/receiving/verifying-payloads/how-manual
//   signed_payload = `${msg_id}.${msg_timestamp}.${body}`
//   sig = base64( HMAC_SHA256(decoded_secret, signed_payload) )
//   header `svix-signature` is space-separated `v1,sig` pairs (key rotation).
//
// We verify in constant time and reject timestamps >5min skewed (replay defense).

import crypto from "crypto";
import { Buffer } from "buffer";

const TOLERANCE_SECONDS = 5 * 60;

export function verifySvixSignature({
  secret,
  rawBody,
  msgId,
  timestamp,
  signatureHeader,
  toleranceSeconds = TOLERANCE_SECONDS,
}) {
  if (!secret) return { valid: false, reason: "secret-missing" };
  if (!rawBody) return { valid: false, reason: "body-missing" };
  if (!msgId || !timestamp || !signatureHeader) return { valid: false, reason: "headers-missing" };

  // Replay defense
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return { valid: false, reason: "timestamp-invalid" };
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (skew > toleranceSeconds) return { valid: false, reason: `timestamp-skew-${skew}s` };

  // Decode the secret. Svix secrets are formatted like `whsec_<base64>`.
  const cleanSecret = secret.replace(/^whsec_/, "");
  let secretBytes;
  try {
    secretBytes = Buffer.from(cleanSecret, "base64");
  } catch (err) {
    void err;
    return { valid: false, reason: "secret-decode" };
  }

  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody);
  const signedPayload = `${msgId}.${timestamp}.${bodyStr}`;
  const expected = crypto.createHmac("sha256", secretBytes).update(signedPayload).digest("base64");

  // Header may contain multiple sigs (key rotation), space-separated.
  const sigs = signatureHeader.split(" ").map((s) => s.trim()).filter(Boolean);
  for (const entry of sigs) {
    const [version, sig] = entry.split(",");
    if (version !== "v1" || !sig) continue;
    if (timingSafeStringEqual(sig, expected)) return { valid: true };
  }
  return { valid: false, reason: "no-matching-signature" };
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Convenience: pull Svix headers off an Express request.
export function svixHeaders(req) {
  const h = req.headers || {};
  return {
    msgId: h["svix-id"] || h["webhook-id"] || null,
    timestamp: h["svix-timestamp"] || h["webhook-timestamp"] || null,
    signatureHeader: h["svix-signature"] || h["webhook-signature"] || null,
  };
}
