import { useState, useEffect, useCallback } from "react";
import { Btn } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { Tag } from "../../components/ui/Tag";
import { Modal } from "../../components/ui/Modal";
import { Label, SectionTitle, Row, Col } from "../../components/ui/Label";
import { AIOutput } from "../../components/ui/AIOutput";
import { Pagination } from "../../components/ui/Pagination";
import { useKB } from "../../contexts/KBContext";
import { useAuth } from "../../contexts/AuthContext";
import { callClaude } from "../../lib/claude";
import { supabase } from "../../lib/supabase";
import { CRM_STAGES, CRM_STAGE_COLORS } from "../../lib/constants";
import { useTheme } from "../../contexts/ThemeContext";

// Icon components
const IconEdit = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;
const IconTrash = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>;
const IconMail = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>;

export default function ContactsPage() {
  const { theme } = useTheme();
  const { profile } = useAuth();
  const { kb } = useKB();
  const teamId = profile?.team_id;

  const [contacts, setContacts] = useState([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [countryFilter, setCountryFilter] = useState("");
  const [sortBy, setSortBy] = useState("created_at");
  const [sortDir, setSortDir] = useState("desc");
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);

  // Pagination
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [totalCount, setTotalCount] = useState(0);

  // Filter dropdown options
  const [filterOptions, setFilterOptions] = useState({ countries: [], sources: [] });

  // Modals
  const [showAddModal, setShowAddModal] = useState(false);
  const [editContact, setEditContact] = useState(null);
  const [form, setForm] = useState({ name: "", company: "", domain: "", email: "", phone: "", role: "", stage: "Lead", country: "" });
  const [noteText, setNoteText] = useState("");
  const [notes, setNotes] = useState([]);
  const [activities, setActivities] = useState([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiOutput, setAiOutput] = useState("");

  // Bulk
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [showBulkEmail, setShowBulkEmail] = useState(false);
  const [bulkPrompt, setBulkPrompt] = useState("Write a personalised cold outreach email introducing our services. Keep it under 100 words, friendly but direct.");
  const [bulkEmails, setBulkEmails] = useState([]);
  const [bulkGenerating, setBulkGenerating] = useState(false);

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Reset page when filters/sort change
  useEffect(() => {
    setPage(1);
    setSelectedIds(new Set());
  }, [debouncedSearch, stageFilter, sourceFilter, countryFilter, sortBy, sortDir, pageSize]);

  // Fetch filter dropdown options (lightweight — only 2 columns)
  const fetchFilterOptions = useCallback(async () => {
    if (!teamId) return;
    const { data } = await supabase.from("contacts").select("country, source").eq("team_id", teamId);
    if (data) {
      setFilterOptions({
        countries: [...new Set(data.map(c => c.country).filter(Boolean))].sort(),
        sources: [...new Set(data.map(c => c.source).filter(Boolean))].sort(),
      });
    }
  }, [teamId]);

  useEffect(() => { fetchFilterOptions(); }, [fetchFilterOptions]);

  // Main paginated fetch — server-side filtering, sorting, pagination
  const fetchContacts = useCallback(async () => {
    if (!teamId) return;
    setLoading(true);
    let query = supabase.from("contacts").select("*", { count: "exact" }).eq("team_id", teamId);

    if (debouncedSearch) {
      const s = `%${debouncedSearch}%`;
      query = query.or(`name.ilike.${s},company.ilike.${s},domain.ilike.${s},email.ilike.${s},category.ilike.${s}`);
    }
    if (stageFilter) query = query.eq("stage", stageFilter);
    if (sourceFilter) query = query.eq("source", sourceFilter);
    if (countryFilter) query = query.eq("country", countryFilter);

    query = query.order(sortBy, { ascending: sortDir === "asc" });
    query = query.range((page - 1) * pageSize, page * pageSize - 1);

    const { data, count } = await query;
    setContacts(data || []);
    setTotalCount(count || 0);
    setLoading(false);
  }, [teamId, debouncedSearch, stageFilter, sourceFilter, countryFilter, sortBy, sortDir, page, pageSize]);

  useEffect(() => { fetchContacts(); }, [fetchContacts]);

  useEffect(() => {
    if (!selected) { setNotes([]); setActivities([]); return; }
    (async () => {
      const [n, a] = await Promise.all([
        supabase.from("notes").select("*").eq("contact_id", selected.id).order("created_at", { ascending: false }),
        supabase.from("activities").select("*").eq("contact_id", selected.id).order("created_at", { ascending: false }),
      ]);
      setNotes(n.data || []);
      setActivities(a.data || []);
    })();
  }, [selected]);

  function toggleSort(col) { if (sortBy === col) setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortBy(col); setSortDir("desc"); } }
  const sortIcon = col => sortBy === col ? (sortDir === "asc" ? " ↑" : " ↓") : "";
  const toggleSelect = id => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => setSelectedIds(prev => prev.size === contacts.length ? new Set() : new Set(contacts.map(c => c.id)));
  const selectedContacts = contacts.filter(c => selectedIds.has(c.id));

  function openAdd() { setForm({ name: "", company: "", domain: "", email: "", phone: "", role: "", stage: "Lead", country: "" }); setShowAddModal(true); }
  function openEdit(c) { setForm({ name: c.name, company: c.company, domain: c.domain, email: c.email, phone: c.phone, role: c.role, stage: c.stage, country: c.country }); setEditContact(c); }

  async function handleSave() {
    if (editContact) {
      const old = editContact;
      const { data, error } = await supabase.from("contacts").update(form).eq("id", old.id).select().single();
      if (!error && data) {
        if (form.stage !== old.stage) await supabase.from("activities").insert({ contact_id: old.id, team_id: teamId, type: "stage_change", description: `Stage: ${old.stage} → ${form.stage}` });
        if (selected?.id === old.id) setSelected(data);
      }
      setEditContact(null);
    } else {
      const { data, error } = await supabase.from("contacts").insert({ ...form, team_id: teamId, source: "manual" }).select().single();
      if (!error && data) {
        await supabase.from("activities").insert({ contact_id: data.id, team_id: teamId, type: "created", description: "Contact created manually" });
      }
      setShowAddModal(false);
    }
    fetchContacts();
    fetchFilterOptions();
  }

  async function handleDelete(id) {
    await supabase.from("contacts").delete().eq("id", id);
    if (selected?.id === id) setSelected(null);
    fetchContacts();
    fetchFilterOptions();
  }

  async function handleStageChange(id, stage) {
    const old = contacts.find(c => c.id === id);
    const { data } = await supabase.from("contacts").update({ stage }).eq("id", id).select().single();
    if (data) {
      if (stage !== old?.stage) await supabase.from("activities").insert({ contact_id: id, team_id: teamId, type: "stage_change", description: `Stage: ${old.stage} → ${stage}` });
      // Optimistic update for current page
      setContacts(prev => prev.map(c => c.id === id ? data : c));
      if (selected?.id === id) setSelected(data);
      // Refetch if stage filter is active (contact may no longer match)
      if (stageFilter) fetchContacts();
    }
  }

  async function handleAddNote() {
    if (!noteText.trim() || !selected) return;
    const { data } = await supabase.from("notes").insert({ contact_id: selected.id, team_id: teamId, text: noteText.trim() }).select().single();
    if (data) { setNotes(prev => [data, ...prev]); await supabase.from("activities").insert({ contact_id: selected.id, team_id: teamId, type: "note_added", description: "Note added" }); setNoteText(""); }
  }

  async function handleAIOutreach() {
    if (!selected) return;
    setAiLoading(true); setAiOutput("");
    try {
      await callClaude(`You write personalised cold outreach emails. Brand voice: ${kb.brand?.tone || "direct, friendly"}`,
        `Write a short cold email (subject + body, under 100 words) for:\nName: ${selected.name}\nCompany: ${selected.company}\nDomain: ${selected.domain}\nEmail: ${selected.email || "N/A"}\nCategory: ${selected.category || "N/A"}\nRevenue: ${selected.estimated_revenue ? "$" + selected.estimated_revenue.toLocaleString() : "N/A"}\nCountry: ${selected.country || "N/A"}`,
        chunk => setAiOutput(chunk));
    } catch (err) { setAiOutput("Error: " + err.message); }
    setAiLoading(false);
  }

  async function handleBulkGenerate() {
    const targets = selectedContacts.filter(c => c.email);
    if (!targets.length) return;
    setBulkGenerating(true); setBulkEmails([]);
    const results = [];
    for (const c of targets) {
      try {
        const result = await callClaude(
          `You write personalised cold outreach emails. Return ONLY JSON: {"subject":"...","body":"..."}\nBrand voice: ${kb.brand?.tone || "direct, friendly"}`,
          `${bulkPrompt}\n\nContact: ${c.name || c.company}\nCompany: ${c.company}\nDomain: ${c.domain}\nEmail: ${c.email}\nCategory: ${c.category || "beauty"}\nRevenue: ${c.estimated_revenue ? "$" + c.estimated_revenue.toLocaleString() : "N/A"}\nCountry: ${c.country || "N/A"}`,
          () => {}, 400);
        try { const p = JSON.parse(result.replace(/```json|```/g, "").trim()); results.push({ contactId: c.id, name: c.name || c.company, email: c.email, subject: p.subject, body: p.body }); }
        catch { results.push({ contactId: c.id, name: c.name || c.company, email: c.email, subject: "Outreach", body: result }); }
      } catch (err) { results.push({ contactId: c.id, name: c.name || c.company, email: c.email, subject: "Error", body: err.message }); }
      setBulkEmails([...results]);
    }
    setBulkGenerating(false);
  }

  const fmtRev = v => v ? `$${(v / 1000).toFixed(0)}k` : "-";
  const fmtDate = d => d ? new Date(d).toLocaleDateString() : "-";

  const thStyle = { textAlign: "left", padding: "10px 10px", fontWeight: 600, color: theme.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: `2px solid ${theme.border}`, cursor: "pointer", whiteSpace: "nowrap", position: "sticky", top: 0, background: theme.surface, zIndex: 1 };
  const tdStyle = { padding: "10px 10px", color: theme.text, borderBottom: `1px solid ${theme.border}`, fontSize: 13, verticalAlign: "top" };
  const selectStyle = { padding: "8px 36px 8px 10px", borderRadius: 8, border: `1.5px solid ${theme.border}`, background: theme.bg, fontFamily: "inherit", fontSize: 13, color: theme.text, minWidth: 100 };
  const iconBtnStyle = { background: "none", border: "none", cursor: "pointer", padding: 4, borderRadius: 4, display: "flex", alignItems: "center", color: theme.textMuted };

  // Contact form (used in both add and edit modals)
  const contactForm = (
    <>
      <Row>
        <Col><Label>Name</Label><Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Brand / Contact name" /></Col>
        <Col><Label>Company</Label><Input value={form.company} onChange={e => setForm(f => ({ ...f, company: e.target.value }))} placeholder="Company" /></Col>
      </Row>
      <Row>
        <Col><Label>Domain</Label><Input value={form.domain} onChange={e => setForm(f => ({ ...f, domain: e.target.value }))} placeholder="example.com" /></Col>
        <Col><Label>Email</Label><Input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="email@example.com" /></Col>
      </Row>
      <Row>
        <Col><Label>Phone</Label><Input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="+1 ..." /></Col>
        <Col><Label>Role</Label><Input value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))} placeholder="Founder, Marketing..." /></Col>
      </Row>
      <Row>
        <Col><Label>Country</Label><Input value={form.country} onChange={e => setForm(f => ({ ...f, country: e.target.value }))} placeholder="US, UK" /></Col>
        <Col><Label>Stage</Label><select value={form.stage} onChange={e => setForm(f => ({ ...f, stage: e.target.value }))} style={{ ...selectStyle, width: "100%" }}>{CRM_STAGES.map(s => <option key={s} value={s}>{s}</option>)}</select></Col>
      </Row>
      <div style={{ marginTop: 8, display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Btn variant="outline" onClick={() => { setShowAddModal(false); setEditContact(null); }}>Cancel</Btn>
        <Btn onClick={handleSave}>{editContact ? "Save Changes" : "Add Contact"}</Btn>
      </div>
    </>
  );

  return (
    <div style={{ display: "flex", gap: 0, height: "calc(100vh - 140px)" }}>
      {/* Add Modal */}
      <Modal open={showAddModal} onClose={() => setShowAddModal(false)} title="Add Contact">{contactForm}</Modal>
      {/* Edit Modal */}
      <Modal open={!!editContact} onClose={() => setEditContact(null)} title="Edit Contact">{contactForm}</Modal>
      {/* Bulk Email Modal */}
      <Modal open={showBulkEmail} onClose={() => setShowBulkEmail(false)} title={`Bulk AI Emails (${selectedContacts.filter(c => c.email).length} contacts)`} width={700}>
        <Label>Email instructions (AI personalises for each lead)</Label>
        <Input multiline rows={2} value={bulkPrompt} onChange={e => setBulkPrompt(e.target.value)} />
        <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
          <Btn onClick={handleBulkGenerate} disabled={bulkGenerating}>
            {bulkGenerating ? `Generating ${bulkEmails.length}/${selectedContacts.filter(c => c.email).length}...` : "Generate Emails"}
          </Btn>
          {selectedContacts.filter(c => !c.email).length > 0 && <span style={{ fontSize: 12, color: "#F59E0B" }}>{selectedContacts.filter(c => !c.email).length} skipped (no email)</span>}
        </div>
        {bulkEmails.map((e, i) => (
          <div key={i} style={{ padding: "12px 0", borderBottom: `1px solid ${theme.border}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <div><span style={{ fontWeight: 600, fontSize: 13, color: theme.text }}>{e.name}</span><span style={{ color: theme.textMuted, fontSize: 12, marginLeft: 8 }}>{e.email}</span></div>
              <a href={`mailto:${e.email}?subject=${encodeURIComponent(e.subject)}&body=${encodeURIComponent(e.body)}`} style={{ fontSize: 12, color: theme.accent, textDecoration: "none", fontWeight: 600 }}>Open in Mail</a>
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>Subject: {e.subject}</div>
            <div style={{ fontSize: 13, color: theme.textMid, lineHeight: 1.6, whiteSpace: "pre-wrap", marginTop: 4 }}>{e.body}</div>
          </div>
        ))}
      </Modal>

      {/* Main table area */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexShrink: 0, flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>{totalCount}</span>
            <span style={{ fontSize: 13, color: theme.textMuted }}>contacts</span>
            {selectedIds.size > 0 && <span style={{ fontSize: 13, fontWeight: 600, color: theme.accent }}>{selectedIds.size} selected</span>}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {selectedIds.size > 0 && <Btn variant="outline" onClick={() => { setShowBulkEmail(true); setBulkEmails([]); }}><IconMail /> Emails ({selectedIds.size})</Btn>}
            <Btn onClick={openAdd}>+ Add Contact</Btn>
          </div>
        </div>

        {/* Filters */}
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexShrink: 0, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ flex: 1, minWidth: 200 }}><Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, company, domain, email..." style={{ marginBottom: 0 }} /></div>
          <select value={stageFilter} onChange={e => setStageFilter(e.target.value)} style={selectStyle}><option value="">All Stages</option>{CRM_STAGES.map(s => <option key={s} value={s}>{s}</option>)}</select>
          <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} style={selectStyle}><option value="">All Sources</option>{filterOptions.sources.map(s => <option key={s} value={s}>{s}</option>)}</select>
          <select value={countryFilter} onChange={e => setCountryFilter(e.target.value)} style={selectStyle}><option value="">All Countries</option>{filterOptions.countries.map(c => <option key={c} value={c}>{c}</option>)}</select>
        </div>

        {/* Table */}
        <div style={{ flex: 1, overflowY: "auto", border: `1px solid ${theme.border}`, borderRadius: 10, background: theme.surface }}>
          {loading ? <div style={{ textAlign: "center", color: theme.textMuted, padding: 40 }}>Loading...</div> :
          contacts.length === 0 ? <div style={{ textAlign: "center", color: theme.textMuted, padding: 40 }}>No contacts found</div> :
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: 36 }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "13%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "6%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "7%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "6%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: 60 }} />
            </colgroup>
            <thead><tr>
              <th style={{ ...thStyle, cursor: "default", textAlign: "center" }}><input type="checkbox" checked={selectedIds.size === contacts.length && contacts.length > 0} onChange={toggleAll} style={{ cursor: "pointer" }} /></th>
              <th style={thStyle} onClick={() => toggleSort("name")}>Brand{sortIcon("name")}</th>
              <th style={thStyle} onClick={() => toggleSort("email")}>Contact{sortIcon("email")}</th>
              <th style={thStyle} onClick={() => toggleSort("category")}>Category{sortIcon("category")}</th>
              <th style={thStyle} onClick={() => toggleSort("country")}>Country{sortIcon("country")}</th>
              <th style={thStyle} onClick={() => toggleSort("estimated_revenue")}>Revenue{sortIcon("estimated_revenue")}</th>
              <th style={thStyle} onClick={() => toggleSort("beauty_score")}>Score{sortIcon("beauty_score")}</th>
              <th style={thStyle} onClick={() => toggleSort("stage")}>Stage{sortIcon("stage")}</th>
              <th style={thStyle} onClick={() => toggleSort("source")}>Source{sortIcon("source")}</th>
              <th style={thStyle} onClick={() => toggleSort("created_at")}>Added{sortIcon("created_at")}</th>
              <th style={{ ...thStyle, cursor: "default" }}></th>
            </tr></thead>
            <tbody>
              {contacts.map(c => (
                <tr key={c.id} onClick={() => setSelected(selected?.id === c.id ? null : c)}
                  style={{ cursor: "pointer", background: selected?.id === c.id ? theme.accentLight : selectedIds.has(c.id) ? (theme.accentLight + "80") : "transparent" }}>
                  <td style={{ ...tdStyle, textAlign: "center" }} onClick={e => { e.stopPropagation(); toggleSelect(c.id); }}>
                    <input type="checkbox" checked={selectedIds.has(c.id)} onChange={() => {}} style={{ cursor: "pointer" }} />
                  </td>
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name || c.company || "-"}</div>
                    {c.domain && <div style={{ fontSize: 11, color: theme.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.domain}</div>}
                  </td>
                  <td style={tdStyle}>
                    {c.email && <div style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.email}</div>}
                    {c.role && <div style={{ fontSize: 11, color: theme.textMuted }}>{c.role}</div>}
                  </td>
                  <td style={{ ...tdStyle, fontSize: 12, color: theme.textMid, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.category || "-"}</td>
                  <td style={tdStyle}>{c.country || "-"}</td>
                  <td style={{ ...tdStyle, fontWeight: 600 }}>{fmtRev(c.estimated_revenue)}</td>
                  <td style={tdStyle}>{c.beauty_score != null ? <Tag color={c.beauty_score >= 0.7 ? "#10B981" : "#F59E0B"}>{Math.round(c.beauty_score * 100)}%</Tag> : "-"}</td>
                  <td style={tdStyle}>
                    <select value={c.stage} onChange={e => { e.stopPropagation(); handleStageChange(c.id, e.target.value); }}
                      onClick={e => e.stopPropagation()}
                      style={{ padding: "3px 24px 3px 6px", borderRadius: 6, border: `1px solid ${theme.border}`, background: theme.bg, fontSize: 11, color: theme.text, cursor: "pointer" }}>
                      {CRM_STAGES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  <td style={{ ...tdStyle, fontSize: 11, color: theme.textMuted }}>{c.source || "-"}</td>
                  <td style={{ ...tdStyle, fontSize: 11, color: theme.textMuted }}>{fmtDate(c.created_at)}</td>
                  <td style={tdStyle} onClick={e => e.stopPropagation()}>
                    <div style={{ display: "flex", gap: 2 }}>
                      <button style={iconBtnStyle} title="Edit" onClick={() => openEdit(c)}><IconEdit /></button>
                      <button style={{ ...iconBtnStyle, color: "#EF4444" }} title="Delete" onClick={() => handleDelete(c.id)}><IconTrash /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>}
        </div>

        {/* Pagination */}
        {!loading && totalCount > 0 && (
          <Pagination
            page={page} pageSize={pageSize} total={totalCount}
            onPageChange={p => { setPage(p); setSelectedIds(new Set()); }}
            onPageSizeChange={ps => { setPageSize(ps); }}
          />
        )}
      </div>

      {/* Detail panel */}
      {selected && (
        <div style={{ width: 360, flexShrink: 0, marginLeft: 16, overflowY: "auto", height: "100%" }}>
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16, color: theme.text }}>{selected.name || selected.company}</div>
                {selected.company && selected.name !== selected.company && <div style={{ fontSize: 13, color: theme.textMid }}>{selected.company}</div>}
              </div>
              <button onClick={() => setSelected(null)} style={{ background: "none", border: "none", cursor: "pointer", color: theme.textMuted, fontSize: 18 }}>x</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px", fontSize: 12, marginBottom: 16 }}>
              {[["Domain", selected.domain], ["Email", selected.email], ["Phone", selected.phone], ["Role", selected.role], ["Country", selected.country], ["Source", selected.source], ["Category", selected.category], ["Products", selected.product_count], ["AOV", selected.aov ? `$${selected.aov}` : null], ["Score", selected.beauty_score != null ? `${Math.round(selected.beauty_score * 100)}%` : null], ["Revenue", selected.estimated_revenue ? `$${selected.estimated_revenue.toLocaleString()}/mo` : null], ["Added", fmtDate(selected.created_at)]].map(([l, v]) => v ? <div key={l}><div style={{ color: theme.textMuted, fontSize: 11, marginBottom: 2 }}>{l}</div><div style={{ color: theme.text, fontWeight: 500, wordBreak: "break-all" }}>{v}</div></div> : null)}
            </div>
            <Label>Stage</Label>
            <select value={selected.stage} onChange={e => handleStageChange(selected.id, e.target.value)} style={{ ...selectStyle, width: "100%", marginBottom: 16 }}>{CRM_STAGES.map(s => <option key={s} value={s}>{s}</option>)}</select>
          </Card>
          <Card>
            <SectionTitle>Notes</SectionTitle>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}><div style={{ flex: 1 }}><Input value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="Add a note..." /></div><Btn size="sm" onClick={handleAddNote}>Add</Btn></div>
            {notes.length === 0 && <div style={{ color: theme.textMuted, fontSize: 12 }}>No notes</div>}
            {notes.map(n => <div key={n.id} style={{ padding: "6px 0", borderBottom: `1px solid ${theme.border}`, fontSize: 12 }}><div style={{ color: theme.text }}>{n.text}</div><div style={{ color: theme.textMuted, fontSize: 11, marginTop: 2 }}>{new Date(n.created_at).toLocaleString()}</div></div>)}
          </Card>
          <Card>
            <SectionTitle>AI Outreach</SectionTitle>
            <Btn size="sm" onClick={handleAIOutreach} disabled={aiLoading}>{aiLoading ? "Generating..." : "Generate Email"}</Btn>
            <AIOutput loading={aiLoading} output={aiOutput} />
          </Card>
          <Card>
            <SectionTitle>Activity</SectionTitle>
            {activities.length === 0 && <div style={{ color: theme.textMuted, fontSize: 12 }}>No activity</div>}
            {activities.map(a => <div key={a.id} style={{ padding: "4px 0", fontSize: 12, borderBottom: `1px solid ${theme.border}` }}><span style={{ color: theme.textMid }}>{a.description}</span><div style={{ color: theme.textMuted, fontSize: 11 }}>{new Date(a.created_at).toLocaleString()}</div></div>)}
          </Card>
        </div>
      )}
    </div>
  );
}
