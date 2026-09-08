import { useEffect, useState } from "react";

// Current time that refreshes on an interval, so "N days left" style countdowns
// never freeze at the moment a row first mounted.
export function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
