import { useState } from "react";
import { Btn } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { Tag } from "../../components/ui/Tag";
import { TabBar } from "../../components/ui/TabBar";
import { Label, SectionTitle, Row, Col } from "../../components/ui/Label";
import { AIOutput } from "../../components/ui/AIOutput";
import { KBBadge } from "../../components/ui/KBBadge";
import { useKB } from "../../contexts/KBContext";
import { callClaude } from "../../lib/claude";
import { OPS_PHASES } from "../../lib/constants";
import { useTheme } from "../../contexts/ThemeContext";


const TABS = [
  ["deliverables", "Deliverables"],
  ["competitors", "Competitor Map"],
  ["offer", "Offer Package"],
];

export default function BuildOfferPage() {
  const { theme } = useTheme();
  const COLOR = theme.accent;
  const { kb } = useKB();
  const [tab, setTab] = useState("deliverables");
  const [deliverables, setDeliverables] = useState([]);
  const [newDel, setNewDel] = useState({ name: "", description: "", price: "" });
  const [competitors, setCompetitors] = useState([]);
  const [newComp, setNewComp] = useState({ name: "", strengths: "", weaknesses: "", pricing: "" });
  const [aiLoading, setAiLoading] = useState(false);
  const [aiOutput, setAiOutput] = useState("");

  function addDeliverable() {
    if (!newDel.name) return;
    setDeliverables(prev => [...prev, { ...newDel, id: Date.now() }]);
    setNewDel({ name: "", description: "", price: "" });
  }

  function removeDeliverable(id) {
    setDeliverables(prev => prev.filter(d => d.id !== id));
  }

  function addCompetitor() {
    if (!newComp.name) return;
    setCompetitors(prev => [...prev, { ...newComp, id: Date.now() }]);
    setNewComp({ name: "", strengths: "", weaknesses: "", pricing: "" });
  }

  function removeCompetitor(id) {
    setCompetitors(prev => prev.filter(c => c.id !== id));
  }

  async function generateOffer() {
    setAiLoading(true);
    setAiOutput("");
    const systemPrompt = `You are a B2B offer strategist for a link-building / digital PR agency. Given the ICP, service profile, deliverables, and competitor analysis, generate a compelling offer package. Include: package name, headline, 3-5 bullet points of what's included, pricing recommendation, guarantee/risk-reversal, and urgency element. Make it irresistible.`;
    const userMessage = `ICP:\n${JSON.stringify(kb.icp, null, 2)}\n\nService:\n${JSON.stringify(kb.service, null, 2)}\n\nDeliverables:\n${deliverables.map(d => `- ${d.name}: ${d.description} ($${d.price})`).join("\n") || "None added yet"}\n\nCompetitors:\n${competitors.map(c => `- ${c.name}: Strengths: ${c.strengths}, Weaknesses: ${c.weaknesses}, Pricing: ${c.pricing}`).join("\n") || "None mapped yet"}`;
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
          <h2 style={{ margin: 0, color: theme.text, fontSize: 22 }}>Build Offer</h2>
          <p style={{ margin: "4px 0 0", color: theme.textMuted, fontSize: 13 }}>Map deliverables to competitors and generate a full offer package</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <KBBadge label="ICP" filled={!!kb.icp.industry} color={COLOR} />
          <KBBadge label="Service" filled={!!kb.service.deliverables} color={COLOR} />
        </div>
      </div>

      <TabBar tabs={TABS} active={tab} onSelect={setTab} />

      {/* Deliverables Tab */}
      {tab === "deliverables" && (
        <div>
          <Card>
            <SectionTitle color={COLOR}>Add Deliverable</SectionTitle>
            <Row>
              <Col>
                <Label>Deliverable Name</Label>
                <Input value={newDel.name} onChange={e => setNewDel(d => ({ ...d, name: e.target.value }))} placeholder="e.g. Monthly Link Building" />
              </Col>
              <Col>
                <Label>Price</Label>
                <Input value={newDel.price} onChange={e => setNewDel(d => ({ ...d, price: e.target.value }))} placeholder="e.g. 2500" />
              </Col>
            </Row>
            <Label>Description</Label>
            <Input multiline rows={2} value={newDel.description} onChange={e => setNewDel(d => ({ ...d, description: e.target.value }))} placeholder="What's included in this deliverable?" />
            <div style={{ marginTop: 10 }}>
              <Btn color={COLOR} onClick={addDeliverable}>Add Deliverable</Btn>
            </div>
          </Card>

          {deliverables.length > 0 ? (
            <Card>
              <SectionTitle color={COLOR}>Deliverables ({deliverables.length})</SectionTitle>
              {deliverables.map(d => (
                <div key={d.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "12px 0", borderBottom: `1px solid ${theme.border}` }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14, color: theme.text }}>{d.name}</div>
                    <div style={{ fontSize: 13, color: theme.textMid, marginTop: 2 }}>{d.description}</div>
                    {d.price && <Tag color={COLOR}>${d.price}</Tag>}
                  </div>
                  <Btn size="sm" color="#EF4444" variant="outline" onClick={() => removeDeliverable(d.id)}>Remove</Btn>
                </div>
              ))}
            </Card>
          ) : (
            <Card>
              <div style={{ textAlign: "center", color: theme.textMuted, padding: 24 }}>No deliverables added yet</div>
            </Card>
          )}
        </div>
      )}

      {/* Competitor Map Tab */}
      {tab === "competitors" && (
        <div>
          <Card>
            <SectionTitle color={COLOR}>Map a Competitor</SectionTitle>
            <Row>
              <Col>
                <Label>Competitor Name</Label>
                <Input value={newComp.name} onChange={e => setNewComp(c => ({ ...c, name: e.target.value }))} placeholder="e.g. Agency X" />
              </Col>
              <Col>
                <Label>Pricing</Label>
                <Input value={newComp.pricing} onChange={e => setNewComp(c => ({ ...c, pricing: e.target.value }))} placeholder="e.g. $3000/mo" />
              </Col>
            </Row>
            <Row>
              <Col>
                <Label>Strengths</Label>
                <Input multiline rows={2} value={newComp.strengths} onChange={e => setNewComp(c => ({ ...c, strengths: e.target.value }))} placeholder="What they do well" />
              </Col>
              <Col>
                <Label>Weaknesses</Label>
                <Input multiline rows={2} value={newComp.weaknesses} onChange={e => setNewComp(c => ({ ...c, weaknesses: e.target.value }))} placeholder="Where they fall short" />
              </Col>
            </Row>
            <div style={{ marginTop: 10 }}>
              <Btn color={COLOR} onClick={addCompetitor}>Add Competitor</Btn>
            </div>
          </Card>

          {competitors.length > 0 ? (
            <Card>
              <SectionTitle color={COLOR}>Competitor Map ({competitors.length})</SectionTitle>
              {competitors.map(c => (
                <div key={c.id} style={{ padding: "12px 0", borderBottom: `1px solid ${theme.border}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div style={{ fontWeight: 600, fontSize: 14, color: theme.text }}>{c.name}</div>
                    <Btn size="sm" color="#EF4444" variant="outline" onClick={() => removeCompetitor(c.id)}>Remove</Btn>
                  </div>
                  {c.pricing && <Tag color={COLOR}>{c.pricing}</Tag>}
                  <Row>
                    <Col>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#10B981", marginTop: 8 }}>Strengths</div>
                      <div style={{ fontSize: 13, color: theme.textMid }}>{c.strengths || "-"}</div>
                    </Col>
                    <Col>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#EF4444", marginTop: 8 }}>Weaknesses</div>
                      <div style={{ fontSize: 13, color: theme.textMid }}>{c.weaknesses || "-"}</div>
                    </Col>
                  </Row>
                </div>
              ))}
            </Card>
          ) : (
            <Card>
              <div style={{ textAlign: "center", color: theme.textMuted, padding: 24 }}>No competitors mapped yet</div>
            </Card>
          )}
        </div>
      )}

      {/* Offer Package Tab */}
      {tab === "offer" && (
        <Card>
          <SectionTitle color={COLOR}>AI Offer Generator</SectionTitle>
          <p style={{ fontSize: 13, color: theme.textMid, marginBottom: 16 }}>
            Generate a full offer package using your ICP, service profile, deliverables, and competitor analysis.
          </p>
          <Btn color={COLOR} onClick={generateOffer} disabled={aiLoading}>
            {aiLoading ? "Generating..." : "Generate Offer Package"}
          </Btn>
          <AIOutput loading={aiLoading} output={aiOutput} accentColor={COLOR} />
        </Card>
      )}
    </div>
  );
}
