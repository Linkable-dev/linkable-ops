// Reply parsers: turn whatever the inbound provider gives us into clean reply
// text the LLM can reason over. Tested against Resend Inbound, SendGrid Inbound
// Parse, and Cloudflare Email Routing payload shapes.

// Common quoted-history markers in many languages.
const REPLY_MARKERS = [
  /^On\s.+?\s+wrote:\s*$/im,
  /^On\s.+?\sat\s.+?\s+(<.+?>\s+)?wrote:\s*$/im,
  /^Le\s.+?\s+a\s+écrit\s*:?\s*$/im,
  /^Il\s.+?\s+ha\s+scritto\s*:?\s*$/im,
  /^Am\s.+?\s+schrieb\s+.+?:\s*$/im,
  /^From:\s.+$/im,
  /^De\s*:\s.+$/im,
  /^Da\s*:\s.+$/im,
  /^[-_]{2,}\s*$/m,
  /^>+ /m,
];

// Strip everything from the first quoted-history marker downward.
export function stripQuotedHistory(text) {
  if (!text) return "";
  let out = text;

  // Find earliest match across all patterns.
  let earliest = -1;
  for (const re of REPLY_MARKERS) {
    const m = re.exec(out);
    if (m && (earliest === -1 || m.index < earliest)) earliest = m.index;
  }
  if (earliest > 0) out = out.slice(0, earliest);

  // Tidy: collapse blank lines, trim.
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

// Strip auto-reply / OOO signatures. Returns true if this looks like one.
export function looksLikeAutoReply(headers, body) {
  const h = lowerHeaders(headers || {});
  if (h["auto-submitted"] && h["auto-submitted"] !== "no") return true;
  if (h["x-autoreply"] === "yes") return true;
  if (h["x-autorespond"]) return true;
  if (h.precedence && /(auto_reply|bulk|junk|list)/i.test(h.precedence)) return true;
  const b = (body || "").toLowerCase();
  if (b.includes("out of office") || b.includes("out-of-office")) return true;
  if (b.includes("currently away") || b.includes("on holiday")) return true;
  if (b.includes("automatic reply") || b.includes("auto-reply")) return true;
  return false;
}

// Detect explicit opt-out signals in the reply text.
export function looksLikeOptOut(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  const triggers = [
    "unsubscribe",
    "stop emailing",
    "do not contact",
    "do not email",
    "remove me",
    "take me off",
    "not interested",
    "désabonner",
    "annulla",
    "cancellatemi",
  ];
  return triggers.some((s) => t.includes(s));
}

function lowerHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

// Resend Inbound webhook payload normalizer.
//
// Resend (Svix) wraps events as:
//   { type: "email.received", created_at, data: { ...email fields... } }
//
// Inbound payload (`type: email.received`) shape we've observed:
//   data: {
//     email_id, created_at,
//     from: "Name <addr@host>" OR { name, address },
//     to:   ["Name <addr@host>"] OR [{ name, address }],
//     subject, text, html,
//     headers: [{ name, value }] | { "Header-Name": "value" },
//     attachments: [...]
//   }
// Different deliveries occasionally vary in shape (Resend has been iterating);
// this normalizer handles all observed variants. Falls back to .data || raw.
export function normalizeInboundPayload(payload) {
  if (!payload) return null;

  // Bounce/complaint events have a different shape — caller should route those
  // to a different handler. Return null here to signal "not an inbound email".
  const eventType = payload.type || "";
  if (eventType && !eventType.includes("received") && !eventType.includes("inbound")) {
    return null;
  }

  const data = payload.data || payload;
  if (!data) return null;

  const fromRaw = data.from ?? data.sender ?? data.From ?? "";
  const toRaw = firstOf(data.to ?? data.recipient ?? data.To);
  const { email: fromEmail, name: fromName } = parseAddress(fromRaw);
  const { email: toEmail } = parseAddress(toRaw);

  // Resend can deliver headers as either an object or an array of {name,value}.
  const lowered = normalizeHeaders(data.headers);

  const messageId =
    data.message_id ||
    data.messageId ||
    lowered["message-id"] ||
    null;
  const inReplyTo =
    data.in_reply_to ||
    data.inReplyTo ||
    lowered["in-reply-to"] ||
    null;
  const referencesRaw = data.references || lowered["references"] || "";
  const references = typeof referencesRaw === "string"
    ? referencesRaw.split(/\s+/).filter(Boolean)
    : Array.isArray(referencesRaw) ? referencesRaw : [];

  const text = data.text || data.plain || "";
  const html = data.html || "";

  return {
    from_email: fromEmail,
    from_name: fromName,
    to_email: toEmail,
    subject: data.subject || "",
    text,
    html,
    headers: lowered,
    message_id: messageId,
    in_reply_to: inReplyTo,
    references,
    email_provider_id: data.email_id || data.id || null,
  };
}

function firstOf(v) {
  if (Array.isArray(v)) return v[0];
  return v;
}

// Accepts either { "X-Foo": "bar" } or [{ name: "X-Foo", value: "bar" }].
function normalizeHeaders(headers) {
  if (!headers) return {};
  if (Array.isArray(headers)) {
    const out = {};
    for (const h of headers) {
      if (!h?.name) continue;
      out[h.name.toLowerCase()] = h.value;
    }
    return out;
  }
  return lowerHeaders(headers);
}

export function parseAddress(raw) {
  if (!raw) return { email: "", name: "" };
  if (typeof raw !== "string") {
    // Resend sometimes posts addresses as { name, address } objects.
    const email = raw.email || raw.address || "";
    return { email: email ? email.toLowerCase() : "", name: raw.name || "" };
  }
  const m = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].replace(/^"|"$/g, "").trim(), email: m[2].trim().toLowerCase() };
  return { email: raw.trim().toLowerCase(), name: "" };
}

// Best-effort: pull plain text from an HTML-only reply.
export function htmlToText(html) {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// One-shot: take a normalized inbound and return the cleaned reply body.
export function extractReplyBody(normalized) {
  const raw = normalized.text || htmlToText(normalized.html);
  return stripQuotedHistory(raw);
}
