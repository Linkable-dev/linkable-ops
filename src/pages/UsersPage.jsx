import { useState, useEffect, useCallback, useMemo } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { useDbTarget } from "../contexts/DbTargetContext";
import { api, friendlyDate, friendlyNumber } from "../lib/api";
import { TabBar } from "../components/ui/TabBar";
import { Input } from "../components/ui/Input";
import { Btn } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import GrantTrialModal from "../components/trials/GrantTrialModal";

const TABS = [["brands", "Brands"], ["creators", "Creators"]];

const DEFAULT_SORT = { sortBy: "user_created", sortDir: "desc" };
const TEXT_SORT_KEYS = new Set([
  "store_name", "email", "owner_name", "creator_name", "instagram_username",
]);

function ownerName(row) {
  return [row.first_name, row.last_name].filter(Boolean).join(" ");
}
function creatorName(row) {
  return ownerName(row) || row.instagram_name || "";
}

function sortValue(row, key) {
  switch (key) {
    case "store_name":           return (row.store_name || "").toLowerCase();
    case "email":                return (row.email || "").toLowerCase();
    case "owner_name":           return ownerName(row).toLowerCase();
    case "creator_name":         return creatorName(row).toLowerCase();
    case "instagram_username":   return (row.instagram_username || "").replace(/^@+/, "").toLowerCase();
    case "instagram_followers_count": {
      const n = Number(row.instagram_followers_count);
      return Number.isFinite(n) ? n : -1;
    }
    case "user_created":
    case "last_sign_in":         return row[key] ? new Date(row[key]).getTime() : 0;
    default:                     return row[key] ?? "";
  }
}

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
  const [sortBy, setSortBy] = useState(DEFAULT_SORT.sortBy);
  const [sortDir, setSortDir] = useState(DEFAULT_SORT.sortDir);
  const [trialModalRow, setTrialModalRow] = useState(null); // null = closed

  const handleSort = (key) => {
    if (sortBy === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(key);
      // Text columns default ascending (A→Z); dates and numbers default descending.
      setSortDir(TEXT_SORT_KEYS.has(key) ? "asc" : "desc");
    }
  };

  const sortedRows = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = sortValue(a, sortBy);
      const vb = sortValue(b, sortBy);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }, [rows, sortBy, sortDir]);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const fn = tab === "brands" ? api.listAdminBrands : api.listAdminCreators;
      const data = await fn({ q, limit: 100 });
      setRows(data);
    } catch (err) {
      setError(err.message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [tab, q]);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(fetchRows, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [fetchRows, q]);

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
        setSortBy(DEFAULT_SORT.sortBy);
        setSortDir(DEFAULT_SORT.sortDir);
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
        <div style={{
          display: "grid",
          gridTemplateColumns: tab === "brands"
            ? "44px minmax(0, 1.4fr) minmax(0, 1.4fr) minmax(0, 0.9fr) 90px 90px 95px 110px 110px 190px"
            : "44px minmax(0, 2fr) minmax(0, 2fr) minmax(0, 1.5fr) 110px 120px 130px",
          padding: "10px 16px",
          borderBottom: `1px solid ${theme.border}`,
          background: theme.surfaceAlt,
          fontSize: 11, fontWeight: 600, textTransform: "uppercase",
          letterSpacing: 0.5, color: theme.textMuted,
        }}>
          <span></span>
          {tab === "brands" ? (
            <>
              <SortHeader theme={theme} sortKey="store_name"   label="Store"        sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
              <SortHeader theme={theme} sortKey="email"        label="Email"        sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
              <SortHeader theme={theme} sortKey="owner_name"   label="Owner"        sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
              <SortHeader theme={theme} sortKey="user_created" label="Joined"       sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
              <SortHeader theme={theme} sortKey="last_sign_in" label="Last sign in" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
              <span>Plan</span>
              <span>Trial plan</span>
              <span>Time left</span>
              <span></span>
            </>
          ) : (
            <>
              <SortHeader theme={theme} sortKey="creator_name"               label="Creator"      sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
              <SortHeader theme={theme} sortKey="email"                      label="Email"        sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
              <SortHeader theme={theme} sortKey="instagram_username"         label="IG Handle"    sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
              <SortHeader theme={theme} sortKey="instagram_followers_count"  label="Followers"    sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
              <SortHeader theme={theme} sortKey="last_sign_in"               label="Last sign in" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
              <span></span>
            </>
          )}
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
            No {tab} found{q ? ` matching "${q}"` : ""}.
          </div>
        ) : (
          sortedRows.map((row) => (
            <UserRow
              key={row.user_id}
              row={row}
              tab={tab}
              theme={theme}
              busy={impersonating === row.user_id}
              onImpersonate={() => handleImpersonate(row)}
              onGrantTrial={() => setTrialModalRow(row)}
            />
          ))
        )}
      </div>

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

function UserRow({ row, tab, theme, busy, onImpersonate, onGrantTrial }) {
  const kind = tab === "brands" ? "brand" : "creator";
  const avatar = avatarFor(row, kind);
  const initials = initialsFor(row, kind);
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = avatar && !imgFailed;

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: tab === "brands"
        ? "44px minmax(0, 1.4fr) minmax(0, 1.4fr) minmax(0, 0.9fr) 90px 90px 95px 110px 110px 190px"
        : "44px minmax(0, 2fr) minmax(0, 2fr) minmax(0, 1.5fr) 110px 120px 130px",
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
          <div style={{ fontSize: 12, color: theme.textMuted, whiteSpace: "nowrap" }}>
            {friendlyDate(row.user_created)}
          </div>
          <div style={{ fontSize: 12, color: theme.textMuted, whiteSpace: "nowrap" }}>
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
          <div style={{ fontSize: 12, color: theme.textMid, whiteSpace: "nowrap" }}>
            {row.instagram_followers_count && row.instagram_followers_count !== "undefined"
              ? friendlyNumber(row.instagram_followers_count)
              : <span style={{ color: theme.textMuted }}>—</span>}
          </div>
          <div style={{ fontSize: 12, color: theme.textMuted, whiteSpace: "nowrap" }}>
            {row.last_sign_in ? friendlyDate(row.last_sign_in) : <span style={{ fontStyle: "italic" }}>never</span>}
          </div>
        </>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
        {tab === "brands" && (
          <Btn size="sm" variant="outline" onClick={onGrantTrial}>
            Trial
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
// plan tier. Mirrors planNameFromAccountId in main-app payment_service.ts;
// kept here so ops doesn't have to call main-app code to label rows.
function paidPlanFromAccountId(accountId) {
  if (!accountId) return null;
  if (accountId.includes("shopify_299")) return "Scale";
  if (accountId.includes("shopify_199")) return "Grow";
  if (accountId.includes("shopify_99"))  return "Starter";
  return null; // shopify_free_plan or anything else
}

// Trial info lives in its own column (TrialStatusCell) so the Plan column
// can stay clean: it answers one question — what is this brand currently
// paying for / on?
//
//   Starter / Grow / Scale  (green)   — paid Shopify subscription
//   Free                    (muted)   — chose shopify_free_plan
//   Legacy free             (purple)  — empty account_id, never picked a plan
//   —                                 — anything else (rare; data hole)
function PlanCell({ row, theme }) {
  const accountId = row.account_id || "";
  const paidPlan = paidPlanFromAccountId(accountId);
  const isFreePlan = accountId === "shopify_free_plan";

  let label;
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
    label = "Legacy free";
    color = "#8B5CF6";
    title = "No account_id set — grandfathered free user";
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

function SortHeader({ theme, sortKey, label, sortBy, sortDir, onSort }) {
  const isActive = sortBy === sortKey;
  const arrow = !isActive ? "" : (sortDir === "asc" ? " ↑" : " ↓");
  return (
    <span
      onClick={() => onSort(sortKey)}
      style={{
        cursor: "pointer", userSelect: "none",
        color: isActive ? theme.text : theme.textMuted,
        transition: "color 0.12s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = theme.text; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = isActive ? theme.text : theme.textMuted; }}
    >
      {label}{arrow}
    </span>
  );
}
