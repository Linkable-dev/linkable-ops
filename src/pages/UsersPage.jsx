import { useState, useEffect, useCallback } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api, friendlyDate, friendlyNumber } from "../lib/api";
import { TabBar } from "../components/ui/TabBar";
import { Input } from "../components/ui/Input";
import { Btn } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";

const TABS = [["brands", "Brands"], ["creators", "Creators"]];

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
  const [tab, setTab] = useState("brands");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [impersonating, setImpersonating] = useState(null); // user_id being acted on
  const [actionError, setActionError] = useState("");

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
          Users
        </h1>
        <p style={{ fontSize: 13, color: theme.textMuted, margin: 0 }}>
          Open the production main app as any brand or creator. Sessions are minted in prod and
          flagged as <code style={{ background: theme.surfaceAlt, padding: "1px 5px", borderRadius: 3, fontSize: 12 }}>admin_impersonation</code> in
          the tokens table; every login is logged to <code style={{ background: theme.surfaceAlt, padding: "1px 5px", borderRadius: 3, fontSize: 12 }}>admin_impersonations</code>.
        </p>
      </div>

      <TabBar tabs={TABS} active={tab} onSelect={(id) => { setTab(id); setQ(""); }} />

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
            ? "44px minmax(0, 2fr) minmax(0, 2fr) minmax(0, 1.4fr) 120px 130px"
            : "44px minmax(0, 2fr) minmax(0, 2fr) minmax(0, 1.5fr) 110px 130px",
          padding: "10px 16px",
          borderBottom: `1px solid ${theme.border}`,
          background: theme.surfaceAlt,
          fontSize: 11, fontWeight: 600, textTransform: "uppercase",
          letterSpacing: 0.5, color: theme.textMuted,
        }}>
          <span></span>
          {tab === "brands" ? (
            <>
              <span>Store</span>
              <span>Email</span>
              <span>Owner</span>
              <span>Joined</span>
              <span></span>
            </>
          ) : (
            <>
              <span>Creator</span>
              <span>Email</span>
              <span>IG Handle</span>
              <span>Followers</span>
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
          rows.map((row) => (
            <UserRow
              key={row.user_id}
              row={row}
              tab={tab}
              theme={theme}
              busy={impersonating === row.user_id}
              onImpersonate={() => handleImpersonate(row)}
            />
          ))
        )}
      </div>

      {!loading && rows.length > 0 && (
        <div style={{ marginTop: 12, fontSize: 12, color: theme.textMuted, textAlign: "right" }}>
          Showing {rows.length} {tab} {rows.length === 100 ? "(capped — refine search)" : ""}
        </div>
      )}
    </div>
  );
}

function UserRow({ row, tab, theme, busy, onImpersonate }) {
  const kind = tab === "brands" ? "brand" : "creator";
  const avatar = avatarFor(row, kind);
  const initials = initialsFor(row, kind);
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = avatar && !imgFailed;

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: tab === "brands"
        ? "44px minmax(0, 2fr) minmax(0, 2fr) minmax(0, 1.4fr) 120px 130px"
        : "44px minmax(0, 2fr) minmax(0, 2fr) minmax(0, 1.5fr) 110px 130px",
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
        </>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Btn size="sm" variant="outline" onClick={onImpersonate} disabled={busy}>
          {busy ? "Opening…" : "View as user ↗"}
        </Btn>
      </div>
    </div>
  );
}
