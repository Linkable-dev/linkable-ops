// Black & white theme with gray shades
export const T = {
  bg: "#FAFAFA",
  surface: "#FFFFFF",
  surfaceAlt: "#F5F5F5",
  border: "#E5E5E5",
  text: "#0A0A0A",
  textMid: "#525252",
  textMuted: "#A3A3A3",
  accent: "#0A0A0A",       // primary accent = black
  accentLight: "#F5F5F5",  // light accent bg
  radius: 10,
  shadow: "0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.03)",
  shadowMd: "0 4px 12px rgba(0,0,0,0.06)",
};

export const OPS_PHASES = [
  { id: "onboarding",  label: "Onboarding",  num: "01", color: "#0A0A0A", bg: "#F5F5F5", path: "/ops/onboarding" },
  { id: "list",        label: "Build List",  num: "02", color: "#262626", bg: "#F5F5F5", path: "/ops/build-list" },
  { id: "offer",       label: "Build Offer", num: "03", color: "#404040", bg: "#F5F5F5", path: "/ops/build-offer" },
  { id: "campaign",    label: "Campaign",    num: "04", color: "#0A0A0A", bg: "#F5F5F5", path: "/ops/campaign" },
  { id: "content",     label: "Content",     num: "05", color: "#262626", bg: "#F5F5F5", path: "/ops/content" },
  { id: "leads",       label: "Leads",       num: "06", color: "#404040", bg: "#F5F5F5", path: "/ops/leads" },
  { id: "performance", label: "Performance", num: "07", color: "#0A0A0A", bg: "#F5F5F5", path: "/ops/performance" },
];

export const CRM_SECTIONS = [
  { id: "contacts", label: "Contacts", path: "/crm/contacts", icon: "people" },
  { id: "pipeline", label: "Pipeline", path: "/crm/pipeline", icon: "funnel" },
  { id: "scraper",  label: "Scraper",  path: "/crm/scraper",  icon: "search" },
  { id: "outreach", label: "Outreach", path: "/crm/outreach", icon: "send" },
];

export const CRM_STAGES = ["Lead", "Contacted", "Meeting", "Proposal", "Won", "Lost"];
export const CRM_STAGE_COLORS = {
  Lead: "#0A0A0A", Contacted: "#404040", Meeting: "#737373",
  Proposal: "#525252", Won: "#171717", Lost: "#A3A3A3",
};

export const PHASE_SUBTITLES = {
  onboarding:  "Build your ICP, Service, and Brand Voice knowledge bases",
  list:        "Source, validate, enrich, and verify leads using a 6-level waterfall",
  offer:       "Map deliverables to competitors and generate a full offer package",
  campaign:    "Write personalised email and LinkedIn sequences using your KBs",
  content:     "Generate hooks, VSL scripts, social proof, and lead magnets",
  leads:       "Manage replies, generate AI responses, and track the pipeline",
  performance: "Track funnel metrics and get AI-powered optimisation recommendations",
};
