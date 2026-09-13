// A single switch that turns every outbound email into a test email.
//
// With OUTBOUND_TEST_RECIPIENT set, nothing leaves for a prospect or a brand:
// every send goes to that one address instead, with the intended recipient
// written into the subject so the tester can see who it WOULD have gone to.
// Everything else — the sender, the body, threading headers, what is written
// to the database — happens exactly as it would for real, which is the point:
// it is the real system being watched, not a dry run of it.
//
// One place, used by all three senders (cold outreach, AI conversations,
// brand nudges), because a switch that covers two of three paths is a switch
// that will one day email a stranger.

export function testRecipient() {
  return (process.env.OUTBOUND_TEST_RECIPIENT || "").trim();
}

export function isSandboxed() {
  return testRecipient() !== "";
}

/** The address and subject a message should actually go out with. */
export function sandboxRecipient({ to, subject }) {
  const recipient = testRecipient();
  if (!recipient) return { to, subject, redirected: false, intendedTo: to };
  return {
    to: recipient,
    subject: `[TEST → ${to}] ${subject}`,
    redirected: true,
    intendedTo: to,
  };
}
