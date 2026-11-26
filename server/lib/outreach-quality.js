// The last look at a person before an email goes to them (26 Nov 2026).
//
// The first 28 people got emails that gave themselves away: a customer-service
// inbox instead of a person, a placeholder address, a brand in Pakistan, a
// "creator call" from 2020, "Hi Rebecca" to claire@, a talent agency instead
// of the creator. One of those is enough for the reader to decide it is a bot.
// The worker should not hand these over in the first place; this is the check
// that holds whatever it hands over, including people already waiting.
//
// Pure: no database, so every rule can be read in a test.

// Inboxes that reach a support queue, not whoever decides on creators. info@,
// hello@ and contact@ stay: at a small shop they are often the founder.
const SUPPORT_INBOX = /^(support|help|service|customer|care|orders?|returns?|writetous|enquir|inquir|sales|admin|retail|gifts?|wholesale|press|billing|accounts?|cs[._-]|shop$)/i;
// Help-desk domains are a support queue by definition.
const HELPDESK_DOMAIN = /(^|\.)(zendesk\.com|gorgias\.help|freshdesk\.com|helpscoutapp\.com)$/i;
// Addresses left in a theme: your@email.com, ihre@email.com, name@domain.com.
const PLACEHOLDER_DOMAIN = /^(email|domain|yourdomain|example|company|site|test|mail)\.(com|de|net|org)$|^example\./i;
const PLACEHOLDER_LOCAL = /^(ihre|your|yours|yourname|name|email|user|username|test|xxx+)$/i;
// A creator's agent answers for a roster, not for the creator.
const AGENCY = /talent|agency|agent\b|agent\.|agents|management|mgmt|-social\./i;

// Country endings we write to (UK, US, Italy, Spain) and endings that are used
// as generic ones. Any other two-letter ending is a country we do not write to.
const OUR_CC = new Set(["uk", "us", "it", "es"]);
const GENERIC_CC = new Set(["io", "ai", "co", "me", "tv", "cc", "ly", "gg", "so", "to", "fm", "sh", "la", "ws", "is", "app"]);

// A creator call older than this is closed; saying "saw your creator call"
// about it reads as a mailmerge. A creator's post goes stale more slowly.
export const BRAND_POST_MAX_DAYS = 60;
export const CREATOR_POST_MAX_DAYS = 120;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** When an Instagram post went up, from its link alone, or null. */
export function postDate(url) {
  const m = /instagram\.com\/(?:[^/]+\/)?(?:p|reel|tv)\/([A-Za-z0-9_-]+)/.exec(String(url || ""));
  if (!m) return null;
  let id = 0n;
  for (const c of m[1].slice(0, 11)) {
    const i = B64.indexOf(c);
    if (i < 0) return null;
    id = id * 64n + BigInt(i);
  }
  const ms = Number(id >> 23n) + 1314220021721;
  return Number.isFinite(ms) && ms > 1314220021721 ? new Date(ms) : null;
}

const daysSince = (date, now) => (new Date(now) - date) / 86400000;

/** Why this person must not get another email, or null. */
export function refusal(row, now = new Date()) {
  const email = String(row.to_email || "").trim().toLowerCase();
  const [local = "", domain = ""] = email.split("@");
  const v = row.variables || {};
  if (PLACEHOLDER_DOMAIN.test(domain) || PLACEHOLDER_LOCAL.test(local)) return "placeholder address";
  const cc = domain.split(".").pop();
  if (cc.length === 2 && !OUR_CC.has(cc) && !GENERIC_CC.has(cc)) return `address in .${cc}, not a country we write to`;
  if (row.audience === "brand") {
    if (SUPPORT_INBOX.test(local) || HELPDESK_DOMAIN.test(domain)) return "customer-service inbox";
    // Only when the email actually shows the call: a creator-post email
    // carries the call link without using it.
    const call = v.intentPostUrl && String(v.proofBlock || "").includes(v.intentPostUrl) ? postDate(v.intentPostUrl) : null;
    if (call && daysSince(call, now) > BRAND_POST_MAX_DAYS) return `creator call is ${Math.round(daysSince(call, now))} days old`;
  } else {
    if (AGENCY.test(email)) return "an agency, not the creator";
    // Only the first email mentions the post; the follow-ups do not.
    const post = (row.step || 0) === 0 ? postDate(v.examplePost) : null;
    if (post && daysSince(post, now) > CREATOR_POST_MAX_DAYS) return `post is ${Math.round(daysSince(post, now))} days old`;
  }
  return null;
}

const TITLES = new Set(["dr", "mr", "mrs", "ms", "miss", "mx", "prof", "sir"]);
const NOT_NAMES = new Set(["customer", "customers", "team", "there", "admin", "info", "shop", "store", "hello", "support", "sales", "owner", "founder", "friend", "all"]);
const GENERIC_LOCAL = /^(info|hello|hi|contact|team|support|help|sales|admin|enquiries|office|mail|collab|collabs|business|partnerships?|pr|brand|brands|bookings?|management|marketing)$/;

/** "Hi Rebecca," checked against what we know. Returns the greeting to use:
 *  the same, tidied ("NICOLE" -> "Nicole"), or bare ("Hi,") when the name is
 *  not believable. A wrong name ends the conversation; no name does not. */
export function cleanGreeting(row) {
  const greeting = String(row.variables?.greeting || "").trim();
  const m = /^(\S+)\s+(.+?),?$/.exec(greeting);
  if (!m) return greeting;
  const [, word, raw] = m;
  const lang = String(row.variables?.language || "en").toLowerCase();
  const bare = lang === "it" && row.audience === "brand" && word === "Ciao" ? "Buongiorno," : `${word},`;
  if (raw.startsWith("@")) return greeting; // the creator's handle, on purpose
  if (/\d/.test(raw)) return bare; // "2.fit.bros", "2Kaysisters": a handle, not a name
  const name = raw.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
  if (!name || name.includes(" ") && row.audience === "brand") return bare;
  if (!/^[\p{L}'-]+$/u.test(name) || name.length < 2 || name.length > 12) return bare;
  if (TITLES.has(name.toLowerCase()) || NOT_NAMES.has(name.toLowerCase())) return bare;
  const nice = name === name.toUpperCase() || name === name.toLowerCase()
    ? name[0].toUpperCase() + name.slice(1).toLowerCase()
    : name;
  if (nice.length < 3 && name === name.toUpperCase()) return bare; // "LO": initials, not a name
  // A brand's name comes from scraping its About page, which also names the
  // celebrities who wore it. When the address is plainly someone else's
  // (claire@ for "Rebecca"), the address wins.
  if (row.audience === "brand") {
    const local = String(row.to_email || "").toLowerCase().split("@")[0];
    const first = local.split(/[._\-+0-9]/)[0];
    if (first.length >= 3 && !GENERIC_LOCAL.test(first) && !local.includes(nice.toLowerCase()) && !nice.toLowerCase().includes(first)) return bare;
  }
  return `${word} ${nice},`;
}

// "one creator posted about X in the last 90 days. GoAffPro pays whoever signs
// themselves up, and I'd guess most of that lot never did." went to brands
// with a single creator found. Rewritten here for people already waiting; the
// worker no longer writes it.
const ONE_CREATOR = /\n?\n?one creator posted about (.+?) in the last 90 days\. (.+?) pays whoever signs themselves up, and I'd guess most of that lot never did\./;
const ONE_CREATOR_HOOK = /^One question\. Of the one creator who posted about (.+?) this quarter, how many ended up in (.+?)\?$/;

/** The variables with the known broken sentences mended. */
export function mendVariables(row) {
  const v = { ...(row.variables || {}) };
  v.greeting = cleanGreeting(row);
  if (typeof v.proofBlock === "string") {
    v.proofBlock = v.proofBlock.replace(ONE_CREATOR, (_, _brand, app) => `\n\n${app} pays whoever signs themselves up, and creators who post without being asked rarely do.`);
    // A count at the start of a sentence: "several creators posted" -> "Several".
    v.proofBlock = v.proofBlock.replace(/(^|\n\n)(several|one|\d+) creators? posted/g, (s, lead, w) => lead + w[0].toUpperCase() + s.slice(lead.length + 1));
  }
  if (typeof v.followUpHook === "string") {
    const hook = ONE_CREATOR_HOOK.exec(v.followUpHook);
    if (hook) {
      const top = /\B@[\w.]+/.exec(String(v.proofBlock || ""))?.[0] || "that creator";
      v.followUpHook = `One question. When ${top} posted about ${hook[1]}, did they end up in ${hook[2]}?`;
    }
  }
  return v;
}
