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
//
// Brands are one tab per channel, then where the leads come from. Email and
// Instagram are the same kind of work - a queue of brands, one open at a time -
// so they are laid out the same way. Email's replies are its Results view, as
// Instagram's are; /gtm/brands/replies still lands there.
export const BRAND_TABS = [
  { to: "/gtm/brands", label: "Email",
    match: (p) => p === "/gtm/brands" || p.startsWith("/gtm/brands/lead") },
  // Brands written to by hand on Instagram, from drafted messages.
  { to: "/gtm/brands/instagram", label: "Instagram",
    match: (p) => p.startsWith("/gtm/brands/instagram") },
  // The campaigns that find brands, for both channels.
  { to: "/gtm/brands/sources", label: "Sources",
    match: (p) => p.startsWith("/gtm/brands/sources") },
];

export const CREATOR_TABS = [
  { to: "/gtm/creators", label: "Find", match: (p) => p === "/gtm/creators" },
  { to: "/gtm/creators/outreach", label: "Outreach",
    match: (p) => p.startsWith("/gtm/creators/outreach") },
  { to: "/gtm/creators/replies", label: "Replies",
    match: (p) => p.startsWith("/gtm/creators/replies") },
];
