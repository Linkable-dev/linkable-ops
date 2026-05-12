// Warmup content generator — Claude Haiku writes the body, we pick the topic.
//
// Topics are intentionally varied (work, personal, share, question, plan)
// so that across a 2-week ramp the same seed inbox sees a mix of casual
// human-shaped emails instead of repeating templates. Spam classifiers and
// Gmail's intelligence treat conversational diversity as a strong positive
// signal — uniform-looking warmup is the fastest way to get flagged.
//
// Hard rules baked into the prompt:
//   - No links, no signoff besides first name, no marketing tone
//   - No business pitch — these are friend-to-friend / colleague-to-colleague
//   - 2-4 sentences total
//   - Subject is all lowercase, 2-5 words

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

// Topics rotate per send so the agent doesn't write 10 "saw this article"
// emails on the same day. Picked uniformly at random per send.
const TOPICS = [
  "share an article or link you 'saw recently' — invent a plausible-sounding article title, no real URLs",
  "ask a casual question about their weekend or upcoming plans",
  "follow up on something hypothetical you supposedly discussed — vague enough that the recipient can play along",
  "share a random thought or observation about your week",
  "ask their opinion on something low-stakes — a tool, a habit, a city, a book",
  "check in casually, no agenda",
  "share a quick win or small frustration from your day",
  "mention something you're reading, watching, or listening to (invent a plausible title)",
  "make a tiny plan suggestion — coffee, call, lunch — without committing to a time",
  "send a short question about their work, framed as curiosity not interrogation",
];

function pickTopic() {
  return TOPICS[Math.floor(Math.random() * TOPICS.length)];
}

// Public entry. Returns { subject, body } ready to send.
// `senderName` is the inbox's from_name (e.g. "Luca from Linkable") — we
// strip " from Linkable" for the signoff so the email reads "— Luca", not
// "— Luca from Linkable" which would tip the recipient it's a work account.
export async function generateWarmupEmail({ senderName, recipientName, apiKey }) {
  const topic = pickTopic();
  const firstNameSender = (senderName || "").split(/\s+/)[0] || "there";
  const firstNameRecipient = (recipientName || "").split(/\s+/)[0] || "";

  const prompt = `Write a brief casual email from one person to a friend or colleague.

Topic this time: ${topic}

Constraints:
- 2 to 4 sentences, no more
- Casual conversational tone — like texting a friend in full sentences
- No emojis
- No links or URLs
- No signoff besides the sender's first name on its own line
- No "Hope this finds you well" or other corporate openers
- Recipient first name: ${firstNameRecipient || "(no name — start without a greeting)"}
- Sender first name: ${firstNameSender}
- Do NOT mention any business, product, sales pitch, or work goal
- If you reference an article, book, tool, or person, invent a plausible-sounding name — don't use real URLs

Output exactly this format and nothing else:
SUBJECT: <2-5 words, all lowercase, no punctuation except dashes>
BODY:
<the email body, signed with ${firstNameSender} on its own line at the bottom>`;

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("warmup-content: Claude error", res.status, err);
      return fallbackEmail(firstNameSender, firstNameRecipient);
    }

    const data = await res.json();
    const text = data.content?.[0]?.text?.trim() || "";
    const parsed = parseClaudeOutput(text);
    if (!parsed) return fallbackEmail(firstNameSender, firstNameRecipient);
    return parsed;
  } catch (err) {
    console.error("warmup-content: exception", err.message);
    return fallbackEmail(firstNameSender, firstNameRecipient);
  }
}

function parseClaudeOutput(text) {
  // Expected:
  //   SUBJECT: short lowercase subject
  //   BODY:
  //   <body lines>
  const subjectMatch = text.match(/^SUBJECT:\s*(.+?)\s*$/im);
  const bodyMatch = text.match(/^BODY:\s*\n([\s\S]+)$/im);
  if (!subjectMatch || !bodyMatch) return null;
  const subject = subjectMatch[1].trim().toLowerCase();
  const body = bodyMatch[1].trim();
  if (subject.length < 2 || body.length < 20) return null;
  return { subject, body };
}

// Fallback when Claude is unreachable. Static templates as last resort —
// repeated daily this looks templated to spam filters, but a few sends with
// fallback content during a 2-week ramp won't move the needle.
const FALLBACKS = [
  { subject: "quick one", body: (r, s) => `${r ? r + ",\n\n" : ""}happy ${dayWord()} — wanted to ping you about something low stakes. what's the best way to reach you these days?\n\n${s}` },
  { subject: "random thought", body: (r, s) => `${r ? r + ",\n\n" : ""}was thinking about that thing we touched on a while back. curious how you've been thinking about it lately.\n\n${s}` },
  { subject: "checking in", body: (r, s) => `${r ? r + ",\n\n" : ""}been a minute. hope ${dayWord()} is treating you well. anything good happening on your end?\n\n${s}` },
];

function dayWord() {
  const day = new Date().getUTCDay();
  if (day === 0 || day === 6) return "your weekend";
  return "your week";
}

function fallbackEmail(senderFirst, recipientFirst) {
  const tpl = FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];
  return {
    subject: tpl.subject,
    body: tpl.body(recipientFirst, senderFirst),
  };
}
