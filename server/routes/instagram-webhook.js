// Meta's webhook for the Instagram account the DMs are sent from.
//
// Two kinds of event arrive, and both close a gap the queue had:
//   - a brand's message to us: the DM was answered. The lead is marked
//     replied, the text is kept, and it can be answered from the page.
//   - an echo of a message we sent from the Instagram app: the DM went. A lead
//     still waiting in the queue is marked sent without anybody pressing the
//     button, and a follow-up is recognised the same way.
//
// No admin auth - Meta calls it - so every POST is checked against the app
// secret (X-Hub-Signature-256) before anything is read. Setup and the three
// environment variables: docs/instagram-replies.md.

import crypto from "node:crypto";
import { Router } from "express";
import { supabase } from "../lib/supabase.js";
import { usernameOf } from "../lib/instagram-graph.js";

const TABLE = "prospector_leads";

export function validSignature(rawBody, header, secret) {
  if (!secret || !rawBody || !header?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const given = header.slice("sha256=".length);
  return given.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

// The events in a webhook body, flattened: { igsid, direction, mid, text, at }.
export function messagesIn(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const ev of entry.messaging || []) {
      const msg = ev.message;
      if (!msg || msg.is_deleted) continue;
      const echo = msg.is_echo === true;
      out.push({
        igsid: String(echo ? ev.recipient?.id : ev.sender?.id || ""),
        direction: echo ? "out" : "in",
        mid: msg.mid || null,
        text: msg.text || (msg.attachments?.length ? "[attachment]" : ""),
        at: new Date(Number(ev.timestamp) || Date.now()).toISOString(),
      });
    }
  }
  return out.filter((m) => m.igsid);
}

async function leadFor(igsid) {
  const known = await supabase.from(TABLE).select("*").eq("ig_user_id", igsid).maybeSingle();
  if (known.data) return known.data;
  const handle = await usernameOf(igsid).catch(() => null);
  if (!handle) return null;
  const { data } = await supabase.from(TABLE).update({ ig_user_id: igsid })
    .eq("handle", handle).select("*").maybeSingle();
  return data || null;
}

export async function recordMessage(m) {
  const lead = await leadFor(m.igsid);
  const { error } = await supabase.from("prospector_dm_messages").upsert({
    mid: m.mid, ig_user_id: m.igsid, handle: lead?.handle || null,
    direction: m.direction, text: m.text, sent_at: m.at,
  }, { onConflict: "mid", ignoreDuplicates: true });
  if (error) throw error;
  if (!lead) return { matched: false };

  const state = lead.dm_state || "none";
  let update = null;
  if (m.direction === "in" && ["sent", "replied"].includes(state)) {
    update = { dm_state: "replied", dm_replied_at: lead.dm_replied_at || m.at, dm_reply_text: m.text };
  } else if (m.direction === "out" && ["none", "drafted"].includes(state) && !lead.pushed_at) {
    // Sent from the Instagram app without pressing "Mark sent".
    update = { dm_state: "sent", dm_sent_at: m.at, dm_sent_by: "instagram" };
  } else if (m.direction === "out" && state === "sent" && !lead.dm_followup_sent_at
             && lead.dm_sent_at && new Date(m.at) - new Date(lead.dm_sent_at) > 12 * 3600 * 1000) {
    update = { dm_followup_sent_at: m.at };
  }
  if (update) await supabase.from(TABLE).update(update).eq("handle", lead.handle);
  return { matched: true, handle: lead.handle, update };
}

export function instagramWebhookRoutes() {
  const router = Router();

  // Meta's subscription handshake.
  router.get("/webhook", (req, res) => {
    const expected = process.env.META_VERIFY_TOKEN;
    if (expected && req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === expected) {
      return res.status(200).send(String(req.query["hub.challenge"] || ""));
    }
    res.status(403).send("forbidden");
  });

  router.post("/webhook", async (req, res) => {
    if (!validSignature(req.rawBody, req.headers["x-hub-signature-256"], process.env.META_APP_SECRET)) {
      return res.status(401).json({ error: "bad signature" });
    }
    const results = [];
    for (const m of messagesIn(req.body)) {
      try {
        results.push(await recordMessage(m));
      } catch (err) {
        console.error("[instagram-webhook]", err?.message);
        results.push({ error: err?.message });
      }
    }
    // Always 200 once the signature is good: Meta retries anything else, and a
    // lead we cannot match is not worth a retry storm.
    res.json({ received: results.length });
  });

  return router;
}
