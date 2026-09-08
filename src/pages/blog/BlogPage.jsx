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
import { Skeleton } from "../../components/ui/Skeleton";

// Where articles are served. Switch to https://www.linkable.link once the
// domain points at the Vercel project.
export const SITE_URL = "https://linkable-landing-page.vercel.app";

const STATUS_COLOR = { published: "#16A34A", draft: "#CA8A04", archived: "#A3A3A3" };
const SOURCE_LABEL = { ai: "AI", manual: "Manual", framer: "Framer" };

export default function BlogPage() {
  const { theme: t } = useTheme();
  const navigate = useNavigate();
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(null); // id or action being processed
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [genOpen, setGenOpen] = useState(false);
  const [topicsOpen, setTopicsOpen] = useState(false);

  const load = useCallback(async () => {
    try { setPosts(await api.getBlogPosts()); setError(null); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const visible = posts.filter((p) => filter === "all" || p.status === filter);
  const counts = { published: posts.filter((p) => p.status === "published").length, draft: posts.filter((p) => p.status === "draft").length };

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
          {[["all", `All (${posts.length})`], ["published", `Published (${counts.published})`], ["draft", `Drafts (${counts.draft})`]].map(([id, label]) => (
            <button key={id} onClick={() => setFilter(id)} style={{ ...link, padding: "6px 12px", background: filter === id ? t.surface : "transparent", color: filter === id ? t.text : t.textMuted, fontWeight: filter === id ? 600 : 400, boxShadow: filter === id ? t.shadow : "none" }}>{label}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn size="sm" variant="outline" onClick={() => setTopicsOpen(true)}>Topics</Btn>
          <Btn size="sm" variant="outline" onClick={deploy} loading={busy === "deploy"} title="Re-render the website from the database now">Publish to site</Btn>
          <Btn size="sm" variant="outline" onClick={() => setGenOpen(true)}>Generate with AI</Btn>
          <Btn size="sm" onClick={() => navigate("/blog/new")}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>
            New article
          </Btn>
        </div>
      </div>

      {error && <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 8, background: "#FEF2F2", color: "#B91C1C", fontSize: 13 }}>{error}</div>}
      {notice && <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 8, background: t.surfaceAlt, color: t.textMid, fontSize: 13, display: "flex", justifyContent: "space-between" }}><span>{notice}</span><button onClick={() => setNotice(null)} style={{ ...link, border: "none", padding: 0 }}>dismiss</button></div>}

      <Card style={{ padding: 0, marginBottom: 0, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} height={16} width={`${60 + (i * 13) % 35}%`} />)}</div>
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

      <Modal open={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} title="Delete article" width={440}>
        <p style={{ margin: "0 0 16px", fontSize: 13, color: t.textMid }}>Delete “{deleteConfirm?.title}”? If it is live, the page is removed from the site on the next sync.</p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn size="sm" variant="outline" onClick={() => setDeleteConfirm(null)}>Cancel</Btn>
          <Btn size="sm" color="#B91C1C" loading={busy === deleteConfirm?.id} onClick={() => remove(deleteConfirm.id)}>Delete</Btn>
        </div>
      </Modal>

      <GenerateModal open={genOpen} onClose={() => setGenOpen(false)} onDone={(post) => { setGenOpen(false); navigate(`/blog/${post.id}`); }} />
      <TopicsModal open={topicsOpen} onClose={() => setTopicsOpen(false)} />
    </div>
  );
}

function GenerateModal({ open, onClose, onDone }) {
  const { theme: t } = useTheme();
  const [topics, setTopics] = useState([]);
  const [topicId, setTopicId] = useState("");
  const [keyword, setKeyword] = useState("");
  const [angle, setAngle] = useState("");
  const [publish, setPublish] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    api.getBlogTopics().then((all) => setTopics(all.filter((x) => x.status === "queued"))).catch(() => {});
    setError(null);
  }, [open]);

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

  return (
    <Modal open={open} onClose={running ? () => {} : onClose} title="Generate an article with AI" width={560}>
      <div style={{ marginBottom: 14 }}>
        <Label>Next topic from the backlog</Label>
        <select style={sel} value={topicId} onChange={(e) => setTopicId(e.target.value)}>
          <option value="">Custom keyword (below)</option>
          {topics.map((x) => <option key={x.id} value={x.id}>{x.keyword}{x.category ? ` · ${x.category}` : ""}</option>)}
        </select>
      </div>
      {!topicId && (
        <>
          <div style={{ marginBottom: 14 }}><Label>Target keyword</Label><Input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="e.g. creator seeding strategy for skincare brands" /></div>
          <div style={{ marginBottom: 14 }}><Label>Angle (optional)</Label><Input value={angle} onChange={(e) => setAngle(e.target.value)} placeholder="What the article should argue or teach" /></div>
        </>
      )}
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: t.textMid, marginBottom: 16 }}>
        <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} /> Publish immediately (otherwise saved as a draft for review)
      </label>
      <p style={{ fontSize: 12, color: t.textMuted, margin: "0 0 16px" }}>Takes two to four minutes. The draft is checked against the style rules and the verified facts before it is saved.</p>
      {error && <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 8, background: "#FEF2F2", color: "#B91C1C", fontSize: 13 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Btn size="sm" variant="outline" onClick={onClose} disabled={running}>Cancel</Btn>
        <Btn size="sm" onClick={run} loading={running}>{running ? "Writing…" : "Generate"}</Btn>
      </div>
    </Modal>
  );
}

function TopicsModal({ open, onClose }) {
  const { theme: t } = useTheme();
  const [topics, setTopics] = useState([]);
  const [keyword, setKeyword] = useState("");
  const [angle, setAngle] = useState("");
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => api.getBlogTopics().then(setTopics).catch((e) => setError(e.message)), []);
  useEffect(() => { if (open) load(); }, [open, load]);

  const add = async () => {
    if (!keyword.trim()) return;
    setBusy("add");
    try { await api.createBlogTopic({ keyword: keyword.trim(), angle: angle.trim() }); setKeyword(""); setAngle(""); await load(); }
    catch (e) { setError(e.message); } finally { setBusy(null); }
  };
  const propose = async () => {
    setBusy("propose");
    try { await api.proposeBlogTopics(); await load(); } catch (e) { setError(e.message); } finally { setBusy(null); }
  };
  const remove = async (id) => {
    setBusy(id);
    try { await api.deleteBlogTopic(id); await load(); } catch (e) { setError(e.message); } finally { setBusy(null); }
  };

  const queued = topics.filter((x) => x.status === "queued");
  const used = topics.filter((x) => x.status !== "queued");
  return (
    <Modal open={open} onClose={onClose} title={`Topic backlog · ${queued.length} queued`} width={680}>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}><Label>Keyword</Label><Input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="what a brand owner would search" /></div>
        <div style={{ flex: 1.4 }}><Label>Angle</Label><Input value={angle} onChange={(e) => setAngle(e.target.value)} placeholder="optional" /></div>
        <Btn size="sm" onClick={add} loading={busy === "add"} style={{ height: 41 }}>Add</Btn>
        <Btn size="sm" variant="outline" onClick={propose} loading={busy === "propose"} style={{ height: 41, whiteSpace: "nowrap" }}>Propose 10 with AI</Btn>
      </div>
      {error && <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 8, background: "#FEF2F2", color: "#B91C1C", fontSize: 13 }}>{error}</div>}
      <div style={{ maxHeight: 420, overflowY: "auto", border: `1px solid ${t.border}`, borderRadius: 8 }}>
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
      {used.length > 0 && <div style={{ fontSize: 12, color: t.textMuted, marginTop: 10 }}>{used.length} topic{used.length === 1 ? "" : "s"} already written.</div>}
    </Modal>
  );
}
