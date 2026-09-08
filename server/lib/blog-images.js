/* global process */
// Stock photos for article heroes, via the Pexels API (PEXELS_API_KEY).
// Returns hero objects the landing-page renderer understands:
//   { provider, id, alt, width, height, src, srcset:[{url,w}], credit:{name,url}, page, query }
// The landing repo downloads the files so the site never hotlinks.
const API = "https://api.pexels.com/v1/search";

export function pexelsEnabled() { return Boolean(process.env.PEXELS_API_KEY); }

export async function searchPhotos(query, { perPage = 12, page = 1 } = {}) {
  if (!pexelsEnabled()) { const e = new Error("PEXELS_API_KEY not set; add it to enable photo search"); e.status = 503; throw e; }
  const url = `${API}?query=${encodeURIComponent(query)}&orientation=landscape&size=large&per_page=${perPage}&page=${page}`;
  const res = await fetch(url, { headers: { Authorization: process.env.PEXELS_API_KEY } });
  if (!res.ok) { const e = new Error(`Pexels ${res.status}: ${await res.text()}`); e.status = 502; throw e; }
  const data = await res.json();
  return (data.photos || []).map((p) => toHero(p, query));
}

function toHero(p, query) {
  const ratio = p.height / p.width;
  return {
    provider: "pexels", id: p.id, alt: p.alt || query, width: p.width, height: p.height,
    thumb: p.src.medium,
    src: p.src.large2x,
    srcset: [{ url: p.src.large, w: 940 }, { url: p.src.large2x, w: 1880 }],
    credit: { name: p.photographer, url: p.photographer_url }, page: p.url, query,
    aspect: ratio,
  };
}

// Best landscape photo for an article that is not already used by another post.
export async function findHeroPhoto(query, { exclude = [] } = {}) {
  if (!pexelsEnabled()) return null;
  const skip = new Set(exclude.map(String));
  for (const q of [query, query.split(/\s+/).slice(0, 2).join(" "), "ecommerce creator content"]) {
    const photos = await searchPhotos(q, { perPage: 15 });
    const pick = photos.find((p) => !skip.has(String(p.id)) && p.aspect >= 0.5 && p.aspect <= 0.8) || photos.find((p) => !skip.has(String(p.id)));
    if (pick) { delete pick.thumb; delete pick.aspect; return pick; }
  }
  return null;
}
