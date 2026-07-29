import { useState, useEffect, useCallback, useMemo } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { useDbTarget } from "../contexts/DbTargetContext";
import { api, friendlyDate, friendlyNumber } from "../lib/api";
import { TabBar } from "../components/ui/TabBar";
import { Input } from "../components/ui/Input";
import { Btn } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import GrantTrialModal from "../components/trials/GrantTrialModal";
import ManageBrandModal from "../components/users/ManageBrandModal";
import {
  useColumnWidths, gridTemplate, ResizeHandle, SortLabel, nextSort, ColumnFilter,
} from "../components/table/tableTools";

const TABS = [["brands", "Brands"], ["creators", "Creators"]];

const DEFAULT_SORT = { sortBy: "user_created", sortDir: "desc" };

// Sorting and filtering are SERVER-side: `key` must exist in the endpoint's
// whitelists (BRAND_SORTS/BRAND_FILTERS etc. in server/routes/admin-users.js).
// `width` is the default px width; the user can drag-resize (persisted in
// localStorage per table). `fill: true` lets a column absorb leftover space.
const BRAND_COLUMNS = [
  { key: "avatar",          label: "",             width: 44,  resizable: false },
  { key: "store_name",      label: "Store",        width: 170, fill: true, sortable: true, defaultDir: "asc",
    filter: { type: "text", placeholder: "Store / website…" } },
  { key: "email",           label: "Email",        width: 190, fill: true, sortable: true, defaultDir: "asc",
    filter: { type: "text", placeholder: "Email…" } },
  { key: "owner_name",      label: "Owner",        width: 120, sortable: true, defaultDir: "asc",
    filter: { type: "text", placeholder: "Name…" } },
  { key: "user_created",    label: "Joined",       width: 85,  sortable: true, defaultDir: "desc" },
  { key: "last_sign_in",    label: "Last sign in", width: 95,  sortable: true, defaultDir: "desc" },
  { key: "plan",            label: "Plan",         width: 95,  sortable: true, defaultDir: "desc",
    filter: { type: "select", options: [
      { value: "scale",      label: "Scale" },
      { value: "growth",     label: "Growth" },
      { value: "free",       label: "Free" },
      { value: "free_trial", label: "Free trial" },
      { value: "legacy",     label: "Legacy free" },
      { value: "no_record",  label: "No record ⚠" },
    ] } },
  { key: "trial_plan_name", label: "Trial plan",   width: 90,  sortable: true, defaultDir: "asc",
    filter: { type: "text", placeholder: "Plan…" } },
  { key: "trial_time_left", label: "Time left",    width: 100, sortable: true, defaultDir: "desc",
    filter: { type: "select", options: [
      { value: "active",  label: "Active" },
      { value: "granted", label: "Granted" },
      { value: "expired", label: "Expired" },
      { value: "none",    label: "No trial" },
    ] } },
  { key: "actions",         label: "",             width: 165 },
];

const CREATOR_COLUMNS = [
  { key: "avatar",                    label: "",             width: 44,  resizable: false },
  { key: "creator_name",              label: "Creator",      width: 180, fill: true, sortable: true, defaultDir: "asc",
    filter: { type: "text", placeholder: "Name…" } },
  { key: "email",                     label: "Email",        width: 200, fill: true, sortable: true, defaultDir: "asc",
    filter: { type: "text", placeholder: "Email…" } },
  { key: "instagram_username",        label: "IG Handle",    width: 140, sortable: true, defaultDir: "asc",
    filter: { type: "text", placeholder: "@handle…" } },
  { key: "instagram_followers_count", label: "Followers",    width: 100, sortable: true, defaultDir: "desc",
    filter: { type: "number", placeholder: "≥ …" } },
  { key: "last_sign_in",              label: "Last sign in", width: 110, sortable: true, defaultDir: "desc" },
  { key: "actions",                   label: "",             width: 95 },
];

function avatarFor(row, kind) {
  // Backend pre-signs GCS URLs into signed_logo_pic / signed_profile_pic so
  // the <img> tag can load them directly. For creators we also fall back to
  // the live Instagram CDN URL when GCS has no profile pic.
  if (kind === "brand") return row.signed_logo_pic || null;
  if (row.signed_profile_pic) return row.signed_profile_pic;
  if (row.instagram_profile_image && /^https?:\/\//.test(row.instagram_profile_image)) {
    return row.instagram_profile_image;
  }
  return null;
}

function initialsFor(row, kind) {
  const name = kind === "brand"
    ? (row.store_name || row.email || "?")
    : (`${row.first_name || ""} ${row.last_name || ""}`.trim() || row.instagram_username || row.email || "?");
  return name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
}

export default function UsersPage() {
  const { theme, mode } = useTheme();
  const { target } = useDbTarget();
  const isDev = target === "dev";
  const [tab, setTab] = useState("brands");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [impersonating, setImpersonating] = useState(null); // user_id being acted on
  const [actionError, setActionError] = useState("");
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [filters, setFilters] = useState({});
  const [manageRow, setManageRow] = useState(null); // null = closed
  const [trialModalRow, setTrialModalRow] = useState(null); // null = closed

  const columns = tab === "brands" ? BRAND_COLUMNS : CREATOR_COLUMNS;
  const { widths, startResize, resetWidth } = useColumnWidths(`admin-${tab}`, useMemo(
    () => Object.fromEntries(columns.map((c) => [c.key, c.width])),
    [columns],
  ));
  const template = gridTemplate(columns, widths);
  // Grid rows are plain divs, so horizontal overflow needs an explicit
  // min-width on a shared scroll body: sum of column widths + gaps + padding.
  const totalWidth = columns.reduce((s, c) => s + (widths[c.key] || c.width), 0)
    + 8 * (columns.length - 1) + 32;
  const hasFilters = Object.keys(filters).length > 0;

  const handleSort = (key, defaultDir) => setSort((s) => nextSort(s, key, defaultDir));

  const handleFilter = (key, value) => {
    setFilters((f) => {
      const next = { ...f };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
  };

  const fetchRows = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const fn = tab === "brands" ? api.listAdminBrands : api.listAdminCreators;
      const data = await fn({ q, limit: 100, sortBy: sort.sortBy, sortDir: sort.sortDir, filters });
      setRows(data);
    } catch (err) {
      setError(err.message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [tab, q, sort, filters]);

  // Debounce free-text search; sort/filter changes arrive pre-debounced
  // (ColumnFilter commits after a pause) so they refetch immediately.
  useEffect(() => {
    const t = setTimeout(fetchRows, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [fetchRows, q]);

  function handleStartupChanged(userId, enabled) {
    setRows((rs) => rs.map((r) => (r.user_id === userId ? { ...r, startup_programme: enabled } : r)));
    setManageRow((r) => (r && r.user_id === userId ? { ...r, startup_programme: enabled } : r));
  }

  async function handleImpersonate(row) {
    setActionError("");
    setImpersonating(row.user_id);
    try {
      const result = await api.impersonateUser(row.user_id);
      // Open in a new tab. The main app's GatewayPage exchanges the
      // ?token=<uuid> for a session cookie, then redirects to the role's
      // dashboard.
      window.open(result.gateway_url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setActionError(`${row.email}: ${err.message}`);
    } finally {
      setImpersonating(null);
    }
  }

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 6px", color: theme.text }}>
          Impersonation
          {isDev && (
            <span style={{
              marginLeft: 10, fontSize: 11, fontWeight: 600,
              padding: "2px 8px", borderRadius: 10,
              background: mode === "dark" ? "#3D2A05" : "#FFFBEB", color: "#F59E0B",
              verticalAlign: "middle",
            }}>DEV</span>
          )}
        </h1>
        <p style={{ fontSize: 13, color: theme.textMuted, margin: 0 }}>
          Open the {isDev ? "dev" : "production"} main app as any brand or creator. Sessions are
          minted in the {isDev ? "dev DB" : "prod DB"} and flagged as <code style={{ background: theme.surfaceAlt, padding: "1px 5px", borderRadius: 3, fontSize: 12 }}>admin_impersonation</code> in
          the tokens table; every login is logged to <code style={{ background: theme.surfaceAlt, padding: "1px 5px", borderRadius: 3, fontSize: 12 }}>admin_impersonations</code> (always
          prod — audit trail).
        </p>
      </div>

      <TabBar tabs={TABS} active={tab} onSelect={(id) => {
        setTab(id);
        setQ("");
        setSort(DEFAULT_SORT);
        setFilters({});
      }} />

      <div style={{ marginBottom: 16, maxWidth: 420 }}>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={tab === "brands"
            ? "Search by store name, website, email, name…"
            : "Search by IG handle, email, name…"
          }
        />
      </div>

      {actionError && (
        <div style={{
          marginBottom: 12, padding: "10px 14px", borderRadius: 8,
          background: mode === "dark" ? "#3B1111" : "#FEF2F2",
          color: "#EF4444", fontSize: 13, border: `1px solid ${mode === "dark" ? "#5B1717" : "#FECACA"}`,
        }}>
          {actionError}
        </div>
      )}

      {/* Table */}
      <div style={{
        background: theme.surface,
        border: `1px solid ${theme.border}`,
        borderRadius: 12,
        overflow: "hidden",
      }}>
       <div style={{ overflowX: "auto" }}>
       <div style={{ minWidth: totalWidth }}>
        {/* Header row: sort labels + drag-resize handles */}
        <div style={{
          display: "grid",
          gridTemplateColumns: template,
          gap: 8,
          padding: "10px 16px",
          borderBottom: `1px solid ${theme.border}`,
          background: theme.surfaceAlt,
          fontSize: 11, fontWeight: 600, textTransform: "uppercase",
          letterSpacing: 0.5, color: theme.textMuted,
        }}>
          {columns.map((col) => (
            <div key={col.key} style={{ position: "relative", minWidth: 0, whiteSpace: "nowrap" }}>
              {col.sortable ? (
                <SortLabel
                  theme={theme}
                  label={col.label}
                  colKey={col.key}
                  sortBy={sort.sortBy}
                  sortDir={sort.sortDir}
                  defaultDir={col.defaultDir}
                  onSort={handleSort}
                />
              ) : (
                <span>{col.label}</span>
              )}
              {col.resizable !== false && (
                <ResizeHandle colKey={col.key} startResize={startResize} resetWidth={resetWidth} theme={theme} />
              )}
            </div>
          ))}
        </div>

        {/* Per-column filter row (server-side) */}
        <div style={{
          display: "grid",
          gridTemplateColumns: template,
          gap: 8,
          padding: "6px 16px",
          borderBottom: `1px solid ${theme.border}`,
          background: theme.surfaceAlt,
          alignItems: "center",
        }}>
          {columns.map((col) => (
            <div key={col.key} style={{ minWidth: 0 }}>
              {col.filter && (
                <ColumnFilter
                  theme={theme}
                  type={col.filter.type}
                  options={col.filter.options}
                  placeholder={col.filter.placeholder}
                  value={filters[col.key] || ""}
                  onCommit={(v) => handleFilter(col.key, v)}
                />
              )}
            </div>
          ))}
        </div>

        {loading ? (
          <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} style={{ height: 36 }} />
            ))}
          </div>
        ) : error ? (
          <div style={{ padding: 24, textAlign: "center", color: "#EF4444", fontSize: 13 }}>
            {error}
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 32, textAlign: "center", color: theme.textMuted, fontSize: 13 }}>
            No {tab} found{q ? ` matching "${q}"` : ""}{hasFilters ? " with the current column filters" : ""}.
          </div>
        ) : (
          rows.map((row) => (
            <UserRow
              key={row.user_id}
              row={row}
              tab={tab}
              theme={theme}
              template={template}
              busy={impersonating === row.user_id}
              onImpersonate={() => handleImpersonate(row)}
              onManage={() => setManageRow(row)}
            />
          ))
        )}
       </div>
       </div>
      </div>

      <ManageBrandModal
        row={manageRow}
        isDev={isDev}
        onClose={() => setManageRow(null)}
        onStartupChanged={handleStartupChanged}
        onWiped={fetchRows}
        onGrantTrial={(row) => { setManageRow(null); setTrialModalRow(row); }}
      />

      <GrantTrialModal
        row={trialModalRow}
        isDev={isDev}
        onClose={() => setTrialModalRow(null)}
        onGranted={() => { setTrialModalRow(null); fetchRows(); }}
      />

      {!loading && rows.length > 0 && (
        <div style={{ marginTop: 12, fontSize: 12, color: theme.textMuted, textAlign: "right" }}>
          Showing {rows.length} {tab} {rows.length === 100 ? "(capped — refine search)" : ""}
        </div>
      )}
    </div>
  );
}

function UserRow({ row, tab, theme, template, busy, onImpersonate, onManage }) {
  const kind = tab === "brands" ? "brand" : "creator";
  const avatar = avatarFor(row, kind);
  const initials = initialsFor(row, kind);
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = avatar && !imgFailed;

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: template,
      alignItems: "center",
      padding: "10px 16px",
      borderBottom: `1px solid ${theme.border}`,
      gap: 8,
    }}>
      {/* Avatar */}
      <div style={{
        width: 32, height: 32, borderRadius: "50%",
        background: theme.surfaceAlt, color: theme.text,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 11, fontWeight: 700, overflow: "hidden",
      }}>
        {showImg
          ? <img src={avatar} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={() => setImgFailed(true)} />
          : initials
        }
      </div>

      {tab === "brands" ? (
        <>
          <div style={{ minWidth: 0, fontSize: 13, fontWeight: 500, color: theme.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {row.store_name || <span style={{ color: theme.textMuted, fontStyle: "italic" }}>(unnamed)</span>}
            {row.store_website && (
              <div style={{ fontSize: 11, color: theme.textMuted, fontWeight: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {row.store_website}
              </div>
            )}
          </div>
          <div style={{ minWidth: 0, fontSize: 13, color: theme.textMid, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {row.email}
          </div>
          <div style={{ minWidth: 0, fontSize: 13, color: theme.textMid, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {[row.first_name, row.last_name].filter(Boolean).join(" ") || <span style={{ color: theme.textMuted }}>—</span>}
          </div>
          <div style={{ fontSize: 12, color: theme.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {friendlyDate(row.user_created)}
          </div>
          <div style={{ fontSize: 12, color: theme.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {row.last_sign_in ? friendlyDate(row.last_sign_in) : <span style={{ fontStyle: "italic" }}>never</span>}
          </div>
          <PlanCell row={row} theme={theme} />
          <TrialPlanCell row={row} theme={theme} />
          <TrialTimeCell row={row} theme={theme} />
        </>
      ) : (
        <>
          <div style={{ minWidth: 0, fontSize: 13, fontWeight: 500, color: theme.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {[row.first_name, row.last_name].filter(Boolean).join(" ")
              || row.instagram_name
              || <span style={{ color: theme.textMuted, fontStyle: "italic" }}>(unnamed)</span>}
            {(row.location_country || row.location_city) && (
              <div style={{ fontSize: 11, color: theme.textMuted, fontWeight: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {[row.location_city, row.location_country].filter(Boolean).join(", ")}
              </div>
            )}
          </div>
          <div style={{ minWidth: 0, fontSize: 13, color: theme.textMid, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {row.email}
          </div>
          <div style={{ minWidth: 0, fontSize: 13, color: theme.textMid, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {row.instagram_username
              ? <span>@{row.instagram_username.replace(/^@+/, "")}</span>
              : <span style={{ color: theme.textMuted }}>—</span>
            }
          </div>
          <div style={{ fontSize: 12, color: theme.textMid, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {row.instagram_followers_count && row.instagram_followers_count !== "undefined"
              ? friendlyNumber(row.instagram_followers_count)
              : <span style={{ color: theme.textMuted }}>—</span>}
          </div>
          <div style={{ fontSize: 12, color: theme.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {row.last_sign_in ? friendlyDate(row.last_sign_in) : <span style={{ fontStyle: "italic" }}>never</span>}
          </div>
        </>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, minWidth: 0 }}>
        {tab === "brands" && (
          <Btn
            size="sm"
            variant={row.startup_programme ? "solid" : "outline"}
            onClick={onManage}
            title={row.startup_programme
              ? "Enrolled in the Startup Programme — manage programme & trials"
              : "Manage Startup Programme enrollment & trials"}
          >
            Manage
          </Btn>
        )}
        <Btn size="sm" variant="outline" onClick={onImpersonate} loading={busy}>
          View ↗
        </Btn>
      </div>
    </div>
  );
}

// Maps users.account_id (set by the main app's subscription flow) to a coarse
// plan tier. Mirrors planNameFromAccountId in main-app payment_service.ts —
// 2026-07 lineup: Scale = $499 family (legacy $299 grandfathers in), Growth =
// $199 family (legacy Grow/Starter prices map here by price fidelity).
function paidPlanFromAccountId(accountId) {
  if (!accountId) return null;
  if (accountId.includes("shopify_499") || accountId.includes("shopify_4970") || accountId.includes("shopify_299")) return "Scale";
  if (accountId.includes("shopify_199") || accountId.includes("shopify_99")) return "Growth";
  return null; // shopify_free_plan or anything else
}

// How many days a brand has to evaluate before they should have a plan.
// Matches the main app's default Shopify-subscription trial period — every
// paid plan starts with `trialDays: 14`, so 14d is the natural window.
const SIGNUP_FREE_WINDOW_DAYS = 14;

// LIN-856 (main repo commit c7c1a03b, 2025-11-20) introduced the Shopify
// subscription flow. Brands created before this date pre-date paid plans
// entirely — empty account_id on them is genuinely "Legacy free." After
// this date, a brand without an account_id should have one (they had to
// pick a plan at signup) — so empty = data anomaly, not "legacy."
const PAID_PLANS_LAUNCH_TS = Date.UTC(2025, 10, 20); // 2025-11-20

// Plan = "what are they on right now."
//
//   Starter / Grow / Scale   (green)   — paid Shopify subscription
//   Free                     (muted)   — chose shopify_free_plan
//   Free trial · Nd left     (amber)   — empty account_id, within 14d of signup
//   Legacy free              (purple)  — empty account_id AND signed up BEFORE paid plans existed
//   No record ⚠              (red)     — empty account_id AND signed up AFTER paid plans (anomaly)
//   —                                  — unrecognized account_id
//
// "No record" is the important one to spot: paid plans launched 2025-11-20,
// so a brand created after that date must have picked a plan at signup.
// An empty account_id post-launch means either the Shopify confirmation
// flow didn't write back to our DB (return-URL handler skipped) or the
// brand started checkout but never confirmed — in either case the row
// needs human review, not a "free" label that hides the problem.
function PlanCell({ row, theme }) {
  const [now] = useState(() => Date.now());
  const accountId = row.account_id || "";
  const paidPlan = paidPlanFromAccountId(accountId);
  const isFreePlan = accountId === "shopify_free_plan";

  let label;
  let sub = null;
  let color = theme.textMid;
  let title = "";

  if (paidPlan) {
    label = paidPlan;
    color = "#10B981";
    title = `Paid plan — account_id ${accountId}`;
  } else if (isFreePlan) {
    label = "Free";
    color = theme.textMid;
    title = "On Shopify free plan (account_id = shopify_free_plan)";
  } else if (!accountId) {
    const created = row.user_created ? new Date(row.user_created).getTime() : null;
    const daysSinceSignup = created ? Math.floor((now - created) / 86_400_000) : null;
    const signedUpBeforeLaunch = created != null && created < PAID_PLANS_LAUNCH_TS;
    const inWindow = daysSinceSignup != null && daysSinceSignup < SIGNUP_FREE_WINDOW_DAYS;

    if (inWindow) {
      const daysLeft = Math.max(0, SIGNUP_FREE_WINDOW_DAYS - daysSinceSignup);
      label = "Free trial";
      sub = `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`;
      color = "#F59E0B";
      title = `Signed up ${daysSinceSignup}d ago — within initial 14-day evaluation window`;
    } else if (signedUpBeforeLaunch) {
      label = "Legacy free";
      color = "#8B5CF6";
      title = `Signed up before paid plans launched (2025-11-20) — grandfathered`;
    } else {
      label = "No record ⚠";
      color = "#EF4444";
      title = daysSinceSignup != null
        ? `Signed up ${daysSinceSignup}d ago — after paid plans launched, but no account_id on file. Likely a failed Shopify confirmation; investigate.`
        : "No account_id and no signup date";
    }
  } else {
    label = "—";
    color = theme.textMuted;
    title = `Unrecognized account_id: ${accountId}`;
  }

  return (
    <div
      style={{
        minWidth: 0, fontSize: 12, color, overflow: "hidden",
        textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}
      title={title}
    >
      {label}
      {sub && (
        <div style={{ fontSize: 10, color: theme.textMuted, fontWeight: 400 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

// Shared derivation. Returns null when the row has no relevant trial state
// (no granted offer, no activation history) so cells can render a dash.
function deriveTrialState(row, now) {
  const activated = row.trial_activation_date && row.trial_activation_date !== "-infinity"
    ? new Date(row.trial_activation_date) : null;
  const expires = row.trial_expiration_date && row.trial_expiration_date !== "-infinity"
    ? new Date(row.trial_expiration_date) : null;

  if (activated && expires && expires.getTime() > now) {
    const daysLeft = Math.max(0, Math.ceil((expires.getTime() - now) / 86_400_000));
    return {
      status: "active",
      planName: row.trial_plan_name || "trial",
      timeLabel: `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`,
      color: "#F59E0B",
      title: `Trial active — payment starts ${expires.toLocaleDateString()}`,
    };
  }
  if (row.trial_plan_name && !activated) {
    return {
      status: "granted",
      planName: row.trial_plan_name,
      timeLabel: `${row.trial_days || 0}d offer`,
      color: "#3B82F6",
      title: "Trial granted but not yet activated by the brand",
    };
  }
  if (activated && expires && expires.getTime() <= now) {
    return {
      status: "expired",
      planName: row.trial_plan_name || "trial",
      timeLabel: `expired ${expires.toLocaleDateString()}`,
      color: "#EF4444",
      title: `Trial expired ${expires.toLocaleDateString()}`,
    };
  }
  return null;
}

// Just the trial plan name with a status color so an operator can scan the
// column and spot which trials are which (Grow trial vs Scale trial, etc).
// Pairs with TrialTimeCell which carries the "10 days left" string.
function TrialPlanCell({ row, theme }) {
  const [now] = useState(() => Date.now());
  const state = deriveTrialState(row, now);
  if (!state) {
    return <span style={{ fontSize: 12, color: theme.textMuted }}>—</span>;
  }
  return (
    <div
      style={{
        minWidth: 0, fontSize: 12, color: state.color, fontWeight: 500,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}
      title={state.title}
    >
      {state.planName}
    </div>
  );
}

// Time/countdown information for the trial. Granted = "Nd offer", Active =
// "N days left", Expired = "expired DATE". The color matches TrialPlanCell
// so the two columns read as a single visual unit even though they're split.
function TrialTimeCell({ row, theme }) {
  const [now] = useState(() => Date.now());
  const state = deriveTrialState(row, now);
  if (!state) {
    return <span style={{ fontSize: 12, color: theme.textMuted }}>—</span>;
  }
  return (
    <div
      style={{
        minWidth: 0, fontSize: 12, color: state.color,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}
      title={state.title}
    >
      {state.timeLabel}
      <div style={{ fontSize: 10, color: theme.textMuted, fontWeight: 400 }}>
        {state.status}
      </div>
    </div>
  );
}
