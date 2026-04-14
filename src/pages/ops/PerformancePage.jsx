import { useState } from "react";
import { Btn } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
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


const TABS = [
  ["funnel", "Funnel"],
  ["metrics", "Metrics"],
  ["ai", "AI Recommendations"],
];

const DEMO_METRICS = [
  { label: "Open Rate", value: "50%", benchmark: "40-60%", status: "good" },
  { label: "Reply Rate", value: "12%", benchmark: "8-15%", status: "good" },
  { label: "Positive Reply Rate", value: "5.1%", benchmark: "3-8%", status: "good" },
  { label: "Meeting Book Rate", value: "2.3%", benchmark: "2-5%", status: "average" },
  { label: "Close Rate", value: "0.9%", benchmark: "1-3%", status: "below" },
  { label: "Avg Deal Size", value: "$4,200", benchmark: "$3,000+", status: "good" },
  { label: "CAC", value: "$890", benchmark: "<$1,000", status: "good" },
  { label: "Pipeline Value", value: "$52,000", benchmark: "-", status: "good" },
];

const statusColors = { good: "#10B981", average: "#F59E0B", below: "#EF4444" };

export default function PerformancePage() {
  const { theme } = useTheme();
  const COLOR = theme.accent;
  const { kb } = useKB();

  const DEMO_FUNNEL = [
    { stage: "Leads Sourced", count: 500, color: theme.text },
    { stage: "Emails Sent", count: 350, color: theme.textMid },
    { stage: "Opened", count: 175, color: theme.textMuted },
    { stage: "Replied", count: 42, color: theme.textMuted },
    { stage: "Positive Reply", count: 18, color: "#10B981" },
    { stage: "Meeting Booked", count: 8, color: "#EF4444" },
    { stage: "Deal Closed", count: 3, color: COLOR },
  ];
  const thStyle = { textAlign: "left", padding: "8px 10px", fontWeight: 600, color: theme.textMid, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 };
  const tdStyle = { padding: "12px 10px", color: theme.text };
  const [tab, setTab] = useState("funnel");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiOutput, setAiOutput] = useState("");

  const maxCount = Math.max(...DEMO_FUNNEL.map(f => f.count));

  async function generateRecommendations() {
    setAiLoading(true);
    setAiOutput("");
    const systemPrompt = `You are a senior outbound performance analyst for a B2B link-building / digital PR agency. Analyze the funnel metrics and provide actionable optimisation recommendations. Structure your response as: 1) Quick Wins (immediate changes), 2) Strategic Changes (medium-term), 3) Testing Roadmap (experiments to run). Be specific with numbers and benchmarks.`;
    const funnelData = DEMO_FUNNEL.map(f => `${f.stage}: ${f.count}`).join("\n");
    const metricsData = DEMO_METRICS.map(m => `${m.label}: ${m.value} (benchmark: ${m.benchmark}, status: ${m.status})`).join("\n");
    const userMessage = `ICP:\n${JSON.stringify(kb.icp, null, 2)}\n\nService:\n${JSON.stringify(kb.service, null, 2)}\n\nFunnel Data:\n${funnelData}\n\nMetrics:\n${metricsData}`;
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
          <h2 style={{ margin: 0, color: theme.text, fontSize: 22 }}>Performance</h2>
          <p style={{ margin: "4px 0 0", color: theme.textMuted, fontSize: 13 }}>Track funnel metrics and get AI-powered optimisation recommendations</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <KBBadge label="ICP" filled={!!kb.icp.industry} color={COLOR} />
          <KBBadge label="Service" filled={!!kb.service.deliverables} color={COLOR} />
        </div>
      </div>

      {/* Top-level Stats */}
      <Card>
        <Row>
          <Col>
            <div style={{ fontSize: 28, fontWeight: 700, color: COLOR }}>{DEMO_FUNNEL[0].count}</div>
            <div style={{ fontSize: 12, color: theme.textMuted }}>Leads Sourced</div>
          </Col>
          <Col>
            <div style={{ fontSize: 28, fontWeight: 700, color: "#10B981" }}>{DEMO_FUNNEL[4].count}</div>
            <div style={{ fontSize: 12, color: theme.textMuted }}>Positive Replies</div>
          </Col>
          <Col>
            <div style={{ fontSize: 28, fontWeight: 700, color: "#EF4444" }}>{DEMO_FUNNEL[5].count}</div>
            <div style={{ fontSize: 12, color: theme.textMuted }}>Meetings Booked</div>
          </Col>
          <Col>
            <div style={{ fontSize: 28, fontWeight: 700, color: theme.text }}>{DEMO_FUNNEL[6].count}</div>
            <div style={{ fontSize: 12, color: theme.textMuted }}>Deals Closed</div>
          </Col>
        </Row>
      </Card>

      <TabBar tabs={TABS} active={tab} onSelect={setTab} />

      {/* Funnel Tab */}
      {tab === "funnel" && (
        <Card>
          <SectionTitle color={COLOR}>Outbound Funnel</SectionTitle>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {DEMO_FUNNEL.map((stage, i) => {
              const pct = Math.round((stage.count / maxCount) * 100);
              const conversionRate = i > 0 ? ((stage.count / DEMO_FUNNEL[i - 1].count) * 100).toFixed(1) : null;
              return (
                <div key={stage.stage}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>{stage.stage}</span>
                      {conversionRate && (
                        <Tag color={stage.color}>{conversionRate}%</Tag>
                      )}
                    </div>
                    <span style={{ fontSize: 15, fontWeight: 700, color: stage.color }}>{stage.count}</span>
                  </div>
                  <ProgressBar pct={pct} color={stage.color} />
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Metrics Tab */}
      {tab === "metrics" && (
        <Card>
          <SectionTitle color={COLOR}>Key Metrics</SectionTitle>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: `2px solid ${theme.border}` }}>
                  <th style={thStyle}>Metric</th>
                  <th style={thStyle}>Value</th>
                  <th style={thStyle}>Benchmark</th>
                  <th style={thStyle}>Status</th>
                </tr>
              </thead>
              <tbody>
                {DEMO_METRICS.map(m => (
                  <tr key={m.label} style={{ borderBottom: `1px solid ${theme.border}` }}>
                    <td style={tdStyle}><span style={{ fontWeight: 600 }}>{m.label}</span></td>
                    <td style={tdStyle}><span style={{ fontSize: 15, fontWeight: 700, color: theme.text }}>{m.value}</span></td>
                    <td style={tdStyle}><span style={{ color: theme.textMuted }}>{m.benchmark}</span></td>
                    <td style={tdStyle}>
                      <Tag color={statusColors[m.status]}>
                        {m.status === "good" ? "On Track" : m.status === "average" ? "Average" : "Below"}
                      </Tag>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* AI Recommendations Tab */}
      {tab === "ai" && (
        <Card>
          <SectionTitle color={COLOR}>AI Optimisation Recommendations</SectionTitle>
          <p style={{ fontSize: 13, color: theme.textMid, marginBottom: 16 }}>
            Get AI-powered recommendations based on your funnel data, metrics, and ICP to improve outbound performance.
          </p>
          <Btn color={COLOR} onClick={generateRecommendations} disabled={aiLoading}>
            {aiLoading ? "Analyzing..." : "Generate Recommendations"}
          </Btn>
          <AIOutput loading={aiLoading} output={aiOutput} accentColor={COLOR} />
        </Card>
      )}
    </div>
  );
}
