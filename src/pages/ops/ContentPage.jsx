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
  ["hooks", "Hooks"],
  ["vsl", "VSL Script"],
  ["proof", "Social Proof"],
  ["magnet", "Lead Magnet"],
];

export default function ContentPage() {
  const { theme } = useTheme();
  const COLOR = theme.accent;
  const { kb } = useKB();
  const [tab, setTab] = useState("hooks");
  const [hookCount, setHookCount] = useState(10);
  const [hookAngle, setHookAngle] = useState("");
  const [vslLength, setVslLength] = useState("3min");
  const [proofType, setProofType] = useState("case-study");
  const [magnetTopic, setMagnetTopic] = useState("");
  const [magnetFormat, setMagnetFormat] = useState("checklist");

  const [aiLoading, setAiLoading] = useState(false);
  const [aiOutput, setAiOutput] = useState("");

  function kbContext() {
    return `ICP:\n${JSON.stringify(kb.icp, null, 2)}\n\nService:\n${JSON.stringify(kb.service, null, 2)}\n\nBrand Voice:\n${JSON.stringify(kb.brand, null, 2)}`;
  }

  async function generateHooks() {
    setAiLoading(true);
    setAiOutput("");
    const systemPrompt = `You are a world-class copywriter for a B2B link-building / digital PR agency. Generate ${hookCount} scroll-stopping hooks for outbound content. Each hook should be 1-2 lines max. Mix formats: questions, stats, contrarian takes, pain-agitation. Match the brand voice.`;
    const userMessage = `${kbContext()}\n\nAngle/topic: ${hookAngle || "General outbound for ICP"}`;
    try {
      await callClaude(systemPrompt, userMessage, chunk => setAiOutput(chunk));
    } catch (err) {
      setAiOutput("Error: " + err.message);
    }
    setAiLoading(false);
  }

  async function generateVSL() {
    setAiLoading(true);
    setAiOutput("");
    const systemPrompt = `You are a direct-response VSL (Video Sales Letter) scriptwriter for a B2B link-building / digital PR agency. Write a ${vslLength} VSL script. Structure: Hook (pattern interrupt) -> Problem (agitate ICP pains) -> Solution (introduce service) -> Proof (results/social proof) -> Offer -> CTA. Include stage directions in brackets. Match brand voice.`;
    const userMessage = kbContext();
    try {
      await callClaude(systemPrompt, userMessage, chunk => setAiOutput(chunk), 3000);
    } catch (err) {
      setAiOutput("Error: " + err.message);
    }
    setAiLoading(false);
  }

  async function generateProof() {
    setAiLoading(true);
    setAiOutput("");
    const typeMap = {
      "case-study": "a detailed case study (Problem, Solution, Results with metrics)",
      "testimonial": "5 realistic testimonial quotes from different client archetypes",
      "results": "a results showcase with specific metrics, before/after comparisons",
    };
    const systemPrompt = `You are a social proof copywriter for a B2B link-building / digital PR agency. Generate ${typeMap[proofType]}. Make it specific and credible (use realistic but fictional company names). Match brand voice.`;
    const userMessage = kbContext();
    try {
      await callClaude(systemPrompt, userMessage, chunk => setAiOutput(chunk), 2000);
    } catch (err) {
      setAiOutput("Error: " + err.message);
    }
    setAiLoading(false);
  }

  async function generateMagnet() {
    setAiLoading(true);
    setAiOutput("");
    const formatMap = {
      checklist: "a downloadable checklist (10-15 items)",
      guide: "a short guide outline with 5-7 sections and key points",
      template: "a ready-to-use template with fill-in-the-blank sections",
      report: "an industry report outline with data points and key findings",
    };
    const systemPrompt = `You are a lead magnet strategist for a B2B link-building / digital PR agency. Create ${formatMap[magnetFormat]} that the ICP would find irresistible. Topic: ${magnetTopic || "related to the ICP's biggest pain"}. Include a compelling title and subtitle. Match brand voice.`;
    const userMessage = kbContext();
    try {
      await callClaude(systemPrompt, userMessage, chunk => setAiOutput(chunk), 2000);
    } catch (err) {
      setAiOutput("Error: " + err.message);
    }
    setAiLoading(false);
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h2 style={{ margin: 0, color: theme.text, fontSize: 22 }}>Content</h2>
          <p style={{ margin: "4px 0 0", color: theme.textMuted, fontSize: 13 }}>Generate hooks, VSL scripts, social proof, and lead magnets</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <KBBadge label="ICP" filled={!!kb.icp.industry} color={COLOR} />
          <KBBadge label="Brand" filled={!!kb.brand.tone} color={COLOR} />
        </div>
      </div>

      <TabBar tabs={TABS} active={tab} onSelect={setTab} />

      {/* Hooks Tab */}
      {tab === "hooks" && (
        <Card>
          <SectionTitle color={COLOR}>Hook Generator</SectionTitle>
          <Row>
            <Col>
              <Label>Number of Hooks</Label>
              <select
                value={hookCount}
                onChange={e => setHookCount(Number(e.target.value))}
                style={{ width: "100%", padding: "10px 13px", borderRadius: 8, border: `1.5px solid ${theme.border}`, background: theme.bg, fontFamily: "inherit", fontSize: 14, color: theme.text }}
              >
                {[5, 10, 15, 20].map(n => <option key={n} value={n}>{n} hooks</option>)}
              </select>
            </Col>
            <Col>
              <Label>Angle / Topic (optional)</Label>
              <Input value={hookAngle} onChange={e => setHookAngle(e.target.value)} placeholder="e.g. Link building ROI, DR growth" />
            </Col>
          </Row>
          <div style={{ marginTop: 14 }}>
            <Btn color={COLOR} onClick={generateHooks} disabled={aiLoading}>
              {aiLoading ? "Generating..." : "Generate Hooks"}
            </Btn>
          </div>
          <AIOutput loading={aiLoading} output={aiOutput} accentColor={COLOR} />
        </Card>
      )}

      {/* VSL Script Tab */}
      {tab === "vsl" && (
        <Card>
          <SectionTitle color={COLOR}>VSL Script Generator</SectionTitle>
          <Row>
            <Col>
              <Label>Target Length</Label>
              <select
                value={vslLength}
                onChange={e => setVslLength(e.target.value)}
                style={{ width: "100%", padding: "10px 13px", borderRadius: 8, border: `1.5px solid ${theme.border}`, background: theme.bg, fontFamily: "inherit", fontSize: 14, color: theme.text }}
              >
                <option value="2min">~2 minutes</option>
                <option value="3min">~3 minutes</option>
                <option value="5min">~5 minutes</option>
                <option value="10min">~10 minutes</option>
              </select>
            </Col>
            <Col />
          </Row>
          <div style={{ marginTop: 14 }}>
            <Btn color={COLOR} onClick={generateVSL} disabled={aiLoading}>
              {aiLoading ? "Writing Script..." : "Generate VSL Script"}
            </Btn>
          </div>
          <AIOutput loading={aiLoading} output={aiOutput} accentColor={COLOR} />
        </Card>
      )}

      {/* Social Proof Tab */}
      {tab === "proof" && (
        <Card>
          <SectionTitle color={COLOR}>Social Proof Generator</SectionTitle>
          <Row>
            <Col>
              <Label>Proof Type</Label>
              <select
                value={proofType}
                onChange={e => setProofType(e.target.value)}
                style={{ width: "100%", padding: "10px 13px", borderRadius: 8, border: `1.5px solid ${theme.border}`, background: theme.bg, fontFamily: "inherit", fontSize: 14, color: theme.text }}
              >
                <option value="case-study">Case Study</option>
                <option value="testimonial">Testimonials</option>
                <option value="results">Results Showcase</option>
              </select>
            </Col>
            <Col />
          </Row>
          <div style={{ marginTop: 14 }}>
            <Btn color={COLOR} onClick={generateProof} disabled={aiLoading}>
              {aiLoading ? "Generating..." : "Generate Social Proof"}
            </Btn>
          </div>
          <AIOutput loading={aiLoading} output={aiOutput} accentColor={COLOR} />
        </Card>
      )}

      {/* Lead Magnet Tab */}
      {tab === "magnet" && (
        <Card>
          <SectionTitle color={COLOR}>Lead Magnet Generator</SectionTitle>
          <Row>
            <Col>
              <Label>Format</Label>
              <select
                value={magnetFormat}
                onChange={e => setMagnetFormat(e.target.value)}
                style={{ width: "100%", padding: "10px 13px", borderRadius: 8, border: `1.5px solid ${theme.border}`, background: theme.bg, fontFamily: "inherit", fontSize: 14, color: theme.text }}
              >
                <option value="checklist">Checklist</option>
                <option value="guide">Guide</option>
                <option value="template">Template</option>
                <option value="report">Industry Report</option>
              </select>
            </Col>
            <Col>
              <Label>Topic (optional)</Label>
              <Input value={magnetTopic} onChange={e => setMagnetTopic(e.target.value)} placeholder="e.g. How to scale link building" />
            </Col>
          </Row>
          <div style={{ marginTop: 14 }}>
            <Btn color={COLOR} onClick={generateMagnet} disabled={aiLoading}>
              {aiLoading ? "Creating..." : "Generate Lead Magnet"}
            </Btn>
          </div>
          <AIOutput loading={aiLoading} output={aiOutput} accentColor={COLOR} />
        </Card>
      )}
    </div>
  );
}
