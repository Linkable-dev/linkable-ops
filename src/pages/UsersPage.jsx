import { useState, useEffect, useCallback, useMemo } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { useDbTarget } from "../contexts/DbTargetContext";
import { api, friendlyDate, friendlyNumber } from "../lib/api";
import { TabBar } from "../components/ui/TabBar";
import { Input } from "../components/ui/Input";
import { Btn } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import GrantTrialModal from "../components/trials/GrantTrialModal";
import { planLabel } from "../components/trials/planConfig";
import ManageBrandModal from "../components/users/ManageBrandModal";
import {
  useColumnWidths, gridTemplate, ResizeHandle, SortLabel, nextSort, ColumnFilter,
} from "../components/table/tableTools";

const TABS = [["brands", "Brands"], ["creators", "Creators"], ["deleted", "Deleted"]];

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
  { key: "subscription",    label: "Subscription", width: 210, sortable: true, defaultDir: "desc",
    filter: { type: "select", options: [
      { value: "paying",   label: "Paying" },
      { value: "trial",    label: "In trial" },
      { value: "granted",  label: "Linkable trial" },
      { value: "offered",  label: "Trial offered" },
      { value: "no_plan",  label: "No plan" },
    ] } },
  { key: "actions",         label: "",             width: 165 },
];

// Soft-deleted brands awaiting the nightly purge. No sort/filter (the endpoint
// orders by soonest purge); "Purge in" is the urgency signal an operator scans.
const DELETED_COLUMNS = [
  { key: "avatar",       label: "",         width: 44,  resizable: false },
  { key: "store_name",   label: "Store",    width: 180, fill: true },
  { key: "email",        label: "Email",    width: 190, fill: true },
  { key: "owner_name",   label: "Owner",    width: 120 },
  { key: "user_deleted", label: "Deleted",  width: 100 },
  { key: "purge",        label: "Purge in", width: 140 },
  { key: "actions",      label: "",         width: 120 },
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
  const [restoring, setRestoring] = useState(null); // user_id being restored
  const [actionError, setActionError] = useState("");
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [filters, setFilters] = useState({});
  const [manageRow, setManageRow] = useState(null); // null = closed
  const [trialModalRow, setTrialModalRow] = useState(null); // null = closed

  const columns = tab === "brands" ? BRAND_COLUMNS
    : tab === "creators" ? CREATOR_COLUMNS
    : DELETED_COLUMNS;
  // "deleted" is a list of brands, but labelled distinctly in empty/footer copy.
  const tabLabel = tab === "deleted" ? "deleted brands" : tab;
  const showFilterRow = columns.some((c) => c.filter);
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
      let data;
      if (tab === "deleted") {
        data = await api.listDeletedBrands({ q, limit: 100 });
      } else {
        const fn = tab === "brands" ? api.listAdminBrands : api.listAdminCreators;
        data = await fn({ q, limit: 100, sortBy: sort.sortBy, sortDir: sort.sortDir, filters });
      }
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

  async function handleRestore(row) {
    const label = row.store_name || row.email || "this brand";
    if (!window.confirm(
      `Restore "${label}"?\n\nThis reactivates the brand and cancels the scheduled deletion. ` +
      `Ended links are not automatically re-activated.`,
    )) return;
    setActionError("");
    setRestoring(row.user_id);
    try {
      await api.restoreBrand(row.user_id);
      // Drop it from the deleted list — it's active again.
      setRows((rs) => rs.filter((r) => r.user_id !== row.user_id));
    } catch (err) {
      setActionError(`${row.email}: ${err.message}`);
    } finally {
      setRestoring(null);
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
          placeholder={tab === "creators"
            ? "Search by IG handle, email, name…"
            : "Search by store name, website, email, name…"
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

        {/* Per-column filter row (server-side). Hidden on the deleted tab,
            whose endpoint has no per-column filters. */}
        {showFilterRow && (
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
        )}

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
            {tab === "deleted"
              ? <>No brands pending deletion{q ? ` matching "${q}"` : ""}.</>
              : <>No {tabLabel} found{q ? ` matching "${q}"` : ""}{hasFilters ? " with the current column filters" : ""}.</>}
          </div>
        ) : tab === "deleted" ? (
          rows.map((row) => (
            <DeletedBrandRow
              key={row.user_id}
              row={row}
              theme={theme}
              template={template}
              busy={restoring === row.user_id}
              onRestore={() => handleRestore(row)}
            />
          ))
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
          Showing {rows.length} {tabLabel} {rows.length === 100 ? "(capped — refine search)" : ""}
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
          <SubscriptionCell row={row} theme={theme} />
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

// One soft-deleted brand row. No impersonate/manage — a deleted account can't
// be opened; the only action is to bring it back before the nightly purge.
function DeletedBrandRow({ row, theme, template, busy, onRestore }) {
  const avatar = avatarFor(row, "brand");
  const initials = initialsFor(row, "brand");
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
      <div style={{
        width: 32, height: 32, borderRadius: "50%",
        background: theme.surfaceAlt, color: theme.text,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 11, fontWeight: 700, overflow: "hidden",
      }}>
        {showImg
          ? <img src={avatar} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={() => setImgFailed(true)} />
          : initials}
      </div>

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
      <div style={{ fontSize: 12, color: theme.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
        title={row.user_deleted ? new Date(row.user_deleted).toLocaleString() : ""}>
        {row.user_deleted ? friendlyDate(row.user_deleted) : "—"}
      </div>
      <PurgeCell row={row} theme={theme} />

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, minWidth: 0 }}>
        <Btn size="sm" color="#10B981" onClick={onRestore} loading={busy}>
          Restore
        </Btn>
      </div>
    </div>
  );
}

// "Purge in" urgency: red when overdue or ≤3 days, amber ≤7, muted otherwise.
// The deletion reason (if any) sits underneath as context.
function PurgeCell({ row, theme }) {
  const scheduled = row.deletion_scheduled_for;
  const days = row.days_until_purge;

  let label;
  let color = theme.textMid;
  if (scheduled == null) {
    label = "no schedule";
    color = theme.textMuted;
  } else if (row.purge_overdue) {
    label = "overdue";
    color = "#EF4444";
  } else {
    label = `${days} day${days === 1 ? "" : "s"}`;
    color = days <= 3 ? "#EF4444" : days <= 7 ? "#F59E0B" : theme.textMid;
  }

  return (
    <div
      style={{ minWidth: 0, fontSize: 12, color, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      title={scheduled
        ? `Scheduled hard-delete: ${new Date(scheduled).toLocaleString()}`
        : "No purge scheduled — will stay soft-deleted until a schedule is set"}
    >
      {label}
      {row.deletion_reason && (
        <div style={{ fontSize: 10, color: theme.textMuted, fontWeight: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {row.deletion_reason}
        </div>
      )}
    </div>
  );
}

// Maps users.account_id (set by the main app's subscription flow) to a coarse
// plan tier. Mirrors planNameFromAccountId in main-app payment_service.ts —
// 2026-07 lineup: Scale = $499 family (legacy $299 grandfathers in), Growth =
// $199 family (legacy Grow/Starter prices map here by price fidelity).
function paidPlanFromAccountId(accountId) {
  if (!accountId) return null;
  // Customer-facing labels (2026-07 rebrand): the $499 tier shows to brands as
  // "Growth" and the $199 tier as "Starter". Internally the app still calls these
  // Scale/Growth (plan_detection, entitlement, account_id), but ops mirrors what
  // the brand actually sees so the two views read the same.
  if (accountId.includes("shopify_499") || accountId.includes("shopify_4970") || accountId.includes("shopify_299")) return "Growth";
  if (accountId.includes("shopify_199") || accountId.includes("shopify_99")) return "Starter";
  return null; // shopify_free_plan or anything else
}

// Shopify statuses that mean "no longer a live paying subscription".
const SUB_TERMINAL = new Set(["CANCELLED", "CANCELED", "EXPIRED", "DECLINED"]);

// #RRGGBB (or #RGB) -> rgba() so a state colour can tint its own pill background.
function hexToRgba(hex, a) {
  const h = String(hex || "").replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return `rgba(115,115,115,${a})`;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// A compact colour-coded status pill (dot + label) so a brand's subscription
// state reads at a glance in the dense table: green = paying/active, amber =
// trial / cancelled-in-grace, red = frozen, blue = trial offered, grey =
// cancelled / no plan. The colour is passed in by SubscriptionCell per state.
function StatePill({ text, color }) {
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        marginTop: 3, padding: "1px 7px 1px 6px", borderRadius: 999,
        fontSize: 10, fontWeight: 600, lineHeight: 1.5,
        color, background: hexToRgba(color, 0.12),
        border: `1px solid ${hexToRgba(color, 0.28)}`,
        maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: color, flexShrink: 0 }} />
      {text}
    </span>
  );
}

// One "Subscription" column covering every state a brand can be in, read from
// app_subscriptions (the main app's Shopify source of truth) with a fallback to
// account_id + brands.trial_* where that table isn't populated yet:
//
//   {Plan} · Trial · Nd left            (amber)  — subscribed, inside the trial
//   {Plan} · Trial · Nd left · granted  (amber)  — that trial is a Linkable grant
//   {Plan} · Paying                     (green)  — subscribed, trial over, billed
//   {Plan} · Cancelled DATE             (grey)   — cancelled/expired/declined
//   {Plan} · Frozen                     (red)    — payment failed
//   {Plan} · Trial offered · Nd         (blue)   — Linkable grant not yet started
//   {Plan} · Trial expired              (grey)   — Linkable grant lapsed, no plan
//   Free                                (muted)  — chose shopify_free_plan
//   No plan · not subscribed            (muted)  — never subscribed
//
// The "(test)" tag marks a test-mode subscription (staff/dev store) that never
// bills. The "· granted" suffix (and the offered/expired states) is what the
// old separate "Linkable trial" column carried — a Linkable-granted trial is
// delivered as a real Shopify subscription, so it belongs in the same cell.
function SubscriptionCell({ row, theme }) {
  const [now] = useState(() => Date.now());
  const accountId = row.account_id || "";
  // A row can report status='ACTIVE' while cancelled_at is set — an out-of-order
  // Shopify webhook that landed after the cancellation. That subscription is
  // dead, so treat a stamped cancelled_at as authoritative and render it as
  // cancelled rather than an ongoing trial/paying state.
  const rawStatus = (row.sub_status || "").toUpperCase();
  const status =
    rawStatus === "ACTIVE" && row.sub_cancelled_at ? "CANCELLED" : rawStatus;
  const isTest = row.sub_test === true || row.sub_test === "t";
  const testTag = isTest ? " (test)" : "";

  // Clean tier label: the account_id customer label ("Starter"), else a Linkable
  // grant's plan, else the Shopify sub name stripped of the "Linkable " prefix /
  // " (Interval)" suffix — so it reads "Starter", not "Linkable Starter (Monthly)".
  const planName =
    paidPlanFromAccountId(accountId) ||
    (row.trial_plan_name ? planLabel(row.trial_plan_name) : "") ||
    (row.sub_name
      ? String(row.sub_name)
          .replace(/^Linkable\s+/i, "")
          .replace(/\s*\((monthly|annual|yearly)\)\s*$/i, "")
          .trim()
      : "") ||
    "Plan";

  // A Linkable-granted trial (trial_plan_name set) overlays the Shopify state.
  const grant = deriveTrialState(row, now);
  const grantedActive = grant && grant.status === "active";

  // A subscription cancelled while still inside its trial keeps access until the
  // trial end (the brand's trial window stays open, so the trial exemption
  // ungates them until then) — surface that grace instead of a bare "Cancelled".
  const trialExpMs = row.trial_expiration_date && row.trial_expiration_date !== "-infinity"
    ? new Date(row.trial_expiration_date).getTime() : null;
  const inTrialGrace =
    row.trial_activation_date && row.trial_activation_date !== "-infinity" && trialExpMs && trialExpMs > now;

  const trialLine = (daysLeft) =>
    `Trial · ${daysLeft} day${daysLeft === 1 ? "" : "s"} left${grantedActive ? " · granted" : ""}`;

  let label;
  let sub = null;
  let color = theme.textMid;
  let title = "";

  if (status) {
    // Authoritative: a real Shopify subscription row exists.
    if (status === "ACTIVE") {
      const trialEnds = row.sub_trial_ends_at ? new Date(row.sub_trial_ends_at).getTime() : null;
      if (trialEnds && trialEnds > now) {
        const daysLeft = Math.max(0, Math.ceil((trialEnds - now) / 86_400_000));
        label = `${planName}${testTag}`;
        sub = trialLine(daysLeft);
        color = "#F59E0B";
        title = grantedActive
          ? "In a Linkable-granted trial — Shopify starts billing when it ends"
          : `In the Shopify 14-day trial — first charge ${new Date(trialEnds).toLocaleDateString()}`;
      } else {
        label = `${planName}${testTag}`;
        sub = "Paying";
        color = "#10B981";
        title = row.sub_current_period_end
          ? `Paying — current period ends ${new Date(row.sub_current_period_end).toLocaleDateString()}`
          : "Active paid subscription (trial over)";
      }
    } else if (status === "FROZEN") {
      label = `${planName}${testTag}`;
      sub = "Frozen";
      color = "#EF4444";
      title = "Subscription frozen on Shopify — recurring payment failed";
    } else if (SUB_TERMINAL.has(status)) {
      const when = row.sub_cancelled_at ? new Date(row.sub_cancelled_at).toLocaleDateString() : null;
      label = `${planName}${testTag}`;
      if (inTrialGrace) {
        // Rose, like a hard cancellation — a cancelled brand should never share
        // the amber of a live trial. The "access until" text carries the grace
        // nuance; the colour says "this is churning", not "healthy trial".
        sub = `Cancelled · access until ${new Date(trialExpMs).toLocaleDateString()}`;
        color = "#E11D48";
        title = `Cancelled${when ? ` on ${when}` : ""} — keeps trial access until ${new Date(trialExpMs).toLocaleDateString()}, then gated`;
      } else {
        // Hard-cancelled with no remaining access: rose, so it reads as a
        // distinct negative state rather than the same grey as "no plan yet".
        sub = when ? `Cancelled ${when}` : "Cancelled";
        color = "#E11D48";
        title = `Subscription ${status.toLowerCase()}${when ? ` on ${when}` : ""}`;
      }
    } else {
      // PENDING / ACCEPTED / anything else Shopify reports.
      label = `${planName}${testTag}`;
      sub = status.charAt(0) + status.slice(1).toLowerCase();
      color = theme.textMid;
      title = `Shopify subscription status: ${status}`;
    }
  } else if (paidPlanFromAccountId(accountId)) {
    // Fallback: a paid account_id but no app_subscriptions row yet.
    const exp = row.trial_expiration_date && row.trial_expiration_date !== "-infinity"
      ? new Date(row.trial_expiration_date).getTime() : null;
    const activated = row.trial_activation_date && row.trial_activation_date !== "-infinity";
    if (activated && exp && exp > now) {
      const daysLeft = Math.max(0, Math.ceil((exp - now) / 86_400_000));
      label = planName;
      sub = trialLine(daysLeft);
      color = "#F59E0B";
      title = `Paid plan (${accountId}); in trial — first charge ${new Date(exp).toLocaleDateString()}`;
    } else {
      label = planName;
      sub = "Paying";
      color = "#10B981";
      title = `Paid plan — account_id ${accountId}`;
    }
  } else if (grant) {
    // No live Shopify plan, but a Linkable grant is on file.
    if (grant.status === "granted") {
      label = planName;
      sub = `Trial offered · ${row.trial_days || 0}d`;
      color = "#3B82F6";
      title = "Linkable trial granted but not yet started by the brand";
    } else if (grant.status === "active") {
      label = planName;
      sub = `Trial · ${grant.timeLabel} · granted`;
      color = "#F59E0B";
      title = "Linkable-granted trial active (no Shopify subscription on file)";
    } else {
      label = planName;
      sub = "Trial expired";
      color = theme.textMuted;
      title = grant.title;
    }
  } else if (accountId === "shopify_free_plan" || accountId === "free_plan") {
    label = "Free";
    color = theme.textMid;
    title = "On the Shopify free plan";
  } else if (!accountId) {
    label = "No plan";
    sub = "not subscribed";
    color = theme.textMuted;
    const created = row.user_created ? new Date(row.user_created).getTime() : null;
    const daysSinceSignup = created ? Math.floor((now - created) / 86_400_000) : null;
    title = daysSinceSignup != null
      ? `No Shopify plan chosen — signed up ${daysSinceSignup}d ago. A cancellation also clears account_id.`
      : "No Shopify plan chosen";
  } else {
    label = "—";
    color = theme.textMuted;
    title = `Unrecognized account_id: ${accountId}`;
  }

  return (
    <div style={{ minWidth: 0, overflow: "hidden" }} title={title}>
      {sub ? (
        <>
          <div
            style={{
              fontSize: 12, fontWeight: 600, color: theme.text,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}
          >
            {label}
          </div>
          <StatePill text={sub} color={color} />
        </>
      ) : (
        // States with no detail line (Free, No plan, unrecognized) become the
        // pill itself so they still carry a colour chip rather than bare text.
        <StatePill text={label} color={color} />
      )}
    </div>
  );
}

// Shared derivation for the TRIAL PLAN / TIME LEFT columns, which track a
// LINKABLE-GRANTED trial specifically (trial_plan_name is set only by the admin
// grant flow). Since 2026-07 the main app also writes brands.trial_* for the
// standard 14-day Shopify trial, but WITHOUT a trial_plan_name — that one shows
// in the PLAN column, so we require trial_plan_name here to keep the two apart.
// Returns null when there is no granted Linkable trial to show.
function deriveTrialState(row, now) {
  if (!row.trial_plan_name) return null;

  const activated = row.trial_activation_date && row.trial_activation_date !== "-infinity"
    ? new Date(row.trial_activation_date) : null;
  const expires = row.trial_expiration_date && row.trial_expiration_date !== "-infinity"
    ? new Date(row.trial_expiration_date) : null;

  if (activated && expires && expires.getTime() > now) {
    const daysLeft = Math.max(0, Math.ceil((expires.getTime() - now) / 86_400_000));
    return {
      status: "active",
      planName: planLabel(row.trial_plan_name),
      timeLabel: `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`,
      color: "#F59E0B",
      title: `Trial active — payment starts ${expires.toLocaleDateString()}`,
    };
  }
  if (row.trial_plan_name && !activated) {
    return {
      status: "granted",
      planName: planLabel(row.trial_plan_name),
      timeLabel: `${row.trial_days || 0}d offer`,
      color: "#3B82F6",
      title: "Trial granted but not yet activated by the brand",
    };
  }
  if (activated && expires && expires.getTime() <= now) {
    return {
      status: "expired",
      planName: planLabel(row.trial_plan_name),
      timeLabel: `expired ${expires.toLocaleDateString()}`,
      color: "#EF4444",
      title: `Trial expired ${expires.toLocaleDateString()}`,
    };
  }
  return null;
}

