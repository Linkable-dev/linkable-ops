// GCS signed-URL helper. Mirrors what the main app's storage_service.py does
// (`blob.generate_signed_url(method='GET', expiration=1h)`) so admin views in
// linkable-ops can render the same profile/logo images the main app does.
//
// Auth: uses the service account at GOOGLE_APPLICATION_CREDENTIALS (already
// configured in server/.env for the CloudSQL connector). Bucket name comes
// from the GCS_BUCKET env var, defaulting to the main app's dev bucket.
//
// Signing is purely local crypto (no network call), so signing many URLs in
// a loop is cheap.

import { Storage } from "@google-cloud/storage";

let bucket = null;
let initFailed = false;

function getBucket() {
  if (initFailed) return null;
  if (bucket) return bucket;
  try {
    const storage = new Storage();
    const bucketName = process.env.GCS_BUCKET || "linkable-storage-dev";
    bucket = storage.bucket(bucketName);
    return bucket;
  } catch (err) {
    console.warn("[gcs] init failed:", err.message);
    initFailed = true;
    return null;
  }
}

export async function signedUrl(blobName, expiresInSeconds = 3600) {
  if (!blobName) return null;
  const b = getBucket();
  if (!b) return null;
  try {
    const [url] = await b.file(blobName).getSignedUrl({
      action: "read",
      expires: Date.now() + expiresInSeconds * 1000,
      version: "v4",
    });
    return url;
  } catch (err) {
    console.warn(`[gcs] sign failed for ${blobName}:`, err.message);
    return null;
  }
}

// Sign many in parallel. Returns the same array length, with nulls for failures.
export async function signedUrls(blobNames, expiresInSeconds = 3600) {
  return Promise.all(blobNames.map((n) => signedUrl(n, expiresInSeconds)));
}
