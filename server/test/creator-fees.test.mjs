// Stop fee (lib/creatorFees.js): the hand-encoded StopCreatorFee messages and
// the refusals that never reach the main app. No database, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { decodeFields, decodeStrings, encodeStrings } from "../lib/mainAppGrpc.js";
import {
  stopCreatorFee, stopRequestBody, stopResponseFromProto, NEEDS_SERVICE_KEY,
} from "../lib/creatorFees.js";

const FEE = "3f2b8c1e-9a4d-4e1b-8c7a-2d5e6f708192";

// A varint field (wire type 0), as the main app's int64 refunded_minor.
function varintField(num, value) {
  const out = [(num << 3) | 0];
  let v = value;
  while (v > 127) { out.push((v & 127) | 128); v = Math.floor(v / 128); }
  out.push(v);
  return Buffer.from(out);
}

test("StopCreatorFeeResponse decodes strings and the int64 refund", () => {
  const msg = Buffer.concat([
    encodeStrings({ 1: FEE, 2: "refunded", 3: "re_123" }),
    varintField(4, 5250),
    encodeStrings({ 5: "gbp" }),
  ]);
  assert.deepEqual(stopResponseFromProto(decodeFields(msg)), {
    fee_id: FEE, status: "refunded", refund_id: "re_123", refunded_minor: 5250, currency: "GBP",
  });
  // decodeStrings keeps its old shape: varints skipped.
  assert.equal(decodeStrings(msg)[4], undefined);
  assert.equal(decodeStrings(msg)[2], "refunded");
});

test("a large refund survives the varint decode", () => {
  const msg = Buffer.concat([encodeStrings({ 2: "refunded" }), varintField(4, 12_345_678_901)]);
  assert.equal(stopResponseFromProto(decodeFields(msg)).refunded_minor, 12_345_678_901);
});

test("'stopping' (refund retried) comes back with no refund", () => {
  const out = stopResponseFromProto(decodeFields(encodeStrings({ 1: FEE, 2: "stopping", 5: "GBP" })));
  assert.equal(out.status, "stopping");
  assert.equal(out.refunded_minor, 0);
  assert.equal(out.refund_id, "");
});

test("StopCreatorFeeRequest: fee_id = 1, reason = 2, actor = 3", () => {
  const m = decodeStrings(stopRequestBody(FEE, "Wrong post link", "ops@linkable.link"));
  assert.deepEqual(m, { 1: FEE, 2: "Wrong post link", 3: "ops@linkable.link" });
});

test("no SQL fallback: without the service key Stop fee refuses with a sentence", async () => {
  const saved = process.env.MAIN_APP_SERVICE_KEY;
  delete process.env.MAIN_APP_SERVICE_KEY;
  try {
    await assert.rejects(stopCreatorFee(FEE, "", "ops@linkable.link", "dev"), (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.message, NEEDS_SERVICE_KEY);
      return true;
    });
  } finally {
    if (saved !== undefined) process.env.MAIN_APP_SERVICE_KEY = saved;
  }
});

test("a malformed fee id is refused before anything else", async () => {
  await assert.rejects(stopCreatorFee("nope", "", "x", "dev"), (err) => err.status === 400);
});
