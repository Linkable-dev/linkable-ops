// "24m ago" and "in 13d", in one place.
//
// Both the Autopilot table and its expanded row say how long ago the agent
// acted and when it will look again; they were the same twelve lines twice,
// which is how two parts of one row end up disagreeing about what "2d" means.

/** How long ago something happened, for a timestamp that has passed. */
export function ago(raw) {
  if (!raw) return "—";
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return "—";
  const mins = Math.floor((Date.now() - at.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** A calendar date, for a fact worth reading precisely rather than relatively
 *  -- "17 Sep 2026", not "13h ago". The year is dropped for anything in the
 *  last 11 months, since a launch date that recent reads faster without it and
 *  the month alone is enough to place it. */
export function friendlyDate(raw) {
  if (!raw) return "—";
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return "—";
  const sameYear = at.getFullYear() === new Date().getFullYear();
  const recent = Date.now() - at.getTime() < 330 * 24 * 60 * 60 * 1000;
  return at.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: sameYear && recent ? undefined : "numeric",
  });
}

/** How long until something will happen, for a timestamp in the future. */
export function whenNext(raw) {
  if (!raw) return "—";
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return "—";
  const mins = Math.round((at.getTime() - Date.now()) / 60000);
  if (mins <= 0) return "due now";
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
}
