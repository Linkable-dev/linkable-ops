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

// Small per-column filter input for a table's filter row. Keeps its own draft
// state and only calls onCommit (→ refetch) after the user pauses typing.
// type: "text" | "number" (min-value) | "select" (needs options: [{value,label}]).
export function ColumnFilter({ type = "text", value, options, placeholder, onCommit, theme, delay = 350 }) {
  const [draft, setDraft] = useState(value ?? "");
  const [prevValue, setPrevValue] = useState(value);
  const timer = useRef(null);

  // External reset (e.g. tab switch clears filters) → sync the draft.
  // "Adjust state during render" pattern instead of an effect.
  if (value !== prevValue) {
    setPrevValue(value);
    setDraft(value ?? "");
  }

  useEffect(() => () => clearTimeout(timer.current), []);

  const baseStyle = {
    width: "100%", boxSizing: "border-box",
    background: theme.bg, color: theme.text,
    border: `1px solid ${theme.border}`, borderRadius: 6,
    fontFamily: "inherit", fontSize: 11, padding: "4px 7px",
    outline: "none",
  };

  if (type === "select") {
    return (
      <select
        value={value ?? ""}
        onChange={(e) => onCommit(e.target.value)}
        style={{ ...baseStyle, cursor: "pointer" }}
      >
        <option value="">All</option>
        {(options || []).map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    );
  }

  return (
    <input
      value={draft}
      inputMode={type === "number" ? "numeric" : undefined}
      placeholder={placeholder || (type === "number" ? "≥ …" : "Filter…")}
      onChange={(e) => {
        const v = e.target.value;
        setDraft(v);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => onCommit(v), delay);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          clearTimeout(timer.current);
          onCommit(draft);
        }
      }}
      style={baseStyle}
    />
  );
}
