import { useState, useEffect, useCallback } from "react";
import { Select } from "../../components/ui/Select";
import { useNavigate } from "react-router-dom";
import { useTheme } from "../../contexts/ThemeContext";
import { api, friendlyDate } from "../../lib/api";
import { Card } from "../../components/ui/Card";
import { Btn } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { Input } from "../../components/ui/Input";
import { Label } from "../../components/ui/Label";
import { Tag } from "../../components/ui/Tag";
import { SkeletonTable } from "../../components/ui/Skeleton";
import {
  useColumnWidths,
  SortLabel,
  nextSort,
  ColumnFilter,
  ResizeHandle,
  useColumnOrder,
  DragHandle,
  HeaderCell,
  headerCellStyle,
} from "../../components/table/tableTools";

// Where articles are served. Switch to https://www.linkable.link once the
// domain points at the Vercel project.
export const SITE_URL = "https://linkable-landing-page.vercel.app";

const STATUS_COLOR = { published: "#16A34A", draft: "#CA8A04", archived: "#A3A3A3" };
const SOURCE_LABEL = { ai: "AI", manual: "Manual", framer: "Framer" };

const BLOG_COLUMNS = [
  { key: "article",   label: "Article",   width: 340, sort: "asc", sortField: "title", fill: true,
    filter: { type: "text", field: "title", placeholder: "Title…" } },
  { key: "status",    label: "Status",    width: 110, sort: "asc", sortField: "status",
    filter: { type: "text", field: "status", placeholder: "Status…" } },
  { key: "source",    label: "Source",    width: 90, sort: "asc", sortField: "source",
    filter: { type: "text", field: "source", placeholder: "Source…" } },
  { key: "length",    label: "Length",    width: 150, sort: "desc", sortField: "word_count",
    filter: { type: "number", field: "word_count" } },
  { key: "published", label: "Published", width: 110, sort: "desc", sortField: "published_at" },
  { key: "updated",   label: "Updated",   width: 110, sort: "desc", sortField: "updated_at" },
  { key: "actions",   label: "",          width: 260, resizable: false },
];
const BLOG_DEFAULT_WIDTHS = Object.fromEntries(BLOG_COLUMNS.map((c) => [c.key, c.width]));
// The actions buttons, not a column of data — stays put rather than being
// draggable somewhere into the middle of the table.
const BLOG_FIXED_KEYS = ["actions"];

// Per-column <td> style, matching what each column used to hardcode inline.
function blogCellStyle(key, td, t) {
  switch (key) {
    case "article": return { ...td, maxWidth: 460 };
    case "length": return { ...td, whiteSpace: "nowrap", color: t.textMid };
    case "published": return { ...td, whiteSpace: "nowrap", color: t.textMid };
    case "updated": return { ...td, whiteSpace: "nowrap", color: t.textMuted };
    case "actions": return { ...td, whiteSpace: "nowrap" };
    default: return td;
  }
}

// One switch, not seven inline <td>s — so the body can map over whatever
// order the header is currently in. Each case is exactly what used to sit
// directly in the JSX for that column.
function renderBlogCell(key, p, { t, navigate, busy, togglePublish, setDeleteConfirm, link }) {
  switch (key) {
    case "article":
      return (
        <>
          <div style={{ fontWeight: 600, marginBottom: 3 }}>{p.title}</div>
          <div style={{ fontSize: 12, color: t.textMuted, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span>/blog/{p.slug}</span>
            {p.category && <Tag color={t.textMid}>{p.category}</Tag>}
          </div>
        </>
      );
    case "status":
      return <Tag color={STATUS_COLOR[p.status] || t.textMuted}>{p.status}</Tag>;
    case "source":
      return <span style={{ color: t.textMid }}>{SOURCE_LABEL[p.source] || p.source}</span>;
    case "length":
      return p.word_count ? `${p.word_count} words · ${p.read_minutes} min` : "";
    case "published":
      return p.published_at ? friendlyDate(p.published_at) : "";
    case "updated":
      return friendlyDate(p.updated_at);
    case "actions":
      return (
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <button style={link} onClick={() => navigate(`/blog/${p.id}`)}>{p.source === "framer" ? "Details" : "Edit"}</button>
          {p.status === "published" && <a style={link} href={`${SITE_URL}/blog/${p.slug}`} target="_blank" rel="noopener noreferrer">View</a>}
          {p.source !== "framer" && <button style={link} disabled={busy === p.id} onClick={() => togglePublish(p)}>{p.status === "published" ? "Unpublish" : "Publish"}</button>}
          {p.source !== "framer" && <button style={{ ...link, color: "#B91C1C" }} onClick={() => setDeleteConfirm(p)}>Delete</button>}
        </div>
      );
    default:
      return null;
  }
}

export default function BlogPage() {
  const { theme: t } = useTheme();
  const navigate = useNavigate();
  const PAGE = 25;
  const [posts, setPosts] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(null); // id or action being processed
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [newOpen, setNewOpen] = useState(false);
  const { widths, startResize, resetWidth } = useColumnWidths("blog-posts", BLOG_DEFAULT_WIDTHS);
  // The column keys are display names ("article", "length"); the database
  // knows them as title and word_count, so each column carries the field its
  // sort and filter actually go to.
  const [sort, setSort] = useState({ sortBy: "", sortDir: "desc" });
  const [colFilters, setColFilters] = useState({});
  const handleSort = (field, defaultDir) => {
    setSort((cur) => nextSort(cur, field, defaultDir));
    setOffset(0);
  };
  const setColFilter = (field, value) => {
    setColFilters((cur) => (cur[field] === value ? cur : { ...cur, [field]: value }));
    setOffset(0);
  };
  const { orderedColumns, dragHandleProps, dropTargetProps, dragOverKey } = useColumnOrder("blog-posts", BLOG_COLUMNS, BLOG_FIXED_KEYS);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getBlogPosts({
        status: filter === "all" ? undefined : filter, limit: PAGE, offset,
        sortBy: sort.sortBy, sortDir: sort.sortDir, filters: colFilters,
      });
      setPosts(r.items); setTotal(r.total); setError(null);
      // Deleting the last article on the last page leaves offset past the end ("26–25 of 25"): step back.
      if (offset > 0 && offset >= r.total) setOffset(Math.max(0, Math.floor(Math.max(0, r.total - 1) / PAGE) * PAGE));
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [filter, offset, sort.sortBy, sort.sortDir, colFilters]);
  useEffect(() => { load(); }, [load]);
  const changeFilter = (f) => { setFilter(f); setOffset(0); };

  const visible = posts;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE, total);

  const togglePublish = async (p) => {
    setBusy(p.id);
    try {
      await api.updateBlogPost(p.id, { status: p.status === "published" ? "draft" : "published" });
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(null); }
  };
  const remove = async (id) => {
    setBusy(id);
    try { await api.deleteBlogPost(id); setDeleteConfirm(null); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(null); }
  };
  const deploy = async () => {
    setBusy("deploy");
    try {
      const r = await api.deployBlog();
      setNotice(r.triggered ? "Site rebuild started. Articles go live in about two minutes." : `Saved. ${r.note}.`);
    } catch (e) { setError(e.message); }
    finally { setBusy(null); }
  };

  const th = { position: "relative", textAlign: "left", fontSize: 11, fontWeight: 600, color: t.textMuted, textTransform: "uppercase", letterSpacing: 0.6, padding: "10px 14px", borderBottom: `1px solid ${t.border}`, whiteSpace: "nowrap" };
  const td = { padding: "12px 14px", borderBottom: `1px solid ${t.border}`, fontSize: 13, color: t.text, verticalAlign: "top" };
  const link = { color: t.textMid, fontSize: 12, textDecoration: "none", border: `1px solid ${t.border}`, borderRadius: 6, padding: "4px 8px", background: "transparent", cursor: "pointer", fontFamily: "inherit" };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 6 }}>
          {[["all", "All"], ["published", "Published"], ["draft", "Drafts"], ["archived", "Archived"]].map(([id, label]) => (
            <button key={id} onClick={() => changeFilter(id)} style={{ ...link, padding: "6px 12px", background: filter === id ? t.surface : "transparent", color: filter === id ? t.text : t.textMuted, fontWeight: filter === id ? 600 : 400, boxShadow: filter === id ? t.shadow : "none" }}>{label}</button>
          ))}
        </div>
        <Btn size="sm" onClick={() => setNewOpen(true)}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>
          New article
        </Btn>
      </div>

      {error && <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 8, background: "#FEF2F2", color: "#B91C1C", fontSize: 13 }}>{error}</div>}
      {notice && <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 8, background: t.surfaceAlt, color: t.textMid, fontSize: 13, display: "flex", justifyContent: "space-between" }}><span>{notice}</span><button onClick={() => setNotice(null)} style={{ ...link, border: "none", padding: 0 }}>dismiss</button></div>}

      <Card style={{ padding: 0, marginBottom: 0, overflow: "hidden" }}>
        {loading ? (
          <SkeletonTable
            rows={8}
            headerBackground="transparent"
            columns={[
              { key: "article", label: "Article", kind: "two-line", width: "34%" },
              { key: "status", label: "Status", kind: "pill" },
              { key: "source", label: "Source", kind: "text" },
              { key: "length", label: "Length", kind: "text" },
              { key: "published", label: "Published", kind: "text" },
              { key: "updated", label: "Updated", kind: "text" },
              { key: "actions", label: "", kind: "actions" },
            ]}
          />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{
              width: "100%",
              minWidth: Object.values(widths).reduce((a, b) => a + b, 0),
              borderCollapse: "collapse", tableLayout: "fixed",
            }}>
              <colgroup>
                {orderedColumns.map((col) => (
                  <col key={col.key} style={{ width: widths[col.key] }} />
                ))}
              </colgroup>
              <thead><tr>
                {orderedColumns.map((col) => (
                  <th
                    key={col.key}
                    style={{ ...th, ...headerCellStyle, background: dragOverKey === col.key ? t.accentLight : undefined }}
                    {...dropTargetProps(col.key)}
                  >
                    <HeaderCell
                      grip={!BLOG_FIXED_KEYS.includes(col.key) && (
                        <DragHandle colKey={col.key} dragHandleProps={dragHandleProps} theme={t} />
                      )}
                      trailing={col.filter && (
                        <ColumnFilter
                          theme={t}
                          label={col.label}
                          type={col.filter.type}
                          placeholder={col.filter.placeholder}
                          value={colFilters[col.filter.field] || ""}
                          onCommit={(v) => setColFilter(col.filter.field, v)}
                        />
                      )}
                    >
                      {col.sort ? (
                        <SortLabel
                          theme={t}
                          label={col.label}
                          colKey={col.sortField}
                          sortBy={sort.sortBy}
                          sortDir={sort.sortDir}
                          defaultDir={col.sort}
                          onSort={handleSort}
                        />
                      ) : col.label}
                    </HeaderCell>
                    {col.resizable !== false && (
                      <ResizeHandle colKey={col.key} startResize={startResize} resetWidth={resetWidth} theme={t} />
                    )}
                  </th>
                ))}
              </tr></thead>
              <tbody>
                {visible.length === 0 && <tr><td style={{ ...td, color: t.textMuted }} colSpan={orderedColumns.length}>No articles here yet.</td></tr>}
                {visible.map((p) => (
                  <tr key={p.id}>
                    {orderedColumns.map((col) => (
                      <td key={col.key} style={blogCellStyle(col.key, td, t)}>
                        {renderBlogCell(col.key, p, { t, navigate, busy, togglePublish, setDeleteConfirm, link })}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, fontSize: 12, color: t.textMuted }}>
        <span>
          {total === 0 ? "No articles" : `${pageStart}–${pageEnd} of ${total}`}
          <span style={{ margin: "0 8px" }}>·</span>
          Changes reach the website within 10 minutes.{" "}
          <button onClick={deploy} disabled={busy === "deploy"} style={{ background: "none", border: "none", padding: 0, color: t.textMid, textDecoration: "underline", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>{busy === "deploy" ? "Publishing…" : "Publish now"}</button>
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          <button style={link} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
          <button style={link} disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</button>
        </div>
      </div>

      <Modal open={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} title="Delete article" width={440}>
        <p style={{ margin: "0 0 16px", fontSize: 13, color: t.textMid }}>Delete “{deleteConfirm?.title}”? If it is live, the page is removed from the site on the next sync.</p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn size="sm" variant="outline" onClick={() => setDeleteConfirm(null)}>Cancel</Btn>
          <Btn size="sm" color="#B91C1C" loading={busy === deleteConfirm?.id} onClick={() => remove(deleteConfirm.id)}>Delete</Btn>
        </div>
      </Modal>

      <NewArticleModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onManual={() => { setNewOpen(false); navigate("/blog/new"); }}
        onDone={(post) => { setNewOpen(false); navigate(`/blog/${post.id}`); }}
        onStarted={() => {
          setNewOpen(false);
          setNotice("Writing the article on Supabase. It will appear here in a minute or so.");
          setTimeout(load, 45_000);
        }}
      />
    </div>
  );
}

function NewArticleModal({ open, onClose, onManual, onDone, onStarted }) {
  const { theme: t } = useTheme();
  const [step, setStep] = useState("choose"); // choose | ai | topics
  const [topics, setTopics] = useState([]);
  const [topicId, setTopicId] = useState("");
  const [keyword, setKeyword] = useState("");
  const [angle, setAngle] = useState("");
  const [publish, setPublish] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  const loadTopics = useCallback(() => api.getBlogTopics().then(setTopics).catch((e) => setError(e.message)), []);
  useEffect(() => { if (open) { setStep("choose"); setError(null); setTopicId(""); setKeyword(""); setAngle(""); loadTopics(); } }, [open, loadTopics]);

  const queued = topics.filter((x) => x.status === "queued");
  const run = async () => {
    setRunning(true); setError(null);
    try {
      const body = topicId ? { topicId, publish } : { keyword: keyword.trim(), angle: angle.trim(), publish };
      if (!body.topicId && !body.keyword) throw new Error("Pick a topic or type a keyword");
      const res = await api.generateBlogPost(body);
      // Generation runs on Supabase, which outlives this request, so the usual
      // answer is "started". The article appears in the list a minute later.
      if (res.running || !res.post) onStarted();
      else onDone(res.post);
    } catch (e) { setError(e.message); }
    finally { setRunning(false); }
  };

  const option = (title, desc, onClick) => (
    <button onClick={onClick} style={{ flex: 1, textAlign: "left", padding: 18, borderRadius: 10, border: `1.5px solid ${t.border}`, background: t.bg, cursor: "pointer", fontFamily: "inherit", color: t.text }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 12, color: t.textMuted, lineHeight: 1.5 }}>{desc}</div>
    </button>
  );
  const back = (to, label) => <button onClick={() => setStep(to)} style={{ background: "none", border: "none", color: t.textMid, cursor: "pointer", fontFamily: "inherit", fontSize: 13, padding: 0, marginBottom: 14 }}>← {label}</button>;
  const title = step === "choose" ? "New article" : step === "ai" ? "New article with AI" : "Topic backlog";

  return (
    <Modal open={open} onClose={running ? () => {} : onClose} title={title} width={step === "topics" ? 680 : 560}>
      {step === "choose" && (
        <div style={{ display: "flex", gap: 12 }}>
          {option("Write it myself", "Open a blank editor: title, body, FAQ and photo, with a quality check against the style rules.", onManual)}
          {option("Generate with AI", "Pick a topic from the backlog or type a keyword. The draft is checked against the style rules and the verified facts, then opens in the editor.", () => setStep("ai"))}
        </div>
      )}

      {step === "ai" && (
        <>
          {back("choose", "Back")}
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <Label>Topic from the backlog ({queued.length} queued)</Label>
              <button onClick={() => setStep("topics")} style={{ background: "none", border: "none", color: t.textMid, cursor: "pointer", fontFamily: "inherit", fontSize: 12, textDecoration: "underline", padding: 0 }}>Manage backlog</button>
            </div>
            <Select
              value={topicId}
              onChange={setTopicId}
              ariaLabel="Topic from the backlog"
              placeholder="Custom keyword (below)"
              options={[{ value: "", label: "Custom keyword (below)" },
                ...queued.map((x) => ({ value: x.id, label: x.keyword, hint: x.category }))]}
              searchPlaceholder="A keyword…"
            />
          </div>
          {!topicId && (
            <>
              <div style={{ marginBottom: 14 }}><Label>Target keyword</Label><Input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="e.g. creator seeding strategy for skincare brands" /></div>
              <div style={{ marginBottom: 14 }}><Label>Angle (optional)</Label><Input value={angle} onChange={(e) => setAngle(e.target.value)} placeholder="What the article should argue or teach" /></div>
            </>
          )}
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: t.textMid, marginBottom: 16 }}>
            <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} /> Publish immediately if it passes every check (otherwise saved as a draft)
          </label>
          <p style={{ fontSize: 12, color: t.textMuted, margin: "0 0 16px" }}>Takes one to three minutes and costs at most about 10 cents.</p>
          {error && <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 8, background: "#FEF2F2", color: "#B91C1C", fontSize: 13 }}>{error}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn size="sm" variant="outline" onClick={onClose} disabled={running}>Cancel</Btn>
            <Btn size="sm" onClick={run} loading={running}>{running ? "Writing…" : "Generate"}</Btn>
          </div>
        </>
      )}

      {step === "topics" && (
        <>
          {back("ai", "Back to generation")}
          <TopicsPanel topics={topics} reload={loadTopics} onError={setError} />
          {error && <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 8, background: "#FEF2F2", color: "#B91C1C", fontSize: 13 }}>{error}</div>}
        </>
      )}
    </Modal>
  );
}

function TopicsPanel({ topics, reload, onError }) {
  const { theme: t } = useTheme();
  const [keyword, setKeyword] = useState("");
  const [angle, setAngle] = useState("");
  const [busy, setBusy] = useState(null);

  const add = async () => {
    if (!keyword.trim()) return;
    setBusy("add");
    try { await api.createBlogTopic({ keyword: keyword.trim(), angle: angle.trim() }); setKeyword(""); setAngle(""); await reload(); }
    catch (e) { onError(e.message); } finally { setBusy(null); }
  };
  const propose = async () => {
    setBusy("propose");
    try { await api.proposeBlogTopics(); await reload(); } catch (e) { onError(e.message); } finally { setBusy(null); }
  };
  const remove = async (id) => {
    setBusy(id);
    try { await api.deleteBlogTopic(id); await reload(); } catch (e) { onError(e.message); } finally { setBusy(null); }
  };

  const queued = topics.filter((x) => x.status === "queued");
  const used = topics.filter((x) => x.status !== "queued");
  return (
    <>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}><Label>Keyword</Label><Input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="what a brand owner would search" /></div>
        <div style={{ flex: 1.4 }}><Label>Angle</Label><Input value={angle} onChange={(e) => setAngle(e.target.value)} placeholder="optional" /></div>
        <Btn size="sm" onClick={add} loading={busy === "add"} style={{ height: 41 }}>Add</Btn>
        <Btn size="sm" variant="outline" onClick={propose} loading={busy === "propose"} style={{ height: 41, whiteSpace: "nowrap" }}>Propose 10 with AI</Btn>
      </div>
      <div style={{ maxHeight: 400, overflowY: "auto", border: `1px solid ${t.border}`, borderRadius: 8 }}>
        {queued.map((x) => (
          <div key={x.id} style={{ display: "flex", gap: 12, padding: "10px 12px", borderBottom: `1px solid ${t.border}`, alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: t.text }}>{x.keyword}</div>
              {x.angle && <div style={{ fontSize: 12, color: t.textMuted, marginTop: 2 }}>{x.angle}</div>}
            </div>
            <Tag color={t.textMid}>{x.category}</Tag>
            <button disabled={busy === x.id} onClick={() => remove(x.id)} style={{ background: "none", border: "none", color: t.textMuted, cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>remove</button>
          </div>
        ))}
        {queued.length === 0 && <div style={{ padding: 14, fontSize: 13, color: t.textMuted }}>Backlog is empty. The daily article will ask AI for new topics, or add some above.</div>}
      </div>
      <div style={{ fontSize: 12, color: t.textMuted, marginTop: 10 }}>The daily article at 07:00 UTC takes the next queued topic.{used.length ? ` ${used.length} already written.` : ""}</div>
    </>
  );
}
