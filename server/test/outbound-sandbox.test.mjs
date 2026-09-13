import { test } from "node:test";
import assert from "node:assert/strict";
import { sandboxRecipient, isSandboxed } from "../lib/outbound-sandbox.js";

test("without the switch, nothing changes", () => {
  delete process.env.OUTBOUND_TEST_RECIPIENT;
  assert.equal(isSandboxed(), false);
  assert.deepEqual(sandboxRecipient({ to: "a@b.com", subject: "Hi" }), {
    to: "a@b.com", subject: "Hi", redirected: false, intendedTo: "a@b.com",
  });
});

test("with the switch, every send goes to the tester and says who it was for", () => {
  process.env.OUTBOUND_TEST_RECIPIENT = " tester@example.com ";
  assert.equal(isSandboxed(), true);
  const out = sandboxRecipient({ to: "prospect@shop.com", subject: "Quick question" });
  assert.equal(out.to, "tester@example.com");
  assert.equal(out.subject, "[TEST → prospect@shop.com] Quick question");
  assert.equal(out.redirected, true);
  assert.equal(out.intendedTo, "prospect@shop.com");
  delete process.env.OUTBOUND_TEST_RECIPIENT;
});
