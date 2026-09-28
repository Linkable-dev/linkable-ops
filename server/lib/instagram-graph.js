// Instagram's messaging API, for the one thing it allows us: answering a
// brand that wrote to us, within 24 hours of its message. A cold first DM is
// not possible through it, which is why the queue is sent by hand.
//
// Configured with an Instagram API access token for the account the DMs are
// sent from ("Instagram API with Instagram Login", permission
// instagram_business_manage_messages). Unset, every function here says so and
// the page hides the buttons that need it. Setup: docs/instagram-replies.md.

const version = () => process.env.IG_GRAPH_VERSION || "v21.0";
const token = () => process.env.IG_ACCESS_TOKEN || "";

export const instagramConfigured = () => Boolean(token());

async function graph(path, { method = "GET", body } = {}) {
  if (!token()) throw new Error("IG_ACCESS_TOKEN is not set on the ops server");
  const res = await fetch(`https://graph.instagram.com/${version()}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Instagram ${res.status}: ${json?.error?.message || "request failed"}`);
  return json;
}

// The username behind an Instagram-scoped user id, which is all a webhook
// gives us about who wrote.
export async function usernameOf(igsid) {
  const json = await graph(`${encodeURIComponent(igsid)}?fields=username`);
  return String(json.username || "").toLowerCase() || null;
}

export async function sendInstagramMessage(igsid, text) {
  return graph("me/messages", { method: "POST", body: { recipient: { id: igsid }, message: { text } } });
}
