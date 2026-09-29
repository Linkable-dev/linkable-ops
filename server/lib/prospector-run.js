// "Find new brands": the ops page starting a prospector worker run now,
// instead of waiting for the next four-hourly schedule.
//
// The button records when it was pressed (prospector_settings
// search_requested_at) and starts the Cloud Run job. The worker reads the
// time and searches Instagram even inside its usual spacing, and moves its
// rotation on by one slice, so a click searches phrasings the last run did not.
//
// Rate-limited here, not in the worker: every search is a session on the
// scraping Instagram account, and a button that can be pressed ten times in a
// minute is how an account gets restricted.
import { GoogleAuth } from "google-auth-library";

export const SEARCH_REQUESTED_KEY = "search_requested_at";
export const SEARCH_COOLDOWN_MINUTES = 30;
// A run that has not reported back in this long has failed, not "is running".
export const SEARCH_RUNNING_MAX_MINUTES = 25;

const JOB = process.env.PROSPECTOR_WORKER_JOB
  || "projects/linkable-418310/locations/europe-west2/jobs/prospector-worker";

let auth;
function googleAuth() {
  if (auth) return auth;
  const json = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    ...(json ? { credentials: JSON.parse(json) } : {}),
  });
  return auth;
}

// Starts one execution of the worker job. Throws when Cloud Run refuses.
export async function startProspectorRun() {
  const client = await googleAuth().getClient();
  const res = await client.request({ url: `https://run.googleapis.com/v2/${JOB}:run`, method: "POST", data: {} });
  return res.data?.name || null;
}

// Where the button stands, from the time it was last pressed and the time the
// worker last reported (prospector_feed_status.updated_at, written at the end
// of every run). → { requestedAt, running, availableAt }
export function searchState({ requestedAt, feedUpdatedAt, now = Date.now() }) {
  const asked = requestedAt ? Date.parse(requestedAt) : NaN;
  if (!Number.isFinite(asked)) return { requestedAt: null, running: false, availableAt: null };
  const reported = feedUpdatedAt ? Date.parse(feedUpdatedAt) : NaN;
  const running = (!Number.isFinite(reported) || reported < asked)
    && now - asked < SEARCH_RUNNING_MAX_MINUTES * 60_000;
  const availableAt = new Date(asked + SEARCH_COOLDOWN_MINUTES * 60_000).toISOString();
  return {
    requestedAt: new Date(asked).toISOString(),
    running,
    availableAt: now < Date.parse(availableAt) ? availableAt : null,
  };
}
