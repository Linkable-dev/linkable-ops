// Test Lab — simulate a Kakiyo-style conversation against a campaign
// without sending email. Pick a campaign, fill in a prospect dossier,
// generate the first message, then role-play the prospect to see the AI
// reply, the style issues it flagged, and the tool calls it would have
// emitted in production.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Skeleton } from "../components/ui/Skeleton";

export default function AiTestLabPage() {
  const { theme } = useTheme();

  const [campaigns, setCampaigns] = useState([]);
  const [campaignId, setCampaignId] = useState("");
  const [defaults, setDefaults] = useState(null);
  const [loadingCampaigns, setLoadingCampaigns] = useState(true);
  const [error, setError] = useState(null);

  // Prospect dossier
  const [prospect, setProspect] = useState({
    email: "founder@glowskinco.com",
    name: "Sara Mitchell",
    company: "Glow Skin Co",
    domain: "glowskinco.com",
    country: "UK",
    productTypes: ["serums", "moisturizers"],
    brandStory: "Clean clinical skincare for sensitive skin, founded by a dermatologist.",
    hasCreators: true,
    hasAffiliates: false,
    socialFollowing: "85k Instagram",
    recentPosts: "Posted last week about struggling to track which TikTok creators drive sales.",
  });

  // History as the LLM sees it
  const [history, setHistory] = useState([]); // [{ direction, body, meta? }]
  const [busy, setBusy] = useState(false);
  const [draftReply, setDraftReply] = useState("");
  const [derivedStatus, setDerivedStatus] = useState("active");
  const [lastTurn, setLastTurn] = useState(null);

  // Quick-create campaign modal
  const [creatingCampaign, setCreatingCampaign] = useState(false);
  const [newCampaignName, setNewCampaignName] = useState("Linkable — Beauty/Wellness ICP");

  const transcriptRef = useRef(null);

  useEffect(() => {
    Promise.all([api.getAiCampaigns(), api.getAiDefaults()])
      .then(([c, d]) => {
        setCampaigns(c);
        setDefaults(d);
        if (c.length && !campaignId) setCampaignId(c[0].id);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoadingCampaigns(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [history]);

  const selectedCampaign = useMemo(
    () => campaigns.find((c) => c.id === campaignId),
    [campaigns, campaignId]
  );

  async function createDefaultCampaign() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.createAiCampaign({
        name: newCampaignName || "Linkable Default",
        offering: defaults?.offering,
        persona: defaults?.persona,
        goal: defaults?.goal,
        goalLink: defaults?.goal_link,
      });
      setCampaigns((prev) => [created, ...prev]);
      setCampaignId(created.id);
      setCreatingCampaign(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function generateFirst() {
    if (!campaignId) {
      setError("Pick a campaign first");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.testLabTurn({ campaignId, prospect, history: [] });
      setHistory([
        {
          direction: "out",
          body: result.body,
          subject: result.subject,
          meta: { kind: "first_message", style_issues: result.style_issues, usage: result.usage, model: result.model },
        },
      ]);
      setLastTurn(result);
      setDerivedStatus("active");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function sendProspectReply() {
    if (!draftReply.trim()) return;
    if (!campaignId) {
      setError("Pick a campaign first");
      return;
    }
    const newHistory = [...history, { direction: "in", body: draftReply.trim() }];
    setHistory(newHistory);
    setDraftReply("");
    setBusy(true);
    setError(null);
    try {
      const result = await api.testLabTurn({
        campaignId,
        prospect,
        history: newHistory.map(({ direction, body }) => ({ direction, body })),
      });
      setHistory((prev) => [
        ...prev,
        {
          direction: "out",
          body: result.body,
          meta: {
            kind: "reply",
            style_issues: result.style_issues,
            tool_calls: result.tool_calls,
            usage: result.usage,
            model: result.model,
          },
        },
      ]);
      setLastTurn(result);
      if (result.derived_status) setDerivedStatus(result.derived_status);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setHistory([]);
    setDerivedStatus("active");
    setLastTurn(null);
    setError(null);
  }

  // ---------- styles ----------
  const labelStyle = { fontSize: 11, fontWeight: 600, color: theme.textMid, marginBottom: 4, letterSpacing: 0.3, textTransform: "uppercase" };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 380px", gap: 16, alignItems: "start" }}>
      {/* LEFT: Conversation transcript */}
      <div>
        <div style={{ marginBottom: 16 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: theme.text, margin: 0 }}>AI Test Lab</h1>
          <p style={{ fontSize: 13, color: theme.textMuted, margin: "4px 0 0" }}>
            Simulate a full conversation against a campaign. Nothing is sent. You play the prospect.
          </p>
        </div>

        <Card style={{ padding: 0, overflow: "hidden" }}>
          {/* Header strip */}
          <div style={{ padding: "12px 16px", borderBottom: `1px solid ${theme.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 13, color: theme.textMid }}>
              {selectedCampaign ? (
                <>
                  <span style={{ color: theme.text, fontWeight: 600 }}>{selectedCampaign.name}</span>
                  <span style={{ marginLeft: 8, color: theme.textMuted }}>· goal: {selectedCampaign.goal}</span>
                </>
              ) : (
                <span style={{ color: theme.textMuted }}>No campaign selected</span>
              )}
            </div>
            <StatusBadge status={derivedStatus} theme={theme} />
          </div>

          {/* Transcript */}
          <div ref={transcriptRef} style={{ minHeight: 360, maxHeight: 540, overflowY: "auto", padding: 16, background: theme.bg }}>
            {history.length === 0 ? (
              <EmptyState theme={theme} onGenerate={generateFirst} disabled={busy || !campaignId} />
            ) : (
              history.map((m, i) => <Bubble key={i} message={m} theme={theme} />)
            )}
          </div>

          {/* Composer */}
          <div style={{ borderTop: `1px solid ${theme.border}`, padding: 12, background: theme.surface }}>
            {history.length === 0 ? (
              <Btn onClick={generateFirst} disabled={!campaignId} loading={busy}>Generate first message</Btn>
            ) : (
              <div>
                <Input
                  multiline
                  rows={3}
                  value={draftReply}
                  onChange={(e) => setDraftReply(e.target.value)}
                  placeholder="Reply as the prospect — try an objection, a question, or 'send me more info'"
                />
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <Btn onClick={sendProspectReply} disabled={!draftReply.trim()} loading={busy}>Send as prospect</Btn>
                  <Btn variant="outline" onClick={reset} disabled={busy}>Reset</Btn>
                </div>
              </div>
            )}
          </div>
        </Card>

        {error && (
          <Card style={{ borderColor: "#DC2626", background: theme.surface }}>
            <div style={{ color: "#DC2626", fontSize: 13 }}>{error}</div>
          </Card>
        )}

        {lastTurn && (
          <DebugPanel turn={lastTurn} theme={theme} />
        )}
      </div>

      {/* RIGHT: Configuration */}
      <div>
        <Card>
          <div style={labelStyle}>Campaign</div>
          {loadingCampaigns ? (
            <div><Skeleton width="60%" height={16} /></div>
          ) : campaigns.length === 0 ? (
            <div>
              <p style={{ fontSize: 13, color: theme.textMid, margin: "0 0 12px" }}>
                No campaigns yet. Create one with the Linkable defaults to get started.
              </p>
              {creatingCampaign ? (
                <div>
                  <Input
                    value={newCampaignName}
                    onChange={(e) => setNewCampaignName(e.target.value)}
                    placeholder="Campaign name"
                    style={{ marginBottom: 8 }}
                  />
                  <Btn onClick={createDefaultCampaign} loading={busy}>Create</Btn>
                </div>
              ) : (
                <Btn onClick={() => setCreatingCampaign(true)}>+ New campaign</Btn>
              )}
            </div>
          ) : (
            <div>
              <select
                value={campaignId}
                onChange={(e) => { setCampaignId(e.target.value); reset(); }}
                style={{
                  width: "100%", padding: "9px 12px", borderRadius: 8,
                  border: `1.5px solid ${theme.border}`, background: theme.bg,
                  color: theme.text, fontSize: 13, fontFamily: "inherit",
                }}
              >
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <div style={{ marginTop: 8 }}>
                {creatingCampaign ? (
                  <div>
                    <Input
                      value={newCampaignName}
                      onChange={(e) => setNewCampaignName(e.target.value)}
                      placeholder="New campaign name"
                      style={{ marginBottom: 8 }}
                    />
                    <div style={{ display: "flex", gap: 8 }}>
                      <Btn size="sm" onClick={createDefaultCampaign} loading={busy}>Create</Btn>
                      <Btn size="sm" variant="outline" onClick={() => setCreatingCampaign(false)}>Cancel</Btn>
                    </div>
                  </div>
                ) : (
                  <Btn size="sm" variant="outline" onClick={() => setCreatingCampaign(true)}>+ New</Btn>
                )}
              </div>
              {selectedCampaign && (
                <div style={{ marginTop: 12, fontSize: 12, color: theme.textMuted, lineHeight: 1.5 }}>
                  <div>Reply model: <code>{selectedCampaign.reply_model}</code></div>
                  <div>First-msg model: <code>{selectedCampaign.first_message_model}</code></div>
                  <div>Goal link: {selectedCampaign.goal_link || <em>(not set)</em>}</div>
                </div>
              )}
            </div>
          )}
        </Card>

        <Card>
          <div style={{ ...labelStyle, marginBottom: 8 }}>Prospect dossier</div>
          <p style={{ fontSize: 12, color: theme.textMuted, margin: "0 0 12px", lineHeight: 1.5 }}>
            What we know about them. Drives both the icebreaker and reply context.
          </p>
          <Field label="Email" value={prospect.email} onChange={(v) => setProspect({ ...prospect, email: v })} theme={theme} />
          <Field label="Name" value={prospect.name} onChange={(v) => setProspect({ ...prospect, name: v })} theme={theme} />
          <Field label="Company" value={prospect.company} onChange={(v) => setProspect({ ...prospect, company: v })} theme={theme} />
          <Field label="Domain" value={prospect.domain} onChange={(v) => setProspect({ ...prospect, domain: v })} theme={theme} />
          <Field label="Country" value={prospect.country} onChange={(v) => setProspect({ ...prospect, country: v })} theme={theme} />
          <Field
            label="Product types (comma-separated)"
            value={(prospect.productTypes || []).join(", ")}
            onChange={(v) => setProspect({ ...prospect, productTypes: v.split(",").map((s) => s.trim()).filter(Boolean) })}
            theme={theme}
          />
          <Field
            label="Brand story"
            value={prospect.brandStory}
            onChange={(v) => setProspect({ ...prospect, brandStory: v })}
            theme={theme}
            multiline
          />
          <Field
            label="Recent posts / signals"
            value={prospect.recentPosts}
            onChange={(v) => setProspect({ ...prospect, recentPosts: v })}
            theme={theme}
            multiline
          />
          <div style={{ display: "flex", gap: 16, marginTop: 8 }}>
            <Toggle
              label="Already works with creators"
              value={!!prospect.hasCreators}
              onChange={(v) => setProspect({ ...prospect, hasCreators: v })}
              theme={theme}
            />
            <Toggle
              label="Has affiliate program"
              value={!!prospect.hasAffiliates}
              onChange={(v) => setProspect({ ...prospect, hasAffiliates: v })}
              theme={theme}
            />
          </div>
        </Card>

        <Card>
          <div style={labelStyle}>Try these scenarios</div>
          <ScenarioButtons setDraftReply={setDraftReply} theme={theme} />
        </Card>
      </div>
    </div>
  );
}

// ---------- subcomponents ----------

function Bubble({ message, theme }) {
  const isOut = message.direction === "out";
  const bg = isOut ? theme.accent : theme.surface;
  const fg = isOut ? (theme.mode === "dark" ? "#0A0A0A" : "#fff") : theme.text;
  const issues = message.meta?.style_issues || [];
  const toolCalls = message.meta?.tool_calls || [];

  return (
    <div style={{ display: "flex", justifyContent: isOut ? "flex-end" : "flex-start", marginBottom: 12 }}>
      <div style={{ maxWidth: "75%" }}>
        {message.subject && (
          <div style={{ fontSize: 11, color: theme.textMuted, marginBottom: 4, fontWeight: 600 }}>
            Subject: {message.subject}
          </div>
        )}
        <div style={{
          background: bg, color: fg, padding: "10px 14px", borderRadius: 12,
          fontSize: 14, lineHeight: 1.55, whiteSpace: "pre-wrap",
          border: isOut ? "none" : `1px solid ${theme.border}`,
        }}>
          {message.body}
        </div>
        {(issues.length > 0 || toolCalls.length > 0) && (
          <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6 }}>
            {issues.map((iss, i) => (
              <span key={`iss-${i}`} style={{
                background: "#FEF3C7", color: "#92400E",
                fontSize: 11, padding: "3px 8px", borderRadius: 6, fontWeight: 600,
              }}>style: {iss}</span>
            ))}
            {toolCalls.map((tc, i) => (
              <span key={`tc-${i}`} style={{
                background: "#DBEAFE", color: "#1E40AF",
                fontSize: 11, padding: "3px 8px", borderRadius: 6, fontWeight: 600,
              }}>tool: {tc.name}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status, theme }) {
  const colors = {
    active: { bg: "#DBEAFE", fg: "#1E40AF" },
    qualified: { bg: "#D1FAE5", fg: "#065F46" },
    booked: { bg: "#A7F3D0", fg: "#064E3B" },
    dead: { bg: "#FEE2E2", fg: "#991B1B" },
    opted_out: { bg: "#F3F4F6", fg: "#374151" },
    escalated: { bg: "#FEF3C7", fg: "#92400E" },
  }[status] || { bg: theme.surfaceAlt, fg: theme.textMid };
  return (
    <span style={{
      background: colors.bg, color: colors.fg, fontSize: 11, fontWeight: 700,
      padding: "4px 10px", borderRadius: 6, textTransform: "uppercase", letterSpacing: 0.5,
    }}>{status}</span>
  );
}

function EmptyState({ theme, onGenerate, disabled }) {
  return (
    <div style={{ textAlign: "center", padding: 48, color: theme.textMuted }}>
      <div style={{ fontSize: 14, marginBottom: 16 }}>
        Press the button to generate the first cold message based on the dossier on the right.
      </div>
      <Btn onClick={onGenerate} disabled={disabled}>Generate first message</Btn>
    </div>
  );
}

function Field({ label, value, onChange, theme, multiline }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: theme.textMid, marginBottom: 4 }}>{label}</div>
      <Input
        multiline={multiline}
        rows={multiline ? 2 : 1}
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function Toggle({ label, value, onChange, theme }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: theme.textMid, cursor: "pointer" }}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function ScenarioButtons({ setDraftReply, theme }) {
  const scenarios = [
    { label: "Interested", text: "Sounds interesting — how does it work?" },
    { label: "Skeptic", text: "We already use Refersion. What's different about you?" },
    { label: "Busy exec", text: "Send me more info." },
    { label: "Pricing first", text: "What does it cost?" },
    { label: "Wrong fit", text: "We don't run a creator program." },
    { label: "Opt out", text: "Please remove me from this list." },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
      {scenarios.map((s) => (
        <button
          key={s.label}
          onClick={() => setDraftReply(s.text)}
          style={{
            padding: "8px 10px", borderRadius: 6, fontSize: 12, fontFamily: "inherit",
            background: theme.bg, border: `1px solid ${theme.border}`,
            color: theme.text, cursor: "pointer", textAlign: "left", lineHeight: 1.4,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>{s.label}</div>
          <div style={{ color: theme.textMuted, fontSize: 11 }}>{s.text.slice(0, 50)}{s.text.length > 50 ? "…" : ""}</div>
        </button>
      ))}
    </div>
  );
}

function DebugPanel({ turn, theme }) {
  const u = turn.usage || {};
  return (
    <Card style={{ marginTop: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: theme.textMid, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.3 }}>
        Last turn details
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, fontSize: 12, color: theme.textMid }}>
        <Stat label="Model" value={turn.model || "—"} theme={theme} />
        <Stat label="Tokens in" value={u.in || 0} theme={theme} />
        <Stat label="Tokens out" value={u.out || 0} theme={theme} />
        <Stat label="Cache read" value={u.cacheRead || 0} theme={theme} />
      </div>
      {turn.tool_calls?.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: theme.textMid, marginBottom: 4 }}>Tool calls</div>
          <pre style={{
            margin: 0, fontSize: 11, color: theme.text,
            background: theme.bg, padding: 10, borderRadius: 6,
            overflowX: "auto", border: `1px solid ${theme.border}`,
          }}>{JSON.stringify(turn.tool_calls, null, 2)}</pre>
        </div>
      )}
    </Card>
  );
}

function Stat({ label, value, theme }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 13, color: theme.text, fontWeight: 600, marginTop: 2 }}>{value}</div>
    </div>
  );
}
