import { useEffect, useMemo, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api, friendlyNumber } from "../lib/api";
import { Card } from "../components/ui/Card";
import { SkeletonTableRows, Skeleton } from "../components/ui/Skeleton";
import { useColumnWidths, ResizeHandle, ColumnFilter } from "../components/table/tableTools";

const STATUS_COLORS = {
  Invited:           { bg: "#F3E8FF", fg: "#6B21A8", bgDark: "#2A1B47", fgDark: "#C4B5FD" },
  Applied:           { bg: "#FEF3C7", fg: "#92400E", bgDark: "#3B2A0E", fgDark: "#FCD34D" },
  Accepted:          { bg: "#DBEAFE", fg: "#1E40AF", bgDark: "#0F2547", fgDark: "#93C5FD" },
  "Sample Accepted": { bg: "#CCFBF1", fg: "#115E59", bgDark: "#0E2E2A", fgDark: "#5EEAD4" },
  Shipped:           { bg: "#E0E7FF", fg: "#3730A3", bgDark: "#1E1B47", fgDark: "#A5B4FC" },
  Posted:            { bg: "#FCE7F3", fg: "#9D174D", bgDark: "#3F0F26", fgDark: "#F9A8D4" },
  Sold:              { bg: "#D1FAE5", fg: "#065F46", bgDark: "#0E2E22", fgDark: "#6EE7B7" },
};

const STAGES = ["Invited", "Applied", "Accepted", "Sample Accepted", "Shipped", "Sold"];

const PAGE_SIZE = 25;

// Default column widths in px (roughly the old percent layout at ~1200px).
// The expand-chevron column is fixed — not resizable.
const COLUMNS = [
  { key: "expand",            width: 28, resizable: false },
  { key: "campaign_name",     width: 260 },
  { key: "brand_name",        width: 160 },
  { key: "creators_invited",  width: 100 },
  { key: "creators_applied",  width: 100 },
  { key: "creators_accepted", width: 90 },
  { key: "samples_accepted",  width: 100 },
  { key: "products_shipped",  width: 85 },
  { key: "clicks",            width: 80 },
  { key: "sales",             width: 80 },
  { key: "bottleneck",        width: 240 },
];
const DEFAULT_WIDTHS = Object.fromEntries(COLUMNS.map((c) => [c.key, c.width]));

export default function CampaignsOpsPage() {
  const { theme, mode } = useTheme();
  const [campaigns, setCampaigns] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [creatorsById, setCreatorsById] = useState({});
  const [creatorsLoading, setCreatorsLoading] = useState(false);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sortBy, setSortBy] = useState("created");
  const [sortDir, setSortDir] = useState("desc");
  const [filters, setFilters] = useState({}); // per-column server-side filters

  const { widths, startResize, resetWidth } = useColumnWidths("ops-campaigns", DEFAULT_WIDTHS);
  const totalWidth = COLUMNS.reduce((sum, c) => sum + (widths[c.key] || c.width), 0);

  const handleFilter = (key, value) => {
    setPage(0);
    setFilters((f) => {
      const next = { ...f };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
  };

  const handleSort = (key) => {
    if (sortBy === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(key);
      // Numeric / severity columns are most useful descending; text ascending.
      setSortDir(["campaign_name", "brand_name"].includes(key) ? "asc" : "desc");
    }
    setPage(0);
  };

  // Debounce search input → server query
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Reset to first page when search changes
  useEffect(() => { setPage(0); }, [debouncedSearch]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setExpandedId(null);
    api.getOpsCampaigns({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, search: debouncedSearch, sortBy, sortDir, filters })
      .then((res) => {
        setCampaigns(res.rows || []);
        setTotal(res.total || 0);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [page, debouncedSearch, sortBy, sortDir, filters]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const toggleExpand = async (id) => {
    if (expandedId === id) { setExpandedId(null); return; }
    setExpandedId(id);
    if (!creatorsById[id]) {
      setCreatorsLoading(true);
      try {
        const data = await api.getOpsCampaignCreators(id);
        setCreatorsById((prev) => ({ ...prev, [id]: data }));
      } catch (e) {
        setCreatorsById((prev) => ({ ...prev, [id]: { error: e.message } }));
      } finally { setCreatorsLoading(false); }
    }
  };

  const filtered = useMemo(() => {
    // Quick-filter chips operate on the visible page only.
    let list = campaigns;
    if (filter === "stuck-shipping") {
      list = list.filter((c) => c.creators_accepted > 0 && c.products_shipped < c.creators_accepted);
    } else if (filter === "no-sales") {
      list = list.filter((c) => c.products_shipped > 0 && c.sales === 0);
    } else if (filter === "no-applications") {
      list = list.filter((c) => Number(c.creators_applied) === 0);
    }
    return list;
  }, [campaigns, filter]);

  if (error) return (
    <Card><div style={{ color: theme.text }}>Failed to load campaigns: {error}</div></Card>
  );

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: theme.text, margin: 0 }}>Campaign Operations</h1>
        <p style={{ fontSize: 13, color: theme.textMuted, margin: "4px 0 0" }}>
          Find what's blocking sales. Click a row to drill into per-creator status.
        </p>
      </div>


      {/* Filters */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search campaign or brand..."
          style={{
            flex: "1 1 240px", maxWidth: 320, height: 34, padding: "0 12px",
            borderRadius: 8, border: `1px solid ${theme.border}`,
            background: theme.surface, color: theme.text, fontSize: 13, outline: "none",
          }}
        />
        {[
          ["all", "All"],
          ["no-applications", "No applications"],
          ["stuck-shipping", "Stuck shipping"],
          ["no-sales", "No sales yet"],
        ].map(([k, label]) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            style={{
              height: 34, padding: "0 12px", borderRadius: 8, fontSize: 12, fontWeight: 500,
              border: `1px solid ${filter === k ? theme.text : theme.border}`,
              background: filter === k ? theme.text : theme.surface,
              color: filter === k ? theme.surface : theme.textMid,
              cursor: "pointer", transition: "all 0.12s",
            }}
          >{label}</button>
        ))}
      </div>

      {/* Campaigns table */}
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", minWidth: totalWidth, borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed" }}>
            <colgroup>
              {COLUMNS.map((c) => (
                <col key={c.key} style={{ width: widths[c.key] || c.width }} />
              ))}
            </colgroup>
            <thead>
              <tr style={{ background: theme.bg }}>
                <Th theme={theme}></Th>
                <Th theme={theme} sortKey="campaign_name"     sortBy={sortBy} sortDir={sortDir} onSort={handleSort} resize={{ colKey: "campaign_name", startResize, resetWidth }}>Campaign</Th>
                <Th theme={theme} sortKey="brand_name"        sortBy={sortBy} sortDir={sortDir} onSort={handleSort} resize={{ colKey: "brand_name", startResize, resetWidth }}>Brand</Th>
                <Th theme={theme} num sortKey="creators_invited"  sortBy={sortBy} sortDir={sortDir} onSort={handleSort} resize={{ colKey: "creators_invited", startResize, resetWidth }}>Invited</Th>
                <Th theme={theme} num sortKey="creators_applied"  sortBy={sortBy} sortDir={sortDir} onSort={handleSort} resize={{ colKey: "creators_applied", startResize, resetWidth }}>Applied</Th>
                <Th theme={theme} num sortKey="creators_accepted" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} resize={{ colKey: "creators_accepted", startResize, resetWidth }}>Accepted</Th>
                <Th theme={theme} num sortKey="samples_accepted"  sortBy={sortBy} sortDir={sortDir} onSort={handleSort} resize={{ colKey: "samples_accepted", startResize, resetWidth }}>Sample acc.</Th>
                <Th theme={theme} num sortKey="products_shipped"  sortBy={sortBy} sortDir={sortDir} onSort={handleSort} resize={{ colKey: "products_shipped", startResize, resetWidth }}>Shipped</Th>
                <Th theme={theme} num sortKey="clicks"            sortBy={sortBy} sortDir={sortDir} onSort={handleSort} resize={{ colKey: "clicks", startResize, resetWidth }}>Clicks</Th>
                <Th theme={theme} num sortKey="sales"             sortBy={sortBy} sortDir={sortDir} onSort={handleSort} resize={{ colKey: "sales", startResize, resetWidth }}>Sales</Th>
                <Th theme={theme}     sortKey="bottleneck"        sortBy={sortBy} sortDir={sortDir} onSort={handleSort} resize={{ colKey: "bottleneck", startResize, resetWidth }}>Bottleneck</Th>
              </tr>
              {/* Per-column filter row (server-side) */}
              <tr style={{ background: theme.bg }}>
                <td />
                <td style={{ padding: "0 12px 10px" }}>
                  <ColumnFilter
                    theme={theme}
                    placeholder="Filter campaign…"
                    value={filters.campaign_name || ""}
                    onCommit={(v) => handleFilter("campaign_name", v)}
                  />
                </td>
                <td style={{ padding: "0 12px 10px" }}>
                  <ColumnFilter
                    theme={theme}
                    placeholder="Filter brand…"
                    value={filters.brand_name || ""}
                    onCommit={(v) => handleFilter("brand_name", v)}
                  />
                </td>
                <td colSpan={8} />
              </tr>
            </thead>
            <tbody>
              {loading && <SkeletonTableRows rows={8} cols={11} theme={theme} />}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={11} style={{ padding: 24, textAlign: "center", color: theme.textMuted }}>No campaigns match.</td></tr>
              )}
              {filtered.map((c) => {
                const isOpen = expandedId === c.id;
                const bottleneck = computeBottleneck(c);
                return (
                  <CampaignRows key={c.id}>
                    <tr
                      onClick={() => toggleExpand(c.id)}
                      style={{
                        borderTop: `1px solid ${theme.border}`,
                        cursor: "pointer",
                        background: isOpen ? theme.accentLight : "transparent",
                        transition: "background 0.12s",
                      }}
                      onMouseEnter={(e) => { if (!isOpen) e.currentTarget.style.background = theme.accentLight; }}
                      onMouseLeave={(e) => { if (!isOpen) e.currentTarget.style.background = "transparent"; }}
                    >
                      <Td theme={theme} style={{ width: 28, color: theme.textMuted }}>
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" style={{ transition: "transform 0.15s", transform: isOpen ? "rotate(90deg)" : "rotate(0deg)" }}>
                          <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </Td>
                      <Td theme={theme} style={{ fontWeight: 500, color: theme.text }}>{c.campaign_name || <em style={{ color: theme.textMuted }}>Untitled</em>}</Td>
                      <Td theme={theme}>{c.brand_name || "—"}</Td>
                      <Td theme={theme} num>{friendlyNumber(c.creators_invited)}</Td>
                      <Td theme={theme} num>{friendlyNumber(c.creators_applied)}</Td>
                      <Td theme={theme} num>{friendlyNumber(c.creators_accepted)}</Td>
                      <Td theme={theme} num>{friendlyNumber(c.samples_accepted)}</Td>
                      <Td theme={theme} num>{friendlyNumber(c.products_shipped)}</Td>
                      <Td theme={theme} num>{friendlyNumber(c.clicks)}</Td>
                      <Td theme={theme} num style={{ fontWeight: c.sales > 0 ? 600 : 400, color: c.sales > 0 ? theme.text : theme.textMuted }}>{friendlyNumber(c.sales)}</Td>
                      <Td theme={theme}>
                        {bottleneck ? <BottleneckBadge theme={theme} mode={mode} label={bottleneck.label} tone={bottleneck.tone} /> : <span style={{ color: theme.textMuted }}>—</span>}
                      </Td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={11} style={{ padding: 0, background: mode === "dark" ? "#0d0d0d" : "#FAFAFA", borderTop: `1px solid ${theme.border}` }}>
                          <CreatorTable
                            theme={theme}
                            mode={mode}
                            creators={creatorsById[c.id]}
                            loading={creatorsLoading && !creatorsById[c.id]}
                          />
                        </td>
                      </tr>
                    )}
                  </CampaignRows>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Pagination */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 12, fontSize: 12, color: theme.textMuted }}>
        <div>
          {total === 0 ? "0 campaigns" : (
            <>Showing <b style={{ color: theme.text }}>{page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)}</b> of <b style={{ color: theme.text }}>{total.toLocaleString()}</b></>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <PageBtn theme={theme} onClick={() => setPage(0)} disabled={page === 0}>«</PageBtn>
          <PageBtn theme={theme} onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>‹ Prev</PageBtn>
          <span style={{ padding: "0 8px" }}>Page {page + 1} of {totalPages}</span>
          <PageBtn theme={theme} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}>Next ›</PageBtn>
          <PageBtn theme={theme} onClick={() => setPage(totalPages - 1)} disabled={page >= totalPages - 1}>»</PageBtn>
        </div>
      </div>
    </div>
  );
}

function PageBtn({ theme, onClick, disabled, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        height: 30, padding: "0 10px", borderRadius: 6,
        border: `1px solid ${theme.border}`,
        background: theme.surface, color: disabled ? theme.textMuted : theme.text,
        fontSize: 12, fontWeight: 500, cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1, transition: "all 0.12s",
      }}
    >{children}</button>
  );
}

function CampaignRows({ children }) {
  return <>{children}</>;
}

function computeBottleneck(c) {
  const invited = Number(c.creators_invited || 0);
  const applied = Number(c.creators_applied || 0);
  const accepted = Number(c.creators_accepted || 0);
  const samplesAccepted = Number(c.samples_accepted || 0);
  const shipped = Number(c.products_shipped || 0);
  const sales = Number(c.sales || 0);
  if (applied === 0 && invited === 0) return { label: "No outreach", tone: "warn" };
  if (applied === 0) return { label: "Awaiting invite responses", tone: "info" };
  if (accepted === 0) return { label: "No acceptances", tone: "warn" };
  if (samplesAccepted > 0 && shipped < samplesAccepted) return { label: "Brand: accepted, not shipped", tone: "danger" };
  if (shipped < accepted) return { label: "Brand: not shipping", tone: "danger" };
  if (sales === 0) return { label: "Content: no sales", tone: "info" };
  return null;
}

function BottleneckBadge({ theme, mode, label, tone }) {
  const palette = {
    danger: { bg: "#FEE2E2", fg: "#991B1B", bgDark: "#3F1313", fgDark: "#FCA5A5" },
    warn:   { bg: "#FEF3C7", fg: "#92400E", bgDark: "#3B2A0E", fgDark: "#FCD34D" },
    info:   { bg: "#DBEAFE", fg: "#1E40AF", bgDark: "#0F2547", fgDark: "#93C5FD" },
  }[tone] || { bg: theme.accentLight, fg: theme.text };
  return (
    <span style={{
      display: "inline-block", padding: "3px 8px", borderRadius: 12,
      fontSize: 11, fontWeight: 600, whiteSpace: "nowrap",
      background: mode === "dark" ? palette.bgDark : palette.bg,
      color: mode === "dark" ? palette.fgDark : palette.fg,
    }}>{label}</span>
  );
}

function CreatorTable({ theme, mode, creators, loading }) {
  if (loading) return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <Skeleton width={180} height={12} />
            <Skeleton width={70} height={18} radius={12} />
            <Skeleton width={50} height={12} />
            <Skeleton width={50} height={12} />
            <Skeleton width={40} height={12} />
            <Skeleton width={40} height={12} />
          </div>
        ))}
      </div>
    </div>
  );
  if (!creators) return null;
  if (creators.error) return <div style={{ padding: 16, color: theme.text }}>Error: {creators.error}</div>;
  if (creators.length === 0) return <div style={{ padding: 24, textAlign: "center", color: theme.textMuted }}>No creators yet for this campaign.</div>;

  return (
    <div style={{ padding: "12px 16px 16px" }}>
      {/* Stage funnel summary */}
      <StageFunnel theme={theme} mode={mode} creators={creators} />

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 10 }}>
        <thead>
          <tr style={{ color: theme.textMuted, textAlign: "left" }}>
            <Th theme={theme} sub>Creator</Th>
            <Th theme={theme} sub>Source</Th>
            <Th theme={theme} sub>Status</Th>
            <Th theme={theme} sub>Sample status</Th>
            <Th theme={theme} sub num>Clicks</Th>
            <Th theme={theme} sub num>Sales</Th>
          </tr>
        </thead>
        <tbody>
          {creators.map((cr) => (
            <tr key={cr.link_id} style={{ borderTop: `1px solid ${theme.border}` }}>
              <Td theme={theme} style={{ color: theme.text, fontWeight: 500 }}>
                {cr.creator_name}
                {cr.instagram_username && (
                  <span style={{ marginLeft: 6, color: theme.textMuted, fontWeight: 400 }}>@{cr.instagram_username}</span>
                )}
              </Td>
              <Td theme={theme}><SourceBadge theme={theme} source={cr.source} /></Td>
              <Td theme={theme}><StatusPill theme={theme} mode={mode} status={cr.status} /></Td>
              <Td theme={theme}>{cr.source === "external" ? <span style={{ color: theme.textMuted }}>—</span> : <SampleStatus theme={theme} v={cr.sample_request_status} />}</Td>
              <Td theme={theme} num>{cr.source === "external" ? <span style={{ color: theme.textMuted }}>—</span> : friendlyNumber(cr.clicks)}</Td>
              <Td theme={theme} num style={{ fontWeight: cr.sales > 0 ? 600 : 400, color: cr.sales > 0 ? theme.text : theme.textMuted }}>{cr.source === "external" ? "—" : friendlyNumber(cr.sales)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StageFunnel({ theme, mode, creators }) {
  const counts = STAGES.reduce((acc, s) => ({ ...acc, [s]: 0 }), {});
  // External (email-invited, not-yet-Linkable) creators count in every stage like
  // everyone else; we track their share separately just for the footnote.
  const ext = { Invited: 0, Applied: 0 };
  for (const c of creators) {
    // Invited (brand-initiated) and Applied (creator-initiated) are parallel sources;
    // a creator is in exactly one. Both converge at Accepted, which the linear funnel
    // continues from.
    if (c.status === "Invited") counts.Invited += 1;
    else counts.Applied += 1;
    if (c.source === "external") {
      if (c.status === "Invited") ext.Invited += 1;
      else ext.Applied += 1;
    }
    if (["Accepted", "Sample Accepted", "Shipped", "Sold"].includes(c.status)) counts.Accepted += 1;
    if (["Sample Accepted", "Shipped", "Sold"].includes(c.status)) counts["Sample Accepted"] += 1;
    if (["Shipped", "Sold"].includes(c.status)) counts.Shipped += 1;
    if (c.status === "Sold") counts.Sold += 1;
  }
  const extParts = [
    ext.Invited > 0 && `${ext.Invited} invited`,
    ext.Applied > 0 && `${ext.Applied} applied`,
  ].filter(Boolean);

  const linearStages = ["Accepted", "Sample Accepted", "Shipped", "Sold"];
  const pillStyle = (s) => ({
    display: "inline-flex", alignItems: "center", gap: 6,
    padding: "4px 10px", borderRadius: 14,
    background: mode === "dark" ? STATUS_COLORS[s].bgDark : STATUS_COLORS[s].bg,
    color: mode === "dark" ? STATUS_COLORS[s].fgDark : STATUS_COLORS[s].fg,
    fontSize: 11, fontWeight: 600,
    whiteSpace: "nowrap",
  });

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
          <span style={pillStyle("Invited")}>Invited <span style={{ opacity: 0.8 }}>· {counts.Invited}</span></span>
          <span style={pillStyle("Applied")}>Applied <span style={{ opacity: 0.8 }}>· {counts.Applied}</span></span>
        </div>
        <EntryMergeConnector color={theme.textMuted} />

        {linearStages.map((s, i) => (
          <div key={s} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={pillStyle(s)}>{s} <span style={{ opacity: 0.8 }}>· {counts[s]}</span></span>
            {i < linearStages.length - 1 && <span style={{ color: theme.textMuted }}>→</span>}
          </div>
        ))}
      </div>
      {extParts.length > 0 && (
        <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 6 }}>
          Includes external creators (invited by email, not yet on Linkable): {extParts.join(" · ")}
        </div>
      )}
    </div>
  );
}

function EntryMergeConnector({ color }) {
  // Two curves from the entry pills (left, top and bottom) converge into a short
  // horizontal segment with a chevron, pointing into the Accepted pill on the right.
  return (
    <svg width="36" height="48" viewBox="0 0 36 48" fill="none" style={{ flexShrink: 0 }} aria-hidden="true">
      <path d="M 0 12 Q 18 12, 24 24" stroke={color} strokeWidth="1.5" fill="none" strokeLinecap="round" />
      <path d="M 0 36 Q 18 36, 24 24" stroke={color} strokeWidth="1.5" fill="none" strokeLinecap="round" />
      <path d="M 24 24 L 30 24" stroke={color} strokeWidth="1.5" fill="none" strokeLinecap="round" />
      <path d="M 28 21 L 32 24 L 28 27" stroke={color} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StatusPill({ theme, mode, status }) {
  const c = STATUS_COLORS[status] || { bg: theme.accentLight, fg: theme.text, bgDark: theme.accentLight, fgDark: theme.text };
  return (
    <span style={{
      display: "inline-block", padding: "3px 8px", borderRadius: 12,
      fontSize: 11, fontWeight: 600,
      background: mode === "dark" ? c.bgDark : c.bg,
      color: mode === "dark" ? c.fgDark : c.fg,
    }}>{status}</span>
  );
}

function SourceBadge({ theme, source }) {
  const isExt = source === "external";
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 10,
      fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4,
      border: `1px solid ${theme.border}`,
      color: isExt ? theme.textMuted : theme.textMid,
      background: isExt ? "transparent" : theme.accentLight,
    }}>{isExt ? "External" : "Platform"}</span>
  );
}

function YN({ theme, v }) {
  return v
    ? <span style={{ color: theme.text, fontWeight: 500 }}>Yes</span>
    : <span style={{ color: theme.textMuted }}>—</span>;
}

function SampleStatus({ theme, v }) {
  if (!v) return <span style={{ color: theme.textMuted }}>—</span>;
  const label = v.charAt(0).toUpperCase() + v.slice(1);
  return <span style={{ color: theme.text, fontWeight: 500 }}>{label}</span>;
}

function Th({ children, theme, num, sub, sortKey, sortBy, sortDir, onSort, resize }) {
  const isSortable = !!sortKey && !!onSort;
  const isActive = isSortable && sortBy === sortKey;
  const arrow = !isActive ? "" : (sortDir === "asc" ? " ↑" : " ↓");
  const baseStyle = {
    position: "relative", // anchor for the ResizeHandle
    textAlign: num ? "right" : "left",
    padding: sub ? "8px 10px" : "12px 12px",
    fontSize: sub ? 10 : 11, fontWeight: 600,
    textTransform: "uppercase", letterSpacing: 0.5,
    color: isActive ? theme.text : theme.textMuted,
    cursor: isSortable ? "pointer" : "default",
    userSelect: "none",
    whiteSpace: "nowrap",
  };
  return (
    <th
      style={baseStyle}
      onClick={isSortable ? () => onSort(sortKey) : undefined}
      onMouseEnter={isSortable ? (e) => { e.currentTarget.style.color = theme.text; } : undefined}
      onMouseLeave={isSortable ? (e) => { e.currentTarget.style.color = isActive ? theme.text : theme.textMuted; } : undefined}
    >
      {children}{arrow}
      {resize && (
        /* Swallow clicks from the handle so drag/reset never triggers the header sort. */
        <span onClick={(e) => e.stopPropagation()}>
          <ResizeHandle colKey={resize.colKey} startResize={resize.startResize} resetWidth={resize.resetWidth} theme={theme} />
        </span>
      )}
    </th>
  );
}

function Td({ children, theme, num, style = {} }) {
  return (
    <td style={{
      padding: "12px 12px",
      textAlign: num ? "right" : "left",
      color: theme.textMid,
      wordBreak: "break-word",
      verticalAlign: "top",
      ...style,
    }}>{children}</td>
  );
}

function Kpi({ theme, label, value, highlight }) {
  return (
    <div style={{
      background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 10,
      padding: "12px 14px",
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textMuted }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: highlight ? theme.text : theme.text, marginTop: 4 }}>{friendlyNumber(value)}</div>
    </div>
  );
}

function Spinner({ theme, label }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "60vh" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ width: 24, height: 24, border: `2.5px solid ${theme.border}`, borderTopColor: theme.text, borderRadius: "50%", animation: "spin 0.6s linear infinite", margin: "0 auto" }} />
        <p style={{ color: theme.textMuted, marginTop: 12, fontSize: 13 }}>{label}</p>
      </div>
    </div>
  );
}
