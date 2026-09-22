// Shared building blocks for the app's data tables: drag-resizable column
// widths (persisted per table in localStorage), drag-to-reorder columns
// (same persistence shape), sortable header cells, and debounced per-column
// filter inputs that drive SERVER-side filtering.
//
// These are retrofit primitives, not a monolithic <DataTable>: each page keeps
// its own markup (real <table> or CSS-grid divs) and behavior (row clicks,
// pills, expanders) and only swaps in the pieces it needs. Grid pages drive
// gridTemplateColumns from useColumnWidths; <table> pages feed the same widths
// into a <colgroup>.
//
// Reordering is real DOM order, not a CSS trick: a <table> lays out <td>s in
// document order regardless of any `order` style (that's a flex/grid-only
// property), so a page that wants its columns to actually move has to render
// both its header AND its body cells from the same `orderedColumns` array —
// see useColumnOrder's own doc comment below.

/* eslint-disable react-refresh/only-export-components -- shared table
   primitives: hooks + tiny components belong together; no fast-refresh need */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Select } from "../ui/Select";

const WIDTHS_STORE_PREFIX = "ops.tableWidths.";

function loadStoredWidths(tableId) {
  try {
    return JSON.parse(localStorage.getItem(WIDTHS_STORE_PREFIX + tableId)) || {};
  } catch {
    return {};
  }
}

// Which columns the user has dragged, kept apart from the widths themselves
// because the widths map is written whole (every column, default or not) and
// so cannot say who chose what. Only `fill` columns read it — see gridTemplate.
const SIZED_STORE_PREFIX = "ops.tableSized.";

function loadStoredSized(tableId) {
  try {
    const raw = JSON.parse(localStorage.getItem(SIZED_STORE_PREFIX + tableId));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function persistSized(tableId, keys) {
  try {
    localStorage.setItem(SIZED_STORE_PREFIX + tableId, JSON.stringify([...keys]));
  } catch { /* private mode etc. — resizing still works for the session */ }
}

const EMPTY_KEYS = [];

function applyFixed(widths, defaultWidths, fixedKeys) {
  if (!fixedKeys.length) return widths;
  const out = { ...widths };
  for (const key of fixedKeys) out[key] = defaultWidths[key];
  return out;
}

// Column widths in px, initialized from defaults overridden by whatever the
// user dragged last time. `startResize` is a mousedown handler for a header
// drag handle; double-clicking a handle resets that column to its default.
// `fixedKeys` names columns the user can't drag (no handle): their stored width
// is ignored, so changing such a default in code takes effect even for someone
// whose localStorage still holds a snapshot taken with the old one.
export function useColumnWidths(tableId, defaultWidths, fixedKeys = EMPTY_KEYS) {
  const seed = useCallback(
    () => applyFixed({ ...defaultWidths, ...loadStoredWidths(tableId) }, defaultWidths, fixedKeys),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tableId, fixedKeys],
  );
  const [widths, setWidths] = useState(seed);
  const dragRef = useRef(null);
  // Which columns the USER has sized, as opposed to ones still on the width
  // they were built with. Only `fill` columns care (see gridTemplate): one of
  // those absorbs the leftover space, so until this existed, dragging the
  // widest column on a grid table — Store or Email on /users, the first thing
  // anyone tries — stored the new width and changed nothing on screen, because
  // the 1fr went on filling the row regardless.
  const sizedSeed = useCallback(
    () => new Set(loadStoredSized(tableId).filter((k) => !fixedKeys.includes(k))),
    [tableId, fixedKeys],
  );
  const [sized, setSized] = useState(sizedSeed);

  // Switching tabs re-mounts with a different tableId (e.g. brands↔creators
  // share the page) — re-seed from that table's stored widths.
  useEffect(() => {
    setWidths(seed());
    setSized(sizedSeed());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId]);

  const persist = useCallback((next) => {
    try {
      localStorage.setItem(WIDTHS_STORE_PREFIX + tableId, JSON.stringify(next));
    } catch { /* private mode etc. — resizing still works for the session */ }
  }, [tableId]);

  const startResize = useCallback((key, e, { min = 50 } = {}) => {
    e.preventDefault();
    e.stopPropagation(); // don't trigger the header's sort onClick
    const startX = e.clientX;
    // Measure what the column is actually RENDERED at, which is not always its
    // stored width: a fill column is stretched by its 1fr, and a fixed-layout
    // <table> spreads leftover space across every column. Starting the drag
    // from the stored number made the column jump to it on the first pixel.
    const cell = e.currentTarget?.parentElement;
    const rendered = cell ? Math.round(cell.getBoundingClientRect().width) : 0;
    dragRef.current = { key, startX, startW: rendered || null, min };
    // Marked on the way IN, not on mouseup: a fill column has to stop
    // absorbing the leftover space as the drag happens, or the whole gesture
    // looks inert until you let go.
    setSized((cur) => {
      if (cur.has(key)) return cur;
      const next = new Set(cur).add(key);
      persistSized(tableId, next);
      return next;
    });
    if (!rendered) {
      // No cell to measure (a caller that puts the handle somewhere else):
      // fall back to the stored width, read through an updater because that is
      // the only way to see the current state from inside the handler.
      setWidths((w) => {
        dragRef.current.startW = w[key];
        return w;
      });
    }
    const onMove = (ev) => {
      const d = dragRef.current;
      if (!d || d.startW == null) return;
      const next = Math.max(d.min, Math.round(d.startW + (ev.clientX - d.startX)));
      setWidths((w) => (w[d.key] === next ? w : { ...w, [d.key]: next }));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setWidths((w) => { persist(w); return w; });
      dragRef.current = null;
      // preventDefault on mousedown does not stop the click that follows, and
      // that click lands on the header - which sorts. So the next one is
      // swallowed, once, in the capture phase before anything can act on it.
      const swallow = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      document.addEventListener("click", swallow, { capture: true, once: true });
      // If no click follows - a drag that ended outside the header, say - the
      // listener must not sit there waiting to eat an unrelated one.
      setTimeout(() => document.removeEventListener("click", swallow, { capture: true }), 0);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [persist, tableId]);

  const resetWidth = useCallback((key) => {
    setWidths((w) => {
      const next = { ...w, [key]: defaultWidths[key] };
      persist(next);
      return next;
    });
    // A column put back to its default is one the user has NOT sized, which is
    // what hands a fill column its leftover space again.
    setSized((cur) => {
      if (!cur.has(key)) return cur;
      const next = new Set(cur);
      next.delete(key);
      persistSized(tableId, next);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persist, tableId]);

  return { widths, sized, startResize, resetWidth };
}

// gridTemplateColumns for CSS-grid tables. A `fill` column absorbs the leftover
// space (its width acts as a minimum) so the table always spans its container —
// until the user drags it, after which the width they chose is the width they
// get. `sized` is useColumnWidths' set of user-sized keys; without it a fill
// column silently ignores every resize.
export function gridTemplate(columns, widths, sized) {
  return columns
    .map((c) => (c.fill && !sized?.has(c.key) ? `minmax(${widths[c.key]}px, 1fr)` : `${widths[c.key]}px`))
    .join(" ");
}

const ORDER_STORE_PREFIX = "ops.tableOrder.";

function loadStoredOrder(tableId) {
  try {
    const raw = JSON.parse(localStorage.getItem(ORDER_STORE_PREFIX + tableId));
    return Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
}

// Column order, drag-to-reorder, persisted per table the same way widths are.
// `columns` is the full list in its built-in (code) order; `fixedKeys` (a
// checkbox or an actions column, say) are excluded from dragging and always
// re-pinned at their original index — so renaming/adding/removing a column
// in code, or a stale localStorage snapshot from before a column existed,
// can never strand a fixed column mid-table or drop an unknown key.
//
// Returns `orderedColumns` — the ONLY thing a caller should ever map over
// for both its header row and its body rows. A <table> lays cells out in
// document order; there's no CSS way to visually reorder a <td> the way
// `order` reorders a flex/grid item. Mapping the header from orderedColumns
// but the body from the original `columns` (or from hardcoded JSX) renders a
// table whose header lies about what's under it the moment a column moves.
export function useColumnOrder(tableId, columns, fixedKeys = EMPTY_KEYS) {
  const keys = columns.map((c) => c.key);
  const keysSig = keys.join("␟"); // an ASCII separator no real column key would contain

  const seed = useCallback(() => {
    const fixedSet = new Set(fixedKeys);
    const draggableDefault = keys.filter((k) => !fixedSet.has(k));
    const stored = loadStoredOrder(tableId);
    let draggableOrder = draggableDefault;
    if (stored) {
      const known = new Set(draggableDefault);
      const kept = stored.filter((k) => known.has(k));
      const missing = draggableDefault.filter((k) => !kept.includes(k));
      draggableOrder = [...kept, ...missing];
    }
    let di = 0;
    return keys.map((k) => (fixedSet.has(k) ? k : draggableOrder[di++]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId, keysSig, fixedKeys]);

  const [order, setOrder] = useState(seed);
  useEffect(() => {
    setOrder(seed());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId, keysSig]);

  const persist = useCallback((next) => {
    try {
      const fixedSet = new Set(fixedKeys);
      localStorage.setItem(ORDER_STORE_PREFIX + tableId, JSON.stringify(next.filter((k) => !fixedSet.has(k))));
    } catch { /* private mode etc. — reordering still works for the session */ }
  }, [tableId, fixedKeys]);

  // A ref, not state: the dragged key only ever needs to be read inside a
  // drop/dragover handler, and putting it in state would re-render every
  // header cell on every pixel the pointer crosses while dragging.
  const draggingRef = useRef(null);
  const [dragOverKey, setDragOverKey] = useState(null);

  // Spread onto the small grip icon in the header, not the whole cell — the
  // cell already owns click-to-sort and a resize drag, and stacking a third
  // gesture on the same surface is how a click meant to sort ends up
  // reordering columns instead.
  const dragHandleProps = useCallback((key) => ({
    draggable: true,
    onDragStart: (e) => {
      draggingRef.current = key;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", key); // Firefox won't start a drag without this
    },
    onDragEnd: () => {
      draggingRef.current = null;
      setDragOverKey(null);
    },
  }), []);

  // Spread onto the <th> itself: the drop target is the whole header cell,
  // not just the grip, because hitting a coin-sized grip exactly on drop
  // would make this fiddly rather than forgiving.
  const dropTargetProps = useCallback((key) => ({
    onDragOver: (e) => {
      if (!draggingRef.current || draggingRef.current === key) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOverKey((cur) => (cur === key ? cur : key));
    },
    onDragLeave: (e) => {
      if (e.currentTarget.contains(e.relatedTarget)) return; // still inside, e.g. over the grip
      setDragOverKey((cur) => (cur === key ? null : cur));
    },
    onDrop: (e) => {
      e.preventDefault();
      const from = draggingRef.current;
      draggingRef.current = null;
      setDragOverKey(null);
      if (!from || from === key || fixedKeys.includes(key)) return;
      setOrder((cur) => {
        const fromIndex = cur.indexOf(from);
        const toIndex = cur.indexOf(key);
        if (fromIndex < 0 || toIndex < 0) return cur;
        const next = cur.filter((k) => k !== from);
        // The dropped column takes the target's place, which means landing
        // AFTER it when the drag went rightwards and before it when it went
        // left. Always inserting before the target made the obvious gesture —
        // drag a column onto its right-hand neighbour to swap the two — lift
        // the column out and put it straight back where it was, so the header
        // didn't move and the feature read as broken; a drag to the far right
        // landed one column short of where it was dropped.
        const at = next.indexOf(key) + (fromIndex < toIndex ? 1 : 0);
        next.splice(at, 0, from);
        // Fixed columns (a checkbox, an actions column) stay at the index they
        // were built at — the same re-pinning `seed` does, applied here too so
        // what the drop renders is what a reload will show.
        const fixedSet = new Set(fixedKeys);
        const draggable = next.filter((k) => !fixedSet.has(k));
        let di = 0;
        const settled = cur.map((k) => (fixedSet.has(k) ? k : draggable[di++]));
        persist(settled);
        return settled;
      });
    },
  }), [persist, fixedKeys]);

  const orderedColumns = order.map((k) => columns.find((c) => c.key === k)).filter(Boolean);
  return { orderedColumns, dragHandleProps, dropTargetProps, dragOverKey };
}

// The small drag-to-reorder grip. Same invisible-until-hovered treatment as
// ResizeHandle, but a distinct affordance (grip glyph vs. an edge strip) so
// the two gestures a header supports don't look like the same control.
export function DragHandle({ colKey, dragHandleProps, theme }) {
  const [hover, setHover] = useState(false);
  return (
    <span
      {...dragHandleProps(colKey)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onMouseDown={(e) => e.stopPropagation()} // don't let a grab start the header's onClick sort
      onClick={(e) => e.stopPropagation()}
      title="Drag to reorder"
      style={{
        display: "inline-flex", alignItems: "center", flexShrink: 0,
        cursor: "grab", marginRight: 2,
        color: theme?.text || "#888",
        opacity: hover ? 0.7 : 0.3, transition: "opacity 0.12s",
      }}
    >
      <svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor" aria-hidden="true">
        <circle cx="2" cy="2" r="1.2" /><circle cx="6" cy="2" r="1.2" />
        <circle cx="2" cy="6" r="1.2" /><circle cx="6" cy="6" r="1.2" />
        <circle cx="2" cy="10" r="1.2" /><circle cx="6" cy="10" r="1.2" />
      </svg>
    </span>
  );
}

// Thin invisible-until-hovered drag strip on a header cell's right edge.
// The parent cell needs position:relative.
export function ResizeHandle({ colKey, startResize, resetWidth, theme }) {
  const [hover, setHover] = useState(false);
  return (
    <span
      onMouseDown={(e) => startResize(colKey, e)}
      onDoubleClick={() => resetWidth(colKey)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Drag to resize · double-click to reset"
      style={{
        // Fully INSIDE the cell. It used to straddle the edge (right: -5), and
        // a header cell that clips its content — which they now do, so a
        // squeezed column stops bleeding over its neighbour — clipped half the
        // grab strip away with it.
        // Wider than it looks, and above everything else in the cell. At 10px
        // it was a coin-sized target sitting at the very edge of the column,
        // so an aim a few pixels short landed on the sort label instead and
        // the column sorted when somebody meant to resize it.
        position: "absolute", top: 0, right: 0, bottom: 0, width: RESIZE_STRIP,
        cursor: "col-resize", zIndex: 5,
        display: "flex", alignItems: "stretch", justifyContent: "center",
      }}
    >
      {/* Visible at rest, not only under the cursor.
          It used to be transparent until hovered, which made the whole
          affordance undiscoverable: no column separators, and no hint that a
          column could be resized at all unless you happened to pass over the
          exact strip. At rest it is the same hairline as the table's own
          borders, so it reads as column separation; on hover it darkens into
          a handle. */}
      <span style={{
        width: hover ? 2 : 1, borderRadius: 1,
        background: hover ? (theme?.text || "#888") : (theme?.border || "#E5EAF0"),
        opacity: hover ? 0.55 : 1,
        transition: "background 0.12s, width 0.12s",
      }} />
    </span>
  );
}

// The two halves of a header cell that every table here needs and each one
// used to re-implement: the style the cell carries, and the layout of what
// sits inside it.
//
// They exist because the bug they fix was in nine tables at once. A header
// cell is `white-space: nowrap` and its column has a fixed width, so a heading
// longer than its own column printed itself straight over the next column's —
// which is what anyone dragging a column narrower sees immediately, and what
// made the resize handle look like it was doing something wrong.
//
// `position: relative` is in here too because ResizeHandle is absolutely
// positioned against the cell and silently does nothing without it.
// How wide the grab strip is, and therefore how much room every header cell
// has to keep free on its right so the strip is never sitting on top of
// something clickable - the filter funnel, in particular, which lives at that
// end of the cell.
export const RESIZE_STRIP = 14;

// What a header cell spends before the label gets a pixel: the drag grip, the
// gap after it, the sort arrow, the filter funnel, the resize strip and the
// cell's own padding.
//
// This is why numeric columns were truncating to "C…" and "S…". They were
// given 80-100px on the reasoning that the values are small numbers, which is
// true, and the header is not - "Accepted" over a column of single digits
// still needs room for "Accepted".
const HEADER_CHROME = { grip: 16, sort: 14, funnel: 22, padding: 22 };

/**
 * The width a column needs for its own header to fit, at minimum.
 *
 * Approximate on purpose: measuring text properly means rendering it, and a
 * default width only has to be close enough that nothing truncates before
 * anybody drags anything. Roughly 6.6px per character at the 11px uppercase
 * headers these tables use.
 */
export function headerWidth(label, { grip = true, sortable = true, filter = true, min = 70 } = {}) {
  const chrome = RESIZE_STRIP + HEADER_CHROME.padding
    + (grip ? HEADER_CHROME.grip : 0)
    + (sortable ? HEADER_CHROME.sort : 0)
    + (filter ? HEADER_CHROME.funnel : 0);
  return Math.max(min, Math.ceil(String(label || "").length * 6.6) + chrome);
}

/**
 * Default widths for a set of columns, each at least wide enough for its own
 * header, and together adding up to something that fills a typical window
 * rather than huddling on the left with dead space beside it.
 *
 * Columns marked `fill` take the slack, so the table spans its container and
 * the extra lands where it is useful - a name, not a count.
 */
export function fitWidths(columns, { target = 1400 } = {}) {
  const base = {};
  for (const col of columns) {
    base[col.key] = col.resizable === false
      ? col.width
      : Math.max(col.width || 0, headerWidth(col.label, {
          sortable: Boolean(col.sortKey || col.sort),
          filter: Boolean(col.filter),
        }));
  }
  const total = Object.values(base).reduce((a, b) => a + (b || 0), 0);
  const fillers = columns.filter((c) => c.fill);
  if (fillers.length && total < target) {
    const share = Math.floor((target - total) / fillers.length);
    for (const col of fillers) base[col.key] += share;
  }
  return base;
}

export const headerCellStyle = {
  position: "relative",
  overflow: "hidden",
  paddingRight: RESIZE_STRIP,
};

// Grip, then a label that gives way, then anything that must keep its size —
// a sort arrow, a filter funnel. Put the ResizeHandle after this, as a direct
// child of the cell, so it anchors to the cell rather than to this row.
export function HeaderCell({ children, grip, trailing, align = "left" }) {
  return (
    <span
      style={{
        display: "flex", alignItems: "center", minWidth: 0,
        justifyContent: align === "right" ? "flex-end" : "flex-start",
      }}
    >
      {grip}
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {children}
      </span>
      {/* Never squashed by a long label: the label is the part that gives way,
          which is what its overflow rules are for. */}
      {trailing && <span style={{ flexShrink: 0, display: "inline-flex" }}>{trailing}</span>}
    </span>
  );
}

// Clickable sort label for a header cell. Layout-agnostic: render it inside a
// <th> or a grid cell. `defaultDir` is the direction used on first click
// ("asc" reads right for text, "desc" for dates/numbers).
export function SortLabel({ label, colKey, sortBy, sortDir, onSort, defaultDir = "desc", theme }) {
  const isActive = sortBy === colKey;
  // Active: a solid arrow saying which way. Inactive: both arrows, faint,
  // rather than nothing -- every sortable column here IS clickable today,
  // but without a persistent mark a header reads as a label, not a control,
  // until you happen to hover it.
  const indicator = isActive ? (sortDir === "asc" ? "↑" : "↓") : "↕";
  return (
    <span
      onClick={() => onSort(colKey, defaultDir)}
      // Always titled now: a narrow column truncates its label, and "Sort by
      // X" is no help when what you want to know is which column X is.
      title={isActive ? label : "Sort by " + label}
      style={{
        // Shrinkable and bounded by its cell: a header wider than the column
        // it sits over used to run straight across the next one's label, and
        // the narrower you dragged a column the further it bled. The label is
        // the part that gives way; the sort arrow keeps its size.
        display: "inline-flex", alignItems: "center", gap: 3,
        minWidth: 0, maxWidth: "100%",
        cursor: "pointer", userSelect: "none",
        color: isActive ? theme.text : theme.textMuted,
        transition: "color 0.12s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = theme.text; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = isActive ? theme.text : theme.textMuted; }}
    >
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
      <span style={{ fontSize: 10, opacity: isActive ? 1 : 0.45, flexShrink: 0 }}>{indicator}</span>
    </span>
  );
}

// Standard sort-state reducer used with SortLabel: click toggles direction on
// the active column, otherwise switches column starting from its defaultDir.
export function nextSort({ sortBy, sortDir }, colKey, defaultDir) {
  if (sortBy === colKey) return { sortBy, sortDir: sortDir === "asc" ? "desc" : "asc" };
  return { sortBy: colKey, sortDir: defaultDir };
}

/* ------------------------------------------------------------ column filter */

// A funnel icon that lives inside the header cell and opens a small popover
// with the controls that suit the column's type. Replaces the old row of bare
// inputs under the header: that row cost a whole band of vertical space on
// every table, could only ever express "contains" and ">=", and left no room
// to say which way a filter ran.
//
// The value stays a single string so the server contract is unchanged — see
// the operator grammar in server/lib/tableQuery.js.
//
//   type: "text" | "number" | "date" | "select" | "boolean"
//   select needs options: [{ value, label }]

const TEXT_OPS = [
  ["contains", "contains"],
  ["is", "is exactly"],
  ["starts", "starts with"],
  ["ends", "ends with"],
  ["empty", "is empty"],
  ["notempty", "is not empty"],
];

const NUMBER_OPS = [
  [">=", "at least"],
  ["<=", "at most"],
  ["=", "exactly"],
  ["..", "between"],
];

const DATE_OPS = [
  ["last", "in the last…"],
  ["before", "not in the last…"],
  [">=", "on or after"],
  ["<=", "on or before"],
  ["..", "between"],
  ["empty", "is empty"],
  ["notempty", "is not empty"],
];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Value string → the popover's working state.
function parseValue(type, value) {
  const v = String(value ?? "").trim();
  if (type === "select" || type === "boolean") return { op: v, a: "", b: "" };
  if (!v) return { op: type === "date" ? "last" : type === "number" ? ">=" : "contains", a: "", b: "" };
  if (v === "empty" || v === "notempty") return { op: v, a: "", b: "" };

  if (type === "text") {
    const m = v.match(/^(contains|is|starts|ends):([\s\S]*)$/i);
    return m ? { op: m[1].toLowerCase(), a: m[2], b: "" } : { op: "contains", a: v, b: "" };
  }
  if (type === "number") {
    const range = v.match(/^(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)$/);
    if (range) return { op: "..", a: range[1], b: range[2] };
    const cmp = v.match(/^(>=|<=|=)?\s*(-?[\d.]+)$/);
    return cmp ? { op: cmp[1] || ">=", a: cmp[2], b: "" } : { op: ">=", a: v, b: "" };
  }
  // date
  const rel = v.match(/^(last|before):(\d+)$/i);
  if (rel) return { op: rel[1].toLowerCase(), a: rel[2], b: "" };
  const range = v.match(/^(\d{4}-\d{2}-\d{2})\s*\.\.\s*(\d{4}-\d{2}-\d{2})$/);
  if (range) return { op: "..", a: range[1], b: range[2] };
  const cmp = v.match(/^(>=|<=)?\s*(\d{4}-\d{2}-\d{2})$/);
  if (cmp) return { op: cmp[1] || ">=", a: cmp[2], b: "" };
  return { op: "last", a: "", b: "" };
}

// The popover's working state → the value string the server parses.
// Returns "" for an incomplete draft, which clears the filter.
function buildValue(type, { op, a, b }) {
  if (type === "select" || type === "boolean") return op || "";
  if (op === "empty" || op === "notempty") return op;
  const A = String(a ?? "").trim();
  const B = String(b ?? "").trim();

  if (type === "text") return A ? (op === "contains" ? A : `${op}:${A}`) : "";
  if (type === "number") {
    if (op === "..") return A && B ? `${A}..${B}` : "";
    return A === "" ? "" : `${op}${A}`;
  }
  if (op === "last" || op === "before") return A ? `${op}:${A}` : "";
  if (op === "..") return DAY.test(A) && DAY.test(B) ? `${A}..${B}` : "";
  return DAY.test(A) ? `${op}${A}` : "";
}

// One-line description of an applied filter, for the icon's tooltip.
export function describeFilter(type, value, options) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  if (type === "select") return (options || []).find((o) => o.value === v)?.label || v;
  if (type === "boolean") return v === "yes" ? "Yes" : "No";
  if (v === "empty") return "is empty";
  if (v === "notempty") return "is not empty";
  const { op, a, b } = parseValue(type, v);
  const label = (list) => list.find(([k]) => k === op)?.[1] || op;
  if (type === "date") {
    if (op === "last") return `in the last ${a} days`;
    if (op === "before") return `not in the last ${a} days`;
    if (op === "..") return `${a} to ${b}`;
    return `${label(DATE_OPS)} ${a}`;
  }
  if (type === "number") return op === ".." ? `between ${a} and ${b}` : `${label(NUMBER_OPS)} ${a}`;
  return `${label(TEXT_OPS)} "${a}"`;
}

const funnelIcon = (filled) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 4.5h18l-7 8.2V20l-4 1.5v-8.8z" />
  </svg>
);

export function ColumnFilter({ type = "text", value, options, placeholder, onCommit, theme, label }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const [draft, setDraft] = useState(() => parseValue(type, value));
  const btnRef = useRef(null);
  const popRef = useRef(null);

  const active = !!String(value ?? "").trim();
  const accent = theme.accent || theme.text;

  const place = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const W = 244;
    setRect({
      // Clamp so a right-hand column's popover stays on screen.
      left: Math.max(8, Math.min(r.left, window.innerWidth - W - 8)),
      top: r.bottom + 6,
      width: W,
    });
  }, []);

  const openPopover = () => {
    setDraft(parseValue(type, value));
    place();
    setOpen(true);
  };

  // Reposition while open; close on Escape or a click outside.
  useEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => place();
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    const onDown = (e) => {
      if (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      // The operator picker inside this popover renders its list in a portal on
      // <body>, so by DOM it is "outside" — and picking an operator would have
      // closed the filter underneath it, losing the half-typed value with it.
      if (e.target?.closest?.('[role="listbox"]')) return;
      setOpen(false);
    };
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [open, place]);

  const commit = (next) => { onCommit(buildValue(type, next)); setOpen(false); };
  const clear = () => { onCommit(""); setOpen(false); };

  const ops = type === "text" ? TEXT_OPS : type === "number" ? NUMBER_OPS : type === "date" ? DATE_OPS : null;
  const needsTwo = draft.op === "..";
  const needsNone = draft.op === "empty" || draft.op === "notempty";

  const fieldStyle = {
    width: "100%", boxSizing: "border-box", height: 30,
    background: theme.surface, color: theme.text,
    border: `1px solid ${theme.border}`, borderRadius: 7,
    fontFamily: "inherit", fontSize: 12, padding: "0 8px", outline: "none",
  };

  // A single click is the whole intent for a fixed-choice filter, so those
  // commit straight away instead of asking for a second click on Apply.
  const choiceList = (items, current) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 210, overflowY: "auto" }}>
      {items.map((o) => {
        const on = current === o.value;
        return (
          <button key={o.value || "all"} onClick={() => { onCommit(o.value); setOpen(false); }} style={{
            display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
            padding: "6px 8px", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontSize: 12,
            border: "none", background: on ? theme.accentLight : "transparent", color: on ? theme.text : theme.textMid,
            fontWeight: on ? 600 : 400,
          }}
            onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = theme.accentLight; }}
            onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = "transparent"; }}
          >
            <span style={{
              width: 13, height: 13, borderRadius: "50%", flexShrink: 0,
              border: `1px solid ${on ? accent : theme.border}`,
              boxShadow: on ? `inset 0 0 0 3px ${theme.surface}` : "none",
              background: on ? accent : "transparent",
            }} />
            {o.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <>
      <button
        ref={btnRef}
        onClick={(e) => { e.stopPropagation(); open ? setOpen(false) : openPopover(); }}
        onMouseDown={(e) => e.stopPropagation()}
        title={active ? `${label || "Filter"} ${describeFilter(type, value, options)}` : `Filter ${label || "column"}`}
        aria-label={`Filter ${label || "column"}`}
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 20, height: 20, marginLeft: 4, padding: 0, flexShrink: 0, verticalAlign: "middle",
          border: "none", borderRadius: 5, cursor: "pointer",
          background: active || open ? theme.accentLight : "transparent",
          color: active ? accent : theme.textMuted,
          opacity: active || open ? 1 : 0.75, transition: "color 0.12s, background 0.12s, opacity 0.12s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = 1; e.currentTarget.style.color = theme.text; }}
        onMouseLeave={(e) => {
          e.currentTarget.style.opacity = active || open ? 1 : 0.75;
          e.currentTarget.style.color = active ? accent : theme.textMuted;
        }}
      >
        {funnelIcon(active)}
      </button>

      {open && rect && createPortal(
        <div
          ref={popRef}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "fixed", left: rect.left, top: rect.top, width: rect.width, zIndex: 1200,
            background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 10,
            boxShadow: theme.shadowMd || "0 10px 30px rgba(0,0,0,0.18)",
            padding: 10, display: "flex", flexDirection: "column", gap: 8,
            fontFamily: "inherit", textTransform: "none", letterSpacing: 0,
          }}
        >
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: theme.textMuted }}>
            {label || "Filter"}
          </div>

          {type === "select" && choiceList(
            [{ value: "", label: "All" }, ...(options || [])],
            String(value ?? ""),
          )}

          {type === "boolean" && choiceList(
            [{ value: "", label: "All" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }],
            String(value ?? ""),
          )}

          {ops && (
            <>
              <Select
                size="sm"
                value={draft.op}
                onChange={(op) => setDraft((d) => ({ ...d, op }))}
                ariaLabel="How to match"
                options={ops.map(([k, l]) => ({ value: k, label: l }))}
              />

              {!needsNone && (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    autoFocus
                    value={draft.a}
                    type={type === "date" && draft.op !== "last" && draft.op !== "before" ? "date" : "text"}
                    inputMode={type === "number" || draft.op === "last" || draft.op === "before" ? "numeric" : undefined}
                    placeholder={
                      type === "number" ? "0"
                        : draft.op === "last" || draft.op === "before" ? "days"
                        : placeholder || "Value…"
                    }
                    onChange={(e) => setDraft((d) => ({ ...d, a: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === "Enter") commit(draft); }}
                    style={fieldStyle}
                  />
                  {needsTwo && (
                    <>
                      <span style={{ fontSize: 11, color: theme.textMuted, flexShrink: 0 }}>and</span>
                      <input
                        value={draft.b}
                        type={type === "date" ? "date" : "text"}
                        inputMode={type === "number" ? "numeric" : undefined}
                        placeholder={type === "number" ? "100" : ""}
                        onChange={(e) => setDraft((d) => ({ ...d, b: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === "Enter") commit(draft); }}
                        style={fieldStyle}
                      />
                    </>
                  )}
                </div>
              )}

              {(draft.op === "last" || draft.op === "before") && (
                <div style={{ display: "flex", gap: 4 }}>
                  {[7, 30, 90].map((d) => (
                    <button key={d} onClick={() => commit({ ...draft, a: String(d) })} style={{
                      flex: 1, height: 24, borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontSize: 11,
                      border: `1px solid ${theme.border}`, background: theme.surfaceAlt, color: theme.textMid,
                    }}>{d}d</button>
                  ))}
                </div>
              )}

              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", paddingTop: 2 }}>
                {active && (
                  <button onClick={clear} style={{
                    height: 28, padding: "0 10px", borderRadius: 999, cursor: "pointer", fontFamily: "inherit",
                    fontSize: 12, border: `1px solid ${theme.border}`, background: "transparent", color: theme.textMid,
                  }}>Clear</button>
                )}
                <button onClick={() => commit(draft)} style={{
                  height: 28, padding: "0 14px", borderRadius: 999, cursor: "pointer", fontFamily: "inherit",
                  fontSize: 12, fontWeight: 600, border: "none", background: accent,
                  color: theme.mode === "dark" ? "#0A0A0A" : "#fff",
                }}>Apply</button>
              </div>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
