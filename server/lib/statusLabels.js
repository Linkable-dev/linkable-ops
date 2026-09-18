// Numeric status/role columns as the Go proto actually defines them
// (linkable/proto/products.proto, links.proto, users.proto) — not guessed.
// products.status and the word choice for links.status match the
// PRODUCT_STATUS/LINK maps server/routes/insights.js already computes with
// (LINK_STATUS is famously inverted: 1 means the BRAND invited, not the
// creator — see insights.js's own LINK map), so a raw int reads the same way
// in the table browser as it does on the analytics pages.
//
// Keyed "table.column" and consumed by GET /:table/schema, which attaches
// the matching map as col.enumLabels for the frontend to render instead of
// the bare integer.
export const ENUM_LABELS = {
  "products.status": { 0: "Unset", 1: "New", 2: "Active", 3: "Paused", 4: "Ended", 5: "Not launched" },
  "links.status": { 0: "Unset", 1: "Invited", 2: "Applied", 3: "Accepted", 4: "Rejected", 5: "Ended" },
  "external_creator_links.status": { 0: "Unset", 1: "Invited", 2: "Applied", 3: "Accepted", 4: "Rejected", 5: "Ended" },
  "users.role": { 0: "Unset", 1: "Admin", 2: "Brand", 3: "Creator" },
  "tokens.role": { 0: "Unset", 1: "Admin", 2: "Brand", 3: "Creator" },
  "users.status": {
    0: "Unset", 1: "Inactive", 2: "Pending", 3: "Approved", 4: "Rejected",
    5: "Connected", 6: "Subscribed", 7: "Completed", 8: "Active",
  },
};
