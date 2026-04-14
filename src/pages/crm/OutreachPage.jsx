import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { T } from "../../lib/constants";

const api = (path, token, opts = {}) =>
  fetch(`/api/outreach${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...opts.headers },
  }).then(r => r.json());

export default function OutreachPage() {
  const { session } = useAuth();
  const token = session?.access_token;

  const [tab, setTab] = useState("launch"); // launch | campaigns | analytics
  const [status, setStatus] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [selectedCampaign, setSelectedCampaign] = useState(null);
  const [loading, setLoading] = useState(false);
  const [polling, setPolling] = useState(false);

  // Launch config
  const [config, setConfig] = useState({
    limit: 20,
    source: "all",
    country: "",
    dryRun: true,
    templateVariants: [],
  });

  const fetchStatus = useCallback(async () => {
    if (!token) return;
    const data = await api("/status", token);
    setStatus(data);
    return data;
  }, [token]);

  const fetchCampaigns = useCallback(async () => {
    if (!token) return;
    const data = await api("/campaigns", token);
    setCampaigns(data);
  }, [token]);

  const fetchAnalytics = useCallback(async () => {
    if (!token) return;
    const data = await api("/analytics", token);
    setAnalytics(data);
  }, [token]);

  useEffect(() => { fetchStatus(); fetchCampaigns(); fetchAnalytics(); }, [fetchStatus, fetchCampaigns, fetchAnalytics]);

  // Poll status while running
  useEffect(() => {
    if (!polling) return;
    const interval = setInterval(async () => {
      const s = await fetchStatus();
      if (s?.status !== "running") {
        setPolling(false);
        fetchCampaigns();
        fetchAnalytics();
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [polling, fetchStatus, fetchCampaigns, fetchAnalytics]);

  const startOutreach = async () => {
    setLoading(true);
    const body = {
      limit: config.limit,
      source: config.source,
      country: config.country || undefined,
      dryRun: config.dryRun,
      templateVariants: config.templateVariants.length ? config.templateVariants : undefined,
    };
    await api("/start", token, { method: "POST", body: JSON.stringify(body) });
    setPolling(true);
    setLoading(false);
    await fetchStatus();
  };

  const stopOutreach = async () => {
    await api("/stop", token, { method: "POST" });
    await fetchStatus();
  };

  const viewCampaign = async (id) => {
    const data = await api(`/campaigns/${id}`, token);
    setSelectedCampaign(data);
  };

  const toggleVariant = (v) => {
    setConfig(c => ({
      ...c,
      templateVariants: c.templateVariants.includes(v)
        ? c.templateVariants.filter(x => x !== v)
        : [...c.templateVariants, v],
    }));
  };

  const isRunning = status?.status === "running";

  return (
    <div style={{ padding: 32, maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Email Outreach</h1>
      <p style={{ color: T.textMuted, marginBottom: 24 }}>Automated cold email campaigns with A/B testing</p>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, marginBottom: 24, borderBottom: `1px solid ${T.border}` }}>
        {[
          { id: "launch", label: "Launch Campaign" },
          { id: "campaigns", label: "Campaigns" },
          { id: "analytics", label: "A/B Analytics" },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: "10px 20px", background: "none", border: "none", cursor: "pointer",
            fontWeight: tab === t.id ? 700 : 400, color: tab === t.id ? T.text : T.textMuted,
            borderBottom: tab === t.id ? `2px solid ${T.text}` : "2px solid transparent",
            marginBottom: -1, fontSize: 14,
          }}>{t.label}</button>
        ))}
      </div>

      {/* Launch Tab */}
      {tab === "launch" && (
        <div>
          {/* Live Status Banner */}
          {isRunning && (
            <div style={{ ...card, background: "#F0FFF4", borderColor: "#C6F6D5", marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <strong>Outreach Running</strong>
                  <span style={{ marginLeft: 12, color: T.textMid }}>
                    {status.sent} sent / {status.total} total
                    {status.failed > 0 && <span style={{ color: "#E53E3E" }}> ({status.failed} failed)</span>}
                  </span>
                </div>
                <button onClick={stopOutreach} style={{ ...btnDanger }}>Stop</button>
              </div>
              <div style={{ marginTop: 8, height: 6, background: "#E2E8F0", borderRadius: 3, overflow: "hidden" }}>
                <div style={{
                  height: "100%", background: "#48BB78", borderRadius: 3,
                  width: `${status.total ? ((status.sent + status.failed + status.skipped) / status.total * 100) : 0}%`,
                  transition: "width 0.3s ease",
                }} />
              </div>
            </div>
          )}

          {/* Config Form */}
          <div style={{ ...card, marginBottom: 20 }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Campaign Settings</h3>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 16 }}>
              <div>
                <label style={labelStyle}>Contact Source</label>
                <select value={config.source} onChange={e => setConfig(c => ({ ...c, source: e.target.value }))} style={inputStyle}>
                  <option value="all">All (Scraper + CRM)</option>
                  <option value="scraper">Scraper Only</option>
                  <option value="crm">CRM Leads Only</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>Max Contacts</label>
                <input type="number" value={config.limit} onChange={e => setConfig(c => ({ ...c, limit: parseInt(e.target.value) || 20 }))} style={inputStyle} min={1} max={200} />
              </div>
              <div>
                <label style={labelStyle}>Country Filter</label>
                <select value={config.country} onChange={e => setConfig(c => ({ ...c, country: e.target.value }))} style={inputStyle}>
                  <option value="">All Countries</option>
                  <option value="US">US</option>
                  <option value="UK">UK</option>
                </select>
              </div>
            </div>

            {/* Template Selection */}
            <label style={labelStyle}>A/B Templates (leave empty = use all)</label>
            <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
              {["A", "B", "C", "D", "E"].map(v => {
                const names = { A: "Direct Value", B: "Social Proof", C: "Question Led", D: "Observation", E: "Industry Trend" };
                const active = config.templateVariants.includes(v);
                return (
                  <button key={v} onClick={() => toggleVariant(v)} style={{
                    padding: "6px 14px", borderRadius: 6, fontSize: 13, cursor: "pointer",
                    border: `1px solid ${active ? T.text : T.border}`,
                    background: active ? T.text : T.surface, color: active ? "#fff" : T.text,
                    fontWeight: active ? 600 : 400,
                  }}>
                    {v}: {names[v]}
                  </button>
                );
              })}
            </div>

            {/* Dry Run Toggle */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={config.dryRun} onChange={e => setConfig(c => ({ ...c, dryRun: e.target.checked }))} />
                <span style={{ fontSize: 14 }}>
                  <strong>Dry Run</strong> — generate emails without sending (preview mode)
                </span>
              </label>
            </div>

            <button onClick={startOutreach} disabled={isRunning || loading} style={{
              ...btnPrimary, opacity: isRunning || loading ? 0.5 : 1,
            }}>
              {loading ? "Starting..." : isRunning ? "Running..." : config.dryRun ? "Preview Emails" : "Start Outreach"}
            </button>

            {!config.dryRun && (
              <p style={{ fontSize: 12, color: T.textMuted, marginTop: 8 }}>
                This will send real emails via Resend. Contacts will be moved to "Contacted" stage.
              </p>
            )}
          </div>

          {/* Recent Results */}
          {status?.results?.length > 0 && (
            <div style={card}>
              <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>
                {status.status === "running" ? "Live Results" : "Last Run Results"}
              </h3>
              <div style={{ maxHeight: 400, overflow: "auto" }}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Email</th>
                      <th style={thStyle}>Template</th>
                      <th style={thStyle}>Status</th>
                      <th style={thStyle}>Subject</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.results.map((r, i) => (
                      <tr key={i}>
                        <td style={tdStyle}>{r.email}</td>
                        <td style={tdStyle}>
                          <span style={tagStyle}>{r.variant}</span>
                        </td>
                        <td style={tdStyle}>
                          <span style={{ ...tagStyle, background: r.status === "sent" || r.status === "draft" ? "#F0FFF4" : r.status === "skipped" ? "#FFFAF0" : "#FFF5F5", color: r.status === "sent" || r.status === "draft" ? "#276749" : r.status === "skipped" ? "#C05621" : "#C53030" }}>
                            {r.status}
                          </span>
                        </td>
                        <td style={{ ...tdStyle, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {r.subject || r.error || r.reason || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Campaigns Tab */}
      {tab === "campaigns" && (
        <div>
          {selectedCampaign ? (
            <div>
              <button onClick={() => setSelectedCampaign(null)} style={{ ...btnSecondary, marginBottom: 16 }}>Back to Campaigns</button>
              <div style={card}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
                  <div>
                    <h3 style={{ fontSize: 16, fontWeight: 600 }}>{selectedCampaign.name}</h3>
                    <p style={{ color: T.textMuted, fontSize: 13 }}>
                      {new Date(selectedCampaign.created_at).toLocaleString()} — {selectedCampaign.status}
                    </p>
                  </div>
                  <div style={{ display: "flex", gap: 16, textAlign: "center" }}>
                    <Stat label="Sent" value={selectedCampaign.emails_sent} />
                    <Stat label="Failed" value={selectedCampaign.emails_failed} />
                    <Stat label="Skipped" value={selectedCampaign.emails_skipped} />
                  </div>
                </div>

                {selectedCampaign.sends?.length > 0 && (
                  <table style={tableStyle}>
                    <thead>
                      <tr>
                        <th style={thStyle}>To</th>
                        <th style={thStyle}>Subject</th>
                        <th style={thStyle}>Template</th>
                        <th style={thStyle}>Status</th>
                        <th style={thStyle}>Sent At</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedCampaign.sends.map(s => (
                        <tr key={s.id}>
                          <td style={tdStyle}>{s.to_name || s.to_email}</td>
                          <td style={{ ...tdStyle, maxWidth: 250, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.subject}</td>
                          <td style={tdStyle}><span style={tagStyle}>{s.template_variant}</span></td>
                          <td style={tdStyle}>
                            <span style={{ ...tagStyle, background: s.status === "sent" ? "#F0FFF4" : "#FFF5F5", color: s.status === "sent" ? "#276749" : "#C53030" }}>
                              {s.status}
                            </span>
                          </td>
                          <td style={{ ...tdStyle, fontSize: 12 }}>{s.sent_at ? new Date(s.sent_at).toLocaleString() : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          ) : (
            <div>
              {campaigns.length === 0 ? (
                <p style={{ color: T.textMuted, textAlign: "center", padding: 40 }}>No campaigns yet. Launch your first one above.</p>
              ) : (
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Campaign</th>
                      <th style={thStyle}>Status</th>
                      <th style={thStyle}>Sent</th>
                      <th style={thStyle}>Failed</th>
                      <th style={thStyle}>Source</th>
                      <th style={thStyle}>Date</th>
                      <th style={thStyle}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.map(c => (
                      <tr key={c.id}>
                        <td style={tdStyle}>{c.name}</td>
                        <td style={tdStyle}>
                          <span style={{ ...tagStyle, background: c.status === "complete" ? "#F0FFF4" : c.status === "running" ? "#EBF8FF" : "#F5F5F5", color: c.status === "complete" ? "#276749" : c.status === "running" ? "#2B6CB0" : T.textMid }}>
                            {c.status}
                          </span>
                        </td>
                        <td style={tdStyle}>{c.emails_sent}</td>
                        <td style={tdStyle}>{c.emails_failed}</td>
                        <td style={tdStyle}>{c.source}</td>
                        <td style={{ ...tdStyle, fontSize: 12 }}>{new Date(c.created_at).toLocaleDateString()}</td>
                        <td style={tdStyle}>
                          <button onClick={() => viewCampaign(c.id)} style={btnSecondary}>View</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      )}

      {/* Analytics Tab */}
      {tab === "analytics" && (
        <div>
          {!analytics ? (
            <p style={{ color: T.textMuted, textAlign: "center", padding: 40 }}>Loading analytics...</p>
          ) : (
            <div>
              {/* Summary Cards */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
                <StatCard label="Total Campaigns" value={analytics.total.campaigns} />
                <StatCard label="Emails Sent" value={analytics.total.totalSent} />
                <StatCard label="Emails Failed" value={analytics.total.totalFailed} />
                <StatCard label="Success Rate" value={analytics.total.total ? `${Math.round(analytics.total.totalSent / analytics.total.total * 100)}%` : "—"} />
              </div>

              {/* A/B Breakdown */}
              <div style={card}>
                <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Template Performance (A/B Test)</h3>
                {analytics.variants.length === 0 ? (
                  <p style={{ color: T.textMuted }}>No data yet. Run a campaign to see results.</p>
                ) : (
                  <table style={tableStyle}>
                    <thead>
                      <tr>
                        <th style={thStyle}>Template</th>
                        <th style={thStyle}>Name</th>
                        <th style={thStyle}>Total Sends</th>
                        <th style={thStyle}>Sent</th>
                        <th style={thStyle}>Failed</th>
                        <th style={thStyle}>Success Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analytics.variants.sort((a, b) => a.variant.localeCompare(b.variant)).map(v => {
                        const tpl = analytics.templates.find(t => t.variant === v.variant);
                        return (
                          <tr key={v.variant}>
                            <td style={tdStyle}><span style={{ ...tagStyle, fontWeight: 700 }}>{v.variant}</span></td>
                            <td style={tdStyle}>{tpl?.name || "—"}</td>
                            <td style={tdStyle}>{v.total}</td>
                            <td style={tdStyle}>{v.sent}</td>
                            <td style={tdStyle}>{v.failed}</td>
                            <td style={tdStyle}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <div style={{ width: 80, height: 6, background: "#E2E8F0", borderRadius: 3, overflow: "hidden" }}>
                                  <div style={{ height: "100%", background: "#48BB78", borderRadius: 3, width: `${v.total ? (v.sent / v.total * 100) : 0}%` }} />
                                </div>
                                <span style={{ fontSize: 13 }}>{v.total ? Math.round(v.sent / v.total * 100) : 0}%</span>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Reusable components
function Stat({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 700 }}>{value || 0}</div>
      <div style={{ fontSize: 11, color: T.textMuted }}>{label}</div>
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div style={card}>
      <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

// Styles
const card = { background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: 20, boxShadow: T.shadow };
const labelStyle = { display: "block", fontSize: 13, fontWeight: 500, marginBottom: 4, color: T.textMid };
const inputStyle = { width: "100%", padding: "8px 12px", borderRadius: 6, border: `1px solid ${T.border}`, fontSize: 14, background: T.surface, boxSizing: "border-box" };
const tableStyle = { width: "100%", borderCollapse: "collapse" };
const thStyle = { textAlign: "left", padding: "8px 12px", fontSize: 12, fontWeight: 600, color: T.textMuted, borderBottom: `1px solid ${T.border}` };
const tdStyle = { padding: "10px 12px", fontSize: 13, borderBottom: `1px solid ${T.border}` };
const tagStyle = { display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 12, background: T.accentLight };
const btnPrimary = { padding: "10px 24px", borderRadius: 8, border: "none", background: T.text, color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" };
const btnSecondary = { padding: "6px 14px", borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, fontSize: 13, cursor: "pointer" };
const btnDanger = { padding: "6px 14px", borderRadius: 6, border: "1px solid #FC8181", background: "#FFF5F5", color: "#C53030", fontSize: 13, fontWeight: 600, cursor: "pointer" };
