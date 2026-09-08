import { useState, useEffect, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTheme } from "../../contexts/ThemeContext";
import { api } from "../../lib/api";
import { Card } from "../../components/ui/Card";
import { Skeleton, SkeletonForm } from "../../components/ui/Skeleton";
import { Btn } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Label, Row, Col } from "../../components/ui/Label";
import { Tag } from "../../components/ui/Tag";
import { blocksToMarkdown, markdownToBlocks, countWords, inlineHtml } from "../../lib/blog-markdown";
import { SITE_URL } from "./BlogPage";

const CATEGORIES = ["Guide", "Sourcing", "Strategy", "Playbook", "Measurement", "By category"];
const EMPTY = { title: "", slug: "", description: "", excerpt: "", category: "Guide", keyword: "", author_name: "Linkable Team", status: "draft", published_at: "", hero_image_id: "", hero_image_alt: "", hero_image: null, faqs: [], source: "manual" };
const slugify = (s) => s.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);

export default function BlogEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { theme: t } = useTheme();
  const isNew = !id;
  const [post, setPost] = useState(EMPTY);
  const [body, setBody] = useState("");
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [problems, setProblems] = useState(null);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(false);
  const [slugTouched, setSlugTouched] = useState(!isNew);
  const [photoQuery, setPhotoQuery] = useState("");
  const [photos, setPhotos] = useState([]);
  const [searching, setSearching] = useState(false);
  const [photoError, setPhotoError] = useState(null);

  useEffect(() => { api.getBlogImages().then(setImages).catch(() => {}); }, []);
  useEffect(() => {
    if (isNew) return;
    api.getBlogPost(id).then((p) => {
      setPost({ ...EMPTY, ...p, published_at: p.published_at || "", faqs: p.faqs || [] });
      setBody(blocksToMarkdown(p.blocks || []));
    }).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [id, isNew]);

  const blocks = useMemo(() => markdownToBlocks(body), [body]);
  const words = countWords(blocks);
  const readOnly = post.source === "framer";
  const set = (k) => (e) => {
    const v = e?.target ? e.target.value : e;
    setPost((p) => {
      const next = { ...p, [k]: v };
      if (k === "title" && !slugTouched) next.slug = slugify(v);
      return next;
    });
  };

  const payload = (overrides = {}) => ({
    title: post.title, slug: post.slug || slugify(post.title), description: post.description, excerpt: post.excerpt,
    category: post.category, keyword: post.keyword, author_name: post.author_name, status: post.status,
    published_at: post.published_at || null, hero_image_id: post.hero_image_id || null, hero_image_alt: post.hero_image_alt, hero_image: post.hero_image || null,
    blocks, faqs: post.faqs.filter((f) => f.q.trim() || f.a.trim()), ...overrides,
  });

  const check = async () => {
    setChecking(true);
    try { const r = await api.validateBlogPost(payload()); setProblems(r.problems); }
    catch (e) { setError(e.message); } finally { setChecking(false); }
  };

  const save = async (overrides) => {
    if (!post.title.trim()) { setError("A title is required"); return; }
    setSaving(true); setError(null);
    try {
      if (isNew) await api.createBlogPost(payload(overrides));
      else await api.updateBlogPost(id, payload(overrides));
      navigate("/blog");
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  const searchPhotos = async () => {
    const q = photoQuery.trim() || post.keyword || post.title;
    if (!q) return;
    setSearching(true); setPhotoError(null);
    try { setPhotos(await api.searchBlogImages(q)); }
    catch (e) { setPhotoError(e.message); }
    finally { setSearching(false); }
  };
  const pickPhoto = (ph) => {
    const { thumb, aspect, ...hero } = ph; // eslint-disable-line no-unused-vars
    setPost((p) => ({ ...p, hero_image: { ...hero, thumb }, hero_image_alt: ph.alt || p.hero_image_alt }));
  };

  const sel = { width: "100%", boxSizing: "border-box", background: t.bg, border: `1.5px solid ${t.border}`, borderRadius: 8, color: t.text, fontFamily: "inherit", fontSize: 14, padding: "10px 13px", outline: "none" };
  const hint = (ok, text) => <span style={{ fontSize: 11, color: ok ? t.textMuted : "#B45309", marginLeft: 8, fontWeight: 400 }}>{text}</span>;

  if (loading) return (
    <div>
      {/* Header row, then the same four cards the editor renders: meta fields, hero photo, body, FAQ. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Skeleton width={84} height={13} />
          <Skeleton width={56} height={18} radius={999} />
          <Skeleton width={60} height={12} />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Skeleton width={112} height={32} radius={999} />
          <Skeleton width={62} height={32} radius={999} />
          <Skeleton width={124} height={32} radius={999} />
        </div>
      </div>
      <Card>
        <SkeletonForm rows={[
          [{ labelWidth: 120 }],
          [{ labelWidth: 30 }, { labelWidth: 100 }],
          [{ labelWidth: 200, height: 70 }],
          [{ labelWidth: 220, height: 70 }],
          [{ labelWidth: 60, height: 41 }, { labelWidth: 46 }, { labelWidth: 44, height: 41 }, { labelWidth: 84 }],
        ]} />
      </Card>
      <Card>
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", marginBottom: 14 }}>
          <div style={{ width: 220, flexShrink: 0 }}>
            <Skeleton width={120} height={11} />
            <div style={{ height: 8 }} />
            <Skeleton width="100%" height={147} radius={10} />
          </div>
          <div style={{ flex: 1 }}>
            <Skeleton width={170} height={11} />
            <div style={{ height: 8 }} />
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <Skeleton width="100%" height={41} radius={8} style={{ flex: 1 }} />
              <Skeleton width={120} height={41} radius={999} />
            </div>
            <Skeleton width={190} height={11} />
            <div style={{ height: 8 }} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 8 }}>
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} width="100%" height={74} radius={8} />)}
            </div>
          </div>
        </div>
        <SkeletonForm rows={[[{ labelWidth: 90 }]]} />
      </Card>
      <Card><SkeletonForm rows={[[{ labelWidth: 150, height: 360 }]]} /></Card>
      <Card><SkeletonForm rows={[[{ labelWidth: 40 }], [{ labelWidth: 50, height: 70 }]]} /></Card>
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: t.textMuted }}>
          <button onClick={() => navigate("/blog")} style={{ background: "none", border: "none", color: t.textMid, cursor: "pointer", fontFamily: "inherit", fontSize: 13, padding: 0 }}>← All articles</button>
          {!isNew && <Tag color={post.status === "published" ? "#16A34A" : "#CA8A04"}>{post.status}</Tag>}
          {!isNew && <span>{post.source === "ai" ? "AI draft" : post.source === "framer" ? "Managed in Framer" : "Manual"}</span>}
          {post.status === "published" && post.slug && <a href={`${SITE_URL}/blog/${post.slug}`} target="_blank" rel="noopener noreferrer" style={{ color: t.textMid }}>View on site</a>}
        </div>
        {!readOnly && (
          <div style={{ display: "flex", gap: 8 }}>
            <Btn size="sm" variant="outline" onClick={check} loading={checking}>Check quality</Btn>
            <Btn size="sm" variant="outline" onClick={() => save()} loading={saving}>Save</Btn>
            <Btn size="sm" onClick={() => save({ status: "published", published_at: post.published_at || new Date().toISOString().slice(0, 10) })} loading={saving}>{post.status === "published" ? "Save & keep live" : "Save & publish"}</Btn>
          </div>
        )}
      </div>

      {readOnly && <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 8, background: t.surfaceAlt, color: t.textMid, fontSize: 13 }}>This article is published from Framer. Edit it there; it is listed here so the AI writer avoids duplicating it.</div>}
      {error && <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 8, background: "#FEF2F2", color: "#B91C1C", fontSize: 13 }}>{error}</div>}
      {problems && (
        <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 8, background: problems.length ? "#FFFBEB" : "#F0FDF4", color: problems.length ? "#92400E" : "#166534", fontSize: 13 }}>
          {problems.length === 0 ? "Passes every style, fact and SEO check." : <ul style={{ margin: 0, paddingLeft: 18 }}>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
        </div>
      )}

      <Card>
        <Row>
          <Col><Label>Title {hint(post.title.length >= 45 && post.title.length <= 62, `${post.title.length} chars · aim for 45–62`)}</Label><Input value={post.title} onChange={set("title")} disabled={readOnly} placeholder="What the reader would search for" /></Col>
        </Row>
        <Row>
          <Col><Label>Slug</Label><Input value={post.slug} onChange={(e) => { setSlugTouched(true); set("slug")(e); }} disabled={readOnly} placeholder="auto-generated-from-title" /></Col>
          <Col><Label>Target keyword</Label><Input value={post.keyword || ""} onChange={set("keyword")} disabled={readOnly} placeholder="lower case search phrase" /></Col>
        </Row>
        <Row>
          <Col><Label>Meta description {hint(post.description.length >= 120 && post.description.length <= 155, `${post.description.length} chars · aim for 120–155`)}</Label><Input multiline rows={2} value={post.description} onChange={set("description")} disabled={readOnly} /></Col>
        </Row>
        <Row>
          <Col><Label>Excerpt (blog card and under the title)</Label><Input multiline rows={2} value={post.excerpt} onChange={set("excerpt")} disabled={readOnly} /></Col>
        </Row>
        <Row>
          <Col><Label>Category</Label><select style={sel} value={post.category} onChange={set("category")} disabled={readOnly}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></Col>
          <Col><Label>Author</Label><Input value={post.author_name} onChange={set("author_name")} disabled={readOnly} /></Col>
          <Col><Label>Status</Label><select style={sel} value={post.status} onChange={set("status")} disabled={readOnly}><option value="draft">draft</option><option value="published">published</option><option value="archived">archived</option></select></Col>
          <Col><Label>Publish date</Label><Input type="date" value={post.published_at} onChange={set("published_at")} disabled={readOnly} /></Col>
        </Row>
      </Card>

      {!readOnly && (
        <Card>
          <div style={{ display: "flex", gap: 16, alignItems: "flex-start", marginBottom: 14 }}>
            <div style={{ width: 220, flexShrink: 0 }}>
              <Label>Current hero image</Label>
              <div style={{ aspectRatio: "3 / 2", borderRadius: 10, overflow: "hidden", background: t.surfaceAlt, border: `1px solid ${t.border}` }}>
                {post.hero_image?.thumb || post.hero_image?.src
                  ? <img src={post.hero_image.thumb || post.hero_image.src} alt={post.hero_image_alt || ""} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                  : images.find((i) => i.id === post.hero_image_id)
                    ? <img src={images.find((i) => i.id === post.hero_image_id).thumb} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                    : <div style={{ padding: 12, fontSize: 12, color: t.textMuted }}>No image yet</div>}
              </div>
              {post.hero_image?.credit?.name && <div style={{ fontSize: 11, color: t.textMuted, marginTop: 6 }}>Photo: {post.hero_image.credit.name} · Pexels</div>}
            </div>
            <div style={{ flex: 1 }}>
              <Label>Find a photo for this article</Label>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <Input value={photoQuery} onChange={(e) => setPhotoQuery(e.target.value)} placeholder={post.keyword || "e.g. woman filming skincare video phone"} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); searchPhotos(); } }} />
                <Btn size="sm" variant="outline" onClick={searchPhotos} loading={searching} style={{ height: 41, whiteSpace: "nowrap" }}>Search photos</Btn>
              </div>
              {photoError && <div style={{ fontSize: 12, color: "#B45309", marginBottom: 8 }}>{photoError}</div>}
              {photos.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8, marginBottom: 12 }}>
                  {photos.map((ph) => (
                    <button key={ph.id} onClick={() => pickPhoto(ph)} title={`${ph.alt} · ${ph.credit.name}`} style={{ padding: 0, border: `2px solid ${post.hero_image?.id === ph.id ? t.text : t.border}`, borderRadius: 8, overflow: "hidden", cursor: "pointer", background: t.surfaceAlt, aspectRatio: "3 / 2" }}>
                      <img src={ph.thumb} alt={ph.alt} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                    </button>
                  ))}
                </div>
              )}
              <Label>Or a stock image from the site pool</Label>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 8 }}>
                {images.map((img) => (
                  <button key={img.id} onClick={() => setPost((p) => ({ ...p, hero_image: null, hero_image_id: img.id, hero_image_alt: p.hero_image_alt || img.alt }))} title={img.alt} style={{ padding: 0, border: `2px solid ${!post.hero_image && post.hero_image_id === img.id ? t.text : t.border}`, borderRadius: 8, overflow: "hidden", cursor: "pointer", background: t.surfaceAlt, aspectRatio: "3 / 2" }}>
                    <img src={img.thumb} alt={img.alt} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                  </button>
                ))}
              </div>
            </div>
          </div>
          <Label>Image alt text</Label>
          <Input value={post.hero_image_alt || ""} onChange={set("hero_image_alt")} placeholder="Plain description of the photo" />
        </Card>
      )}

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <Label>Body {hint(words >= 700 && words <= 1000, `${words} words · aim for 700–1,000`)}</Label>
          {!readOnly && <button onClick={() => setPreview((v) => !v)} style={{ background: "none", border: `1px solid ${t.border}`, borderRadius: 6, color: t.textMid, cursor: "pointer", fontFamily: "inherit", fontSize: 12, padding: "4px 10px" }}>{preview ? "Edit" : "Preview"}</button>}
        </div>
        {preview || readOnly ? (
          <div style={{ fontSize: 15, lineHeight: 1.65, color: t.text }}>
            {blocks.map((b, i) => {
              if (b.type === "h2") return <h2 key={i} style={{ fontSize: 22, margin: "28px 0 10px" }} dangerouslySetInnerHTML={{ __html: inlineHtml(b.text) }} />;
              if (b.type === "h3") return <h3 key={i} style={{ fontSize: 17, margin: "22px 0 8px" }} dangerouslySetInnerHTML={{ __html: inlineHtml(b.text) }} />;
              if (b.type === "quote") return <blockquote key={i} style={{ margin: "14px 0", padding: "6px 16px", borderLeft: `3px solid ${t.border}`, color: t.textMid }} dangerouslySetInnerHTML={{ __html: inlineHtml(b.text) }} />;
              if (b.type === "ul" || b.type === "ol") { const L = b.type; return <L key={i} style={{ margin: "10px 0", paddingLeft: 22 }}>{b.items.map((it, k) => <li key={k} dangerouslySetInnerHTML={{ __html: inlineHtml(it) }} />)}</L>; }
              return <p key={i} style={{ margin: "10px 0" }} dangerouslySetInnerHTML={{ __html: inlineHtml(b.text) }} />;
            })}
            {blocks.length === 0 && <div style={{ color: t.textMuted, fontSize: 13 }}>Nothing to preview yet.</div>}
          </div>
        ) : (
          <>
            <Input multiline rows={26} value={body} onChange={(e) => setBody(e.target.value)} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13, lineHeight: 1.6 }} placeholder={"Write in plain text.\n\n## A heading that asks the reader's question\n\nParagraphs separated by a blank line. **bold**, *italic*, [link text](/pricing).\n\n- list item\n- list item\n\n> a short pull quote"} />
            <div style={{ fontSize: 12, color: t.textMuted, marginTop: 8 }}>## heading · ### sub-heading · blank line between paragraphs · - bullets · 1. numbered · &gt; quote · **bold** · *italic* · [text](/pricing)</div>
          </>
        )}
      </Card>

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <Label>FAQ (shown at the end of the article and as FAQ schema for search engines)</Label>
          {!readOnly && <Btn size="sm" variant="outline" onClick={() => setPost((p) => ({ ...p, faqs: [...p.faqs, { q: "", a: "" }] }))}>Add question</Btn>}
        </div>
        {post.faqs.length === 0 && <div style={{ color: t.textMuted, fontSize: 13 }}>No questions yet. Aim for three or four.</div>}
        {post.faqs.map((f, i) => (
          <div key={i} style={{ display: "flex", gap: 10, marginBottom: 10, alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}><Input value={f.q} onChange={(e) => setPost((p) => ({ ...p, faqs: p.faqs.map((x, k) => k === i ? { ...x, q: e.target.value } : x) }))} placeholder="Question" disabled={readOnly} /></div>
            <div style={{ flex: 2 }}><Input multiline rows={2} value={f.a} onChange={(e) => setPost((p) => ({ ...p, faqs: p.faqs.map((x, k) => k === i ? { ...x, a: e.target.value } : x) }))} placeholder="Answer in one to three sentences" disabled={readOnly} /></div>
            {!readOnly && <button onClick={() => setPost((p) => ({ ...p, faqs: p.faqs.filter((_, k) => k !== i) }))} style={{ background: "none", border: "none", color: t.textMuted, cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "10px 4px" }} title="Remove">×</button>}
          </div>
        ))}
      </Card>
    </div>
  );
}
