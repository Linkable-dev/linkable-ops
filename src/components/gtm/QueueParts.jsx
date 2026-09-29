import { useEffect, useRef, useState } from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { Btn } from "../ui/Button";

// The pieces the brand outreach queues (Email and Instagram) share: filter
// pills, the pager under a list, small tags and counts. One copy, so the two
// tabs cannot drift apart in how they look or behave.

// A dropdown of checkboxes. `emptyMeansAll`: nothing chosen means every option
// (a filter), rather than none of them (a list of things to do). Counts, when
// given, include the options left out, so it is clear what a change adds or
// removes before making it.
export function MultiPicker({ theme, options, chosen, disabled, onChange, allLabel, noun, title,
                       emptyMeansAll = true, short = (o) => o.code }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const codes = options.map((o) => o.code);
  const all = emptyMeansAll && !chosen.length;
  const isOn = (c) => all || chosen.includes(c);

  function toggle(code) {
    const current = all ? codes : chosen;
    const next = current.includes(code) ? current.filter((c) => c !== code) : [...current, code];
    // Every option ticked is the same as no filter, and is stored as one.
    onChange(emptyMeansAll && codes.every((c) => next.includes(c)) ? [] : next);
  }

  const picked = options.filter((o) => chosen.includes(o.code));
  const label = !chosen.length ? allLabel
    : picked.length <= 2 ? picked.map(short).join(", ")
    : `${chosen.length} ${noun}`;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <Btn size="sm" variant="secondary" onClick={() => setOpen((v) => !v)} disabled={disabled}
           aria-expanded={open} title={title}>
        {label} ▾
      </Btn>
      {open && (
        <div style={{
          position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 20, width: 270,
          background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 12,
          boxShadow: theme.shadowMd, padding: 8, maxHeight: 380, overflowY: "auto",
        }}>
          <button type="button" onClick={() => onChange([])} disabled={disabled || !chosen.length}
                  style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 8px",
                           border: "none", background: "transparent", fontFamily: "inherit",
                           fontSize: 12, color: !chosen.length ? theme.textMuted : theme.text,
                           cursor: !chosen.length ? "default" : "pointer" }}>
            {allLabel}
          </button>
          {options.map((o) => (
            <label key={o.code} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
                                         fontSize: 12.5, color: theme.text, cursor: "pointer" }}>
              <input type="checkbox" checked={isOn(o.code)} disabled={disabled}
                     onChange={() => toggle(o.code)} style={{ margin: 0 }} />
              <span style={{ flex: 1 }}>{o.label}</span>
              {o.count != null && (
                <span style={{ color: theme.textMuted, fontVariantNumeric: "tabular-nums" }}>{o.count}</span>
              )}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// One choice from a short list, drawn like the filters beside it rather than
// as a form select.
export function SortPicker({ theme, value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const current = options.find((o) => o.value === value) || options[0];
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <Btn size="sm" variant="secondary" onClick={() => setOpen((v) => !v)} aria-expanded={open} title="Order">
        {current.label} ▾
      </Btn>
      {open && (
        <div style={{
          position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 20, width: 220,
          background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 12,
          boxShadow: theme.shadowMd, padding: 6,
        }}>
          {options.map((o) => (
            <button key={o.value} type="button" onClick={() => { onChange(o.value); setOpen(false); }}
                    style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 8px",
                             border: "none", borderRadius: 8, fontFamily: "inherit", fontSize: 12.5,
                             cursor: "pointer", color: theme.text,
                             background: o.value === current.value ? theme.accentLight : "transparent",
                             fontWeight: o.value === current.value ? 600 : 400 }}>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Stat({ theme, label, value, warn }) {
  return (
    <span style={{ fontSize: 12, color: warn ? theme.warning : theme.textMuted, marginLeft: 6 }}>
      <strong style={{ color: warn ? theme.warning : theme.text, fontWeight: 600 }}>{value ?? 0}</strong> {label}
    </span>
  );
}

export function Tag({ children, tone, title }) {
  const { theme } = useTheme();
  const color = tone ? theme[tone] : theme.textMid;
  return (
    <span title={title} style={{
      fontSize: 10.5, padding: "1px 7px", borderRadius: 999, whiteSpace: "nowrap", lineHeight: "16px",
      border: `1px solid ${tone ? color : theme.border}`, color,
    }}>
      {children}
    </span>
  );
}

// "1-50 of 120" with previous and next; the arrows only when there is more
// than one page.
export function ListPager({ theme, page, pageSize, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? page * pageSize + 1 : 0;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px",
                  borderTop: `1px solid ${theme.border}`, fontSize: 12, color: theme.textMuted }}>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>
        {pages > 1 ? `${from}-${to} of ${total}` : `${total} brand${total === 1 ? "" : "s"}`}
      </span>
      <div style={{ flex: 1 }} />
      {pages > 1 && (
        <>
          <Btn size="sm" variant="secondary" onClick={() => onPage(page - 1)} disabled={page <= 0}
               aria-label="Previous page">‹</Btn>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{page + 1} / {pages}</span>
          <Btn size="sm" variant="secondary" onClick={() => onPage(page + 1)} disabled={page >= pages - 1}
               aria-label="Next page">›</Btn>
        </>
      )}
    </div>
  );
}

// "Find new brands": starts a prospector run now rather than at the next
// scheduled one. One run fills both queues, Email and Instagram, so the two
// tabs share it; the server refuses while one is running and for half an hour
// after.
export function FindBrands({ theme, search, busy, problem, onFind }) {
  const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const running = Boolean(search?.running);
  const coolingUntil = !running && search?.availableAt ? search.availableAt : null;
  let note = null;
  if (running) note = `Searching Instagram since ${hhmm(search.requestedAt)}. New brands appear here in a few minutes.`;
  else if (search?.requestedAt) {
    const n = search.newBrands || 0;
    note = `Last search ${hhmm(search.requestedAt)} · ${n} new ${n === 1 ? "brand" : "brands"}`
      + (coolingUntil ? ` · next from ${hhmm(coolingUntil)}` : "");
  }
  return (
    <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      {(problem || note) && (
        <span style={{ fontSize: 12, color: problem ? theme.warning : theme.textMuted }}>{problem || note}</span>
      )}
      <Btn size="sm" onClick={onFind} loading={busy || running} disabled={busy || running || Boolean(coolingUntil)}
           title={coolingUntil ? `One search every half hour: next from ${hhmm(coolingUntil)}`
             : "Search Instagram for brands asking for creators, now"}>
        {running ? "Searching…" : "Find new brands"}
      </Btn>
    </div>
  );
}

// A "?" beside a page title: what the page is for and how to work it, on
// hover or click, so the page itself can stay short. Esc or a click outside
// closes it.
export function HelpTip({ title, children, label = "How this page works" }) {
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const shown = open || hover;
  return (
    <span ref={ref} style={{ position: "relative", display: "inline-flex", alignSelf: "center" }}
          onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button type="button" aria-label={label} aria-expanded={shown} onClick={() => setOpen((v) => !v)}
              style={{
                width: 20, height: 20, borderRadius: 999, padding: 0, cursor: "pointer",
                border: `1px solid ${shown ? theme.text : theme.border}`, background: theme.surface,
                color: shown ? theme.text : theme.textMuted, fontFamily: "inherit", fontSize: 11.5,
                fontWeight: 600, lineHeight: "18px",
              }}>
        ?
      </button>
      {shown && (
        <div role="tooltip" style={{
          position: "absolute", left: 0, top: "calc(100% + 8px)", zIndex: 30, width: 400, maxWidth: "80vw",
          background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 12,
          boxShadow: theme.shadowMd, padding: "14px 16px", fontSize: 12.5, lineHeight: 1.55,
          color: theme.textMid, fontWeight: 400, cursor: "default",
        }}>
          {title && <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 6 }}>{title}</div>}
          {children}
        </div>
      )}
    </span>
  );
}

// The body of a HelpTip: a few short points, each a heading and a sentence.
export function HelpList({ items }) {
  const { theme } = useTheme();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map(([head, text]) => (
        <div key={head}>
          <span style={{ color: theme.text, fontWeight: 600 }}>{head}.</span> {text}
        </div>
      ))}
    </div>
  );
}
