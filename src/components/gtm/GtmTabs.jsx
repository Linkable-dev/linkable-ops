import { Link, useLocation } from "react-router-dom";
import { useTheme } from "../../contexts/ThemeContext";

/**
 * The stages of one audience's GTM, in the order they happen.
 *
 * GTM is organised by who we are trying to bring on rather than by which tool
 * does it, because "Outbound" and "Replies" were two halves of the same job on
 * the same audience, sitting a nav apart. Finding a brand, writing to it and
 * reading what came back are one flow.
 */
export function GtmTabs({ tabs }) {
  const { theme } = useTheme();
  const { pathname } = useLocation();

  return (
    <div style={{ display: "flex", gap: 2, borderBottom: `1px solid ${theme.border}` }}>
      {tabs.map((tab) => {
        const active = tab.match ? tab.match(pathname) : pathname === tab.to;
        return (
          <Link
            key={tab.to}
            to={tab.to}
            style={{
              padding: "8px 14px",
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
  );
}

export const BRAND_TABS = [
  { to: "/gtm/brands", label: "Find", match: (p) => p.startsWith("/gtm/brands") },
  { to: "/ai/agents", label: "Outreach", match: (p) => p.startsWith("/ai/agents") },
  { to: "/ai/inbox", label: "Replies", match: (p) => p.startsWith("/ai/inbox") },
];
