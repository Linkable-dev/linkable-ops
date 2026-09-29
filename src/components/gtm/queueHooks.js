import { useCallback, useEffect, useLayoutEffect, useState } from "react";

// Shared by the brand outreach queues (Email and Instagram): the same list,
// pager and filters, so the two tabs work the same way. Components live in
// QueueParts.jsx; these are the hooks and helpers, in a file of their own so
// fast refresh keeps working for everything importing them.

// Wide enough for the list beside the message; below this they stack.
export function useWide(min = 1100) {
  const [wide, setWide] = useState(() => window.innerWidth >= min);
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= min);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [min]);
  return wide;
}

const PAGER_PX = 100; // the gap above the list, the pager, the card border, the bottom padding, a margin

// How many rows fit between the top of the list and the bottom of the window,
// with room for the pager under them: the page asks the server for exactly
// that many, so the list never scrolls inside itself and the pager is always
// on screen. Measured again when the window is resized or `key` changes.
export function useRowsThatFit(anchorRef, rowPx, enabled, key) {
  const fit = useCallback(() => {
    const top = anchorRef.current ? anchorRef.current.getBoundingClientRect().top + window.scrollY : 330;
    return Math.max(5, Math.floor((window.innerHeight - top - PAGER_PX) / rowPx));
  }, [anchorRef, rowPx]);
  const [rows, setRows] = useState(() => Math.max(5, Math.floor((window.innerHeight - 330 - PAGER_PX) / rowPx)));
  useLayoutEffect(() => {
    if (!enabled) return undefined;
    const measure = () => setRows((cur) => { const next = fit(); return next === cur ? cur : next; });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [enabled, fit, key]);
  return rows;
}

// Options with counts, largest first; a chosen option with nothing waiting
// still shows, so it can be unticked.
export function countedOptions(counts, chosen, labelOf) {
  const codes = Object.keys(counts || {}).sort((a, b) => (counts[b] - counts[a]) || a.localeCompare(b));
  for (const c of chosen) if (!codes.includes(c)) codes.push(c);
  return codes.map((code) => ({ code, label: labelOf(code), count: counts?.[code] ?? 0 }));
}
