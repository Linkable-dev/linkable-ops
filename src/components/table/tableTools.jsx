// Shared building blocks for the app's data tables: drag-resizable column
// widths (persisted per table in localStorage), sortable header cells, and
// debounced per-column filter inputs that drive SERVER-side filtering.
//
// These are retrofit primitives, not a monolithic <DataTable>: each page keeps
// its own markup (real <table> or CSS-grid divs) and behavior (row clicks,
// pills, expanders) and only swaps in the pieces it needs. Grid pages drive
// gridTemplateColumns from useColumnWidths; <table> pages feed the same widths
// into a <colgroup>.

/* eslint-disable react-refresh/only-export-components -- shared table
   primitives: hooks + tiny components belong together; no fast-refresh need */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const WIDTHS_STORE_PREFIX = "ops.tableWidths.";

function loadStoredWidths(tableId) {
  try {
    return JSON.parse(localStorage.getItem(WIDTHS_STORE_PREFIX + tableId)) || {};
  } catch {
    return {};
  }
}

// Column widths in px, initialized from defaults overridden by whatever the
// user dragged last time. `startResize` is a mousedown handler for a header
// drag handle; double-clicking a handle resets that column to its default.
export function useColumnWidths(tableId, defaultWidths) {
  const [widths, setWidths] = useState(() => ({
    ...defaultWidths,
    ...loadStoredWidths(tableId),
  }));
  const dragRef = useRef(null);

  // Switching tabs re-mounts with a different tableId (e.g. brands↔creators
  // share the page) — re-seed from that table's stored widths.
  useEffect(() => {
    setWidths({ ...defaultWidths, ...loadStoredWidths(tableId) });
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
    dragRef.current = { key, startX, startW: null, min };
    setWidths((w) => {
      dragRef.current.startW = w[key];
      return w;
    });
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
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [persist]);

  const resetWidth = useCallback((key) => {
    setWidths((w) => {
      const next = { ...w, [key]: defaultWidths[key] };
      persist(next);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persist, tableId]);

  return { widths, startResize, resetWidth };
}

// gridTemplateColumns for CSS-grid tables. The `fill` column absorbs leftover
// space (its width acts as a minimum) so the table always spans its container.
export function gridTemplate(columns, widths) {
  return columns
    .map((c) => (c.fill ? `minmax(${widths[c.key]}px, 1fr)` : `${widths[c.key]}px`))
    .join(" ");
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
        position: "absolute", top: 0, right: -5, bottom: 0, width: 10,
        cursor: "col-resize", zIndex: 2,
        display: "flex", alignItems: "stretch", justifyContent: "center",
      }}
    >
      <span style={{
        width: 2, borderRadius: 1,
        background: hover ? (theme?.text || "#888") : "transparent",
        opacity: hover ? 0.5 : 1,
      }} />
    </span>
  );
}

// Clickable sort label for a header cell. Layout-agnostic: render it inside a
// <th> or a grid cell. `defaultDir` is the direction used on first click
// ("asc" reads right for text, "desc" for dates/numbers).
export function SortLabel({ label, colKey, sortBy, sortDir, onSort, defaultDir = "desc", theme }) {
  const isActive = sortBy === colKey;
  const arrow = !isActive ? "" : sortDir === "asc" ? " ↑" : " ↓";
  return (
    <span
      onClick={() => onSort(colKey, defaultDir)}
      style={{
        cursor: "pointer", userSelect: "none",
        color: isActive ? theme.text : theme.textMuted,
        transition: "color 0.12s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = theme.text; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = isActive ? theme.text : theme.textMuted; }}
    >
      {label}{arrow}
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
              <select
                value={draft.op}
                onChange={(e) => setDraft((d) => ({ ...d, op: e.target.value }))}
                style={{ ...fieldStyle, cursor: "pointer" }}
              >
                {ops.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>

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
