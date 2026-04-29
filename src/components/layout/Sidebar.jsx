import { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTheme } from "../../contexts/ThemeContext";
import { useAuth } from "../../contexts/AuthContext";
import { api, friendlyName } from "../../lib/api";
import logoDark from "../../assets/logo-dark.svg";
import logoWhite from "../../assets/logo-white.svg";
import iconDark from "../../assets/icon-dark.svg";
import iconWhite from "../../assets/icon-white.svg";

const dashboardIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
);

const tableIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18" />
  </svg>
);

export default function Sidebar() {
  const location = useLocation();
  const path = location.pathname;
  const { theme, mode, sidebarOpen, toggleSidebar } = useTheme();
  const [tables, setTables] = useState([]);
  const [loading, setLoading] = useState(true);

  const { admin, logout } = useAuth();
  const logo = mode === "dark" ? logoWhite : logoDark;
  const icon = mode === "dark" ? iconWhite : iconDark;
  const W = sidebarOpen ? 240 : 64;

  const [cmsOpen, setCmsOpen] = useState(() => {
    const saved = localStorage.getItem("sidebar:cmsOpen");
    return saved === null ? true : saved === "1";
  });
  useEffect(() => {
    localStorage.setItem("sidebar:cmsOpen", cmsOpen ? "1" : "0");
  }, [cmsOpen]);

  const [opsOpen, setOpsOpen] = useState(() => {
    const saved = localStorage.getItem("sidebar:opsOpen");
    return saved === null ? true : saved === "1";
  });
  useEffect(() => {
    localStorage.setItem("sidebar:opsOpen", opsOpen ? "1" : "0");
  }, [opsOpen]);

  const [aiOpen, setAiOpen] = useState(() => {
    const saved = localStorage.getItem("sidebar:aiOpen");
    return saved === null ? true : saved === "1";
  });
  useEffect(() => {
    localStorage.setItem("sidebar:aiOpen", aiOpen ? "1" : "0");
  }, [aiOpen]);

  useEffect(() => {
    api.getTables()
      .then(setTables)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const navItem = (to, label, isActive, iconEl, indent = false) => (
    <Link to={to} title={label} style={{
      display: "flex", alignItems: "center", gap: 10, height: 34,
      padding: sidebarOpen ? (indent ? "0 10px 0 22px" : "0 10px") : "0",
      justifyContent: sidebarOpen ? "flex-start" : "center",
      borderRadius: 6, textDecoration: "none", fontSize: 13, fontWeight: isActive ? 500 : 400,
      color: isActive ? theme.text : theme.textMid,
      background: isActive ? theme.accentLight : "transparent",
      transition: "all 0.12s",
    }}
      onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = theme.accentLight; }}
      onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
    >
      <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 18, flexShrink: 0, color: isActive ? theme.text : theme.textMuted }}>
        {iconEl}
      </span>
      {sidebarOpen && <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>}
    </Link>
  );

  const sectionHeader = (label) => sidebarOpen ? (
    <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1, color: theme.textMuted, padding: "12px 12px 6px" }}>
      {label}
    </div>
  ) : (
    <div style={{ height: 1, background: theme.border, margin: "10px 10px" }} />
  );

  const moduleHeader = (label, iconEl, open, onToggle) => sidebarOpen ? (
    <button onClick={onToggle} style={{
      display: "flex", alignItems: "center", gap: 10, width: "100%",
      background: "transparent", border: "none", cursor: "pointer",
      fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.2,
      color: theme.textMuted, padding: "6px 10px", height: 32, borderRadius: 6,
      transition: "background 0.12s, color 0.12s",
    }}
      onMouseEnter={(e) => { e.currentTarget.style.background = theme.accentLight; e.currentTarget.style.color = theme.text; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = theme.textMuted; }}
    >
      <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 18, flexShrink: 0 }}>
        {iconEl}
      </span>
      <span style={{ flex: 1, textAlign: "left" }}>{label}</span>
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" style={{ transition: "transform 0.15s", transform: open ? "rotate(90deg)" : "rotate(0deg)", flexShrink: 0 }}>
        <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </button>
  ) : (
    <div style={{ height: 1, background: theme.border, margin: "10px 10px" }} />
  );

  const subHeader = (label) => sidebarOpen && (
    <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.8, color: theme.textMuted, padding: "10px 12px 4px 22px", opacity: 0.7 }}>
      {label}
    </div>
  );

  const cmsIcon = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L2 7l10 5 10-5-10-5z"/>
      <path d="M2 17l10 5 10-5"/>
      <path d="M2 12l10 5 10-5"/>
    </svg>
  );

  const opsIcon = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
    </svg>
  );

  const campaignsIcon = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 11l18-8-5 18-4-7-9-3z"/>
    </svg>
  );

  const aiIcon = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  );

  const inboxIcon = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-6l-2 3h-4l-2-3H2"/>
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
    </svg>
  );

  const usersIcon = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  );

  return (
    <aside style={{
      position: "fixed", top: 0, left: 0, width: W, height: "100vh",
      background: theme.sidebarBg, borderRight: `1px solid ${theme.sidebarBorder}`,
      display: "flex", flexDirection: "column", zIndex: 100,
      transition: "width 0.2s ease",
    }}>
      {/* Logo */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: sidebarOpen ? "flex-start" : "center",
        padding: sidebarOpen ? "20px 20px 12px" : "20px 0 12px", height: 56, flexShrink: 0,
      }}>
        {sidebarOpen
          ? <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <img src={logo} alt="Linkable" style={{ height: 15 }} />
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: theme.textMuted, background: theme.accentLight, padding: "2px 6px", borderRadius: 4, lineHeight: 1 }}>OPS</span>
            </div>
          : <img src={icon} alt="Linkable" style={{ height: 22 }} />
        }
      </div>

      {/* Toggle button */}
      <button onClick={toggleSidebar} title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"} style={{
        position: "absolute", top: 20, right: -14, zIndex: 200,
        width: 28, height: 28, borderRadius: "50%",
        background: theme.surface, border: `1px solid ${theme.border}`,
        boxShadow: "0 1px 4px rgba(0,0,0,0.1)",
        cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
        color: theme.textMuted, transition: "right 0.2s ease",
      }}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path d={sidebarOpen ? "M10 3L5 8l5 5" : "M6 3l5 5-5 5"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {/* Navigation */}
      <nav style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: sidebarOpen ? "0 10px" : "0 6px" }}>
        <div style={{ paddingTop: 8 }}>
          {moduleHeader("Operations", opsIcon, opsOpen, () => setOpsOpen(!opsOpen))}
        </div>
        {(opsOpen || !sidebarOpen) && (
          <div style={{
            display: "flex", flexDirection: "column", gap: 1,
            marginLeft: sidebarOpen ? 14 : 0,
            paddingLeft: sidebarOpen ? 8 : 0,
            borderLeft: sidebarOpen ? `1px solid ${theme.border}` : "none",
            marginTop: 4, marginBottom: 6,
          }}>
            {navItem("/ops/campaigns", "Campaigns", path.startsWith("/ops/campaigns"), campaignsIcon)}
            {navItem("/users", "Users", path.startsWith("/users"), usersIcon)}
          </div>
        )}

        <div style={{ paddingTop: 4 }}>
          {moduleHeader("AI", aiIcon, aiOpen, () => setAiOpen(!aiOpen))}
        </div>
        {(aiOpen || !sidebarOpen) && (
          <div style={{
            display: "flex", flexDirection: "column", gap: 1,
            marginLeft: sidebarOpen ? 14 : 0,
            paddingLeft: sidebarOpen ? 8 : 0,
            borderLeft: sidebarOpen ? `1px solid ${theme.border}` : "none",
            marginTop: 4, marginBottom: 6,
          }}>
            {navItem("/ai/inbox", "AI Inbox", path.startsWith("/ai/inbox"), inboxIcon)}
            {navItem("/ai/test-lab", "AI Test Lab", path.startsWith("/ai/test-lab"), aiIcon)}
          </div>
        )}

        <div style={{ paddingTop: 4 }}>
          {moduleHeader("CMS", cmsIcon, cmsOpen, () => setCmsOpen(!cmsOpen))}
        </div>
        {(cmsOpen || !sidebarOpen) && (
          <div style={{
            display: "flex", flexDirection: "column", gap: 1,
            marginLeft: sidebarOpen ? 14 : 0,
            paddingLeft: sidebarOpen ? 8 : 0,
            borderLeft: sidebarOpen ? `1px solid ${theme.border}` : "none",
            marginTop: 4,
          }}>
            {navItem("/", "Dashboard", path === "/", dashboardIcon)}
            {subHeader("Tables")}
            {loading ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "6px 10px" }}>
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} style={{
                    height: 10, borderRadius: 4,
                    width: `${55 + (i * 17) % 35}%`,
                    background: `linear-gradient(90deg, ${mode === "dark" ? "#1f1f1f" : "#EAEAEA"} 0%, ${mode === "dark" ? "#2a2a2a" : "#F5F5F5"} 50%, ${mode === "dark" ? "#1f1f1f" : "#EAEAEA"} 100%)`,
                    backgroundSize: "200% 100%",
                    animation: "skeletonShimmer 1.2s ease-in-out infinite",
                  }} />
                ))}
              </div>
            ) : tables.length === 0 ? (
              <div style={{ fontSize: 12, color: theme.textMuted, padding: "6px 12px" }}>No tables found</div>
            ) : (
              tables.map((t) =>
                navItem(
                  `/tables/${t}`,
                  friendlyName(t),
                  path.startsWith(`/tables/${t}`),
                  tableIcon
                )
              )
            )}
          </div>
        )}
      </nav>

      {/* Account at bottom */}
      <div style={{ flexShrink: 0, borderTop: `1px solid ${theme.border}`, padding: sidebarOpen ? "8px 10px" : "8px 6px" }}>
        {/* User card */}
        <Link to="/team" style={{
          display: "flex", alignItems: "center", gap: 10, textDecoration: "none",
          padding: sidebarOpen ? "8px 8px" : "8px 0", justifyContent: sidebarOpen ? "flex-start" : "center",
          borderRadius: 8, transition: "background 0.12s",
        }}
          onMouseEnter={(e) => e.currentTarget.style.background = theme.accentLight}
          onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
        >
          <div style={{
            width: 32, height: 32, borderRadius: "50%", flexShrink: 0,
            background: mode === "dark" ? "#333" : "#0A0A0A", color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 12, fontWeight: 700,
          }}>
            {(admin?.name || admin?.email || "A")[0].toUpperCase()}
          </div>
          {sidebarOpen && (
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: theme.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {admin?.name || "Admin"}
              </div>
              <div style={{ fontSize: 11, color: theme.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {admin?.email}
              </div>
            </div>
          )}
          {sidebarOpen && (
            <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); logout(); }} title="Sign out" style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 28, height: 28, borderRadius: 6, border: "none",
              background: "transparent", cursor: "pointer", color: theme.textMuted, flexShrink: 0,
              transition: "color 0.12s, background 0.12s",
            }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "#EF4444"; e.currentTarget.style.background = mode === "dark" ? "#3B1111" : "#FEF2F2"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = theme.textMuted; e.currentTarget.style.background = "transparent"; }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>
              </svg>
            </button>
          )}
        </Link>
        {!sidebarOpen && (
          <button onClick={logout} title="Sign out" style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: "100%", height: 32, marginTop: 4, borderRadius: 6, border: "none",
            background: "transparent", cursor: "pointer", color: theme.textMuted,
            transition: "color 0.12s",
          }}
            onMouseEnter={(e) => e.currentTarget.style.color = "#EF4444"}
            onMouseLeave={(e) => e.currentTarget.style.color = theme.textMuted}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>
            </svg>
          </button>
        )}
      </div>
    </aside>
  );
}
