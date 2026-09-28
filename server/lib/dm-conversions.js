// Did a brand we DMed become a customer? The question the whole DM queue is
// for, and until now nothing could answer it.
//
// Matched against the product database (prod) by the three things a signup
// records and a lead knows: the *.myshopify.com address (users.shopify_shop),
// the storefront domain (users.shopify_storefront, brands.store_website), and
// the email. Only signups after the DM count - a brand that was already a
// customer should never have been in the queue, and is not a conversion.

import { cloudSqlQuery, runWithDbTarget } from "./cloudsql.js";
import { supabase } from "./supabase.js";

const TABLE = "prospector_leads";

export const bareDomain = (value) => String(value || "").trim().toLowerCase()
  .replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] || null;

// Which lead a signup belongs to, by the strongest signal first.
export function matchSignup(lead, signups) {
  const shop = bareDomain(lead.myshopify_domain);
  const domain = bareDomain(lead.domain);
  const email = String(lead.contact_email || "").trim().toLowerCase() || null;
  for (const s of signups) {
    if (shop && bareDomain(s.shopify_shop) === shop) return { signup: s, how: "shopify store" };
  }
  for (const s of signups) {
    if (domain && [s.shopify_storefront, s.store_website, s.shopify_shop].map(bareDomain).includes(domain)) {
      return { signup: s, how: "domain" };
    }
  }
  for (const s of signups) {
    if (email && String(s.email || "").toLowerCase() === email) return { signup: s, how: "email" };
  }
  return null;
}

// → { checked, converted: [{ handle, how }] }
export async function refreshConversions() {
  const { data: leads, error } = await supabase
    .from(TABLE)
    .select("handle,domain,myshopify_domain,contact_email,dm_sent_at")
    .not("dm_sent_at", "is", null)
    .is("converted_at", null);
  if (error) throw error;
  if (!leads?.length) return { checked: 0, converted: [] };

  const earliest = leads.reduce((m, l) => (l.dm_sent_at < m ? l.dm_sent_at : m), leads[0].dm_sent_at);
  const { rows: signups } = await runWithDbTarget("prod", () => cloudSqlQuery(`
    SELECT u.email, u.shopify_shop, u.shopify_storefront, b.store_website, u.created
    FROM users u LEFT JOIN brands b ON b.user_id = u.id
    WHERE u.role = 2 AND u.created >= $1`, [earliest]));

  const converted = [];
  for (const lead of leads) {
    const after = signups.filter((s) => new Date(s.created) >= new Date(lead.dm_sent_at));
    const hit = matchSignup(lead, after);
    if (!hit) continue;
    const { error: saveError } = await supabase.from(TABLE).update({
      converted_at: new Date(hit.signup.created).toISOString(),
      converted_match: hit.how,
    }).eq("handle", lead.handle);
    if (saveError) throw saveError;
    converted.push({ handle: lead.handle, how: hit.how });
  }
  return { checked: leads.length, converted };
}
