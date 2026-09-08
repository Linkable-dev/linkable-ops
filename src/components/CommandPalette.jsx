import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTheme } from "../contexts/ThemeContext";
import { useBrandDrawer } from "../contexts/BrandDrawerContext";
import { api, friendlyName } from "../lib/api";

// Cmd/Ctrl+K palette: pages and tables locally, brands / creators / campaigns
// from the server. Header's search button dispatches "lk-open-palette".
const PAGES = [
  ["Home", "/"], ["Alerts", "/alerts"], ["Ask the data", "/ask"], ["Blog", "/blog"], ["Campaigns", "/ops/campaigns"],
  ["Impersonation", "/users"], ["Trials", "/trials"], ["Inbox", "/ai/inbox"], ["Outbound", "/ai/campaigns"],
  ["Test Lab", "/ai/test-lab"], ["Dashboard", "/dashboard"], ["Team", "/team"],
];
let tablesCache = null;

export default function CommandPalette() {
  const { theme } = useTheme();
  const navigate = useNavigate();
  const { openBrand } = useBrandDrawer();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [remote, setRemote] = useState(null);
  const [loading, setLoading] = useState(false);
  const [tables, setTables] = useState(tablesCache || []);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const close = useCallback(() => { setOpen(false); setQ(""); setRemote(null); setCursor(0); }, []);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((v) => !v); }
      else if (e.key === "Escape" && open) close();
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("lk-open-palette", onOpen);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("lk-open-palette", onOpen); };
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    setTimeout(() => inputRef.current?.focus(), 0);
    if (!tablesCache) api.getTables().then((t) => { tablesCache = Array.isArray(t) ? t : t?.tables || []; setTables(tablesCache); }).catch(() => {});
  }, [open]);

  // Typing resets the cursor and the remote state; the fetch itself is debounced.
  const onChange = (value) => {
    setQ(value); setCursor(0);
    const text = value.trim();
    if (text.length < 2) { setRemote(null); setLoading(false); } else setLoading(true);
  };
  useEffect(() => {
    if (!open) return;
    const text = q.trim();
    if (text.length < 2) return;
    const t = setTimeout(() => {
      api.globalSearch(text).then((r) => { setRemote(r); setCursor(0); }).catch(() => setRemote(null)).finally(() => setLoading(false));
    }, 180);
    return () => clearTimeout(t);
  }, [q, open]);

  const items = useMemo(() => {
    const text = q.trim().toLowerCase();
    const match = (s) => !text || String(s || "").toLowerCase().includes(text);
    const out = [];
    for (const [label, to] of PAGES) if (match(label)) out.push({ group: "Pages", label, hint: to, run: () => navigate(to) });
    if (text) for (const t of tables) if (match(t) || match(friendlyName(t))) out.push({ group: "Tables", label: friendlyName(t), hint: `/tables/${t}`, run: () => navigate(`/tables/${t}`) });
    for (const b of remote?.brands || []) out.push({ group: "Brands", label: b.store_name || b.email, hint: [b.email, b.store_website].filter(Boolean).join(" · "), run: () => openBrand(b.user_id) });
    for (const c of remote?.creators || []) out.push({ group: "Creators", label: c.name || c.instagram_username || c.email, hint: [c.instagram_username && `@${c.instagram_username}`, c.email].filter(Boolean).join(" · "), run: () => navigate(`/users?tab=creators&q=${encodeURIComponent(c.instagram_username || c.email || c.name)}`) });
    for (const c of remote?.campaigns || []) out.push({ group: "Campaigns", label: c.title, hint: `${c.brand_name || ""} · ${c.status_label}`, run: () => navigate(`/ops/campaigns?search=${encodeURIComponent(c.title)}`) });
    for (const c of remote?.outbound || []) out.push({ group: "Outbound", label: c.name, hint: `${c.audience_type || ""} · ${c.status}`, run: () => navigate(`/ai/campaigns/${c.id}`) });
    if (text.length >= 4) out.push({ group: "Ask", label: `Ask the data: “${q.trim()}”`, hint: "run as a question", run: () => navigate(`/ask?q=${encodeURIComponent(q.trim())}`) });
    return out.slice(0, 40);
  }, [q, tables, remote, navigate, openBrand]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${cursor}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;

  const pick = (item) => { close(); item.run(); };
  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(items.length - 1, c + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if (e.key === "Enter" && items[cursor]) { e.preventDefault(); pick(items[cursor]); }
  };

  let lastGroup = null;
  return (
    <div onClick={close} style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(18,20,25,0.4)", backdropFilter: "blur(3px)", display: "flex", justifyContent: "center", alignItems: "flex-start", paddingTop: "12vh" }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette" style={{ width: "min(640px, calc(100vw - 32px))", background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 16, boxShadow: theme.shadowMd, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: `1px solid ${theme.border}` }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={theme.textMuted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input
            ref={inputRef} value={q} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown}
            placeholder="Search brands, creators, campaigns, tables, pages… or ask a question"
            style={{ flex: 1, border: "none", outline: "none", background: "transparent", color: theme.text, fontSize: 15, fontFamily: "inherit" }}
          />
          {loading && <span style={{ fontSize: 11, color: theme.textMuted }}>searching…</span>}
          <kbd style={{ fontSize: 11, color: theme.textMuted, border: `1px solid ${theme.border}`, borderRadius: 6, padding: "2px 6px" }}>esc</kbd>
        </div>
        <div ref={listRef} style={{ maxHeight: "56vh", overflowY: "auto", padding: 6 }}>
          {items.length === 0 && (
            <div style={{ padding: 24, textAlign: "center", fontSize: 13, color: theme.textMuted }}>{q.trim().length < 2 ? "Type to search." : loading ? "Searching…" : "No matches."}</div>
          )}
          {items.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            const active = i === cursor;
            return (
              <div key={`${item.group}-${item.label}-${i}`}>
                {header && <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: theme.textMuted, padding: "10px 10px 4px" }}>{header}</div>}
                <button data-idx={i} onMouseEnter={() => setCursor(i)} onClick={() => pick(item)} style={{
                  display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", padding: "9px 10px", borderRadius: 8, border: "none", cursor: "pointer", fontFamily: "inherit",
                  background: active ? theme.accentLight : "transparent", color: theme.text,
                }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.label}</span>
                  {item.hint && <span style={{ fontSize: 11, color: theme.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "45%" }}>{item.hint}</span>}
                  {active && <kbd style={{ fontSize: 10, color: theme.textMuted, border: `1px solid ${theme.border}`, borderRadius: 5, padding: "1px 5px" }}>↵</kbd>}
                </button>
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 14, padding: "8px 16px", borderTop: `1px solid ${theme.border}`, fontSize: 11, color: theme.textMuted }}>
          <span>↑↓ navigate</span><span>↵ open</span><span>⌘K toggle</span>
        </div>
      </div>
    </div>
  );
}
