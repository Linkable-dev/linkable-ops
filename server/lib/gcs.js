// GCS signed-URL helper. Mirrors what the main app's storage_service.py does
// (`blob.generate_signed_url(method='GET', expiration=1h)`) so admin views in
// linkable-ops can render the same images and files the main app does.
//
// Auth: uses the service account at GOOGLE_APPLICATION_CREDENTIALS (already
// configured in server/.env for the CloudSQL connector).
//
// The bucket follows the request's database target, the way every query here
// already does. It used to be one GCS_BUCKET for everything, defaulting to
// dev's — so with the panel switched to prod, a prod row's file name was
// signed against the dev bucket and came back as a broken image. A file name
// only means anything next to the database it was read from.
//
// Signing is purely local crypto (no network call), so signing many URLs in
// a loop is cheap.

import { Storage } from "@google-cloud/storage";
import { currentDbTarget } from "./cloudsql.js";

const BUCKETS = {
  prod: process.env.GCS_BUCKET || "linkable-storage",
  dev: process.env.GCS_BUCKET_DEV || "linkable-storage-dev",
};

let storage = null;
let initFailed = false;
const buckets = new Map();

function getBucket(target) {
  if (initFailed) return null;
  const name = BUCKETS[target || currentDbTarget()] || BUCKETS.prod;
  if (buckets.has(name)) return buckets.get(name);
  try {
    storage = storage || new Storage();
    const b = storage.bucket(name);
    buckets.set(name, b);
    return b;
  } catch (err) {
    console.warn("[gcs] init failed:", err.message);
    initFailed = true;
    return null;
  }
}

// `disposition` asks GCS to send Content-Disposition with the object, which is
// how a download becomes a download: the HTML `download` attribute is ignored
// cross-origin, so a link to storage.googleapis.com opens the file in a tab
// instead of saving it. The header has to come from the signature.
export async function signedUrl(blobName, expiresInSeconds = 3600, target, disposition) {
  if (!blobName) return null;
  const b = getBucket(target);
  if (!b) return null;
  try {
    const [url] = await b.file(blobName).getSignedUrl({
      action: "read",
      expires: Date.now() + expiresInSeconds * 1000,
      version: "v4",
      ...(disposition ? { responseDisposition: disposition } : {}),
    });
    return url;
  } catch (err) {
    console.warn(`[gcs] sign failed for ${blobName}:`, err.message);
    return null;
  }
}

// Sign a gs://bucket/object path, whatever bucket it names.
//
// The content service stores an asset's location as a full gs:// URI rather
// than a bare object name, and it is not always the target's default bucket —
// so the bucket comes from the path, not from the switch. Anything already
// https:// is passed through: it is fetchable as it stands.
export async function signedGsUrl(gsPath, expiresInSeconds = 3600, disposition) {
  const path = String(gsPath || "");
  if (!path) return null;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  const m = path.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const [, bucketName, object] = m;
  if (initFailed) return null;
  try {
    storage = storage || new Storage();
    const b = buckets.get(bucketName) || storage.bucket(bucketName);
    buckets.set(bucketName, b);
    const [url] = await b.file(object).getSignedUrl({
      action: "read",
      expires: Date.now() + expiresInSeconds * 1000,
      version: "v4",
      ...(disposition ? { responseDisposition: disposition } : {}),
    });
    return url;
  } catch (err) {
    console.warn(`[gcs] sign failed for ${path}:`, err.message);
    return null;
  }
}

// Sign many in parallel. Returns the same array length, with nulls for failures.
export async function signedUrls(blobNames, expiresInSeconds = 3600, target) {
  // Resolved once, here: signing happens inside a Promise.all, and the async
  // context that carries the target does not survive every await in every
  // caller. One read at the top cannot drift.
  const t = target || currentDbTarget();
  return Promise.all(blobNames.map((n) => signedUrl(n, expiresInSeconds, t)));
}
