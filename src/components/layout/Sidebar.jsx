import { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { useTheme } from "../../contexts/ThemeContext";
import { useAuth } from "../../contexts/AuthContext";
import { api, friendlyName } from "../../lib/api";
import { SkeletonNavItems } from "../ui/Skeleton";
import logoDark from "../../assets/logo-dark.svg";
import logoWhite from "../../assets/logo-white.svg";
import iconDark from "../../assets/icon-dark.svg";
import iconWhite from "../../assets/icon-white.svg";

// Icons, all in one place and all the same family: 24-grid, stroked, no fills.
//
// One meaning per icon, which is the rule that was being broken: the paper
// plane was on both "Campaigns" and "Outbound", and the speech bubble was on
// "Ask the data", on "Autopilot" and on the GTM header — three things that
// have nothing to do with each other and one of which sends no messages at
// all. An icon that appears twice stops being a signal, and in the collapsed
// sidebar it is the ONLY signal.
const icon = (paths, width = 16) => (
  <svg width={width} height={width} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {paths}
  </svg>
);

const homeIcon = icon(<path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1V9.5z" />, 18);

// --- Product ---------------------------------------------------------
// A shopping bag for the section: this is the product brands and creators are
// inside, as opposed to how they got here.
const marketIcon = icon(<>
  <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
  <path d="M3 6h18" />
  <path d="M16 10a4 4 0 0 1-8 0" />
</>);
const alertsIcon = icon(<>
  <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
  <path d="M13.7 21a2 2 0 0 1-3.4 0" />
</>);
const healthIcon = icon(<path d="M3 12h4l2.5-6 4 12L16 12h5" />);
// A megaphone, not a paper plane: a campaign is a brand promoting something,
// and nothing on this page sends anything.
const campaignsIcon = icon(<>
  <path d="M3 11l18-5v12L3 14v-3z" />
  <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
</>);
// Autopilot wears the brand app's own SparklesIcon, path for path. The agent
// is marked with it everywhere a brand sees it, and one symbol for one thing
// across the two apps beats a second icon that means the same and looks like
// something else.
const autopilotIcon = icon(
  <path d="M9.813 15.904 9.375 17.25l-.438-1.346a4.5 4.5 0 0 0-2.841-2.841L4.75 12.625l1.346-.438a4.5 4.5 0 0 0 2.841-2.841L9.375 8l.438 1.346a4.5 4.5 0 0 0 2.841 2.841l1.346.438-1.346.438a4.5 4.5 0 0 0-2.841 2.841ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.456-2.456L14.25 6l1.035-.259a3.375 3.375 0 0 0 2.456-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />,
);
// A coin for the money question: what recruiting costs against what it
// brings in. Distinct from the trophy-less trials icon and from the megaphone
// on Campaigns — this is the only page that is about the ledger, not activity.
const costsIcon = icon(<>
  <circle cx="12" cy="12" r="9" />
  <path d="M12 7v10M9.5 9.5c0-1.4 1.2-2.2 2.7-2.2 1.7 0 2.8.9 2.8 2 0 3-5.5 1.3-5.5 4.2 0 1.2 1.2 2 2.8 2 1.5 0 2.7-.8 2.7-2.2" />
</>);
const trialsIcon = icon(<>
  <polyline points="20 12 20 22 4 22 4 12" />
  <rect x="2" y="7" width="20" height="5" />
  <line x1="12" y1="22" x2="12" y2="7" />
  <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" />
  <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" />
</>);
const usersIcon = icon(<>
  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
  <circle cx="9" cy="7" r="4" />
  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
</>);

// Invented people, and the plates they are photographed into. A camera rather
// than another sparkle: the sparkle is Autopilot's, and two AI things wearing
// one mark is how you end up clicking the wrong one.
const aiCreatorsIcon = icon(<>
  <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
  <circle cx="12" cy="13" r="3.2" />
</>);

// Delivered files: a picture with a corner turned, which is what the grid is
// full of. Distinct from the camera, which is the roster we invent.
const contentIcon = icon(<>
  <rect x="3" y="3" width="18" height="18" rx="2" />
  <circle cx="8.5" cy="8.5" r="1.6" />
  <path d="M21 15l-5-5L5 21" />
</>);

// --- GTM -----------------------------------------------------------------
// A rising line for the section, because what these three have in common is
// growth, not messaging. The plane now belongs to Outbound alone.
const gtmIcon = icon(<>
  <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
  <polyline points="17 6 23 6 23 12" />
</>);
const sendIcon = icon(<path d="M3 11l18-8-5 18-4-7-9-3z" />);
const prospectIcon = icon(<>
  <circle cx="12" cy="12" r="8" />
  <circle cx="12" cy="12" r="3" />
  <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
</>);
const inboxIcon = icon(<>
  <path d="M22 12h-6l-2 3h-4l-2-3H2" />
  <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
</>);
const blogIcon = icon(<>
  <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
  <polyline points="14 3 14 9 20 9" />
  <path d="M8 13h8M8 17h5" />
</>);

// --- Data ----------------------------------------------------------------
// A database cylinder for the section that IS the database. The stacked
// layers it used to wear said "assets" more than "rows".
const dataIcon = icon(<>
  <ellipse cx="12" cy="5" rx="9" ry="3" />
  <path d="M21 5v14c0 1.66-4 3-9 3s-9-1.34-9-3V5" />
  <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
</>);
const dashboardIcon = icon(<>
  <rect x="3" y="3" width="7" height="7" rx="1" />
  <rect x="14" y="3" width="7" height="7" rx="1" />
  <rect x="3" y="14" width="7" height="7" rx="1" />
  <rect x="14" y="14" width="7" height="7" rx="1" />
</>, 18);
const askIcon = icon(<>
  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4" />
  <line x1="12" y1="17" x2="12" y2="17" />
</>);
const tableIcon = icon(<path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18" />, 18);

/** A section's open/closed state, remembered per section in localStorage. */
function useRememberedSection(key, initiallyOpen) {
  const [open, setOpen] = useState(() => {
    const saved = localStorage.getItem(`sidebar:${key}`);
    return saved === null ? initiallyOpen : saved === "1";
  });
  useEffect(() => {
    localStorage.setItem(`sidebar:${key}`, open ? "1" : "0");
  }, [key, open]);
  return [open, setOpen];
}

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

  // Three sections, each remembering whether it was left open. Data starts
  // closed: it is the longest list and the one you go to on purpose.
  const [marketOpen, setMarketOpen] = useRememberedSection("marketplaceOpen", true);
  const [gtmOpen, setGtmOpen] = useRememberedSection("gtmOpen", true);
  const [dataOpen, setDataOpen] = useRememberedSection("dataOpen", false);

  useEffect(() => {
    api.getTables()
      .then(setTables)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const navItem = (to, label, isActive, iconEl, indent = false) => (
    <Link key={to} to={to} title={label} style={{
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
          {navItem("/", "Home", path === "/", homeIcon)}
        </div>
        {/* Product — the product itself: who is in it, what they are
            running, and whether it is going well. */}
        <div style={{ paddingTop: 4 }}>
          {moduleHeader("Product", marketIcon, marketOpen, () => setMarketOpen(!marketOpen))}
        </div>
        {(marketOpen || !sidebarOpen) && (
          <div style={{
            display: "flex", flexDirection: "column", gap: 1,
            marginLeft: sidebarOpen ? 14 : 0,
            paddingLeft: sidebarOpen ? 8 : 0,
            borderLeft: sidebarOpen ? `1px solid ${theme.border}` : "none",
            marginTop: 4, marginBottom: 6,
          }}>
            {/* Alphabetical — a fixed, predictable order beats a curated one
                once there's no single "operator's morning" story to order by. */}
            {/* The roster every brand generates with — ours to cast, not any
                one brand's. */}
            {navItem("/ops/ai-creators", "AI creators", path.startsWith("/ops/ai-creators"), aiCreatorsIcon)}
            {navItem("/alerts", "Alerts", path.startsWith("/alerts"), alertsIcon)}
            {/* Autopilot, by the name it has everywhere it actually runs, and
                under the mark the brand app gives it. */}
            {navItem("/ops/autopilot", "Autopilot", path.startsWith("/ops/autopilot"), autopilotIcon)}
            {navItem("/health", "Brand health", path.startsWith("/health"), healthIcon)}
            {/* What real creators sent back, which until now only the brand
                that received it could see. */}
            {navItem("/ops/content", "Campaign content", path.startsWith("/ops/content"), contentIcon)}
            {navItem("/ops/campaigns", "Campaigns", path.startsWith("/ops/campaigns"), campaignsIcon)}
            {navItem("/ops/costs", "Costs & margin", path.startsWith("/ops/costs"), costsIcon)}
            {navItem("/users", "Impersonation", path.startsWith("/users"), usersIcon)}
            {navItem("/trials", "Trials", path.startsWith("/trials"), trialsIcon)}
          </div>
        )}

        {/* GTM — how brands and creators arrive in the first place. */}
        <div style={{ paddingTop: 4 }}>
          {moduleHeader("GTM", gtmIcon, gtmOpen, () => setGtmOpen(!gtmOpen))}
        </div>
        {(gtmOpen || !sidebarOpen) && (
          <div style={{
            display: "flex", flexDirection: "column", gap: 1,
            marginLeft: sidebarOpen ? 14 : 0,
            paddingLeft: sidebarOpen ? 8 : 0,
            borderLeft: sidebarOpen ? `1px solid ${theme.border}` : "none",
            marginTop: 4, marginBottom: 6,
          }}>
            {navItem("/ai/prospecting", "Prospecting", path.startsWith("/ai/prospecting"), prospectIcon)}
            {navItem("/ai/agents", "Outbound", path.startsWith("/ai/agents"), sendIcon)}
            {navItem("/ai/inbox", "Replies", path.startsWith("/ai/inbox"), inboxIcon)}
            {navItem("/blog", "Blog", path.startsWith("/blog"), blogIcon)}
          </div>
        )}

        {/* Data — the rows underneath all of it, and the two ways of reading
            them. "Ask the data" moved here from Operations: it is a query
            over these tables, not something an operator does to a brand. */}
        <div style={{ paddingTop: 4 }}>
          {moduleHeader("Data", dataIcon, dataOpen, () => setDataOpen(!dataOpen))}
        </div>
        {(dataOpen || !sidebarOpen) && (
          <div style={{
            display: "flex", flexDirection: "column", gap: 1,
            marginLeft: sidebarOpen ? 14 : 0,
            paddingLeft: sidebarOpen ? 8 : 0,
            borderLeft: sidebarOpen ? `1px solid ${theme.border}` : "none",
            marginTop: 4,
          }}>
            {navItem("/dashboard", "Dashboard", path === "/dashboard", dashboardIcon)}
            {navItem("/ask", "Ask the data", path.startsWith("/ask"), askIcon)}
            {subHeader("Tables")}
            {loading ? (
              <SkeletonNavItems count={8} indent showLabel={sidebarOpen} />
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
