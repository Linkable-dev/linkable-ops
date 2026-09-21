import { Link, Outlet, useLocation } from "react-router-dom";
import { useTheme } from "../../contexts/ThemeContext";

/**
 * The tab strip for one GTM audience, rendered above whichever page is showing.
 *
 * It lives in the route rather than in the pages because that is the only place
 * it can be true. Put it inside a page and it exists only on the pages you
 * remembered to add it to — which is what happened: clicking Outreach navigated
 * to a page that had never heard of the tabs, and they disappeared.
 *
 * So the section owns the tabs and the pages own their contents. A page added
 * to the section later gets them for free, and cannot forget.
 */
export function GtmSection({ tabs }) {
  const { theme } = useTheme();
  const { pathname } = useLocation();

  return (
    <div>
      <div style={{
        display: "flex",
        gap: 2,
        padding: "0 24px",
        borderBottom: `1px solid ${theme.border}`,
        background: theme.bg,
      }}>
        {tabs.map((tab) => {
          const active = tab.match ? tab.match(pathname) : pathname === tab.to;
          return (
            <Link
              key={tab.to}
              to={tab.to}
              style={{
                padding: "10px 14px",
                fontSize: 13,
                textDecoration: "none",
                color: active ? theme.text : theme.textMuted,
                borderBottom: `2px solid ${active ? theme.text : "transparent"}`,
                marginBottom: -1,
              }}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
      <Outlet />
    </div>
  );
}

// Two of these are the prospector's (Find, Replies) and two belong to the main
// app's own outbound (Outreach, Inbox). They share a strip because an operator
// working brands does not care which system a row came from — but Replies and
// Inbox stay separate tabs, because they are separate systems and merging them
// would mean pretending one pipeline's suppression list covers the other's.
export const BRAND_TABS = [
  { to: "/gtm/brands", label: "Find",
    match: (p) => p === "/gtm/brands" || p.startsWith("/gtm/brands/lead") },
  { to: "/ai/agents", label: "Outreach", match: (p) => p.startsWith("/ai/agents") },
  { to: "/gtm/brands/replies", label: "Replies",
    match: (p) => p.startsWith("/gtm/brands/replies") },
  { to: "/ai/inbox", label: "Inbox", match: (p) => p.startsWith("/ai/inbox") },
];

export const CREATOR_TABS = [
  { to: "/gtm/creators", label: "Find", match: (p) => p === "/gtm/creators" },
  { to: "/gtm/creators/outreach", label: "Outreach",
    match: (p) => p.startsWith("/gtm/creators/outreach") },
  { to: "/gtm/creators/replies", label: "Replies",
    match: (p) => p.startsWith("/gtm/creators/replies") },
];
