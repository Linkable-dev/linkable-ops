import { useState } from "react";
import { Btn } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { Tag } from "../../components/ui/Tag";
import { TabBar } from "../../components/ui/TabBar";
import { Label, SectionTitle, Row, Col } from "../../components/ui/Label";
import { AIOutput } from "../../components/ui/AIOutput";
import { SlackNotification } from "../../components/ui/SlackNotification";
import { KBBadge } from "../../components/ui/KBBadge";
import { useKB } from "../../contexts/KBContext";
import { callClaude } from "../../lib/claude";
import { OPS_PHASES } from "../../lib/constants";
import { useTheme } from "../../contexts/ThemeContext";


const TABS = [
  ["inbox", "Inbox"],
  ["pipeline", "Pipeline"],
  ["ai", "AI Responder"],
];

const DEMO_LEADS = [
  { id: 1, name: "Sarah Chen", company: "GrowthLoop", email: "sarah@growthloop.io", channel: "Email", status: "positive", message: "Thanks for reaching out! We've been looking for help with our link building strategy. Can we set up a call next week?", date: "2 hours ago" },
  { id: 2, name: "Mark Johnson", company: "ScaleSaaS", email: "mark@scalesaas.com", channel: "LinkedIn", status: "neutral", message: "Interesting, tell me more about your pricing and what results you've achieved for similar companies.", date: "5 hours ago" },
  { id: 3, name: "Emily Rodriguez", company: "DataVault", email: "emily@datavault.co", channel: "Email", status: "new", message: "I saw your email. We might be interested but our budget is tight this quarter. What's the minimum engagement?", date: "1 day ago" },
];

export default function LeadsPage() {
  const { theme } = useTheme();
  const COLOR = theme.accent;
  const { kb } = useKB();

  const STATUS_COLORS = {
    new: theme.text,
    positive: "#10B981",
    neutral: "#F59E0B",
    negative: "#EF4444",
    meeting: theme.textMid,
  };
  const [tab, setTab] = useState("inbox");
  const [leads, setLeads] = useState(DEMO_LEADS);
  const [selected, setSelected] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiOutput, setAiOutput] = useState("");
  const [notifications, setNotifications] = useState([
    { id: 1, name: "Sarah Chen", company: "GrowthLoop", channel: "Email" },
  ]);

  const newCount = leads.filter(l => l.status === "new").length;
  const positiveCount = leads.filter(l => l.status === "positive").length;

  function dismissNotification(id) {
    setNotifications(prev => prev.filter(n => n.id !== id));
  }

  function updateLeadStatus(id, status) {
    setLeads(prev => prev.map(l => l.id === id ? { ...l, status } : l));
    if (selected?.id === id) setSelected(prev => ({ ...prev, status }));
  }

  async function generateReply() {
    if (!selected) return;
    setAiLoading(true);
    setAiOutput("");
    const systemPrompt = `You are a senior B2B sales rep for a link-building / digital PR agency. Write a thoughtful, personalised reply to a prospect's message. Keep it under 120 words. Be helpful, not pushy. Match the brand voice. If positive, suggest a next step (call/meeting). If neutral, address objections. If negative, be gracious.`;
    const userMessage = `ICP:\n${JSON.stringify(kb.icp, null, 2)}\n\nService:\n${JSON.stringify(kb.service, null, 2)}\n\nBrand Voice:\n${JSON.stringify(kb.brand, null, 2)}\n\nLead Info:\nName: ${selected.name}\nCompany: ${selected.company}\nChannel: ${selected.channel}\nStatus: ${selected.status}\n\nTheir message:\n"${selected.message}"`;
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
          <h2 style={{ margin: 0, color: theme.text, fontSize: 22 }}>Leads</h2>
          <p style={{ margin: "4px 0 0", color: theme.textMuted, fontSize: 13 }}>Manage replies, generate AI responses, and track the pipeline</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <KBBadge label="ICP" filled={!!kb.icp.industry} color={COLOR} />
          <KBBadge label="Brand" filled={!!kb.brand.tone} color={COLOR} />
        </div>
      </div>

      {/* Slack Notifications */}
      {notifications.map(n => (
        <SlackNotification key={n.id} lead={n} onDismiss={() => dismissNotification(n.id)} />
      ))}

      {/* Stats Row */}
      <Card>
        <Row>
          <Col>
            <div style={{ fontSize: 28, fontWeight: 700, color: COLOR }}>{leads.length}</div>
            <div style={{ fontSize: 12, color: theme.textMuted }}>Total replies</div>
          </Col>
          <Col>
            <div style={{ fontSize: 28, fontWeight: 700, color: STATUS_COLORS.new }}>{newCount}</div>
            <div style={{ fontSize: 12, color: theme.textMuted }}>New / Unread</div>
          </Col>
          <Col>
            <div style={{ fontSize: 28, fontWeight: 700, color: STATUS_COLORS.positive }}>{positiveCount}</div>
            <div style={{ fontSize: 12, color: theme.textMuted }}>Positive</div>
          </Col>
          <Col>
            <div style={{ fontSize: 28, fontWeight: 700, color: STATUS_COLORS.meeting }}>{leads.filter(l => l.status === "meeting").length}</div>
            <div style={{ fontSize: 12, color: theme.textMuted }}>Meetings</div>
          </Col>
        </Row>
      </Card>

      <TabBar tabs={TABS} active={tab} onSelect={setTab} />

      {/* Inbox Tab */}
      {tab === "inbox" && (
        <div style={{ display: "flex", gap: 20 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {leads.map(lead => (
              <Card
                key={lead.id}
                style={{
                  cursor: "pointer",
                  borderLeft: selected?.id === lead.id ? `3px solid ${COLOR}` : undefined,
                  transition: "border-left 0.15s",
                }}
              >
                <div onClick={() => { setSelected(lead); setAiOutput(""); }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 15, color: theme.text }}>{lead.name}</div>
                      <div style={{ fontSize: 13, color: theme.textMid, marginTop: 2 }}>{lead.company}</div>
                    </div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <Tag color={STATUS_COLORS[lead.status] || "#9CA3AF"}>{lead.status}</Tag>
                      <Tag color="#9CA3AF">{lead.channel}</Tag>
                    </div>
                  </div>
                  <div style={{ fontSize: 13, color: theme.textMid, marginTop: 8, lineHeight: 1.6 }}>
                    {lead.message.length > 120 ? lead.message.slice(0, 120) + "..." : lead.message}
                  </div>
                  <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 6 }}>{lead.date}</div>
                </div>
              </Card>
            ))}
          </div>

          {/* Detail Panel */}
          {selected && (
            <div style={{ width: 400, flexShrink: 0 }}>
              <Card>
                <SectionTitle color={COLOR}>Lead Details</SectionTitle>
                <div style={{ fontWeight: 600, fontSize: 17, marginBottom: 4 }}>{selected.name}</div>
                <div style={{ fontSize: 13, color: theme.textMid }}>{selected.company}</div>
                <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 2 }}>{selected.email}</div>
                <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
                  <Tag color={STATUS_COLORS[selected.status]}>{selected.status}</Tag>
                  <Tag color="#9CA3AF">{selected.channel}</Tag>
                </div>
              </Card>

              <Card>
                <SectionTitle color={COLOR}>Their Message</SectionTitle>
                <div style={{ fontSize: 14, color: theme.text, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
                  {selected.message}
                </div>
              </Card>

              <Card>
                <SectionTitle color={COLOR}>Update Status</SectionTitle>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {Object.entries(STATUS_COLORS).map(([status, sColor]) => (
                    <Btn
                      key={status}
                      size="sm"
                      color={sColor}
                      variant={selected.status === status ? "solid" : "outline"}
                      onClick={() => updateLeadStatus(selected.id, status)}
                    >
                      {status}
                    </Btn>
                  ))}
                </div>
              </Card>

              <Card>
                <SectionTitle color={COLOR}>AI Reply</SectionTitle>
                <Btn color={COLOR} onClick={generateReply} disabled={aiLoading}>
                  {aiLoading ? "Generating..." : "Generate Reply"}
                </Btn>
                <AIOutput loading={aiLoading} output={aiOutput} accentColor={COLOR} />
              </Card>
            </div>
          )}
        </div>
      )}

      {/* Pipeline Tab */}
      {tab === "pipeline" && (
        <div style={{ display: "flex", gap: 14, overflowX: "auto", paddingBottom: 16 }}>
          {Object.entries(STATUS_COLORS).map(([status, sColor]) => {
            const statusLeads = leads.filter(l => l.status === status);
            return (
              <div key={status} style={{ minWidth: 200, flex: 1 }}>
                <div style={{
                  background: sColor + "12",
                  borderTop: `3px solid ${sColor}`,
                  borderRadius: "10px 10px 0 0",
                  padding: "12px 14px",
                  marginBottom: 8,
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontWeight: 700, fontSize: 13, color: sColor, textTransform: "capitalize" }}>{status}</span>
                    <span style={{ fontSize: 11, color: theme.textMuted, fontWeight: 600 }}>{statusLeads.length}</span>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {statusLeads.length === 0 ? (
                    <div style={{ padding: "20px 14px", textAlign: "center", color: theme.textMuted, fontSize: 12, background: theme.surfaceAlt, borderRadius: 10, border: `1px dashed ${theme.border}` }}>
                      Empty
                    </div>
                  ) : (
                    statusLeads.map(lead => (
                      <Card key={lead.id} style={{ marginBottom: 0, padding: 14 }}>
                        <div style={{ fontWeight: 600, fontSize: 13, color: theme.text }}>{lead.name}</div>
                        <div style={{ fontSize: 12, color: theme.textMid, marginTop: 2 }}>{lead.company}</div>
                        <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 4 }}>{lead.channel} - {lead.date}</div>
                      </Card>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* AI Responder Tab */}
      {tab === "ai" && (
        <Card>
          <SectionTitle color={COLOR}>Bulk AI Responder</SectionTitle>
          <p style={{ fontSize: 13, color: theme.textMid, marginBottom: 16 }}>
            Select a lead from the Inbox tab to generate an AI-powered reply. The AI uses your ICP, Service, and Brand Voice KBs to craft personalised responses.
          </p>
          {selected ? (
            <div>
              <div style={{ marginBottom: 12 }}>
                <span style={{ fontWeight: 600, color: theme.text }}>Selected: </span>
                <span style={{ color: theme.textMid }}>{selected.name} at {selected.company}</span>
                <Tag color={STATUS_COLORS[selected.status]} >{selected.status}</Tag>
              </div>
              <Btn color={COLOR} onClick={generateReply} disabled={aiLoading}>
                {aiLoading ? "Generating..." : "Generate Reply"}
              </Btn>
              <AIOutput loading={aiLoading} output={aiOutput} accentColor={COLOR} />
            </div>
          ) : (
            <div style={{ textAlign: "center", color: theme.textMuted, padding: 24 }}>
              Select a lead from the Inbox tab first
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
