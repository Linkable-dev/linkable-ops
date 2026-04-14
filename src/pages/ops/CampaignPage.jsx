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
  ["email", "Email Sequence"],
  ["linkedin", "LinkedIn Sequence"],
  ["settings", "Campaign Settings"],
];

export default function CampaignPage() {
  const { theme } = useTheme();
  const COLOR = theme.accent;
  const { kb } = useKB();
  const [tab, setTab] = useState("email");
  const [emailSteps, setEmailSteps] = useState(3);
  const [linkedInSteps, setLinkedInSteps] = useState(4);
  const [campaignName, setCampaignName] = useState("");
  const [targetDesc, setTargetDesc] = useState("");
  const [emailAiLoading, setEmailAiLoading] = useState(false);
  const [emailAiOutput, setEmailAiOutput] = useState("");
  const [linkedInAiLoading, setLinkedInAiLoading] = useState(false);
  const [linkedInAiOutput, setLinkedInAiOutput] = useState("");

  async function generateEmailSequence() {
    setEmailAiLoading(true);
    setEmailAiOutput("");
    const systemPrompt = `You are an expert cold email copywriter for a B2B link-building / digital PR agency. Write a ${emailSteps}-step cold email sequence. Each email should be under 100 words, personalised, and follow the brand voice. Include subject lines. Use the knowledge bases provided.`;
    const userMessage = `ICP:\n${JSON.stringify(kb.icp, null, 2)}\n\nService:\n${JSON.stringify(kb.service, null, 2)}\n\nBrand Voice:\n${JSON.stringify(kb.brand, null, 2)}\n\nCampaign: ${campaignName || "General outbound"}\nTarget: ${targetDesc || "ICP-matching prospects"}`;
    try {
      await callClaude(systemPrompt, userMessage, chunk => setEmailAiOutput(chunk), 2000);
    } catch (err) {
      setEmailAiOutput("Error: " + err.message);
    }
    setEmailAiLoading(false);
  }

  async function generateLinkedInSequence() {
    setLinkedInAiLoading(true);
    setLinkedInAiOutput("");
    const systemPrompt = `You are an expert LinkedIn outreach strategist for a B2B link-building / digital PR agency. Write a ${linkedInSteps}-step LinkedIn sequence. Include: connection request note (under 300 chars), follow-up messages (under 200 words each), and a breakup message. Match the brand voice.`;
    const userMessage = `ICP:\n${JSON.stringify(kb.icp, null, 2)}\n\nService:\n${JSON.stringify(kb.service, null, 2)}\n\nBrand Voice:\n${JSON.stringify(kb.brand, null, 2)}\n\nCampaign: ${campaignName || "General outbound"}\nTarget: ${targetDesc || "ICP-matching prospects"}`;
    try {
      await callClaude(systemPrompt, userMessage, chunk => setLinkedInAiOutput(chunk), 2000);
    } catch (err) {
      setLinkedInAiOutput("Error: " + err.message);
    }
    setLinkedInAiLoading(false);
  }

  const kbReady = !!(kb.icp.industry && kb.service.deliverables && kb.brand.tone);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h2 style={{ margin: 0, color: theme.text, fontSize: 22 }}>Campaign</h2>
          <p style={{ margin: "4px 0 0", color: theme.textMuted, fontSize: 13 }}>Write personalised email and LinkedIn sequences using your KBs</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <KBBadge label="ICP" filled={!!kb.icp.industry} color={COLOR} />
          <KBBadge label="Service" filled={!!kb.service.deliverables} color={COLOR} />
          <KBBadge label="Brand" filled={!!kb.brand.tone} color={COLOR} />
        </div>
      </div>

      {!kbReady && (
        <Card style={{ borderLeft: `3px solid ${COLOR}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 18 }}>!</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: theme.text }}>Complete your Knowledge Bases first</div>
              <div style={{ fontSize: 13, color: theme.textMid }}>Campaigns work best when ICP, Service, and Brand Voice KBs are filled in during Onboarding.</div>
            </div>
          </div>
        </Card>
      )}

      <TabBar tabs={TABS} active={tab} onSelect={setTab} />

      {/* Email Sequence Tab */}
      {tab === "email" && (
        <Card>
          <SectionTitle color={COLOR}>Email Sequence Generator</SectionTitle>
          <Row>
            <Col>
              <Label>Number of Steps</Label>
              <select
                value={emailSteps}
                onChange={e => setEmailSteps(Number(e.target.value))}
                style={{ width: "100%", padding: "10px 13px", borderRadius: 8, border: `1.5px solid ${theme.border}`, background: theme.bg, fontFamily: "inherit", fontSize: 14, color: theme.text }}
              >
                {[2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n} emails</option>)}
              </select>
            </Col>
            <Col>
              <Label>Campaign Name (optional)</Label>
              <Input value={campaignName} onChange={e => setCampaignName(e.target.value)} placeholder="e.g. Q1 SaaS Outbound" />
            </Col>
          </Row>
          <Label>Target Description (optional)</Label>
          <Input multiline rows={2} value={targetDesc} onChange={e => setTargetDesc(e.target.value)} placeholder="Describe the specific segment you're targeting..." />
          <div style={{ marginTop: 14 }}>
            <Btn color={COLOR} onClick={generateEmailSequence} disabled={emailAiLoading}>
              {emailAiLoading ? "Writing..." : "Generate Email Sequence"}
            </Btn>
          </div>
          <AIOutput loading={emailAiLoading} output={emailAiOutput} accentColor={COLOR} />
        </Card>
      )}

      {/* LinkedIn Sequence Tab */}
      {tab === "linkedin" && (
        <Card>
          <SectionTitle color={COLOR}>LinkedIn Sequence Generator</SectionTitle>
          <Row>
            <Col>
              <Label>Number of Touchpoints</Label>
              <select
                value={linkedInSteps}
                onChange={e => setLinkedInSteps(Number(e.target.value))}
                style={{ width: "100%", padding: "10px 13px", borderRadius: 8, border: `1.5px solid ${theme.border}`, background: theme.bg, fontFamily: "inherit", fontSize: 14, color: theme.text }}
              >
                {[3, 4, 5, 6, 7].map(n => <option key={n} value={n}>{n} touchpoints</option>)}
              </select>
            </Col>
            <Col>
              <Label>Campaign Name (optional)</Label>
              <Input value={campaignName} onChange={e => setCampaignName(e.target.value)} placeholder="e.g. Q1 SaaS Outbound" />
            </Col>
          </Row>
          <div style={{ marginTop: 14 }}>
            <Btn color={COLOR} onClick={generateLinkedInSequence} disabled={linkedInAiLoading}>
              {linkedInAiLoading ? "Writing..." : "Generate LinkedIn Sequence"}
            </Btn>
          </div>
          <AIOutput loading={linkedInAiLoading} output={linkedInAiOutput} accentColor={COLOR} />
        </Card>
      )}

      {/* Campaign Settings Tab */}
      {tab === "settings" && (
        <Card>
          <SectionTitle color={COLOR}>Campaign Settings</SectionTitle>
          <Row>
            <Col>
              <Label>Daily Send Limit (Email)</Label>
              <Input placeholder="e.g. 50" />
            </Col>
            <Col>
              <Label>Daily Send Limit (LinkedIn)</Label>
              <Input placeholder="e.g. 25" />
            </Col>
          </Row>
          <Row>
            <Col>
              <Label>Sending Window Start</Label>
              <Input placeholder="e.g. 08:00" />
            </Col>
            <Col>
              <Label>Sending Window End</Label>
              <Input placeholder="e.g. 18:00" />
            </Col>
          </Row>
          <Row>
            <Col>
              <Label>Days Between Steps</Label>
              <Input placeholder="e.g. 3" />
            </Col>
            <Col>
              <Label>Timezone</Label>
              <Input placeholder="e.g. America/New_York" />
            </Col>
          </Row>
          <div style={{ marginTop: 10 }}>
            <Tag color={COLOR}>Settings are saved locally for now</Tag>
          </div>
        </Card>
      )}
    </div>
  );
}
