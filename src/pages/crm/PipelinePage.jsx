import { useState, useEffect, useCallback } from "react";
import { Card } from "../../components/ui/Card";
import { Btn } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Tag } from "../../components/ui/Tag";
import { Modal } from "../../components/ui/Modal";
import { Label, SectionTitle } from "../../components/ui/Label";
import { useAuth } from "../../contexts/AuthContext";
import { supabase } from "../../lib/supabase";
import { CRM_STAGES, CRM_STAGE_COLORS } from "../../lib/constants";
import { useTheme } from "../../contexts/ThemeContext";

const COL_WIDTH = 260;
const LS_KEY = "pipeline-card-fields";

const CARD_FIELDS = [
  { key: "name", label: "Contact Name" },
  { key: "domain", label: "Domain" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "role", label: "Role" },
  { key: "country", label: "Country" },
  { key: "category", label: "Category" },
  { key: "estimated_revenue", label: "Revenue" },
  { key: "beauty_score", label: "Score" },
  { key: "source", label: "Source" },
  { key: "product_count", label: "Products" },
  { key: "aov", label: "AOV" },
  { key: "contact_email", label: "Contact Email" },
  { key: "value", label: "Deal Value", from: "deal" },
  { key: "created_at", label: "Date Added", from: "deal" },
];

const DEFAULT_VISIBLE = ["domain", "value", "created_at"];

function loadVisibleFields() {
  try { const v = JSON.parse(localStorage.getItem(LS_KEY)); return Array.isArray(v) ? v : DEFAULT_VISIBLE; }
  catch { return DEFAULT_VISIBLE; }
}

function formatVal(key, v) {
  if (v == null || v === "") return null;
  if (key === "estimated_revenue" || key === "value") return `$${Number(v).toLocaleString()}`;
  if (key === "beauty_score") return `${Math.round(v * 100)}%`;
  if (key === "aov") return `$${v}`;
  if (key === "created_at") return new Date(v).toLocaleDateString();
  return String(v);
}

function getVal(deal, field) {
  if (field.from === "deal") return deal[field.key];
  return deal.contacts?.[field.key];
}

export default function PipelinePage() {
  const { theme } = useTheme();
  const { profile } = useAuth();
  const teamId = profile?.team_id;

  const [deals, setDeals] = useState([]);
  const [loading, setLoading] = useState(true);

  // Drag & drop
  const [dragOverStage, setDragOverStage] = useState(null);
  const [draggingId, setDraggingId] = useState(null);

  // Detail panel
  const [selected, setSelected] = useState(null);
  const [notes, setNotes] = useState([]);
  const [activities, setActivities] = useState([]);
  const [noteText, setNoteText] = useState("");

  // Card field config
  const [visibleFields, setVisibleFields] = useState(loadVisibleFields);
  const [showFieldConfig, setShowFieldConfig] = useState(false);

  const fetchDeals = useCallback(async () => {
    if (!teamId) return;
    setLoading(true);
    const { data } = await supabase.from("deals").select("*, contacts(*)").eq("team_id", teamId).order("created_at", { ascending: false });
    setDeals(data || []);
    setLoading(false);
  }, [teamId]);

  useEffect(() => { fetchDeals(); }, [fetchDeals]);

  // Load notes & activities for selected deal's contact
  useEffect(() => {
    if (!selected?.contact_id) { setNotes([]); setActivities([]); return; }
    (async () => {
      const [n, a] = await Promise.all([
        supabase.from("notes").select("*").eq("contact_id", selected.contact_id).order("created_at", { ascending: false }),
        supabase.from("activities").select("*").eq("contact_id", selected.contact_id).order("created_at", { ascending: false }),
      ]);
      setNotes(n.data || []);
      setActivities(a.data || []);
    })();
  }, [selected?.contact_id]);

  async function handleStageChange(dealId, newStage) {
    const { data } = await supabase.from("deals").update({ stage: newStage, updated_at: new Date().toISOString() }).eq("id", dealId).select("*, contacts(*)").single();
    if (data) {
      setDeals(prev => prev.map(d => d.id === dealId ? data : d));
      if (selected?.id === dealId) setSelected(data);
    }
  }

  async function handleValueChange(dealId, newValue) {
    const v = parseFloat(newValue) || 0;
    const { data } = await supabase.from("deals").update({ value: v, updated_at: new Date().toISOString() }).eq("id", dealId).select("*, contacts(*)").single();
    if (data) {
      setDeals(prev => prev.map(d => d.id === dealId ? data : d));
      if (selected?.id === dealId) setSelected(data);
    }
  }

  async function handleAddNote() {
    if (!noteText.trim() || !selected?.contact_id) return;
    const { data } = await supabase.from("notes").insert({ contact_id: selected.contact_id, team_id: teamId, text: noteText.trim() }).select().single();
    if (data) {
      setNotes(prev => [data, ...prev]);
      await supabase.from("activities").insert({ contact_id: selected.contact_id, team_id: teamId, type: "note_added", description: "Note added" });
      setNoteText("");
    }
  }

  function toggleField(key) {
    setVisibleFields(prev => {
      const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key];
      localStorage.setItem(LS_KEY, JSON.stringify(next));
      return next;
    });
  }

  // Drag handlers
  function onDragStart(e, dealId) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dealId);
    setDraggingId(dealId);
  }
  function onDragEnd() { setDraggingId(null); setDragOverStage(null); }
  function onDragOver(e, stage) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOverStage(stage); }
  function onDragLeave(e, stage) { if (!e.currentTarget.contains(e.relatedTarget)) setDragOverStage(prev => prev === stage ? null : prev); }
  function onDrop(e, stage) {
    e.preventDefault();
    const dealId = e.dataTransfer.getData("text/plain");
    if (dealId) handleStageChange(dealId, stage);
    setDragOverStage(null);
    setDraggingId(null);
  }

  const dealsByStage = CRM_STAGES.reduce((acc, stage) => { acc[stage] = deals.filter(d => d.stage === stage); return acc; }, {});
  const totalValue = deals.reduce((s, d) => s + (d.value || 0), 0);
  const wonValue = deals.filter(d => d.stage === "Won").reduce((s, d) => s + (d.value || 0), 0);

  const fmtRev = v => v ? `$${Number(v).toLocaleString()}` : "-";
  const fmtDate = d => d ? new Date(d).toLocaleDateString() : "-";
  const contact = selected?.contacts;

  const activeFields = CARD_FIELDS.filter(f => visibleFields.includes(f.key));

  return (
    <div style={{ display: "flex", gap: 0, height: "calc(100vh - 140px)" }}>
      {/* Field config modal */}
      <Modal open={showFieldConfig} onClose={() => setShowFieldConfig(false)} title="Card Display Fields" width={360}>
        <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 12 }}>Choose which fields appear on deal cards.</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {CARD_FIELDS.map(f => (
            <label key={f.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, cursor: "pointer", background: visibleFields.includes(f.key) ? theme.accentLight : "transparent" }}>
              <input type="checkbox" checked={visibleFields.includes(f.key)} onChange={() => toggleField(f.key)} style={{ cursor: "pointer" }} />
              <span style={{ fontSize: 13, color: theme.text }}>{f.label}</span>
              <span style={{ fontSize: 11, color: theme.textMuted, marginLeft: "auto" }}>{f.from === "deal" ? "Deal" : "Contact"}</span>
            </label>
          ))}
        </div>
      </Modal>

      {/* Main kanban area */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {/* Stats bar */}
        <div style={{ display: "flex", gap: 20, alignItems: "center", marginBottom: 16, flexShrink: 0, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>{deals.length} deals</span>
          <span style={{ fontSize: 13, color: theme.textMuted }}>Total: ${totalValue.toLocaleString()}</span>
          <span style={{ fontSize: 13, color: "#10B981", fontWeight: 600 }}>Won: ${wonValue.toLocaleString()}</span>
          <div style={{ marginLeft: "auto" }}>
            <Btn variant="outline" size="sm" onClick={() => setShowFieldConfig(true)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
              {" "}Card Fields
            </Btn>
          </div>
        </div>

        {loading ? (
          <Card><div style={{ textAlign: "center", color: theme.textMuted, padding: 40 }}>Loading pipeline...</div></Card>
        ) : (
          /* Kanban board */
          <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
            <div style={{ display: "flex", gap: 12, minWidth: "min-content" }}>
              {CRM_STAGES.map(stage => {
                const stageDeals = dealsByStage[stage] || [];
                const stageValue = stageDeals.reduce((s, d) => s + (d.value || 0), 0);
                const sc = CRM_STAGE_COLORS[stage] || theme.accent;
                const isOver = dragOverStage === stage;
                return (
                  <div key={stage} style={{ minWidth: COL_WIDTH, flex: `0 0 ${COL_WIDTH}px`, display: "flex", flexDirection: "column" }}>
                    {/* Sticky column header */}
                    <div style={{ position: "sticky", top: 0, zIndex: 1, background: theme.bg, paddingBottom: 8 }}>
                      <div style={{ borderTop: `3px solid ${sc}`, borderRadius: "8px 8px 0 0", background: theme.surface, padding: "10px 14px", border: `1px solid ${theme.border}`, borderBottom: "none" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ fontWeight: 600, fontSize: 13, color: theme.text }}>{stage}</span>
                          <span style={{ fontSize: 12, fontWeight: 600, color: theme.textMuted, background: theme.surfaceAlt, borderRadius: 10, padding: "2px 8px" }}>{stageDeals.length}</span>
                        </div>
                        {stageValue > 0 && <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 2 }}>${stageValue.toLocaleString()}</div>}
                      </div>
                    </div>
                    {/* Drop zone */}
                    <div
                      onDragOver={e => onDragOver(e, stage)}
                      onDragLeave={e => onDragLeave(e, stage)}
                      onDrop={e => onDrop(e, stage)}
                      style={{
                        display: "flex", flexDirection: "column", gap: 8, paddingBottom: 20, flex: 1,
                        borderRadius: 8, transition: "background 0.15s, outline 0.15s",
                        outline: isOver ? `2px dashed ${sc}` : "2px dashed transparent",
                        background: isOver ? (theme.accentLight + "80") : "transparent",
                        padding: isOver ? 8 : 0,
                      }}
                    >
                      {stageDeals.length === 0 && !isOver ? (
                        <div style={{ padding: 20, textAlign: "center", color: theme.textMuted, fontSize: 12, background: theme.surfaceAlt, borderRadius: 8, border: `1px dashed ${theme.border}` }}>
                          No deals
                        </div>
                      ) : stageDeals.map(deal => (
                        <div
                          key={deal.id}
                          draggable
                          onDragStart={e => onDragStart(e, deal.id)}
                          onDragEnd={onDragEnd}
                          onClick={() => setSelected(selected?.id === deal.id ? null : deal)}
                          style={{
                            background: theme.surface,
                            border: `1px solid ${selected?.id === deal.id ? sc : theme.border}`,
                            borderRadius: 10, padding: 14, boxShadow: theme.shadow,
                            cursor: "grab", userSelect: "none",
                            opacity: draggingId === deal.id ? 0.5 : 1,
                            transition: "opacity 0.15s, border-color 0.15s",
                          }}
                        >
                          <div style={{ fontWeight: 600, fontSize: 13, color: theme.text, marginBottom: 2 }}>{deal.contacts?.name || deal.contacts?.company || "(Unknown)"}</div>
                          {activeFields.map(f => {
                            const v = formatVal(f.key, getVal(deal, f));
                            if (!v) return null;
                            return (
                              <div key={f.key} style={{ fontSize: 11, color: f.key === "value" ? sc : theme.textMuted, fontWeight: f.key === "value" ? 700 : 400, marginTop: 2 }}>
                                {f.key === "value" ? v : <><span style={{ color: theme.textMuted }}>{f.label}: </span>{v}</>}
                              </div>
                            );
                          })}
                        </div>
                      ))}
                      {isOver && stageDeals.length === 0 && (
                        <div style={{ padding: 20, textAlign: "center", color: theme.textMuted, fontSize: 12 }}>
                          Drop here
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Detail panel */}
      {selected && contact && (
        <div style={{ width: 360, flexShrink: 0, marginLeft: 16, overflowY: "auto", height: "100%" }}>
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16, color: theme.text }}>{contact.name || contact.company}</div>
                {contact.company && contact.name !== contact.company && <div style={{ fontSize: 13, color: theme.textMid }}>{contact.company}</div>}
              </div>
              <button onClick={() => setSelected(null)} style={{ background: "none", border: "none", cursor: "pointer", color: theme.textMuted, fontSize: 18 }}>x</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px", fontSize: 12, marginBottom: 16 }}>
              {[
                ["Domain", contact.domain], ["Email", contact.email], ["Phone", contact.phone],
                ["Role", contact.role], ["Country", contact.country], ["Source", contact.source],
                ["Category", contact.category], ["Products", contact.product_count],
                ["AOV", contact.aov ? `$${contact.aov}` : null],
                ["Score", contact.beauty_score != null ? `${Math.round(contact.beauty_score * 100)}%` : null],
                ["Revenue", contact.estimated_revenue ? `$${Number(contact.estimated_revenue).toLocaleString()}/mo` : null],
                ["Added", fmtDate(contact.created_at)],
              ].map(([l, v]) => v ? (
                <div key={l}>
                  <div style={{ color: theme.textMuted, fontSize: 11, marginBottom: 2 }}>{l}</div>
                  <div style={{ color: theme.text, fontWeight: 500, wordBreak: "break-all" }}>{v}</div>
                </div>
              ) : null)}
            </div>

            <Label>Deal Value</Label>
            <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 12 }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: theme.text }}>$</span>
              <input
                type="number" min="0" step="100"
                value={selected.value || 0}
                onChange={e => {
                  const v = parseFloat(e.target.value) || 0;
                  setSelected(prev => ({ ...prev, value: v }));
                  setDeals(prev => prev.map(d => d.id === selected.id ? { ...d, value: v } : d));
                }}
                onBlur={() => handleValueChange(selected.id, selected.value)}
                style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: `1px solid ${theme.border}`, backgroundColor: theme.bg, fontSize: 15, fontWeight: 600, color: theme.text, fontFamily: "inherit" }}
              />
            </div>

            <Label>Stage</Label>
            <select value={selected.stage} onChange={e => handleStageChange(selected.id, e.target.value)}
              style={{ width: "100%", padding: "8px 28px 8px 10px", borderRadius: 8, border: `1px solid ${theme.border}`, backgroundColor: theme.bg, fontSize: 13, color: theme.text, cursor: "pointer", marginBottom: 16 }}>
              {CRM_STAGES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </Card>
          <Card>
            <SectionTitle>Notes</SectionTitle>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <div style={{ flex: 1 }}><Input value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="Add a note..." /></div>
              <Btn size="sm" onClick={handleAddNote}>Add</Btn>
            </div>
            {notes.length === 0 && <div style={{ color: theme.textMuted, fontSize: 12 }}>No notes</div>}
            {notes.map(n => (
              <div key={n.id} style={{ padding: "6px 0", borderBottom: `1px solid ${theme.border}`, fontSize: 12 }}>
                <div style={{ color: theme.text }}>{n.text}</div>
                <div style={{ color: theme.textMuted, fontSize: 11, marginTop: 2 }}>{new Date(n.created_at).toLocaleString()}</div>
              </div>
            ))}
          </Card>
          <Card>
            <SectionTitle>Activity</SectionTitle>
            {activities.length === 0 && <div style={{ color: theme.textMuted, fontSize: 12 }}>No activity</div>}
            {activities.map(a => (
              <div key={a.id} style={{ padding: "4px 0", fontSize: 12, borderBottom: `1px solid ${theme.border}` }}>
                <span style={{ color: theme.textMid }}>{a.description}</span>
                <div style={{ color: theme.textMuted, fontSize: 11 }}>{new Date(a.created_at).toLocaleString()}</div>
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}
