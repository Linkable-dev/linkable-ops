import { useState, useEffect, useCallback, useRef } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api, friendlyDate } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Label } from "../components/ui/Label";
import { Select } from "../components/ui/Select";
import { Tag } from "../components/ui/Tag";
import { SkeletonTable } from "../components/ui/Skeleton";
import { Modal } from "../components/ui/Modal";
import {
  useColumnWidths,
  SortLabel,
  nextSort,
  ColumnFilter,
  ResizeHandle,
  HeaderCell,
  headerCellStyle,
} from "../components/table/tableTools";

// Pitch brands: the external brands creators pitch from Discover.
//
// Adding one takes an Instagram handle or a store address. The request is
// written here and service-grpc reads the rest within seconds (the store,
// logo, products, contact email, signals, follower counts), so the page polls
// the recent requests until each one says Added, Updated or Failed.

const PAGE = 25;
const POLL_MS = 3000;

const COLUMNS = [
  { key: "brand", label: "Brand", width: 280, sort: "asc", sortField: "name",
    filter: { type: "text", field: "name", placeholder: "Name, store or handle…" } },
  { key: "instagram", label: "Instagram", width: 120, sort: "desc", sortField: "instagram_followers",
    filter: { type: "number", field: "instagram_followers" } },
  { key: "tiktok", label: "TikTok", width: 100, sort: "desc", sortField: "tiktok_followers" },
  { key: "youtube", label: "YouTube", width: 100, sort: "desc", sortField: "youtube_followers" },
  { key: "contact", label: "Contact", width: 230,
    filter: { type: "text", field: "contact_email", placeholder: "Email…" } },
  { key: "category", label: "Category", width: 170, sort: "asc", sortField: "category",
    filter: { type: "text", field: "category", placeholder: "Category…" } },
  { key: "signals", label: "Signals", width: 200 },
  { key: "source", label: "Source", width: 110, sort: "asc", sortField: "source",
    filter: { type: "text", field: "source", placeholder: "Source…" } },
  { key: "added", label: "Added", width: 110, sort: "desc", sortField: "created",
    filter: { type: "date", field: "created" } },
  { key: "actions", label: "Actions", width: 220 },
];
const DEFAULT_WIDTHS = Object.fromEntries(COLUMNS.map((c) => [c.key, c.width]));

const SOURCE_LABEL = { ops: "Ops", instagram_dm: "Instagram DMs", import: "Import", creator: "A creator", detected: "Detected", linkable: "Linkable", ugc_call: "UGC call" };

const STATUS = {
  pending: { label: "Waiting", color: "#737C9A" },
  working: { label: "Reading the store…", color: "#2563EB" },
  added: { label: "Added", color: "#16A34A" },
  updated: { label: "Already listed, refreshed", color: "#0D9488" },
  failed: { label: "Couldn't add", color: "#B91C1C" },
};

// 120000 -> "120K"; "" when not known.
function count(n) {
  const v = Number(n) || 0;
  if (v <= 0) return "";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 100_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(v);
}

function Logo({ src, name, size = 32, t }) {
  const [broken, setBroken] = useState(false);
  const box = { width: size, height: size, borderRadius: size / 2, border: `1px solid ${t.border}`, background: "#fff", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", fontSize: 11, fontWeight: 600, color: t.textMid };
  if (!src || broken) return <div style={box}>{(name || "?").trim().charAt(0).toUpperCase()}</div>;
  return <div style={box}><img src={src} alt="" onError={() => setBroken(true)} style={{ width: "100%", height: "100%", objectFit: "contain", padding: 3, boxSizing: "border-box" }} /></div>;
}

function renderCell(key, b, { t, categories, link, busy, onEdit, onRefresh, onRemove }) {
  switch (key) {
    case "actions":
      // Header left, the row's actions grouped on the right.
      return (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          {b.on_linkable ? (
            <span style={{ fontSize: 12, color: t.textMuted }} title="Its details come from its Linkable account.">From its Linkable account</span>
          ) : (
            <>
              <button style={{ ...link, borderRadius: "6px 0 0 6px" }} onClick={() => onEdit(b)}>Edit</button>
              <button style={{ ...link, marginLeft: -1, borderRadius: 0 }} disabled={busy === b.id} onClick={() => onRefresh(b)}>{busy === b.id ? "Refreshing…" : "Refresh"}</button>
              <button style={{ ...link, marginLeft: -1, borderRadius: "0 6px 6px 0", color: "#B91C1C" }} onClick={() => onRemove(b)}>Remove</button>
            </>
          )}
        </div>
      );
    case "brand":
      return (
        <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
          <Logo src={b.logo_url} name={b.name} t={t} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {b.name}{b.on_linkable && <span style={{ marginLeft: 6 }}><Tag color="#2563EB">On Linkable</Tag></span>}
            </div>
            <a href={`https://${b.domain}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: t.textMuted, textDecoration: "none" }}>{b.domain}</a>
          </div>
        </div>
      );
    case "instagram":
      return b.instagram ? (
        <a href={`https://instagram.com/${b.instagram}`} target="_blank" rel="noopener noreferrer" style={{ color: t.text, textDecoration: "none" }} title={`@${b.instagram}`}>
          {count(b.instagram_followers) || `@${b.instagram}`}
        </a>
      ) : <span style={{ color: t.textMuted }}>—</span>;
    case "tiktok":
      return b.tiktok && count(b.tiktok_followers)
        ? <a href={`https://www.tiktok.com/@${b.tiktok}`} target="_blank" rel="noopener noreferrer" style={{ color: t.text, textDecoration: "none" }}>{count(b.tiktok_followers)}</a>
        : <span style={{ color: t.textMuted }}>—</span>;
    case "youtube":
      return b.youtube && count(b.youtube_followers)
        ? <a href={b.youtube} target="_blank" rel="noopener noreferrer" style={{ color: t.text, textDecoration: "none" }}>{count(b.youtube_followers)}</a>
        : <span style={{ color: t.textMuted }}>—</span>;
    case "contact":
      return b.contact_email ? (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", maxWidth: "100%" }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.contact_email}</span>
          {b.contact_verified && <span title="Verified" style={{ color: "#16A34A" }}>✓</span>}
        </span>
      ) : <span style={{ color: t.textMuted }}>No email found</span>;
    case "category":
      return categories[b.category] || <span style={{ color: t.textMuted }}>—</span>;
    case "signals": {
      const parts = [];
      if (b.latest_product_title && b.latest_product_at && Date.now() - new Date(b.latest_product_at).getTime() < 60 * 86_400_000) parts.push("New launch");
      if (b.program_kind) parts.push(`${b.program_kind[0].toUpperCase()}${b.program_kind.slice(1)} program`);
      return parts.length ? <span style={{ color: t.textMid }}>{parts.join(" · ")}</span> : <span style={{ color: t.textMuted }}>—</span>;
    }
    case "source":
      return <span style={{ color: t.textMid }}>{SOURCE_LABEL[b.source] || b.source}</span>;
    case "added":
      return <span style={{ color: t.textMuted, whiteSpace: "nowrap" }}>{friendlyDate(b.created)}</span>;
    default:
      return null;
  }
}

export default function PitchBrandsPage() {
  const { theme: t } = useTheme();
  const [available, setAvailable] = useState(true);
  const [categories, setCategories] = useState({});
  const [categoryOptions, setCategoryOptions] = useState([]);

  // Add a brand
  const [input, setInput] = useState("");
  const [email, setEmail] = useState("");
  const [category, setCategory] = useState("");
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState(null);

  // Recent requests
  const [requests, setRequests] = useState([]);
  const waitingRef = useRef(false);

  // The brand list
  const [brands, setBrands] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sort, setSort] = useState({ sortBy: "", sortDir: "desc" });
  const [colFilters, setColFilters] = useState({});
  const { widths, startResize, resetWidth } = useColumnWidths("pitch-brands", DEFAULT_WIDTHS);
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    api.getPitchBrandCategories()
      .then((r) => {
        setCategories(Object.fromEntries(r.categories.map((c) => [c.value, c.label])));
        setCategoryOptions([{ value: "", label: "Not sure" }, ...r.categories]);
      })
      .catch(() => {});
  }, []);

  const loadBrands = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getPitchBrands({ limit: PAGE, offset, sortBy: sort.sortBy, sortDir: sort.sortDir, filters: colFilters });
      setAvailable(r.available);
      setBrands(r.items);
      setTotal(r.total);
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [offset, sort.sortBy, sort.sortDir, colFilters]);
  useEffect(() => { loadBrands(); }, [loadBrands]);

  const loadRequests = useCallback(async () => {
    try {
      const r = await api.getPitchBrandRequests();
      const wasWaiting = waitingRef.current;
      const waiting = r.requests.some((x) => x.status === "pending" || x.status === "working");
      waitingRef.current = waiting;
      setRequests(r.requests);
      // A request just finished: the new brand belongs in the list.
      if (wasWaiting && !waiting) loadBrands();
    } catch { /* the list below shows errors; polling just tries again */ }
  }, [loadBrands]);
  useEffect(() => { loadRequests(); }, [loadRequests]);
  useEffect(() => {
    const id = setInterval(() => { if (waitingRef.current) loadRequests(); }, POLL_MS);
    return () => clearInterval(id);
  }, [loadRequests]);

  const submit = async (e) => {
    e?.preventDefault();
    if (!input.trim()) { setFormError("Enter an Instagram handle or a store address."); return; }
    setSending(true);
    setFormError(null);
    try {
      await api.addPitchBrand({ input: input.trim(), contact_email: email.trim(), category });
      setInput(""); setEmail(""); setCategory("");
      waitingRef.current = true;
      await loadRequests();
    } catch (err) { setFormError(err.message); }
    finally { setSending(false); }
  };

  const refresh = async (b) => {
    setBusy(b.id);
    try {
      await api.refreshPitchBrand(b.id);
      waitingRef.current = true;
      await loadRequests();
      setNotice(`Reading ${b.name} again. It updates in a few seconds.`);
    } catch (e) { setError(e.message); }
    finally { setBusy(null); }
  };
  const remove = async () => {
    const b = removing;
    setBusy(b.id);
    try {
      const r = await api.removePitchBrand(b.id);
      setRemoving(null);
      setNotice(`${b.name} is off Pitch.${r.drafts_closed ? ` ${r.drafts_closed} unsent ${r.drafts_closed === 1 ? "draft was" : "drafts were"} closed.` : ""}`);
      await loadBrands();
    } catch (e) { setError(e.message); setRemoving(null); }
    finally { setBusy(null); }
  };

  const handleSort = (field, defaultDir) => { setSort((cur) => nextSort(cur, field, defaultDir)); setOffset(0); };
  const setColFilter = (field, value) => { setColFilters((cur) => (cur[field] === value ? cur : { ...cur, [field]: value })); setOffset(0); };

  const th = { position: "relative", textAlign: "left", fontSize: 11, fontWeight: 600, color: t.textMuted, textTransform: "uppercase", letterSpacing: 0.6, padding: "10px 14px", borderBottom: `1px solid ${t.border}`, whiteSpace: "nowrap" };
  const td = { padding: "12px 14px", borderBottom: `1px solid ${t.border}`, fontSize: 13, color: t.text, verticalAlign: "middle", overflow: "hidden" };
  const link = { color: t.textMid, fontSize: 12, textDecoration: "none", border: `1px solid ${t.border}`, borderRadius: 6, padding: "4px 8px", background: "transparent", cursor: "pointer", fontFamily: "inherit" };
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE, total);

  if (!available && !loading) {
    return (
      <Card>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Pitch isn't on this database yet</div>
        <div style={{ fontSize: 13, color: t.textMid }}>Switch the database target to dev to add and see Pitch brands.</div>
      </Card>
    );
  }

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>Add a brand</div>
        <div style={{ fontSize: 13, color: t.textMid, marginBottom: 14 }}>
          Enter its Instagram handle or store address. Linkable finds the store and reads the logo, products, contact email, signals and follower counts. It must be a Shopify store.
        </div>
        <form onSubmit={submit} style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ flex: "2 1 260px", minWidth: 0 }}>
            <Label>Instagram handle or store address</Label>
            <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="@drinkolipop or drinkolipop.com" autoFocus />
          </div>
          <div style={{ flex: "1.4 1 220px", minWidth: 0 }}>
            <Label>Contact email (optional)</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Found on the store if left empty" type="email" />
          </div>
          <div style={{ flex: "1 1 180px", minWidth: 0 }}>
            <Label>Category (optional)</Label>
            <Select value={category} onChange={setCategory} options={categoryOptions} placeholder="Not sure" />
          </div>
          <Btn size="md" loading={sending} disabled={sending} onClick={submit}>Add brand</Btn>
        </form>
        {formError && <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 8, background: "#FEF2F2", color: "#B91C1C", fontSize: 13 }}>{formError}</div>}

        {requests.length > 0 && (
          <div style={{ marginTop: 18, borderTop: `1px solid ${t.border}`, paddingTop: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: t.textMuted, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 }}>Recently added</div>
            {requests.map((r) => {
              const s = STATUS[r.status] || STATUS.pending;
              return (
                <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: `1px solid ${t.border}`, fontSize: 13 }}>
                  {r.brand_id ? <Logo src={r.logo_url} name={r.name} size={28} t={t} /> : <div style={{ width: 28 }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.name || r.input}
                      {r.domain && <span style={{ fontWeight: 400, color: t.textMuted, marginLeft: 8 }}>{r.domain}</span>}
                    </div>
                    <div style={{ fontSize: 12, color: r.status === "failed" ? "#B91C1C" : t.textMuted }}>
                      {r.status === "failed"
                        ? r.error
                        : r.brand_id
                          ? [
                              r.instagram && `@${r.instagram}${count(r.instagram_followers) ? ` ${count(r.instagram_followers)}` : ""}`,
                              count(r.tiktok_followers) && `TikTok ${count(r.tiktok_followers)}`,
                              count(r.youtube_followers) && `YouTube ${count(r.youtube_followers)}`,
                              r.contact_email || "No contact email found",
                            ].filter(Boolean).join(" · ")
                          : `Sent by ${r.requested_by || "an admin"} · ${friendlyDate(r.created)}`}
                    </div>
                  </div>
                  {r.status === "working" || r.status === "pending"
                    ? <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: s.color, fontSize: 12 }}><span className="spin" style={{ width: 10, height: 10, borderRadius: 5, border: `2px solid ${s.color}`, borderTopColor: "transparent", display: "inline-block", animation: "spin 0.8s linear infinite" }} />{s.label}</span>
                    : <Tag color={s.color}>{s.label}</Tag>}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {error && <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 8, background: "#FEF2F2", color: "#B91C1C", fontSize: 13, display: "flex", justifyContent: "space-between" }}><span>{error}</span><button onClick={() => setError(null)} style={{ ...link, border: "none", padding: 0 }}>dismiss</button></div>}
      {notice && <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 8, background: t.surfaceAlt, color: t.textMid, fontSize: 13, display: "flex", justifyContent: "space-between" }}><span>{notice}</span><button onClick={() => setNotice(null)} style={{ ...link, border: "none", padding: 0 }}>dismiss</button></div>}

      <Card style={{ padding: 0, marginBottom: 0, overflow: "hidden" }}>
        {loading && brands.length === 0 ? (
          <SkeletonTable rows={8} headerBackground="transparent" columns={COLUMNS.map((c) => ({ key: c.key, label: c.label, kind: c.key === "brand" ? "two-line" : "text" }))} />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", minWidth: Object.values(widths).reduce((a, b) => a + b, 0), borderCollapse: "collapse", tableLayout: "fixed" }}>
              <colgroup>{COLUMNS.map((c) => <col key={c.key} style={{ width: widths[c.key] }} />)}</colgroup>
              <thead><tr>
                {COLUMNS.map((col) => (
                  <th key={col.key} style={{ ...th, ...headerCellStyle }}>
                    <HeaderCell
                      trailing={col.filter && (
                        <ColumnFilter theme={t} label={col.label} type={col.filter.type} placeholder={col.filter.placeholder}
                          value={colFilters[col.filter.field] || ""} onCommit={(v) => setColFilter(col.filter.field, v)} />
                      )}
                    >
                      {col.sort
                        ? <SortLabel theme={t} label={col.label} colKey={col.sortField} sortBy={sort.sortBy} sortDir={sort.sortDir} defaultDir={col.sort} onSort={handleSort} />
                        : col.label}
                    </HeaderCell>
                    <ResizeHandle colKey={col.key} startResize={startResize} resetWidth={resetWidth} theme={t} />
                  </th>
                ))}
              </tr></thead>
              <tbody>
                {brands.length === 0 && <tr><td style={{ ...td, color: t.textMuted }} colSpan={COLUMNS.length}>No brands match.</td></tr>}
                {brands.map((b) => (
                  <tr key={b.id}>
                    {COLUMNS.map((col) => <td key={col.key} style={td}>{renderCell(col.key, b, { t, categories, link, busy, onEdit: setEditing, onRefresh: refresh, onRemove: setRemoving })}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, fontSize: 12, color: t.textMuted }}>
        <span>{total === 0 ? "No brands" : `${pageStart}–${pageEnd} of ${total}`}</span>
        <div style={{ display: "flex", gap: 6 }}>
          <button style={link} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
          <button style={link} disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</button>
        </div>
      </div>

      <EditBrandModal
        brand={editing}
        categoryOptions={categoryOptions}
        onClose={() => setEditing(null)}
        onSaved={(b) => { setEditing(null); setBrands((cur) => cur.map((x) => (x.id === b.id ? { ...x, ...b } : x))); setNotice(`Saved ${b.name}.`); }}
      />

      <Modal open={!!removing} onClose={() => setRemoving(null)} title="Remove from Pitch" width={460}>
        <p style={{ margin: "0 0 16px", fontSize: 13, color: t.textMid, lineHeight: 1.5 }}>
          Creators will no longer see or pitch <strong style={{ color: t.text }}>{removing?.name}</strong>, and any unsent drafts to it close. Pitches already sent keep their history. Adding it again here brings it back.
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn size="sm" variant="outline" onClick={() => setRemoving(null)}>Cancel</Btn>
          <Btn size="sm" color="#B91C1C" loading={busy === removing?.id} onClick={remove}>Remove</Btn>
        </div>
      </Modal>
    </div>
  );
}

function EditBrandModal({ brand, categoryOptions, onClose, onSaved }) {
  const { theme: t } = useTheme();
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!brand) return;
    setForm({
      name: brand.name || "",
      instagram: brand.instagram || "",
      contact_email: brand.contact_email || "",
      category: brand.category || "",
      country: brand.country || "",
      description: brand.description || "",
    });
    setError(null);
  }, [brand]);
  const field = (key) => ({ value: form[key] ?? "", onChange: (e) => setForm((f) => ({ ...f, [key]: e.target.value })) });

  const save = async () => {
    // Only what changed, so an edit never overwrites the store's own reading
    // of a field the admin did not touch.
    const changed = Object.fromEntries(Object.entries(form).filter(([k, v]) => (brand[k] ?? "") !== v));
    if (Object.keys(changed).length === 0) { onClose(); return; }
    setSaving(true);
    setError(null);
    try {
      const r = await api.updatePitchBrand(brand.id, changed);
      onSaved(r.brand);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  return (
    <Modal open={!!brand} onClose={onClose} title={`Edit ${brand?.name || "brand"}`} width={560}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div><Label>Name</Label><Input {...field("name")} /></div>
        <div><Label>Instagram handle</Label><Input {...field("instagram")} placeholder="drinkolipop" /></div>
        <div><Label>Contact email</Label><Input {...field("contact_email")} type="email" placeholder="partnerships@brand.com" /></div>
        <div>
          <Label>Category</Label>
          <Select value={form.category ?? ""} onChange={(v) => setForm((f) => ({ ...f, category: v }))} options={categoryOptions} placeholder="Not sure" />
        </div>
        <div><Label>Country</Label><Input {...field("country")} placeholder="GB" maxLength={2} /></div>
        <div style={{ gridColumn: "1 / -1" }}>
          <Label>About</Label>
          <Input {...field("description")} multiline rows={4} placeholder="What the brand is, in a sentence or two" />
        </div>
      </div>
      <div style={{ fontSize: 12, color: t.textMuted, marginTop: 10 }}>
        A contact email entered here counts as verified. A new Instagram handle has its follower counts read again within the hour.
      </div>
      {error && <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 8, background: "#FEF2F2", color: "#B91C1C", fontSize: 13 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <Btn size="sm" variant="outline" onClick={onClose}>Cancel</Btn>
        <Btn size="sm" loading={saving} disabled={saving} onClick={save}>Save</Btn>
      </div>
    </Modal>
  );
}
