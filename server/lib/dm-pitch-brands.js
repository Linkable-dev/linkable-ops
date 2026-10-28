// DM sent → a brand creators can pitch (main app QA 145). The brands
// Linkable writes to on Instagram belong on creator Discover too, so pressing
// DM sent on the Instagram tab also asks the main app to list the brand.
//
// Ops only says which lead: it writes one row in the app's
// pitch_brand_requests (source "instagram_dm"), the same queue Add to Pitch
// uses, and service-grpc reads the store within seconds and decides the rest
// (services/pitch_dm_brands.go): no duplicate when the brand is already listed
// or on Linkable, the category from what the store sells, the store's own logo
// and product photos, the bio as the description when the store has none, a
// brand removed from Pitch left off, and no paid lookups.
//
// Always the prod database, whichever one the header points at: the DM went
// to a real brand, and real creators pitch from prod. The send never fails
// because of this; the response says what happened to the brand.
//
// The request waits as status "dm_pending", never "pending": an app deploy
// from before QA 145 reads every pending request as an admin's Add brand.
//
// One live request per lead (a unique index on the app side), so DM sent
// again after an undo adds nothing. Undo leaves the brand listed: a brand
// creators can pitch is no harm.
import { cloudSqlQuery } from "./cloudsql.js";

export const DM_PITCH_TARGET = "prod";
export const DM_PITCH_SOURCE = "instagram_dm";

// The store address the request names: the lead's domain, else its
// myshopify address. Pitch lists Shopify stores only, so a lead with neither
// has nothing to add.
export function dmPitchStore(lead) {
  const clean = (v) => String(v || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
  return clean(lead?.domain) || clean(lead?.myshopify_domain);
}

// What is sent for a lead, or why nothing is (a sentence the panel shows).
export function dmPitchRequest(lead, who) {
  if (!lead) return { skip: "Not added to Pitch because the lead wasn't found." };
  if (lead.is_agency === true) return { skip: "Not added to Pitch because it's marked as not a brand." };
  const input = dmPitchStore(lead);
  if (!input) return { skip: "Not added to Pitch because it has no store address." };
  const email = String(lead.contact_email || "").trim().toLowerCase();
  return {
    params: [
      who ? `DM sent by ${who}` : "DM sent",
      input,
      email.includes("@") ? email : "",
      String(lead.vertical_effective || ""),
      DM_PITCH_SOURCE,
      lead.id,
      String(lead.handle || "").trim().toLowerCase().replace(/^@/, ""),
      String(lead.ig_biography || "").trim().slice(0, 1000),
      String(lead.country || "").trim().toUpperCase(),
    ],
  };
}

const INSERT = `
  INSERT INTO pitch_brand_requests
    (requested_by, input, contact_email, category, source, prospector_lead_id, instagram, about, country, status)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'dm_pending')
  ON CONFLICT (prospector_lead_id) WHERE source = 'instagram_dm' AND status <> 'failed' DO NOTHING
  RETURNING id`;

// Queues the lead's brand for Pitch. Resolves with { status, message }:
// queued (with the request id), already (a request for this lead exists),
// skipped (nothing to add) or failed (the app's database said no; the DM is
// still marked sent).
export async function queueDmBrandForPitch(lead, who, { query = (sql, params) => cloudSqlQuery(sql, params, DM_PITCH_TARGET) } = {}) {
  const req = dmPitchRequest(lead, who);
  if (req.skip) return { status: "skipped", message: req.skip };
  try {
    const { rows } = await query(INSERT, req.params);
    if (!rows.length) return { status: "already", message: "Already sent to Pitch." };
    console.log(`[dm-pitch] lead=${lead.id} handle=${lead.handle} store=${req.params[1]} request=${rows[0].id}`);
    return { status: "queued", message: "Added to Pitch. Creators can pitch it once Linkable has read the store.", request_id: rows[0].id };
  } catch (err) {
    // 42P01/42703/42P10: the app on prod has not got DM brands yet (its next deploy adds them).
    const notYet = ["42P01", "42703", "42P10"].includes(err?.code);
    console.error(`[dm-pitch] lead=${lead.id} handle=${lead.handle} not queued:`, err?.message || err);
    return {
      status: "failed",
      message: notYet
        ? "Not added to Pitch because the app doesn't take brands from DMs until its next deploy. Use Add to Pitch for now."
        : "Not added to Pitch. Use Add to Pitch to add it by hand.",
    };
  }
}
