import { useEffect, useRef } from "react";

// Runs `fn` every `ms` while the tab is shown, and never while it is hidden.
// A tab left open overnight used to keep asking the ops database for data
// nobody was looking at; on 25 Nov 2026 that load took the database down.
// When the tab comes back after at least `ms`, `fn` runs once straight away
// so the page is fresh. Pass `enabled = false` to stop it altogether.
export function useVisibleInterval(fn, ms, enabled = true) {
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });

  useEffect(() => {
    if (!enabled) return undefined;
    let last = Date.now();
    const visible = () => document.visibilityState === "visible";
    const run = () => { last = Date.now(); fnRef.current(); };
    const timer = setInterval(() => { if (visible()) run(); }, ms);
    const onShow = () => { if (visible() && Date.now() - last >= ms) run(); };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [ms, enabled]);
}
