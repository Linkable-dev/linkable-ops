import { useState, useRef, useEffect } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTheme } from "../../contexts/ThemeContext";
import { useAuth } from "../../contexts/AuthContext";
import { OPS_PHASES, CRM_SECTIONS } from "../../lib/constants";
import logoDark from "../../assets/logo-dark.svg";
import logoWhite from "../../assets/logo-white.svg";
import iconDark from "../../assets/icon-dark.svg";
import iconWhite from "../../assets/icon-white.svg";

// SVG icons for each ops phase
const opsIcons = {
  onboarding: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>,
  list: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>,
  offer: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>,
  campaign: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>,
  content: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  leads: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>,
  performance: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
};

const crmIcons = {
  contacts: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="7" r="4"/><path d="M5.5 21a6.5 6.5 0 0113 0"/></svg>,
  pipeline: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></svg>,
  scraper: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  outreach: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>,
};


export default function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const path = location.pathname;
  const { theme, mode, sidebarOpen, toggleSidebar } = useTheme();
  const { profile, signOut } = useAuth();
  const [accountOpen, setAccountOpen] = useState(false);
  const dropdownRef = useRef(null);

  const logo = mode === "dark" ? logoWhite : logoDark;
  const icon = mode === "dark" ? iconWhite : iconDark;
  const W = sidebarOpen ? 240 : 64;
  const initials = (profile?.full_name || "U")[0].toUpperCase();

  useEffect(() => {
    const handler = (e) => { if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setAccountOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const navItem = (to, label, isActive, iconEl) => (
    <Link to={to} title={label} style={{
      display: "flex", alignItems: "center", gap: 12, height: 38,
      padding: sidebarOpen ? "0 12px" : "0", justifyContent: sidebarOpen ? "flex-start" : "center",
      borderRadius: 8, textDecoration: "none", fontSize: 14, fontWeight: isActive ? 500 : 400,
      color: isActive ? theme.text : theme.textMid,
      background: isActive ? theme.accentLight : "transparent",
      transition: "all 0.12s",
    }}>
      <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 20, flexShrink: 0, color: isActive ? theme.text : theme.textMuted }}>
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
          ? <img src={logo} alt="Linkable" style={{ height: 15 }} />
          : <img src={icon} alt="Linkable" style={{ height: 22 }} />
        }
      </div>

      {/* Toggle button on the border — half in sidebar, half out */}
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

        {/* Outbound Ops group */}
        {sectionHeader("Outbound")}
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {OPS_PHASES.map(p => navItem(p.path, p.label, path.startsWith(p.path), opsIcons[p.id]))}
        </div>

        {/* CRM group */}
        {sectionHeader("CRM")}
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {CRM_SECTIONS.map(s => navItem(s.path, s.label, path.startsWith(s.path), crmIcons[s.id]))}
        </div>
      </nav>

      {/* Account at bottom */}
      <div ref={dropdownRef} style={{ flexShrink: 0, padding: sidebarOpen ? "10px 10px 16px" : "10px 6px 16px", borderTop: `1px solid ${theme.border}`, position: "relative" }}>

        {/* Upward dropdown */}
        {accountOpen && (
          <div style={{
            position: "absolute", bottom: sidebarOpen ? 64 : 58, left: sidebarOpen ? 10 : 4, right: sidebarOpen ? 10 : 4,
            background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 10,
            boxShadow: theme.shadowMd, padding: 4, zIndex: 200,
            minWidth: sidebarOpen ? undefined : 170,
          }}>
            {profile && (
              <div style={{ padding: "8px 12px", borderBottom: `1px solid ${theme.border}`, marginBottom: 4 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>{profile.full_name}</div>
                <div style={{ fontSize: 11, color: theme.textMuted }}>{profile.email}</div>
              </div>
            )}
            <DropdownItem icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>}
              label="Settings" theme={theme} onClick={() => { setAccountOpen(false); navigate("/settings"); }} />
            <DropdownItem icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>}
              label="Sign out" theme={theme} onClick={() => { setAccountOpen(false); signOut(); }} danger />
          </div>
        )}

        {/* Account button */}
        <button onClick={() => setAccountOpen(!accountOpen)} style={{
          display: "flex", alignItems: "center", gap: 10, width: "100%",
          padding: sidebarOpen ? "8px 8px" : "8px 0", justifyContent: sidebarOpen ? "flex-start" : "center",
          border: "none", background: accountOpen ? theme.accentLight : "transparent",
          cursor: "pointer", borderRadius: 8, fontFamily: "inherit", transition: "background 0.12s",
        }}>
          <div style={{
            width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
            background: mode === "dark" ? "#333" : "#0A0A0A", color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 12, fontWeight: 700,
          }}>{initials}</div>
          {sidebarOpen && (
            <>
              <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: theme.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {profile?.full_name || "Account"}
                </div>
              </div>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, transform: accountOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
                <path d="M4 6l4 4 4-4" stroke={theme.textMuted} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}

function DropdownItem({ icon, label, theme, onClick, danger }) {
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "8px 12px",
      border: "none", background: "transparent", cursor: "pointer", borderRadius: 6,
      fontSize: 13, color: danger ? "#EF4444" : theme.textMid, fontFamily: "inherit", textAlign: "left",
    }} onMouseEnter={e => e.currentTarget.style.background = theme.accentLight}
       onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
      {icon}{label}
    </button>
  );
}
