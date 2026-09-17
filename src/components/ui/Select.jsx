import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTheme } from "../../contexts/ThemeContext";

/**
 * The app's select: one control, and you can type at it.
 *
 * Every dropdown here used to be a bare <select>, which means the operating
 * system's own menu — a different shape on every machine, unstyleable, and
 * searchable only by the first letter. That is fine for "images / video" and
 * useless for a list of every campaign, which is what several of them are.
 *
 * So: a button that opens a list, with a search box once the list is long
 * enough to need one. The popover is a portal, because these live inside
 * modals, table headers and overflow:auto panels, all of which would clip a
 * relatively-positioned one.
 *
 * Options are {value, label, hint?} — or plain strings, or [value, label]
 * pairs, because half the call sites already had one of those shapes and a
 * component that only takes the third makes every one of them convert.
 */

const SEARCH_FROM = 7;

function normalise(options) {
  return (options || []).map((o) => {
    if (o == null) return null;
    if (typeof o === "string" || typeof o === "number") return { value: o, label: String(o) };
    if (Array.isArray(o)) return { value: o[0], label: String(o[1] ?? o[0]) };
    return { value: o.value, label: String(o.label ?? o.value), hint: o.hint, disabled: o.disabled };
  }).filter(Boolean);
}

export function Select({
  value,
  onChange,
  options,
  placeholder = "Pick one…",
  searchable = "auto",
  searchPlaceholder = "Type to narrow…",
  disabled = false,
  size = "md",
  style = {},
  ariaLabel,
  id,
}) {
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const listRef = useRef(null);

  const items = useMemo(() => normalise(options), [options]);
  const selected = items.find((o) => String(o.value) === String(value ?? ""));
  const showSearch = searchable === true || (searchable === "auto" && items.length >= SEARCH_FROM);

  const shown = useMemo(() => {
    const text = q.trim().toLowerCase();
    if (!text) return items;
    return items.filter((o) =>
      o.label.toLowerCase().includes(text) || String(o.hint || "").toLowerCase().includes(text));
  }, [items, q]);

  const place = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.max(r.width, 220);
    // Opens downward unless the bottom of the screen is closer than the list
    // is tall, which is the difference between a picker and a scroll hunt.
    const below = window.innerHeight - r.bottom;
    const height = Math.min(320, 44 * Math.min(shown.length || 1, 7) + (showSearch ? 46 : 0));
    const dropUp = below < height + 16 && r.top > below;
    setRect({
      left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
      top: dropUp ? Math.max(8, r.top - height - 6) : r.bottom + 6,
      width,
      maxHeight: height,
    });
  }, [shown.length, showSearch]);

  useEffect(() => {
    if (!open) return undefined;
    place();
    const onMove = () => place();
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); setOpen(false); btnRef.current?.focus(); }
    };
    const onDown = (e) => {
      if (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [open, place]);

  // The highlighted row follows the keyboard rather than the other way round.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children?.[cursor];
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor, open]);

  const choose = (option) => {
    if (option?.disabled) return;
    onChange?.(option ? option.value : "");
    setOpen(false);
    setQ("");
    btnRef.current?.focus();
  };

  const onListKey = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => {
        const next = e.key === "ArrowDown" ? c + 1 : c - 1;
        return Math.max(0, Math.min(next, shown.length - 1));
      });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      choose(shown[cursor]);
    }
  };

  const height = size === "sm" ? 30 : 34;
  const field = {
    display: "flex", alignItems: "center", gap: 8, width: "100%", height,
    padding: size === "sm" ? "0 8px" : "0 10px", borderRadius: 8,
    border: `1px solid ${open ? theme.text : theme.border}`,
    background: disabled ? theme.surfaceAlt : theme.surface,
    color: selected ? theme.text : theme.textMuted,
    fontSize: 13, fontFamily: "inherit", textAlign: "left",
    cursor: disabled ? "not-allowed" : "pointer",
    ...style,
  };

  return (
    <>
      <button
        ref={btnRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (disabled) return;
          setQ("");
          setCursor(Math.max(0, items.findIndex((o) => String(o.value) === String(value ?? ""))));
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        style={field}
      >
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected ? selected.label : placeholder}
        </span>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, opacity: 0.6 }} aria-hidden="true">
          <path d="M3 6l5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && rect && createPortal(
        <div
          ref={popRef}
          role="listbox"
          onKeyDown={onListKey}
          style={{
            position: "fixed", left: rect.left, top: rect.top, width: rect.width,
            // Above the modal layer: several of these live inside one.
            zIndex: 2000,
            background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 10,
            boxShadow: "0 12px 32px rgba(0,0,0,0.18)", overflow: "hidden",
            display: "flex", flexDirection: "column", maxHeight: rect.maxHeight + 46,
          }}
        >
          {showSearch && (
            <div style={{ padding: 8, borderBottom: `1px solid ${theme.border}` }}>
              <input
                autoFocus
                value={q}
                onChange={(e) => { setQ(e.target.value); setCursor(0); }}
                placeholder={searchPlaceholder}
                style={{
                  width: "100%", boxSizing: "border-box", height: 30, padding: "0 8px",
                  borderRadius: 7, border: `1px solid ${theme.border}`,
                  background: theme.bg, color: theme.text, fontSize: 12,
                  fontFamily: "inherit", outline: "none",
                }}
              />
            </div>
          )}

          <div ref={listRef} style={{ overflowY: "auto", padding: 4 }}>
            {shown.length === 0 && (
              <div style={{ padding: "10px 8px", fontSize: 12, color: theme.textMuted }}>
                Nothing matches “{q}”.
              </div>
            )}
            {shown.map((o, i) => {
              const on = String(o.value) === String(value ?? "");
              const active = i === cursor;
              return (
                <button
                  key={`${o.value}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={on}
                  disabled={o.disabled}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => choose(o)}
                  style={{
                    display: "block", width: "100%", textAlign: "left", border: "none",
                    padding: "7px 8px", borderRadius: 7, cursor: o.disabled ? "not-allowed" : "pointer",
                    background: active ? theme.accentLight : "transparent",
                    color: o.disabled ? theme.textMuted : theme.text,
                    fontFamily: "inherit", fontSize: 13, fontWeight: on ? 600 : 400,
                  }}
                >
                  <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {o.label}
                  </span>
                  {o.hint && (
                    <span style={{ display: "block", fontSize: 11, color: theme.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {o.hint}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
