// Transactional sender for operator nudges to existing brands.
//
// Deliberately NOT server/automation/send.js: that one is built for cold
// outreach and does three things that are wrong for a customer email —
// it rewrites any link into a "Book a demo" / "Try Linkable free" CTA,
// stamps List-Unsubscribe (we are writing to a paying customer about
// their own account, not marketing at them), and sets X-Entity-Ref-ID
// specifically to STOP Gmail threading. A nudge wants the opposite of
// all three.

const RESEND_API_URL = "https://api.resend.com/emails";

// Who the brand sees. Both must be on a Resend-verified domain.
// brand@linkable.link is already verified and is where the team triages
// replies, so it is the default rather than a new address nobody watches.
export const nudgeFrom = () => process.env.NUDGE_FROM || "Linkable <brand@linkable.link>";
export const nudgeReplyTo = () => process.env.NUDGE_REPLY_TO || process.env.NUDGE_FROM || "brand@linkable.link";

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Plain text → minimal HTML. Bare URLs become links pointing at themselves;
// nothing is substituted for anything else.
function bodyToHtml(text) {
  const html = escapeHtml(text)
    .replace(/(https?:\/\/[^\s<]+[^\s<.,;:)\]"'])/g,
      (url) => `<a href="${url}" style="color:#0A0A0A;text-decoration:underline;">${url}</a>`)
    .replace(/\n/g, "<br>");
  return `<div style="font-family:-apple-system,system-ui,sans-serif;font-size:15px;color:#1a1a1a;line-height:1.6;">${html}</div>`;
}

// Resolves to { success, resendId } | { success: false, error }.
export async function sendNudgeEmail({ to, subject, body, from, replyTo }) {
  if (!to || !subject || !body) {
    return { success: false, error: "Missing recipient, subject or body" };
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { success: false, error: "RESEND_API_KEY is not set on the server" };

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        from: from || nudgeFrom(),
        to: [to],
        reply_to: replyTo || nudgeReplyTo(),
        subject,
        text: body,
        html: bodyToHtml(body),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { success: false, error: data.message || `Resend returned ${res.status}` };
    }
    return { success: true, resendId: data.id };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
