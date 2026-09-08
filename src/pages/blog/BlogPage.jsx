import { useState, useEffect, useCallback } from "react";
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

// Where articles are served. Switch to https://www.linkable.link once the
// domain points at the Vercel project.
export const SITE_URL = "https://linkable-landing-page.vercel.app";

const STATUS_COLOR = { published: "#16A34A", draft: "#CA8A04", archived: "#A3A3A3" };
const SOURCE_LABEL = { ai: "AI", manual: "Manual", framer: "Framer" };

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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getBlogPosts({ status: filter === "all" ? undefined : filter, limit: PAGE, offset });
      setPosts(r.items); setTotal(r.total); setError(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [filter, offset]);
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

  const th = { textAlign: "left", fontSize: 11, fontWeight: 600, color: t.textMuted, textTransform: "uppercase", letterSpacing: 0.6, padding: "10px 14px", borderBottom: `1px solid ${t.border}`, whiteSpace: "nowrap" };
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
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={th}>Article</th><th style={th}>Status</th><th style={th}>Source</th><th style={th}>Length</th><th style={th}>Published</th><th style={th}>Updated</th><th style={th}></th>
              </tr></thead>
              <tbody>
                {visible.length === 0 && <tr><td style={{ ...td, color: t.textMuted }} colSpan={7}>No articles here yet.</td></tr>}
                {visible.map((p) => (
                  <tr key={p.id}>
                    <td style={{ ...td, maxWidth: 460 }}>
                      <div style={{ fontWeight: 600, marginBottom: 3 }}>{p.title}</div>
                      <div style={{ fontSize: 12, color: t.textMuted, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <span>/blog/{p.slug}</span>
                        {p.category && <Tag color={t.textMid}>{p.category}</Tag>}
                      </div>
                    </td>
                    <td style={td}><Tag color={STATUS_COLOR[p.status] || t.textMuted}>{p.status}</Tag></td>
                    <td style={td}><span style={{ color: t.textMid }}>{SOURCE_LABEL[p.source] || p.source}</span></td>
                    <td style={{ ...td, whiteSpace: "nowrap", color: t.textMid }}>{p.word_count ? `${p.word_count} words · ${p.read_minutes} min` : ""}</td>
                    <td style={{ ...td, whiteSpace: "nowrap", color: t.textMid }}>{p.published_at ? friendlyDate(p.published_at) : ""}</td>
                    <td style={{ ...td, whiteSpace: "nowrap", color: t.textMuted }}>{friendlyDate(p.updated_at)}</td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <button style={link} onClick={() => navigate(`/blog/${p.id}`)}>{p.source === "framer" ? "Details" : "Edit"}</button>
                        {p.status === "published" && <a style={link} href={`${SITE_URL}/blog/${p.slug}`} target="_blank" rel="noopener noreferrer">View</a>}
                        {p.source !== "framer" && <button style={link} disabled={busy === p.id} onClick={() => togglePublish(p)}>{p.status === "published" ? "Unpublish" : "Publish"}</button>}
                        {p.source !== "framer" && <button style={{ ...link, color: "#B91C1C" }} onClick={() => setDeleteConfirm(p)}>Delete</button>}
                      </div>
                    </td>
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

      <NewArticleModal open={newOpen} onClose={() => setNewOpen(false)} onManual={() => { setNewOpen(false); navigate("/blog/new"); }} onDone={(post) => { setNewOpen(false); navigate(`/blog/${post.id}`); }} />
    </div>
  );
}

function NewArticleModal({ open, onClose, onManual, onDone }) {
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
      const { post } = await api.generateBlogPost(body);
      onDone(post);
    } catch (e) { setError(e.message); }
    finally { setRunning(false); }
  };

  const sel = { width: "100%", boxSizing: "border-box", background: t.bg, border: `1.5px solid ${t.border}`, borderRadius: 8, color: t.text, fontFamily: "inherit", fontSize: 14, padding: "10px 13px", outline: "none" };
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
            <select style={sel} value={topicId} onChange={(e) => setTopicId(e.target.value)}>
              <option value="">Custom keyword (below)</option>
              {queued.map((x) => <option key={x.id} value={x.id}>{x.keyword}{x.category ? ` · ${x.category}` : ""}</option>)}
            </select>
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
