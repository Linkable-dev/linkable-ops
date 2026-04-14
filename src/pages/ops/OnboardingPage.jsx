import { useState } from "react";
import { Btn } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { TabBar } from "../../components/ui/TabBar";
import { Label, SectionTitle, Row, Col } from "../../components/ui/Label";
import { AIOutput } from "../../components/ui/AIOutput";
import { ProgressBar } from "../../components/ui/ProgressBar";
import { KBBadge } from "../../components/ui/KBBadge";
import { useKB } from "../../contexts/KBContext";
import { callClaude } from "../../lib/claude";
import { OPS_PHASES } from "../../lib/constants";
import { useTheme } from "../../contexts/ThemeContext";


const TABS = [
  ["icp", "ICP"],
  ["service", "Service"],
  ["brand", "Brand Voice"],
  ["brief", "Strategic Brief"],
];

export default function OnboardingPage() {
  const { theme } = useTheme();
  const COLOR = theme.accent;
  const { kb, setKb } = useKB();
  const [tab, setTab] = useState("icp");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiOutput, setAiOutput] = useState("");

  const icpFilled = !!(kb.icp.industry || kb.icp.pains);
  const serviceFilled = !!(kb.service.deliverables || kb.service.competitors);
  const brandFilled = !!(kb.brand.tone || kb.brand.voice);
  const filledCount = [icpFilled, serviceFilled, brandFilled].filter(Boolean).length;
  const pct = Math.round((filledCount / 3) * 100);

  function updateIcp(field, value) {
    setKb({ icp: { ...kb.icp, [field]: value } });
  }
  function updateService(field, value) {
    setKb({ service: { ...kb.service, [field]: value } });
  }
  function updateBrand(field, value) {
    setKb({ brand: { ...kb.brand, [field]: value } });
  }

  async function generateBrief() {
    setAiLoading(true);
    setAiOutput("");
    const systemPrompt = `You are a senior B2B outbound strategist for a link-building / digital PR agency. Given the ICP, Service, and Brand Voice knowledge bases, produce a concise Strategic Brief (under 400 words) that the ops team can use across all 7 phases. Include: target summary, positioning, key messaging pillars, tone guidelines, and recommended outbound angles.`;
    const userMessage = `ICP:\n${JSON.stringify(kb.icp, null, 2)}\n\nService:\n${JSON.stringify(kb.service, null, 2)}\n\nBrand Voice:\n${JSON.stringify(kb.brand, null, 2)}`;
    try {
      const full = await callClaude(systemPrompt, userMessage, chunk => setAiOutput(chunk));
      setKb({ strategicBrief: full });
    } catch (err) {
      setAiOutput("Error: " + err.message);
    }
    setAiLoading(false);
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h2 style={{ margin: 0, color: theme.text, fontSize: 22 }}>Onboarding</h2>
          <p style={{ margin: "4px 0 0", color: theme.textMuted, fontSize: 13 }}>Build your ICP, Service, and Brand Voice knowledge bases</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <KBBadge label="ICP" filled={icpFilled} color={COLOR} />
          <KBBadge label="Service" filled={serviceFilled} color={COLOR} />
          <KBBadge label="Brand" filled={brandFilled} color={COLOR} />
        </div>
      </div>

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <SectionTitle color={COLOR}>Knowledge Base Completion</SectionTitle>
          <span style={{ fontSize: 13, fontWeight: 700, color: COLOR }}>{pct}%</span>
        </div>
        <ProgressBar pct={pct} color={COLOR} />
      </Card>

      <TabBar tabs={TABS} active={tab} onSelect={setTab} />

      {/* ICP Tab */}
      {tab === "icp" && (
        <Card>
          <SectionTitle color={COLOR}>Ideal Customer Profile</SectionTitle>
          <Row>
            <Col>
              <Label>Industry / Vertical</Label>
              <Input value={kb.icp.industry} onChange={e => updateIcp("industry", e.target.value)} placeholder="e.g. SaaS, eCommerce, FinTech" />
            </Col>
            <Col>
              <Label>Geography</Label>
              <Input value={kb.icp.geography} onChange={e => updateIcp("geography", e.target.value)} placeholder="e.g. US, UK, DACH" />
            </Col>
          </Row>
          <Row>
            <Col>
              <Label>Funding Stage</Label>
              <Input value={kb.icp.fundingStage} onChange={e => updateIcp("fundingStage", e.target.value)} placeholder="e.g. Series A, Bootstrapped" />
            </Col>
            <Col>
              <Label>Revenue Range</Label>
              <Input value={kb.icp.revenueRange} onChange={e => updateIcp("revenueRange", e.target.value)} placeholder="e.g. $1M-$10M ARR" />
            </Col>
          </Row>
          <Label>Pains</Label>
          <Input multiline rows={3} value={kb.icp.pains} onChange={e => updateIcp("pains", e.target.value)} placeholder="What keeps them up at night?" />
          <div style={{ height: 10 }} />
          <Label>Fears</Label>
          <Input multiline rows={3} value={kb.icp.fears} onChange={e => updateIcp("fears", e.target.value)} placeholder="What are they afraid of?" />
          <div style={{ height: 10 }} />
          <Label>Desires</Label>
          <Input multiline rows={3} value={kb.icp.desires} onChange={e => updateIcp("desires", e.target.value)} placeholder="What do they ultimately want?" />
          <div style={{ height: 10 }} />
          <Label>Tech Stack</Label>
          <Input value={kb.icp.techStack} onChange={e => updateIcp("techStack", e.target.value)} placeholder="e.g. HubSpot, Salesforce, WordPress" />
        </Card>
      )}

      {/* Service Tab */}
      {tab === "service" && (
        <Card>
          <SectionTitle color={COLOR}>Service Profile</SectionTitle>
          <Label>Deliverables</Label>
          <Input multiline rows={4} value={kb.service.deliverables} onChange={e => updateService("deliverables", e.target.value)} placeholder="List your core deliverables (link building, digital PR, content, etc.)" />
          <div style={{ height: 10 }} />
          <Label>Competitors</Label>
          <Input multiline rows={3} value={kb.service.competitors} onChange={e => updateService("competitors", e.target.value)} placeholder="Who do your prospects compare you to?" />
          <div style={{ height: 10 }} />
          <Label>Existing Customers</Label>
          <Input multiline rows={3} value={kb.service.existingCustomers} onChange={e => updateService("existingCustomers", e.target.value)} placeholder="Notable customers or case studies" />
        </Card>
      )}

      {/* Brand Voice Tab */}
      {tab === "brand" && (
        <Card>
          <SectionTitle color={COLOR}>Brand Voice</SectionTitle>
          <Label>Tone</Label>
          <Input value={kb.brand.tone} onChange={e => updateBrand("tone", e.target.value)} placeholder="e.g. Professional but approachable, witty" />
          <div style={{ height: 10 }} />
          <Label>Voice Guidelines</Label>
          <Input multiline rows={4} value={kb.brand.voice} onChange={e => updateBrand("voice", e.target.value)} placeholder="Describe how your brand speaks (first person, formal/informal, etc.)" />
          <div style={{ height: 10 }} />
          <Label>Examples</Label>
          <Input multiline rows={4} value={kb.brand.examples} onChange={e => updateBrand("examples", e.target.value)} placeholder="Paste sample copy, emails, or messaging you like" />
        </Card>
      )}

      {/* Strategic Brief Tab */}
      {tab === "brief" && (
        <Card>
          <SectionTitle color={COLOR}>AI Strategic Brief</SectionTitle>
          <p style={{ fontSize: 13, color: theme.textMid, marginBottom: 16 }}>
            Generate a strategic brief from your ICP, Service, and Brand Voice KBs. This brief will guide all downstream phases.
          </p>
          <Btn color={COLOR} onClick={generateBrief} disabled={aiLoading || (!icpFilled && !serviceFilled && !brandFilled)}>
            {aiLoading ? "Generating..." : "Generate Strategic Brief"}
          </Btn>
          <AIOutput loading={aiLoading} output={aiOutput || kb.strategicBrief} accentColor={COLOR} />
        </Card>
      )}
    </div>
  );
}
