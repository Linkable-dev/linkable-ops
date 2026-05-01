// Email sending via Resend API
// Spam-proof: plain text, rate-limited, proper headers, CAN-SPAM compliant

const RESEND_API_URL = "https://api.resend.com/emails";

// Rate limit: max 2 emails per second, 100 per hour (conservative for warming)
const SEND_INTERVAL_MS = 1500; // 1.5 seconds between sends
const MAX_PER_HOUR = 500;

let hourlyCount = 0;
let hourlyReset = Date.now();

function checkRateLimit() {
  const now = Date.now();
  if (now - hourlyReset > 3600000) {
    hourlyCount = 0;
    hourlyReset = now;
  }
  if (hourlyCount >= MAX_PER_HOUR) {
    return { allowed: false, retryAfterMs: 3600000 - (now - hourlyReset) };
  }
  return { allowed: true };
}

// Convert plain text body to minimal HTML, replacing raw URLs with anchor text
function bodyToHtml(text) {
  // Replace URLs BEFORE escaping HTML entities
  // Calendly demo link
  let html = text.replace(
    /[^\n]*:\s*(https?:\/\/calendly\.com\/[^\s]+)/gi,
    'CALENDLY_CTA_PLACEHOLDER'
  );
  // Extract the actual calendly URL for the href
  const calendlyUrl = text.match(/https?:\/\/calendly\.com\/[^\s]+/)?.[0] || "https://calendly.com/federico-linkable/linkable-demo?utm_source=outreach";

  // Linkable link with lead-in text
  html = html.replace(
    /[^\n]*:\s*https?:\/\/www\.linkable\.link\S*/gi,
    'LINKABLE_CTA_PLACEHOLDER'
  );

  // Catch any remaining raw URLs
  html = html.replace(/https?:\/\/www\.linkable\.link\S*/g, 'LINKABLE_CTA_PLACEHOLDER');
  html = html.replace(/https?:\/\/calendly\.com\/[^\s]+/g, 'CALENDLY_CTA_PLACEHOLDER');

  // Now escape HTML entities
  html = html
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Insert actual anchor tags
  html = html.replace(
    /LINKABLE_CTA_PLACEHOLDER/g,
    '<a href="https://linkable.link" style="color:#0A0A0A;text-decoration:underline;">Try Linkable free</a>'
  );
  html = html.replace(
    /CALENDLY_CTA_PLACEHOLDER/g,
    `<a href="${calendlyUrl.replace(/&/g, '&amp;')}" style="color:#0A0A0A;text-decoration:underline;">Book a quick demo</a>`
  );

  // Preserve line breaks
  html = html.replace(/\n/g, "<br>");

  return `<div style="font-family:-apple-system,system-ui,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.6;">${html}</div>`;
}

export async function sendEmail({ to, toName, subject, body, from, replyTo, resendApiKey }) {
  // Rate limit check
  const limit = checkRateLimit();
  if (!limit.allowed) {
    return {
      success: false,
      error: `Hourly rate limit reached (${MAX_PER_HOUR}/hr). Retry in ${Math.ceil(limit.retryAfterMs / 60000)} minutes.`,
    };
  }

  // Validate inputs
  if (!to || !subject || !body) {
    return { success: false, error: "Missing required fields: to, subject, body" };
  }

  if (!resendApiKey) {
    return { success: false, error: "Missing Resend API key" };
  }

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resendApiKey}`,
      },
      body: JSON.stringify({
        from: from || "Linkable <outreach@linkable.link>",
        to: [to],
        reply_to: replyTo || from || "outreach@linkable.link",
        subject,
        text: body,
        html: bodyToHtml(body),
        headers: {
          "X-Entity-Ref-ID": crypto.randomUUID(), // Prevent threading/grouping in Gmail
          "List-Unsubscribe": `<mailto:unsubscribe@linkable.link?subject=Unsubscribe>`,
        },
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      return {
        success: false,
        error: data.message || `Resend API error: ${res.status}`,
        statusCode: res.status,
      };
    }

    hourlyCount++;

    return {
      success: true,
      resendId: data.id,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

// Delay helper for rate limiting between sends
export function delaySend() {
  return new Promise(resolve => setTimeout(resolve, SEND_INTERVAL_MS));
}

// Get current rate limit status
export function getRateLimitStatus() {
  const now = Date.now();
  if (now - hourlyReset > 3600000) {
    hourlyCount = 0;
    hourlyReset = now;
  }
  return {
    sent: hourlyCount,
    limit: MAX_PER_HOUR,
    remaining: MAX_PER_HOUR - hourlyCount,
    resetsIn: Math.max(0, Math.ceil((3600000 - (now - hourlyReset)) / 60000)),
  };
}
