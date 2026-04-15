import { useState, useCallback } from "react";
import { useLocation, useParams } from "react-router-dom";
import { useTheme } from "../../contexts/ThemeContext";

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
  const { title, subtitle } = getPageInfo(location.pathname);
  const [isFullscreen, setIsFullscreen] = useState(!!document.fullscreenElement);

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
        <div style={{
          display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 500,
          padding: "4px 10px", borderRadius: 20,
          background: mode === "dark" ? "#052e16" : "#F0FDF4",
          color: "#22C55E",
        }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#22C55E" }} />
          Cloud SQL
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
