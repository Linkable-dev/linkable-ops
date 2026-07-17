import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { useTheme } from "../contexts/ThemeContext";
import { api, friendlyName, friendlyDate, friendlyNumber } from "../lib/api";
import { Pagination } from "../components/ui/Pagination";
import { Btn } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import RecordForm from "./RecordForm";
import { Skeleton } from "../components/ui/Skeleton";

// Columns to hide from table view (sensitive, internal, or not useful)
const HIDDEN_COLUMNS = new Set([
  "password_hash", "password_reset_otp", "activation_code_hash",
  "shopify_token", "shopify_storefront", "facebook_token",
  "stripe_account_id", "stripe_customer_id", "stripe_transfer_id",
  "default_payment_method_id", "payment_intent_id", "transfer_id", "transfer_group",
  "token", "verifier", "sub", "account_id",
  "raw_api_response", "original_invitation_data",
  "instagram_posts_data", "feed_preview_urls",
  "hashtags", "hashtag_frequencies", "lookalikes",
  "language_codes", "language_confidence", "links_in_bio",
]);

// Column name patterns to hide
const HIDDEN_PATTERNS = [/token$/i, /secret$/i, /hash$/i, /_otp$/i];

function shouldHideColumn(col) {
  if (col.is_primary_key) return true;
  if (col.data_type === "uuid" && !col.fk) return true;
  const n = col.column_name.toLowerCase();
  if (HIDDEN_COLUMNS.has(n)) return true;
  if (HIDDEN_PATTERNS.some((p) => p.test(n))) return true;
  // Hide deleted/updated timestamps
  if (n === "deleted" || n === "updated") return true;
  return false;
}

// Smart column ordering: name/label first, then meaningful text, numbers, FKs, booleans, dates last
function sortColumns(cols) {
  const priority = (c) => {
    const n = c.column_name.toLowerCase();
    if (n === "name" || n === "title" || n === "full_name" || n === "display_name" || n === "label" || n === "store_name") return 0;
    if (n === "first_name" || n === "last_name") return 1;
    if (n.endsWith("_name") || n.endsWith("_title")) return 2;
    if (n === "email" || n.endsWith("_email")) return 3;
    if (n === "username" || n.endsWith("_username")) return 4;
    if (n === "status" || n.endsWith("_status") || n === "role" || n === "type") return 5;
    if (c.fk) return 6;
    if (n === "description" || n === "about" || n === "message" || n === "reason") return 10;
    if (["text", "character varying", "varchar"].includes(c.data_type)) return 7;
    if (["integer", "bigint", "numeric", "real", "double precision", "smallint"].includes(c.data_type)) return 8;
    if (c.data_type === "boolean") return 9;
    if (c.data_type.includes("timestamp") || c.data_type === "date") return 11;
    if (c.data_type === "json" || c.data_type === "jsonb") return 12;
    return 8;
  };
  return [...cols].sort((a, b) => priority(a) - priority(b));
}

export default function TablePage() {
  const { table } = useParams();
  const { theme, mode } = useTheme();

  const [schema, setSchema] = useState([]);
  const [data, setData] = useState({ rows: [], total: 0, page: 1, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("");
  const [sortDir, setSortDir] = useState("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [filters, setFilters] = useState({});
  const [showFilters, setShowFilters] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [fkLabels, setFkLabels] = useState({});
  // Column widths: { colName: width }
  const [colWidths, setColWidths] = useState({});
  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editId, setEditId] = useState(null); // null = new, value = editing
  // FK options for filter dropdowns
  const [fkFilterOptions, setFkFilterOptions] = useState({});

  const pk = schema.find((c) => c.is_primary_key)?.column_name;
  const displayableCols = sortColumns(schema.filter((c) => !shouldHideColumn(c)));
  const visibleCols = displayableCols.slice(0, 10);
  const hasMore = displayableCols.length > 10;

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: pageSize, filters };
      if (search) params.search = search;
      if (sortBy) { params.sortBy = sortBy; params.sortDir = sortDir; }
      const [schemaRes, rowsRes] = await Promise.all([
        api.getSchema(table),
        api.getRows(table, params),
      ]);
      setSchema(schemaRes);
      setData(rowsRes);

      // Resolve FK labels
      const fkCols = schemaRes.filter((c) => c.fk);
      if (fkCols.length > 0 && rowsRes.rows.length > 0) {
        const labels = {};
        await Promise.all(fkCols.map(async (col) => {
          const ids = rowsRes.rows.map((r) => r[col.column_name]).filter(Boolean);
          if (ids.length === 0) return;
          try { labels[col.column_name] = await api.resolveFks(col.fk.refTable, ids); } catch {}
        }));
        setFkLabels(labels);
      } else {
        setFkLabels({});
      }

      // Load FK options for FK column filters
      if (fkCols.length > 0) {
        const opts = {};
        await Promise.all(fkCols.map(async (col) => {
          try { opts[col.column_name] = await api.getFkOptions(col.fk.refTable); } catch {}
        }));
        setFkFilterOptions(opts);
      }
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }, [table, page, pageSize, search, sortBy, sortDir, filters]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => {
    setSearch(""); setSortBy(""); setSortDir("asc"); setPage(1);
    setFilters({}); setShowFilters(false); setFkLabels({}); setColWidths({});
  }, [table]);
  // Selection is page/filter scoped — clear it whenever the visible row set changes
  useEffect(() => { setSelectedIds(new Set()); }, [table, page, pageSize, search, sortBy, sortDir, filters]);

  const handleSort = (col) => {
    if (sortBy === col) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortBy(col); setSortDir("asc"); }
    setPage(1);
  };

  const handleFilter = (key, val) => {
    setFilters((prev) => {
      const next = { ...prev, [key]: val };
      if (!val) delete next[key];
      return next;
    });
    setPage(1);
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    setDeleting(deleteConfirm);
    try { await api.deleteRow(table, deleteConfirm); setDeleteConfirm(null); fetchData(); }
    catch (err) { console.error(err); }
    finally { setDeleting(null); }
  };

  const toggleRowSelected = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const pageRowIds = pk ? data.rows.map((r) => r[pk]) : [];
  const allPageSelected = pageRowIds.length > 0 && pageRowIds.every((id) => selectedIds.has(id));
  const toggleSelectAllOnPage = () => {
    setSelectedIds((prev) => {
      if (allPageSelected) {
        const next = new Set(prev);
        pageRowIds.forEach((id) => next.delete(id));
        return next;
      }
      return new Set([...prev, ...pageRowIds]);
    });
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    setBulkDeleting(true);
    try {
      await api.deleteRows(table, [...selectedIds]);
      setBulkDeleteConfirm(false);
      setSelectedIds(new Set());
      fetchData();
    } catch (err) { console.error(err); }
    finally { setBulkDeleting(false); }
  };

  const openNew = () => { setEditId(null); setModalOpen(true); };
  const openEdit = (id) => { setEditId(id); setModalOpen(true); };
  const closeModal = () => { setModalOpen(false); setEditId(null); };
  const onSaved = () => { closeModal(); fetchData(); };

  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  // Column resize
  const resizeRef = useRef(null);
  const startResize = (colName, e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidths[colName] || 160;
    const onMove = (ev) => {
      const diff = ev.clientX - startX;
      setColWidths((prev) => ({ ...prev, [colName]: Math.max(80, startW + diff) }));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const sortIcon = (col) => {
    if (sortBy !== col) return (
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke={theme.textMuted} strokeWidth="2" strokeLinecap="round" style={{ opacity: 0.3 }}>
        <path d="M4 6l4-3 4 3M4 10l4 3 4-3" />
      </svg>
    );
    return sortDir === "asc" ? (
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke={theme.text} strokeWidth="2" strokeLinecap="round"><path d="M4 10l4-4 4 4" /></svg>
    ) : (
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke={theme.text} strokeWidth="2" strokeLinecap="round"><path d="M4 6l4 4 4-4" /></svg>
    );
  };

  return (
    <div>
      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        {selectedIds.size > 0 ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: theme.text }}>
              {selectedIds.size.toLocaleString()} selected
            </div>
            <button onClick={() => setSelectedIds(new Set())} style={{
              padding: "5px 10px", borderRadius: 6, border: "none", fontSize: 12, fontWeight: 500,
              background: theme.accentLight, color: theme.textMid, cursor: "pointer", fontFamily: "inherit",
            }}>Clear</button>
            <button onClick={() => setBulkDeleteConfirm(true)} style={{
              display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 6,
              border: "none", fontSize: 12, fontWeight: 600, background: "#EF4444", color: "#fff",
              cursor: "pointer", fontFamily: "inherit",
            }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
              </svg>
              Delete Selected
            </button>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: theme.textMuted }}>
            {data.total.toLocaleString()} records &middot; {schema.length} columns
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={() => setShowFilters(!showFilters)} style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 14px",
            borderRadius: 8, border: `1.5px solid ${showFilters ? theme.text : theme.border}`,
            background: showFilters ? theme.accentLight : "transparent",
            color: showFilters ? theme.text : theme.textMid, fontSize: 12, fontWeight: 600,
            cursor: "pointer", fontFamily: "inherit",
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>
            </svg>
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
          </button>
          <Link to={`/tables/${table}/analytics`} style={{ textDecoration: "none" }}>
            <Btn variant="outline" size="sm">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
              </svg>
              Analytics
            </Btn>
          </Link>
          <Btn size="sm" onClick={openNew}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3v10M3 8h10"/></svg>
            Add Record
          </Btn>
        </div>
      </div>

      {/* Search */}
      <div style={{ position: "relative", maxWidth: 340, marginBottom: 16 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={theme.textMuted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)" }}>
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          type="text" value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search across all text fields..."
          style={{
            width: "100%", padding: "9px 13px 9px 36px",
            borderRadius: 8, border: `1.5px solid ${theme.border}`, background: theme.bg,
            color: theme.text, fontFamily: "inherit", fontSize: 13, outline: "none",
            transition: "background 0.2s, border-color 0.2s, color 0.2s",
          }}
        />
        {search && (
          <button onClick={() => { setSearch(""); setPage(1); }} style={{
            position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
            background: "none", border: "none", cursor: "pointer", color: theme.textMuted, padding: 4,
          }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
          </button>
        )}
      </div>

      {/* Smart Filters */}
      {showFilters && (
        <div style={{
          display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 16, padding: 16,
          background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 10,
        }}>
          {visibleCols.map((col) => (
            <FilterControl
              key={col.column_name} col={col} theme={theme} mode={mode}
              filters={filters} onFilter={handleFilter}
              fkOptions={fkFilterOptions[col.column_name]}
            />
          ))}
          {activeFilterCount > 0 && (
            <div style={{ display: "flex", alignItems: "flex-end" }}>
              <button onClick={() => setFilters({})} style={{
                padding: "6px 12px", borderRadius: 6, border: "none", fontSize: 12, fontWeight: 500,
                background: theme.accentLight, color: theme.textMid, cursor: "pointer", fontFamily: "inherit",
              }}>Clear all</button>
            </div>
          )}
        </div>
      )}

      {/* Table */}
      <div style={{
        background: theme.surface, border: `1px solid ${theme.border}`,
        borderRadius: 10, overflow: "hidden", boxShadow: theme.shadow,
      }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 13, width: "max-content", minWidth: "100%" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${theme.border}`, background: theme.surfaceAlt }}>
                {pk && (
                  <th style={{ padding: "10px 8px", width: 36, minWidth: 36 }}>
                    <input
                      type="checkbox"
                      checked={allPageSelected}
                      onChange={toggleSelectAllOnPage}
                      style={{ cursor: "pointer" }}
                    />
                  </th>
                )}
                {visibleCols.map((col) => (
                  <th key={col.column_name} style={{
                    textAlign: "left", padding: "10px 14px", fontSize: 11, fontWeight: 600,
                    color: theme.textMuted, textTransform: "capitalize", letterSpacing: 0.3,
                    cursor: "pointer", userSelect: "none", whiteSpace: "nowrap", position: "relative",
                    minWidth: colWidths[col.column_name] || 120,
                    maxWidth: colWidths[col.column_name] || 280,
                    width: colWidths[col.column_name] || undefined,
                  }} onClick={() => handleSort(col.column_name)}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      {friendlyName(col.fk ? col.column_name.replace(/_id$/, "") : col.column_name)}
                      {sortIcon(col.column_name)}
                    </span>
                    {/* Resize handle */}
                    <div
                      onMouseDown={(e) => startResize(col.column_name, e)}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        position: "absolute", right: 0, top: 0, bottom: 0, width: 8,
                        cursor: "col-resize", zIndex: 2,
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = theme.border}
                      onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                    />
                  </th>
                ))}
                {hasMore && <th style={{ padding: "10px 14px", fontSize: 11, color: theme.textMuted, minWidth: 60 }}>+{displayableCols.length - 10}</th>}
                <th style={{ padding: "10px 14px", textAlign: "right", fontSize: 11, fontWeight: 600, color: theme.textMuted, minWidth: 90, position: "sticky", right: 0, background: theme.surfaceAlt }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 10 }).map((_, r) => (
                  <tr key={`sk-${r}`} style={{ borderBottom: `1px solid ${theme.border}` }}>
                    {pk && <td />}
                    {visibleCols.map((col, c) => (
                      <td key={col.column_name} style={{ padding: "12px 14px" }}>
                        <Skeleton width={`${50 + ((r + c) * 11) % 45}%`} height={11} />
                      </td>
                    ))}
                    {hasMore && <td />}
                    <td />
                  </tr>
                ))
              ) : data.rows.length === 0 ? (
                <tr><td colSpan={visibleCols.length + (hasMore ? 2 : 1) + (pk ? 1 : 0)} style={{ textAlign: "center", padding: "48px 0", color: theme.textMuted, fontSize: 13 }}>No records found</td></tr>
              ) : data.rows.map((row, i) => {
                const id = pk ? row[pk] : i;
                return (
                  <tr key={id} style={{
                    borderBottom: `1px solid ${theme.border}`, transition: "background 0.1s",
                    background: pk && selectedIds.has(id) ? theme.accentLight : undefined,
                  }}
                    onMouseEnter={(e) => { if (!selectedIds.has(id)) e.currentTarget.style.background = theme.accentLight; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = pk && selectedIds.has(id) ? theme.accentLight : "transparent"; }}>
                    {pk && (
                      <td style={{ padding: "10px 8px" }}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(id)}
                          onChange={() => toggleRowSelected(id)}
                          style={{ cursor: "pointer" }}
                        />
                      </td>
                    )}
                    {visibleCols.map((col) => (
                      <td key={col.column_name} style={{
                        padding: "10px 14px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        minWidth: colWidths[col.column_name] || 120,
                        maxWidth: colWidths[col.column_name] || 280,
                      }}>
                        <CellValue
                          value={row[col.column_name]} type={col.data_type}
                          fk={col.fk} fkLabel={fkLabels[col.column_name]?.[String(row[col.column_name])]}
                          theme={theme} mode={mode}
                        />
                      </td>
                    ))}
                    {hasMore && <td style={{ padding: "10px 14px", color: theme.textMuted, fontSize: 11 }}>...</td>}
                    <td style={{ padding: "10px 14px", textAlign: "right", position: "sticky", right: 0, background: "inherit" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4 }}>
                        {pk && (
                          <>
                            <button onClick={() => openEdit(row[pk])} title="Edit" style={{
                              display: "flex", alignItems: "center", justifyContent: "center",
                              width: 28, height: 28, borderRadius: 6, color: theme.textMuted,
                              background: "transparent", border: "none", cursor: "pointer",
                              transition: "background 0.1s, color 0.1s",
                            }}
                              onMouseEnter={(e) => { e.currentTarget.style.background = theme.accentLight; e.currentTarget.style.color = theme.text; }}
                              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = theme.textMuted; }}
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                              </svg>
                            </button>
                            <button onClick={() => setDeleteConfirm(id)} title="Delete" style={{
                              display: "flex", alignItems: "center", justifyContent: "center",
                              width: 28, height: 28, borderRadius: 6, color: theme.textMuted,
                              background: "transparent", border: "none", cursor: "pointer",
                              transition: "background 0.1s, color 0.1s",
                            }}
                              onMouseEnter={(e) => { e.currentTarget.style.background = "#FEE2E2"; e.currentTarget.style.color = "#EF4444"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = theme.textMuted; }}
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                              </svg>
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {data.total > 0 && (
          <div style={{ borderTop: `1px solid ${theme.border}`, padding: "0 14px" }}>
            <Pagination page={page} pageSize={pageSize} total={data.total}
              onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }} />
          </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      <Modal open={deleteConfirm !== null} onClose={() => setDeleteConfirm(null)} title="Delete Record" width={420}>
        <div style={{ padding: "4px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10, flexShrink: 0,
              background: mode === "dark" ? "#3B1111" : "#FEF2F2",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>Are you sure?</div>
              <div style={{ fontSize: 13, color: theme.textMid, marginTop: 2 }}>
                This record will be permanently deleted. This action cannot be undone.
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, paddingTop: 12, borderTop: `1px solid ${theme.border}` }}>
            <Btn variant="outline" size="sm" onClick={() => setDeleteConfirm(null)}>Cancel</Btn>
            <button
              onClick={handleDelete}
              disabled={deleting}
              style={{
                padding: "7px 18px", borderRadius: 8, border: "none", fontSize: 12, fontWeight: 600,
                background: "#EF4444", color: "#fff", cursor: deleting ? "not-allowed" : "pointer",
                fontFamily: "inherit", opacity: deleting ? 0.7 : 1,
              }}
            >
              {deleting ? "Deleting..." : "Delete"}
            </button>
          </div>
        </div>
      </Modal>

      {/* Bulk Delete Confirmation Modal */}
      <Modal open={bulkDeleteConfirm} onClose={() => setBulkDeleteConfirm(false)} title="Delete Records" width={420}>
        <div style={{ padding: "4px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10, flexShrink: 0,
              background: mode === "dark" ? "#3B1111" : "#FEF2F2",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>Are you sure?</div>
              <div style={{ fontSize: 13, color: theme.textMid, marginTop: 2 }}>
                {selectedIds.size} record{selectedIds.size === 1 ? "" : "s"} will be permanently deleted. This action cannot be undone.
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, paddingTop: 12, borderTop: `1px solid ${theme.border}` }}>
            <Btn variant="outline" size="sm" onClick={() => setBulkDeleteConfirm(false)}>Cancel</Btn>
            <button
              onClick={handleBulkDelete}
              disabled={bulkDeleting}
              style={{
                padding: "7px 18px", borderRadius: 8, border: "none", fontSize: 12, fontWeight: 600,
                background: "#EF4444", color: "#fff", cursor: bulkDeleting ? "not-allowed" : "pointer",
                fontFamily: "inherit", opacity: bulkDeleting ? 0.7 : 1,
              }}
            >
              {bulkDeleting ? "Deleting..." : `Delete ${selectedIds.size}`}
            </button>
          </div>
        </div>
      </Modal>

      {/* Add / Edit Modal */}
      <Modal open={modalOpen} onClose={closeModal} title={editId ? `Edit Record` : `New Record`} width={580}>
        <RecordForm table={table} id={editId} onSaved={onSaved} onCancel={closeModal} />
      </Modal>
    </div>
  );
}

// ---- Type-aware filter controls ----
function FilterControl({ col, theme, mode, filters, onFilter, fkOptions }) {
  const name = col.column_name;
  const type = col.data_type;
  const label = friendlyName(col.fk ? name.replace(/_id$/, "") : name);

  const inputStyle = {
    width: "100%", boxSizing: "border-box", padding: "6px 10px", borderRadius: 6,
    border: `1px solid ${theme.border}`, background: theme.bg, color: theme.text,
    fontFamily: "inherit", fontSize: 12, outline: "none",
    transition: "background 0.2s, border-color 0.2s",
  };

  // Boolean → toggle buttons
  if (type === "boolean") {
    const val = filters[name];
    return (
      <div style={{ minWidth: 130 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: theme.textMuted, marginBottom: 4 }}>{label}</div>
        <div style={{ display: "flex", gap: 0, background: theme.surfaceAlt, borderRadius: 6, padding: 2 }}>
          {[["", "All"], ["true", "Yes"], ["false", "No"]].map(([v, l]) => (
            <button key={v} onClick={() => onFilter(name, v)} style={{
              flex: 1, padding: "4px 8px", borderRadius: 5, border: "none", fontSize: 11, fontWeight: (val || "") === v ? 600 : 400,
              background: (val || "") === v ? theme.surface : "transparent",
              color: (val || "") === v ? theme.text : theme.textMuted,
              cursor: "pointer", fontFamily: "inherit", boxShadow: (val || "") === v ? theme.shadow : "none",
            }}>{l}</button>
          ))}
        </div>
      </div>
    );
  }

  // FK → dropdown
  if (col.fk && fkOptions?.options) {
    return (
      <div style={{ minWidth: 160, flex: "1 1 160px", maxWidth: 240 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: theme.textMuted, marginBottom: 4 }}>{label}</div>
        <select
          value={filters[name] || ""}
          onChange={(e) => onFilter(name, e.target.value)}
          style={{ ...inputStyle, paddingRight: 28 }}
        >
          <option value="">All</option>
          {fkOptions.options.map((opt) => (
            <option key={opt.id} value={opt.id}>{opt.label || `#${opt.id}`}</option>
          ))}
        </select>
      </div>
    );
  }

  // Date → from / to
  if (type.includes("timestamp") || type === "date") {
    return (
      <div style={{ minWidth: 200, flex: "1 1 200px", maxWidth: 300 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: theme.textMuted, marginBottom: 4 }}>{label}</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            type="date"
            value={filters[`${name}_from`] || ""}
            onChange={(e) => onFilter(`${name}_from`, e.target.value)}
            style={{ ...inputStyle, flex: 1 }}
          />
          <span style={{ fontSize: 10, color: theme.textMuted }}>to</span>
          <input
            type="date"
            value={filters[`${name}_to`] || ""}
            onChange={(e) => onFilter(`${name}_to`, e.target.value)}
            style={{ ...inputStyle, flex: 1 }}
          />
        </div>
      </div>
    );
  }

  // Number → exact match
  if (["integer", "bigint", "smallint", "numeric", "real", "double precision"].includes(type)) {
    return (
      <div style={{ minWidth: 120, flex: "1 1 120px", maxWidth: 180 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: theme.textMuted, marginBottom: 4 }}>{label}</div>
        <input type="number" value={filters[name] || ""} onChange={(e) => onFilter(name, e.target.value)} placeholder="Exact..." style={inputStyle} />
      </div>
    );
  }

  // Text → search
  return (
    <div style={{ minWidth: 160, flex: "1 1 160px", maxWidth: 240 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: theme.textMuted, marginBottom: 4 }}>{label}</div>
      <input type="text" value={filters[name] || ""} onChange={(e) => onFilter(name, e.target.value)} placeholder="Contains..." style={inputStyle} />
    </div>
  );
}

// ---- Cell rendering ----
function CellValue({ value, type, fk, fkLabel, theme, mode }) {
  if (value === null || value === undefined) {
    return <span style={{ color: theme.textMuted, fontStyle: "italic", fontSize: 11 }}>—</span>;
  }
  if (fk && fkLabel) {
    return (
      <div style={{ lineHeight: 1.3 }}>
        <div style={{ fontSize: 13, color: theme.text, fontWeight: 500 }}>{fkLabel}</div>
        <div style={{ fontSize: 10, color: theme.textMuted, fontFamily: "monospace", marginTop: 1 }}>
          {String(value).length > 12 ? String(value).slice(0, 8) + "..." : value}
        </div>
      </div>
    );
  }
  if (fk && !fkLabel && value) {
    return (
      <div style={{ lineHeight: 1.3 }}>
        <div style={{ fontSize: 12, color: theme.textMuted, fontStyle: "italic" }}>Unknown</div>
        <div style={{ fontSize: 10, color: theme.textMuted, fontFamily: "monospace", marginTop: 1 }}>
          {String(value).length > 12 ? String(value).slice(0, 8) + "..." : value}
        </div>
      </div>
    );
  }
  if (typeof value === "boolean" || type === "boolean") {
    const bool = typeof value === "boolean" ? value : value === "true";
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 500, color: bool ? "#22C55E" : theme.textMuted }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: bool ? "#22C55E" : theme.border }} />
        {bool ? "Yes" : "No"}
      </span>
    );
  }
  if (type?.includes("timestamp") || type === "date") {
    const friendly = friendlyDate(value);
    const full = new Date(value);
    return <span style={{ color: theme.textMid, fontSize: 12 }} title={!isNaN(full) ? full.toLocaleString() : String(value)}>{friendly}</span>;
  }
  if (["integer", "bigint", "numeric", "real", "double precision", "smallint"].includes(type)) {
    return <span style={{ color: theme.text, fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>{friendlyNumber(value)}</span>;
  }
  if (type === "json" || type === "jsonb") {
    let preview;
    try {
      const obj = typeof value === "string" ? JSON.parse(value) : value;
      if (Array.isArray(obj)) preview = `[${obj.length} items]`;
      else if (typeof obj === "object") preview = `{${Object.keys(obj).length} fields}`;
      else preview = String(obj);
    } catch { preview = String(value).slice(0, 40); }
    return <span style={{ color: theme.textMid, fontSize: 11, background: theme.surfaceAlt, padding: "2px 6px", borderRadius: 4 }}>{preview}</span>;
  }
  if (type === "uuid" || (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}/.test(value))) {
    return <span style={{ color: theme.textMuted, fontSize: 11, fontFamily: "monospace" }} title={value}>{value.slice(0, 8)}...</span>;
  }
  const str = String(value);
  return <span style={{ color: theme.text }} title={str.length > 50 ? str : undefined}>{str.length > 50 ? str.slice(0, 50) + "..." : str}</span>;
}
