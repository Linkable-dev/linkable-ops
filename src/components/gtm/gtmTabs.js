// The GTM tab strips. Their own module because GtmSection.jsx exports a
// component, and a file that exports both a component and a constant breaks
// fast refresh for everything importing it.

// One system, so one pair of tabs.
//
// This strip used to carry four: Find and Replies from the prospector, Outreach
// and Inbox from the main app's own outbound. They were kept as separate tabs
// rather than merged because the two pipelines keep separate suppression lists,
// and one screen over two lists would mean an opt-out in one silently failing
// to stop the other.
//
// That objection only held while both were alive. The older one has sent 1,297
// emails for 530 opens and no replies at all, has no active campaign and no
// agent switched on; its Inbox holds one conversation. A tab strip that offers
// it two of four slots says it is a going concern, and it is not.
//
// Nothing is deleted. GtmAgentsPage and AiInboxPage still exist, /ai/agents and
// /ai/inbox still render them for anyone holding a link, and the data and API
// are untouched — this is the tab strip declining to advertise them.
export const BRAND_TABS = [
  { to: "/gtm/brands", label: "Find",
    match: (p) => p === "/gtm/brands" || p.startsWith("/gtm/brands/lead") },
  { to: "/gtm/brands/replies", label: "Replies",
    match: (p) => p.startsWith("/gtm/brands/replies") },
];

export const CREATOR_TABS = [
  { to: "/gtm/creators", label: "Find", match: (p) => p === "/gtm/creators" },
  { to: "/gtm/creators/outreach", label: "Outreach",
    match: (p) => p.startsWith("/gtm/creators/outreach") },
  { to: "/gtm/creators/replies", label: "Replies",
    match: (p) => p.startsWith("/gtm/creators/replies") },
];
