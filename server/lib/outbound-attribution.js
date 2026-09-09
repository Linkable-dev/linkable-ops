// Joins the outbound machine to the revenue it produced.
//
// The two halves live in different databases: prospects and sends in Supabase,
// customers and subscriptions in Cloud SQL. There is no foreign key between
// them, so the join is done here on the two things both sides record — the
// shop's domain and the contact's email address.
//
// Until this existed, outbound could report sends, opens, clicks and replies
// and nothing else, which meant every choice about templates, senders and
// segments was being made on reply rate: a comparison of conversations, not of
// customers.

import { supabase } from "./supabase.js";
import { cloudSqlQuery } from "./cloudsql.js";

// PostgREST caps a response at 1000 rows whatever .limit() says, so every read
// of a table that can outgrow that has to page explicitly.
async function pageAll(table, columns, tweak = (q) => q, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await tweak(
      supabase.from(table).select(columns).range(from, from + pageSize - 1),
    );
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < pageSize) return out;
  }
}

// "https://www.Acme-Store.co.uk/collections/all" → "acme-store.co.uk"
// Returns null for anything that isn't a usable host, so blanks never match
// each other.
export function normalizeDomain(value) {
  if (!value) return null;
  let s = String(value).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\./, "");
  s = s.split("/")[0].split("?")[0].split("#")[0].split("@").pop();
  s = s.replace(/:\d+$/, "").replace(/\.$/, "");
  if (!s.includes(".") || /\s/.test(s)) return null;
  return s;
}

const emailDomain = (email) => {
  const at = String(email || "").lastIndexOf("@");
  return at < 0 ? null : normalizeDomain(String(email).slice(at + 1));
};

// A myshopify.com host is the store's Shopify subdomain, not its real domain,
// and it is never what StoreLeads holds — matching on it would pair unrelated
// stores through a shared suffix.
const isUsableShopDomain = (d) => !!d && !d.endsWith("myshopify.com");

/* ------------------------------------------------------------------ sources */

// Every send we actually put in someone's inbox, with the campaign and the
// creative that carried it.
async function loadSends() {
  const rows = await pageAll(
    "email_sends",
    "id, to_email, campaign_id, template_key, brand_group, touch_number, sender_email, sent_at, contact_id",
    (q) => q.not("sent_at", "is", null).order("sent_at", { ascending: true }),
  );
  return rows;
}

// contact_id → the domain StoreLeads knew the prospect by. email_sends only
// stores the address, so this is how a send reaches a shop domain.
async function loadContactDomains() {
  const rows = await pageAll("contacts", "id, domain, email");
  const byId = new Map();
  for (const c of rows) {
    const d = normalizeDomain(c.domain) || emailDomain(c.email);
    if (d) byId.set(c.id, d);
  }
  return byId;
}

// Brands, including deleted ones: a prospect who signed up and later churned is
// still a conversion, and hiding it would flatter the numbers.
async function loadBrands() {
  const { rows } = await cloudSqlQuery(`
    SELECT u.id AS user_id, LOWER(u.email) AS email, b.store_name, b.store_website,
           u.created AS signed_up_at, u.account_id,
           (u.deleted = 'infinity'::timestamptz) AS active,
           asub.status AS sub_status, asub.price_amount, asub.price_currency,
           asub.interval AS sub_interval, COALESCE(asub.test, false) AS sub_test
    FROM users u
    JOIN brands b ON b.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT status, price_amount, price_currency, interval, test
      FROM app_subscriptions WHERE user_id = u.id
      ORDER BY (status = 'ACTIVE' AND cancelled_at IS NULL) DESC,
               shopify_created_at DESC NULLS LAST, synced_at DESC NULLS LAST
      LIMIT 1
    ) asub ON true
    WHERE u.role = 2`);
  return rows;
}

// Monthly value of a brand's plan, in the plan's own currency. A test charge is
// worth nothing, and neither is a subscription that is no longer ACTIVE.
function monthlyValue(b) {
  if (b.sub_test) return { mrr: 0, currency: null, paying: false };
  const fromPlan = /^shopify_(\d+)/.exec(b.account_id || "")?.[1];
  const amount = Number(b.price_amount) || Number(fromPlan) || 0;
  if (!amount) return { mrr: 0, currency: null, paying: false };
  if (b.sub_status && b.sub_status !== "ACTIVE") return { mrr: 0, currency: null, paying: false };
  const yearly = /year|annual/i.test(b.sub_interval || "") ||
                 /yearly|annual/i.test(b.account_id || "");
  return {
    mrr: Math.round((yearly ? amount / 12 : amount) * 100) / 100,
    currency: b.price_currency || "USD",
    paying: true,
  };
}

/* -------------------------------------------------------------- the join */

// Returns one row per brand we both emailed and later signed up.
//
// `matched_by` says which key carried the match, because they are not equally
// strong: an email match is the same human, a domain match is the same shop.
export async function computeConversions() {
  const [sends, contactDomains, brands] = await Promise.all([
    loadSends(), loadContactDomains(), loadBrands(),
  ]);

  // Earliest send per key, so "did the email come first?" has an answer.
  const byEmail = new Map();
  const byDomain = new Map();
  const keep = (map, key, send) => {
    if (!key) return;
    const prev = map.get(key);
    if (!prev || new Date(send.sent_at) < new Date(prev.sent_at)) map.set(key, send);
  };
  for (const s of sends) {
    const email = String(s.to_email || "").trim().toLowerCase();
    keep(byEmail, email, s);
    const domain = contactDomains.get(s.contact_id) || emailDomain(email);
    keep(byDomain, domain, s);
  }

  const rows = [];
  for (const b of brands) {
    const site = normalizeDomain(b.store_website);
    const domain = isUsableShopDomain(site) ? site : null;

    const emailHit = b.email ? byEmail.get(b.email) : null;
    const domainHit = domain ? byDomain.get(domain) : null;
    const hit = emailHit || domainHit;
    if (!hit) continue;

    const firstSentAt = new Date(hit.sent_at);
    const signedUpAt = b.signed_up_at ? new Date(b.signed_up_at) : null;
    const value = monthlyValue(b);

    rows.push({
      user_id: b.user_id,
      email: b.email,
      store_name: b.store_name || null,
      prospect_domain: domain || emailDomain(b.email),
      matched_by: emailHit ? "email" : "domain",
      first_sent_at: firstSentAt.toISOString(),
      signed_up_at: signedUpAt ? signedUpAt.toISOString() : null,
      campaign_id: hit.campaign_id || null,
      template_key: hit.template_key || null,
      brand_group: hit.brand_group || null,
      sender_email: hit.sender_email || null,
      // The email has to come first. A brand that signed up before we ever
      // wrote to them was not produced by outbound, however well the domains
      // line up — counting those is how attribution starts flattering itself.
      attributed: !!signedUpAt && signedUpAt >= firstSentAt,
      brand_active: b.active === true,
      is_paying: value.paying,
      mrr: value.mrr,
      mrr_currency: value.currency,
    });
  }
  return rows;
}

/* ------------------------------------------------------------- persistence */

// Cloud SQL, beside the app's other ops-owned tables (ops_alert_dismissals,
// ops_brand_nudges), so refreshing needs no manual Supabase migration.
const tableReady = {};
export async function ensureConversionsTable(target = "prod") {
  if (!tableReady[target]) {
    tableReady[target] = cloudSqlQuery(`
      CREATE TABLE IF NOT EXISTS ops_outbound_conversions (
        user_id uuid PRIMARY KEY,
        email text,
        store_name text,
        prospect_domain text,
        matched_by text,
        first_sent_at timestamptz,
        signed_up_at timestamptz,
        campaign_id uuid,
        template_key text,
        brand_group text,
        sender_email text,
        attributed boolean NOT NULL DEFAULT false,
        brand_active boolean,
        is_paying boolean,
        mrr numeric,
        mrr_currency text,
        computed_at timestamptz NOT NULL DEFAULT NOW()
      )`)
      .then(() => cloudSqlQuery(
        `CREATE INDEX IF NOT EXISTS ops_outbound_conversions_campaign_idx
           ON ops_outbound_conversions (campaign_id)`))
      .catch((e) => { delete tableReady[target]; throw e; });
  }
  return tableReady[target];
}

// Recompute and replace. The set is small (it can only ever be as large as the
// brand base) so a full refresh is simpler and safer than incremental updates.
export async function refreshConversions(target = "prod") {
  await ensureConversionsTable(target);
  const rows = await computeConversions();
  await cloudSqlQuery("DELETE FROM ops_outbound_conversions");
  for (const r of rows) {
    await cloudSqlQuery(`
      INSERT INTO ops_outbound_conversions
        (user_id, email, store_name, prospect_domain, matched_by, first_sent_at, signed_up_at,
         campaign_id, template_key, brand_group, sender_email, attributed, brand_active,
         is_paying, mrr, mrr_currency, computed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())`,
      [r.user_id, r.email, r.store_name, r.prospect_domain, r.matched_by, r.first_sent_at,
       r.signed_up_at, r.campaign_id, r.template_key, r.brand_group, r.sender_email,
       r.attributed, r.brand_active, r.is_paying, r.mrr, r.mrr_currency]);
  }
  return { matched: rows.length, attributed: rows.filter((r) => r.attributed).length };
}

/* ----------------------------------------------------------------- reading */

// Headline funnel plus the per-campaign and per-creative splits. Sends come
// from Supabase (the denominator), conversions from the table above.
export async function attributionSummary(target = "prod") {
  await ensureConversionsTable(target);

  const [{ rows: conv }, sends] = await Promise.all([
    cloudSqlQuery(`SELECT * FROM ops_outbound_conversions ORDER BY signed_up_at DESC NULLS LAST`),
    loadSends(),
  ]);

  const contacted = new Set(sends.map((s) => String(s.to_email || "").toLowerCase()).filter(Boolean));
  const attributed = conv.filter((c) => c.attributed);
  const paying = attributed.filter((c) => c.is_paying);

  const group = (key) => {
    const m = new Map();
    for (const s of sends) {
      const k = s[key] || "(none)";
      if (!m.has(k)) m.set(k, { key: k, sends: 0, signups: 0, paying: 0, mrr: 0 });
      m.get(k).sends += 1;
    }
    for (const c of attributed) {
      const k = c[key] || "(none)";
      if (!m.has(k)) m.set(k, { key: k, sends: 0, signups: 0, paying: 0, mrr: 0 });
      const row = m.get(k);
      row.signups += 1;
      if (c.is_paying) { row.paying += 1; row.mrr += Number(c.mrr) || 0; }
    }
    return [...m.values()]
      .map((r) => ({
        ...r,
        mrr: Math.round(r.mrr * 100) / 100,
        signupRate: r.sends ? Math.round((r.signups / r.sends) * 10000) / 100 : 0,
      }))
      .sort((a, b) => b.paying - a.paying || b.signups - a.signups || b.sends - a.sends);
  };

  return {
    totals: {
      sends: sends.length,
      contacted: contacted.size,
      matched: conv.length,
      signups: attributed.length,
      paying: paying.length,
      mrr: Math.round(paying.reduce((a, c) => a + (Number(c.mrr) || 0), 0) * 100) / 100,
      // A match whose signup predates the first email: real overlap, but not
      // something outbound can claim.
      preExisting: conv.length - attributed.length,
    },
    byCampaign: group("campaign_id"),
    byGroup: group("brand_group"),
    byTemplate: group("template_key"),
    bySender: group("sender_email"),
    conversions: conv,
    computedAt: conv[0]?.computed_at || null,
  };
}
