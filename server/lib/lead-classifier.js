// What the keyword classifier cannot tell: the vertical of a brand whose words
// matched nothing, and whether an account is a brand at all.
//
// About a quarter of brands reach ops with no vertical, and the Instagram
// searches bring in accounts that post other brands' creator calls - agencies,
// PR firms, UGC marketplaces, creators sharing gigs. None of those is a brand
// to pitch, and the brand/personal classifier upstream cannot tell them apart
// from a brand because they look like businesses. Claude Haiku can, for about
// $0.0003 a lead, once per lead (classified_at).

import { claudeMessage } from "./anthropic.js";
import { supabase } from "./supabase.js";
import { VERTICALS } from "./verticals.js";

export const CLASSIFIER_MODEL = "claude-haiku-4-5-20251001";
// Haiku list price, $/million tokens.
const PRICE = { in: 1, out: 5 };
const BATCH = 20;
const TABLE = "prospector_leads";

const TOOL = {
  name: "classify_accounts",
  description: "Return one verdict per account given.",
  input_schema: {
    type: "object",
    properties: {
      accounts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            handle: { type: "string" },
            vertical: { type: "string", enum: [...Object.keys(VERTICALS), "NONE"] },
            is_agency: { type: "boolean" },
          },
          required: ["handle", "vertical", "is_agency"],
        },
      },
    },
    required: ["accounts"],
  },
};

const SYSTEM = `You sort Instagram accounts found posting calls for creators.

For each account decide two things from its name, category, bio and post:

1. vertical: what the business sells, as one of:
${Object.entries(VERTICALS).map(([code, label]) => `   ${code} = ${label}`).join("\n")}
   NONE when it sells none of these, or you cannot tell.

2. is_agency: true when the account is NOT a brand selling its own products:
   a marketing, PR, talent or UGC agency; a creator marketplace or platform; a
   community or page sharing other brands' opportunities; an individual
   creator; a media outlet or blog; an event. false for a brand, shop,
   restaurant, hotel or other business selling its own things.

Be conservative with is_agency: a brand posting its own creator call is not an
agency. Call classify_accounts with every handle you were given.`;

function describe(lead) {
  const clip = (v, n) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n);
  return [
    `@${lead.handle}`,
    lead.ig_full_name || lead.brand_name ? `name: ${clip(lead.ig_full_name || lead.brand_name, 80)}` : null,
    lead.ig_category ? `category: ${clip(lead.ig_category, 60)}` : null,
    lead.ig_biography ? `bio: ${clip(lead.ig_biography, 220)}` : null,
    lead.intent_caption ? `post: ${clip(lead.intent_caption, 300)}` : null,
    lead.domain ? `site: ${lead.domain}` : null,
  ].filter(Boolean).join(" | ");
}

// Classify leads nobody has classified yet. → { classified, agencies, costUsd }
export async function classifyMissing({ limit = 60 } = {}) {
  const { data: leads, error } = await supabase
    .from(TABLE)
    .select("handle,brand_name,ig_full_name,ig_category,ig_biography,intent_caption,domain,vertical")
    .is("classified_at", null)
    .in("dm_state", ["none", "drafted"])
    .or("tier.not.is.null,status.eq.not_shopify")
    .limit(limit);
  if (error) throw error;

  const totals = { classified: 0, agencies: 0, costUsd: 0 };
  for (let i = 0; i < (leads || []).length; i += BATCH) {
    const batch = leads.slice(i, i + BATCH);
    const res = await claudeMessage({
      model: CLASSIFIER_MODEL,
      system: SYSTEM,
      maxTokens: 1500,
      temperature: 0,
      tools: [TOOL],
      toolChoice: { type: "tool", name: "classify_accounts" },
      messages: [{ role: "user", content: batch.map(describe).join("\n") }],
    });
    const u = res.usage || {};
    totals.costUsd += ((u.input_tokens || 0) * PRICE.in + (u.output_tokens || 0) * PRICE.out) / 1e6;

    const verdicts = res.toolCalls.find((t) => t.name === "classify_accounts")?.input?.accounts || [];
    const byHandle = new Map(verdicts.map((v) => [String(v.handle || "").replace(/^@/, "").toLowerCase(), v]));
    const now = new Date().toISOString();
    for (const lead of batch) {
      const v = byHandle.get(lead.handle);
      // A lead the model skipped stays unclassified and is tried again.
      if (!v) continue;
      const { error: saveError } = await supabase.from(TABLE).update({
        vertical_ai: v.vertical in VERTICALS ? v.vertical : null,
        is_agency: v.is_agency === true,
        classified_at: now,
      }).eq("handle", lead.handle);
      if (saveError) throw saveError;
      totals.classified += 1;
      if (v.is_agency === true) totals.agencies += 1;
    }
  }
  totals.costUsd = Math.round(totals.costUsd * 10000) / 10000;
  return totals;
}
