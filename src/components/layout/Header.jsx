import { useState, useCallback, useEffect, useRef } from "react";
import { useLocation, useParams } from "react-router-dom";
import { useTheme } from "../../contexts/ThemeContext";
import { useDbTarget } from "../../contexts/DbTargetContext";

function getPageInfo(pathname) {
  if (pathname === "/") return { title: "Dashboard", subtitle: "Database overview and analytics" };
  const match = pathname.match(/^\/tables\/([^/]+)/);
  if (match) {
    const table = match[1].replace(/_/g, " ");
    if (pathname.endsWith("/analytics")) return { title: `${table}`, subtitle: "Analytics" };
    if (pathname.endsWith("/new")) return { title: `${table}`, subtitle: "New record" };
    const idMatch = pathname.match(/^\/tables\/[^/]+\/(.+)$/);
    if (idMatch && idMatch[1] !== "analytics" && idMatch[1] !== "new") return { title: `${table}`, subtitle: `Record #${idMatch[1]}` };
    return { title: table, subtitle: "Browse and manage records" };
  }
  return { title: "Admin", subtitle: "" };
}

export default function Header() {
  const location = useLocation();
  const { theme, mode, toggleTheme } = useTheme();
  const { target, setTarget } = useDbTarget();
  const { title, subtitle } = getPageInfo(location.pathname);
  const [isFullscreen, setIsFullscreen] = useState(!!document.fullscreenElement);
  const [dbMenuOpen, setDbMenuOpen] = useState(false);
  const dbMenuRef = useRef(null);

  useEffect(() => {
    if (!dbMenuOpen) return;
    function onClickOutside(e) {
      if (dbMenuRef.current && !dbMenuRef.current.contains(e.target)) setDbMenuOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [dbMenuOpen]);

  // Switching target during a session would leave stale data on screen; force
  // a reload so every in-flight cache/query starts from a clean state.
  const switchTarget = (next) => {
    setDbMenuOpen(false);
    if (next === target) return;
    setTarget(next);
    window.location.reload();
  };

  const isDev = target === "dev";
  const pillBg = isDev
    ? (mode === "dark" ? "#3D2A05" : "#FFFBEB")
    : (mode === "dark" ? "#052e16" : "#F0FDF4");
  const pillColor = isDev ? "#F59E0B" : "#22C55E";
  const pillLabel = isDev ? "Cloud SQL · Dev" : "Cloud SQL · Prod";

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  }, []);

  const iconBtn = (onClick, btnTitle, children) => (
    <button onClick={onClick} title={btnTitle} style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      width: 32, height: 32, borderRadius: 8, border: `1px solid ${theme.border}`,
      background: "transparent", cursor: "pointer", color: theme.textMid,
      transition: "all 0.15s",
    }}>{children}</button>
  );

  return (
    <header style={{
      position: "sticky", top: 0, height: 56,
      background: theme.surface, borderBottom: `1px solid ${theme.border}`,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0 24px", zIndex: 90, transition: "background 0.2s, border-color 0.2s",
    }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: theme.text, letterSpacing: -0.2, textTransform: "capitalize" }}>{title}</h1>
        {subtitle && <p style={{ margin: 0, fontSize: 12, color: theme.textMuted, marginTop: 1 }}>{subtitle}</p>}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div ref={dbMenuRef} style={{ position: "relative" }}>
          <button
            onClick={() => setDbMenuOpen((v) => !v)}
            title={isDev
              ? "Targeting DEV database — click to switch"
              : "Targeting PROD database — click to switch"}
            style={{
              display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 500,
              padding: "4px 10px", borderRadius: 20, border: "none", cursor: "pointer",
              background: pillBg, color: pillColor,
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: pillColor }} />
            {pillLabel}
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 2 }}>
              <path d="M2 4l3 3 3-3" />
            </svg>
          </button>
          {dbMenuOpen && (
            <div style={{
              position: "absolute", top: "calc(100% + 6px)", right: 0, minWidth: 200,
              background: theme.surface, border: `1px solid ${theme.border}`,
              borderRadius: 10, boxShadow: theme.shadowMd, zIndex: 100, overflow: "hidden",
            }}>
              <DbOption
                theme={theme} dot="#22C55E" label="Prod"
                hint="app.linkable.link"
                active={!isDev}
                onClick={() => switchTarget("prod")}
              />
              <DbOption
                theme={theme} dot="#F59E0B" label="Dev"
                hint="34.105.150.146"
                active={isDev}
                onClick={() => switchTarget("dev")}
              />
              <div style={{
                padding: "8px 12px", fontSize: 11, color: theme.textMuted,
                borderTop: `1px solid ${theme.border}`, background: theme.surfaceAlt,
                lineHeight: 1.4,
              }}>
                Auth & ops-internal tables always hit prod.
              </div>
            </div>
          )}
        </div>

        {iconBtn(toggleFullscreen, isFullscreen ? "Exit fullscreen" : "Fullscreen",
          isFullscreen ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 1v3H1M12 1v3h3M4 15v-3H1M12 15v-3h3"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 1h4v3M15 1h-4v3M1 15h4v-3M15 15h-4v-3"/>
            </svg>
          )
        )}

        {iconBtn(toggleTheme, mode === "dark" ? "Light mode" : "Dark mode",
          mode === "dark" ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <circle cx="8" cy="8" r="3"/>
              <path d="M8 1.5v1M8 13.5v1M1.5 8h1M13.5 8h1M3.4 3.4l.7.7M11.9 11.9l.7.7M3.4 12.6l.7-.7M11.9 4.1l.7-.7"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13.5 9A5.5 5.5 0 017 2.5 5.5 5.5 0 108 14.5c2.2 0 4.1-1.3 5-3.1.16-.31.36-.74.5-1.4z"/>
            </svg>
          )
        )}
      </div>
    </header>
  );
}

function DbOption({ theme, dot, label, hint, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 10, width: "100%",
        padding: "10px 12px", border: "none", background: "transparent",
        cursor: "pointer", textAlign: "left", color: theme.text,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = theme.surfaceAlt; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
    >
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 11, color: theme.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{hint}</div>
      </span>
      {active && (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: theme.text }}>
          <path d="M3 8l3 3 7-7" />
        </svg>
      )}
    </button>
  );
}
