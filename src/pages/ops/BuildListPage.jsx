import { useState } from "react";
import { Btn } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { Tag } from "../../components/ui/Tag";
import { TabBar } from "../../components/ui/TabBar";
import { Label, SectionTitle, Row, Col } from "../../components/ui/Label";
import { AIOutput } from "../../components/ui/AIOutput";
import { ProgressBar } from "../../components/ui/ProgressBar";
import { KBBadge } from "../../components/ui/KBBadge";
import { useKB } from "../../contexts/KBContext";
import { callClaude } from "../../lib/claude";
import { OPS_PHASES } from "../../lib/constants";
import { useTheme } from "../../contexts/ThemeContext";


const WATERFALL_LEVELS = [
  { id: "l1", label: "L1 - Source", desc: "Identify target companies from ICP criteria" },
  { id: "l2", label: "L2 - Validate", desc: "Confirm company fits ICP (industry, size, revenue)" },
  { id: "l3", label: "L3 - Enrich", desc: "Add firmographic data (tech stack, funding, headcount)" },
  { id: "l4", label: "L4 - Find Contacts", desc: "Identify decision-makers and their roles" },
  { id: "l5", label: "L5 - Verify Emails", desc: "Validate email deliverability" },
  { id: "l6", label: "L6 - Score & Prioritise", desc: "Rank leads by fit and intent signals" },
];

const TABS = [
  ["waterfall", "Waterfall"],
  ["leads", "Lead List"],
  ["ai", "AI Sourcing"],
];

export default function BuildListPage() {
  const { theme } = useTheme();
  const COLOR = theme.accent;
  const { kb } = useKB();
  const thStyle = { textAlign: "left", padding: "8px 10px", fontWeight: 600, color: theme.textMid, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 };
  const tdStyle = { padding: "10px 10px", color: theme.text };
  const [tab, setTab] = useState("waterfall");
  const [levels, setLevels] = useState(() =>
    WATERFALL_LEVELS.reduce((acc, l) => ({ ...acc, [l.id]: { done: false, count: 0, notes: "" } }), {})
  );
  const [leads, setLeads] = useState([]);
  const [newLead, setNewLead] = useState({ company: "", domain: "", contact: "", email: "", role: "" });
  const [aiLoading, setAiLoading] = useState(false);
  const [aiOutput, setAiOutput] = useState("");

  const doneLevels = Object.values(levels).filter(l => l.done).length;
  const pct = Math.round((doneLevels / WATERFALL_LEVELS.length) * 100);

  function toggleLevel(id) {
    setLevels(prev => ({ ...prev, [id]: { ...prev[id], done: !prev[id].done } }));
  }

  function addLead() {
    if (!newLead.company && !newLead.domain) return;
    setLeads(prev => [...prev, { ...newLead, id: Date.now(), score: "-" }]);
    setNewLead({ company: "", domain: "", contact: "", email: "", role: "" });
  }

  function removeLead(id) {
    setLeads(prev => prev.filter(l => l.id !== id));
  }

  async function aiSourceLeads() {
    setAiLoading(true);
    setAiOutput("");
    const systemPrompt = `You are an expert B2B lead researcher for a link-building / digital PR agency. Given the ICP, suggest 10 highly targeted companies with reasoning. Format as a numbered list with: Company Name | Domain | Why they fit. Be specific, not generic.`;
    const userMessage = `ICP:\n${JSON.stringify(kb.icp, null, 2)}\n\nService:\n${JSON.stringify(kb.service, null, 2)}`;
    try {
      await callClaude(systemPrompt, userMessage, chunk => setAiOutput(chunk));
    } catch (err) {
      setAiOutput("Error: " + err.message);
    }
    setAiLoading(false);
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h2 style={{ margin: 0, color: theme.text, fontSize: 22 }}>Build List</h2>
          <p style={{ margin: "4px 0 0", color: theme.textMuted, fontSize: 13 }}>Source, validate, enrich, and verify leads using a 6-level waterfall</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <KBBadge label="ICP" filled={!!kb.icp.industry} color={COLOR} />
          <KBBadge label="Service" filled={!!kb.service.deliverables} color={COLOR} />
        </div>
      </div>

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <SectionTitle color={COLOR}>Waterfall Progress</SectionTitle>
          <span style={{ fontSize: 13, fontWeight: 700, color: COLOR }}>{doneLevels}/{WATERFALL_LEVELS.length} levels</span>
        </div>
        <ProgressBar pct={pct} color={COLOR} />
      </Card>

      <TabBar tabs={TABS} active={tab} onSelect={setTab} />

      {/* Waterfall Tab */}
      {tab === "waterfall" && (
        <div>
          {WATERFALL_LEVELS.map(level => (
            <Card key={level.id}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
                <div
                  onClick={() => toggleLevel(level.id)}
                  style={{
                    width: 28, height: 28, borderRadius: 8, flexShrink: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: levels[level.id].done ? COLOR : theme.surfaceAlt,
                    color: levels[level.id].done ? "#fff" : theme.textMuted,
                    cursor: "pointer", fontWeight: 700, fontSize: 14,
                    border: `1.5px solid ${levels[level.id].done ? COLOR : theme.border}`,
                    transition: "all 0.15s",
                  }}
                >
                  {levels[level.id].done ? "\u2713" : ""}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: theme.text, marginBottom: 2 }}>{level.label}</div>
                  <div style={{ fontSize: 13, color: theme.textMid, marginBottom: 8 }}>{level.desc}</div>
                  <Input
                    value={levels[level.id].notes}
                    onChange={e => setLevels(prev => ({ ...prev, [level.id]: { ...prev[level.id], notes: e.target.value } }))}
                    placeholder="Notes for this level..."
                  />
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Lead List Tab */}
      {tab === "leads" && (
        <div>
          <Card>
            <SectionTitle color={COLOR}>Add Lead</SectionTitle>
            <Row>
              <Col>
                <Label>Company</Label>
                <Input value={newLead.company} onChange={e => setNewLead(l => ({ ...l, company: e.target.value }))} placeholder="Company name" />
              </Col>
              <Col>
                <Label>Domain</Label>
                <Input value={newLead.domain} onChange={e => setNewLead(l => ({ ...l, domain: e.target.value }))} placeholder="example.com" />
              </Col>
            </Row>
            <Row>
              <Col>
                <Label>Contact Name</Label>
                <Input value={newLead.contact} onChange={e => setNewLead(l => ({ ...l, contact: e.target.value }))} placeholder="Full name" />
              </Col>
              <Col>
                <Label>Email</Label>
                <Input value={newLead.email} onChange={e => setNewLead(l => ({ ...l, email: e.target.value }))} placeholder="email@example.com" />
              </Col>
            </Row>
            <Row>
              <Col>
                <Label>Role</Label>
                <Input value={newLead.role} onChange={e => setNewLead(l => ({ ...l, role: e.target.value }))} placeholder="CEO, Head of Marketing..." />
              </Col>
              <Col />
            </Row>
            <div style={{ marginTop: 8 }}>
              <Btn color={COLOR} onClick={addLead}>Add to List</Btn>
            </div>
          </Card>

          {leads.length > 0 && (
            <Card>
              <SectionTitle color={COLOR}>Lead List ({leads.length})</SectionTitle>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: `2px solid ${theme.border}` }}>
                      <th style={thStyle}>Company</th>
                      <th style={thStyle}>Domain</th>
                      <th style={thStyle}>Contact</th>
                      <th style={thStyle}>Email</th>
                      <th style={thStyle}>Role</th>
                      <th style={thStyle}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leads.map(lead => (
                      <tr key={lead.id} style={{ borderBottom: `1px solid ${theme.border}` }}>
                        <td style={tdStyle}>{lead.company}</td>
                        <td style={tdStyle}>{lead.domain}</td>
                        <td style={tdStyle}>{lead.contact}</td>
                        <td style={tdStyle}>{lead.email}</td>
                        <td style={tdStyle}><Tag color={COLOR}>{lead.role || "-"}</Tag></td>
                        <td style={tdStyle}>
                          <Btn size="sm" color="#EF4444" variant="outline" onClick={() => removeLead(lead.id)}>Remove</Btn>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {leads.length === 0 && (
            <Card>
              <div style={{ textAlign: "center", color: theme.textMuted, padding: 24 }}>No leads added yet. Add manually above or use AI Sourcing.</div>
            </Card>
          )}
        </div>
      )}

      {/* AI Sourcing Tab */}
      {tab === "ai" && (
        <Card>
          <SectionTitle color={COLOR}>AI Lead Sourcing</SectionTitle>
          <p style={{ fontSize: 13, color: theme.textMid, marginBottom: 16 }}>
            Use your ICP knowledge base to generate a targeted list of prospect companies.
          </p>
          <Btn color={COLOR} onClick={aiSourceLeads} disabled={aiLoading || !kb.icp.industry}>
            {aiLoading ? "Sourcing..." : "Generate Lead Suggestions"}
          </Btn>
          <AIOutput loading={aiLoading} output={aiOutput} accentColor={COLOR} />
        </Card>
      )}
    </div>
  );
}

