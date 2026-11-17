// Find an Instagram post from a screenshot (Federico, 17 Nov 2026: "ci metto
// 5 min per campagna"). Copying each post's link by hand is the slow part of
// Add calls, so the batch mode sends screenshots only: Claude reads the
// handle and the caption's opening off each one (callInbox.js), and this
// finds the post itself among the account's latest posts and reels, by its
// caption, through Apify (the prospector's token, read from Secret Manager).
//
// About 1 to 3 cents a post: the profile's 12 latest posts first, its 24
// latest reels only when those miss. Nothing is guessed: a post is returned
// only when its caption matches what the screenshot shows; otherwise the card
// asks for the link.

import { GoogleAuth } from "google-auth-library";

const APIFY = "https://api.apify.com/v2/acts";
const SECRET = "projects/linkable-418310/secrets/prospector-apify-token/versions/latest";
const REELS_LIMIT = 24;
// Each Apify run waits at most this long (the Vercel function has 60 s).
const RUN_TIMEOUT_S = 40;

let cachedToken = null;

function credentials() {
  const json = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (json) return { credentials: JSON.parse(json) };
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return { keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS };
  return {};
}

// apifyToken: APIFY_TOKEN when set, else the prospector's token.
export async function apifyToken() {
  if (process.env.APIFY_TOKEN) return process.env.APIFY_TOKEN;
  if (cachedToken) return cachedToken;
  const auth = new GoogleAuth({ ...credentials(), scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  const res = await client.request({ url: `https://secretmanager.googleapis.com/v1/${SECRET}:access` });
  cachedToken = Buffer.from(res.data.payload.data, "base64").toString("utf8").trim();
  return cachedToken;
}

async function runActor(actor, input, { token, fetchImpl = fetch } = {}) {
  const url = `${APIFY}/${actor}/run-sync-get-dataset-items?timeout=${RUN_TIMEOUT_S}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Apify ${actor} answered ${res.status}`);
  const items = await res.json();
  return Array.isArray(items) ? items : [];
}

// The words of a caption, for matching: lower case, letters and digits only
// (fancy Unicode bold folded), no hashtags or handles.
export function captionWords(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/(^|\s)[#@][\p{L}\p{N}_.]+/gu, " ")
    .replace(/\.\.\.\s*more$|…\s*more$/u, " ")
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

// matchScore: the share of the screenshot's first words (up to 14) that
// appear, in order, near the start of the post's caption.
export function matchScore(seen, caption) {
  const want = captionWords(seen).slice(0, 14);
  if (want.length < 2) return 0;
  const have = captionWords(caption).slice(0, 80);
  let i = 0;
  let hit = 0;
  for (const w of want) {
    const at = have.indexOf(w, i);
    if (at !== -1) {
      hit++;
      i = at + 1;
    }
  }
  return hit / want.length;
}

const MATCH = 0.75;

// A bio link that is the brand's own site, not a link-in-bio page or a
// marketplace or social profile.
const NOT_A_SITE = /(^|\.)(linktr\.ee|beacons\.ai|lnk\.bio|linkin\.bio|bio\.site|campsite\.bio|komi\.io|stan\.store|instagram\.com|tiktok\.com|facebook\.com|youtube\.com|etsy\.com|amazon\.[a-z.]+|depop\.com|vinted\.[a-z.]+|wa\.me|linkpop\.com|shopmy\.us|later\.com|tap\.bio|hoo\.be|snipfeed\.co|msha\.ke)$/i;
export function brandWebsite(link) {
  try {
    const host = new URL(String(link || "")).hostname.replace(/^www\./, "");
    return host && !NOT_A_SITE.test(host) ? host : "";
  } catch {
    return "";
  }
}

function best(posts, seen) {
  let top = null;
  for (const p of posts) {
    const score = matchScore(seen, p.caption);
    if (score >= MATCH && (!top || score > top.score)) top = { ...p, score };
  }
  return top;
}

const shortPost = (p, kind) => ({
  code: p.shortCode,
  url: `https://www.instagram.com/${kind === "reel" || p.productType === "clips" ? "reel" : "p"}/${p.shortCode}/`,
  caption: p.caption || "",
  posted_at: p.timestamp || "",
});

// findPost: the post on @handle whose caption starts like `seen`. Returns
// { post_url, caption, posted_at, website, full_name, searched } or
// { post_url: "" , searched } when nothing matched.
export async function findPost({ handle, seen }, deps = {}) {
  const h = String(handle || "").trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(h)) return { post_url: "", searched: 0, why: "no handle" };
  if (captionWords(seen).length < 2) return { post_url: "", searched: 0, why: "no caption" };
  const token = deps.token || (await apifyToken());
  const run = deps.runActor || ((actor, input) => runActor(actor, input, { token }));

  const [profile] = await run("apify~instagram-profile-scraper", { usernames: [h] });
  const website = brandWebsite(profile?.externalUrl);
  const fullName = profile?.fullName || "";
  const grid = (profile?.latestPosts || []).filter((p) => p.shortCode).map((p) => shortPost(p, p.type === "Video" ? "reel" : "post"));
  let hit = best(grid, seen);
  let searched = grid.length;
  if (!hit) {
    const reels = (await run("apify~instagram-reel-scraper", { username: [h], resultsLimit: REELS_LIMIT }))
      .filter((p) => p.shortCode && String(p.ownerUsername || "").toLowerCase() === h)
      .map((p) => shortPost(p, "reel"));
    searched += reels.length;
    hit = best(reels, seen);
  }
  console.log(`[post-finder] @${h} searched=${searched} found=${hit ? hit.code : "-"}${hit ? ` score=${hit.score.toFixed(2)}` : ""}`);
  if (!hit) return { post_url: "", searched, website, full_name: fullName };
  return { post_url: hit.url, caption: hit.caption, posted_at: hit.posted_at, website, full_name: fullName, searched };
}
