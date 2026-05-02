// AI Inbox — see live conversations, run bulk first-message batches,
// inspect suppressions & inbound webhook events.

import { useEffect, useMemo, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api, friendlyDate } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Skeleton, SkeletonRow } from "../components/ui/Skeleton";

const STATUS_TINTS = {
  active: { bg: "#DBEAFE", fg: "#1E40AF" },
  qualified: { bg: "#D1FAE5", fg: "#065F46" },
  booked: { bg: "#A7F3D0", fg: "#064E3B" },
  dead: { bg: "#FEE2E2", fg: "#991B1B" },
  opted_out: { bg: "#F3F4F6", fg: "#374151" },
  escalated: { bg: "#FEF3C7", fg: "#92400E" },
};

const STATUS_FILTERS = ["all", "active", "qualified", "booked", "escalated", "dead", "opted_out"];

export default function AiInboxPage() {
  const { theme } = useTheme();

  const [tab, setTab] = useState("threads");        // threads | bulk | suppressions | events
  const [campaigns, setCampaigns] = useState([]);
  const [campaignId, setCampaignId] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [threads, setThreads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [thread, setThread] = useState(null);

  useEffect(() => {
    api.getAiCampaigns()
      .then(setCampaigns)
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (tab !== "threads") return;
    setLoading(true);
    setError(null);
    api.listAiThreads({
      campaign: campaignId === "all" ? undefined : campaignId,
      status: statusFilter === "all" ? undefined : statusFilter,
      limit: 100,
    })
      .then(setThreads)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [tab, campaignId, statusFilter]);

  useEffect(() => {
    if (!selectedId) { setThread(null); return; }
    api.getAiThread(selectedId)
      .then(setThread)
      .catch((e) => setError(e.message));
  }, [selectedId]);

  const filteredThreads = useMemo(() => {
    return threads;
  }, [threads]);

  return (
    <div>
      <div style={{ marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: theme.text, margin: 0 }}>AI Inbox</h1>
          <p style={{ fontSize: 13, color: theme.textMuted, margin: "4px 0 0" }}>
            Live conversations the AI is managing. Bulk-start new threads, review suppressions, debug webhook events.
          </p>
        </div>
      </div>

      <Tabs tab={tab} setTab={setTab} theme={theme} />

      {error && (
        <Card style={{ borderColor: "#DC2626" }}>
          <div style={{ color: "#DC2626", fontSize: 13 }}>{error}</div>
        </Card>
      )}

      {tab === "threads" && (
        <div style={{ display: "grid", gridTemplateColumns: selectedId ? "minmax(0, 380px) minmax(0, 1fr)" : "1fr", gap: 16, alignItems: "start" }}>
          <div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              <select
                value={campaignId}
                onChange={(e) => setCampaignId(e.target.value)}
                style={selectStyle(theme)}
              >
                <option value="all">All campaigns</option>
                {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                style={selectStyle(theme)}
              >
                {STATUS_FILTERS.map((s) => (
                  <option key={s} value={s}>{s === "all" ? "Any status" : s.replace("_", " ")}</option>
                ))}
              </select>
            </div>

            {loading && threads.length === 0 ? (
              <Card style={{ padding: 0 }}>
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} style={{ padding: "14px 16px", borderBottom: `1px solid ${theme.border}` }}>
                    <SkeletonRow widths={["40%", "75%", "55%"]} />
                  </div>
                ))}
              </Card>
            ) : filteredThreads.length === 0 ? (
              <Card><div style={{ color: theme.textMuted, fontSize: 13 }}>No conversations yet. Start one from the bulk tab or the Test Lab.</div></Card>
            ) : (
              <Card style={{ padding: 0 }}>
                {filteredThreads.map((t, i) => (
                  <ThreadRow
                    key={t.id}
                    thread={t}
                    selected={t.id === selectedId}
                    onClick={() => setSelectedId(t.id)}
                    theme={theme}
                    isLast={i === filteredThreads.length - 1}
                  />
                ))}
              </Card>
            )}
          </div>

          {selectedId && (
            <ThreadDetail thread={thread} onClose={() => setSelectedId(null)} theme={theme} />
          )}
        </div>
      )}

      {tab === "metrics" && <MetricsPanel theme={theme} />}
      {tab === "leads" && <LeadsPanel campaigns={campaigns} theme={theme} />}
      {tab === "bulk" && <BulkPanel campaigns={campaigns} theme={theme} />}
      {tab === "suppressions" && <SuppressionsPanel theme={theme} />}
      {tab === "events" && <EventsPanel theme={theme} />}
    </div>
  );
}

function Tabs({ tab, setTab, theme }) {
  const tabs = [
    { id: "threads", label: "Threads" },
    { id: "metrics", label: "Metrics" },
    { id: "leads", label: "Find leads" },
    { id: "bulk", label: "Bulk start" },
    { id: "suppressions", label: "Suppressions" },
    { id: "events", label: "Webhook events" },
  ];
  return (
    <div style={{ display: "flex", gap: 4, marginBottom: 16, borderBottom: `1px solid ${theme.border}` }}>
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => setTab(t.id)}
          style={{
            padding: "8px 14px", fontFamily: "inherit", fontSize: 13, fontWeight: 500,
            background: "transparent", border: "none", cursor: "pointer",
            color: tab === t.id ? theme.text : theme.textMuted,
            borderBottom: tab === t.id ? `2px solid ${theme.accent}` : "2px solid transparent",
            marginBottom: -1,
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function ThreadRow({ thread, selected, onClick, theme, isLast }) {
  const tint = STATUS_TINTS[thread.status] || { bg: theme.surfaceAlt, fg: theme.textMid };
  return (
    <button
      onClick={onClick}
      style={{
        display: "block", width: "100%", textAlign: "left", padding: "12px 16px",
        background: selected ? theme.accentLight : "transparent",
        border: "none", borderBottom: isLast ? "none" : `1px solid ${theme.border}`,
        cursor: "pointer", fontFamily: "inherit", color: theme.text,
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = theme.surfaceAlt; }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: theme.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {thread.prospect_name || thread.prospect_email}
        </div>
        <span style={{
          background: tint.bg, color: tint.fg, fontSize: 10, fontWeight: 700,
          padding: "2px 6px", borderRadius: 4, textTransform: "uppercase", letterSpacing: 0.4,
        }}>{thread.status}</span>
      </div>
      <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 4 }}>
        {thread.prospect_company || thread.prospect_email}
      </div>
      <div style={{ fontSize: 11, color: theme.textMuted, display: "flex", justifyContent: "space-between" }}>
        <span>q: {thread.qualification_score} · f: {thread.follow_up_count || 0}</span>
        <span>{friendlyDate(thread.updated_at)}</span>
      </div>
    </button>
  );
}

function ThreadDetail({ thread, onClose, theme }) {
  if (!thread) {
    return <Card><div style={{ color: theme.textMuted }}>Loading thread…</div></Card>;
  }
  const messages = thread.messages || [];
  return (
    <Card style={{ padding: 0 }}>
      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${theme.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontWeight: 600, color: theme.text, fontSize: 14 }}>{thread.prospect_name || thread.prospect_email}</div>
          <div style={{ fontSize: 12, color: theme.textMuted }}>{thread.prospect_email} · {thread.prospect_company || "—"}</div>
        </div>
        <button onClick={onClose} style={{ background: "transparent", border: "none", color: theme.textMuted, fontSize: 18, cursor: "pointer" }}>×</button>
      </div>
      <div style={{ padding: 16, maxHeight: 540, overflowY: "auto", background: theme.bg }}>
        {messages.length === 0 ? (
          <div style={{ color: theme.textMuted, fontSize: 13 }}>No messages yet.</div>
        ) : messages.map((m) => (
          <MessageBubble key={m.id} m={m} theme={theme} />
        ))}
      </div>
      {thread.ai_notes && (
        <div style={{ borderTop: `1px solid ${theme.border}`, padding: 12, background: theme.surfaceAlt }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: theme.textMid, textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 4 }}>AI notes</div>
          <pre style={{ margin: 0, fontSize: 11, color: theme.textMid, whiteSpace: "pre-wrap" }}>{thread.ai_notes}</pre>
        </div>
      )}
    </Card>
  );
}

function MessageBubble({ m, theme }) {
  const isOut = m.direction === "out";
  const bg = isOut ? theme.accent : theme.surface;
  const fg = isOut ? (theme.mode === "dark" ? "#0A0A0A" : "#fff") : theme.text;
  const sentLabel = m.sent_at
    ? `sent ${friendlyDate(m.sent_at)}`
    : m.scheduled_for
      ? `scheduled ${friendlyDate(m.scheduled_for)}`
      : m.error
        ? `error: ${m.error}`
        : "draft";
  return (
    <div style={{ display: "flex", justifyContent: isOut ? "flex-end" : "flex-start", marginBottom: 12 }}>
      <div style={{ maxWidth: "78%" }}>
        {m.subject && (
          <div style={{ fontSize: 10, color: theme.textMuted, marginBottom: 3, fontWeight: 600 }}>
            {m.subject}
          </div>
        )}
        <div style={{
          background: bg, color: fg, padding: "10px 14px", borderRadius: 12,
          fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap",
          border: isOut ? "none" : `1px solid ${theme.border}`,
        }}>
          {m.body}
        </div>
        <div style={{ fontSize: 10, color: theme.textMuted, marginTop: 4, textAlign: isOut ? "right" : "left" }}>
          {sentLabel}
          {m.tool_calls?.length ? ` · tools: ${m.tool_calls.map((t) => t.name).join(", ")}` : ""}
        </div>
      </div>
    </div>
  );
}

function BulkPanel({ campaigns, theme }) {
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id || "");
  const [source, setSource] = useState("scraper_results");
  const [limit, setLimit] = useState(20);
  const [country, setCountry] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!campaignId && campaigns.length) setCampaignId(campaigns[0].id);
  }, [campaigns, campaignId]);

  const refresh = () => api.listAiBulkRuns({ limit: 25 }).then(setRuns).catch((e) => setError(e.message));

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await api.startAiBulk({
        campaignId,
        source,
        filters: country ? { country } : {},
        limit: parseInt(limit) || 20,
        dryRun,
      });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 380px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
      <div>
        <SingleSendCard campaigns={campaigns} campaignId={campaignId} setCampaignId={setCampaignId} theme={theme} />
      <Card>
        <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 12 }}>New bulk run</div>
        <Field label="Campaign" theme={theme}>
          <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} style={selectStyle(theme)}>
            <option value="">— pick a campaign —</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Source" theme={theme}>
          <select value={source} onChange={(e) => setSource(e.target.value)} style={selectStyle(theme)}>
            <option value="storeleads">storeleads (recommended)</option>
            <option value="scraper_results">scraper_results</option>
            <option value="contacts">contacts</option>
          </select>
        </Field>
        <Field label="Country (optional)" theme={theme}>
          <Input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="e.g. UK" />
        </Field>
        <Field label="Max prospects" theme={theme}>
          <Input value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="20" />
        </Field>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: theme.textMid, margin: "4px 0 12px" }}>
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          Dry run (no email sent)
        </label>
        <Btn onClick={start} disabled={!campaignId} loading={busy}>Start bulk run</Btn>
      </Card>
      </div>

      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 8 }}>Recent runs</div>
        {runs.length === 0 ? (
          <Card><div style={{ color: theme.textMuted, fontSize: 13 }}>No runs yet.</div></Card>
        ) : (
          <Card style={{ padding: 0 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: theme.surfaceAlt, color: theme.textMid }}>
                  <Th>Status</Th><Th>Source</Th><Th>Total</Th><Th>Sent</Th><Th>Skipped</Th><Th>Failed</Th><Th>When</Th><Th></Th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} style={{ borderTop: `1px solid ${theme.border}`, color: theme.text }}>
                    <Td><RunStatus status={r.status} theme={theme} /></Td>
                    <Td>{r.source}</Td>
                    <Td>{r.processed}/{r.total}</Td>
                    <Td>{r.sent}</Td>
                    <Td>{r.skipped}</Td>
                    <Td>{r.failed}</Td>
                    <Td>{friendlyDate(r.started_at)}</Td>
                    <Td>{r.status === "running" && (
                      <button onClick={() => api.stopAiBulkRun(r.id).then(refresh)} style={miniBtn(theme)}>Stop</button>
                    )}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
      {error && <div style={{ gridColumn: "1 / -1", color: "#DC2626", fontSize: 13 }}>{error}</div>}
    </div>
  );
}

// Single-prospect send. Quickest way to test the real loop end-to-end —
// generate + actually send a first message to one address you control,
// then reply from there to watch the AI handle it.
function SingleSendCard({ campaigns, campaignId, setCampaignId, theme }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [domain, setDomain] = useState("");
  const [productTypes, setProductTypes] = useState("");
  const [brandStory, setBrandStory] = useState("");
  const [dryRun, setDryRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function send() {
    if (!campaignId || !email) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.startAiConversation({
        campaignId,
        prospect: {
          email: email.trim(),
          name: name.trim() || null,
          company: company.trim() || null,
          domain: domain.trim() || null,
          productTypes: productTypes.split(",").map((s) => s.trim()).filter(Boolean),
          brandStory: brandStory.trim() || null,
        },
        dryRun,
      });
      setResult(r);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 4 }}>
        Send to one address (test loop)
      </div>
      <p style={{ fontSize: 11, color: theme.textMuted, margin: "0 0 12px", lineHeight: 1.5 }}>
        Sends a real first message to one prospect. Useful for testing the full loop with your own gmail.
      </p>
      <Field label="Campaign" theme={theme}>
        <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} style={selectStyle(theme)}>
          <option value="">— pick a campaign —</option>
          {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label="Email *" theme={theme}>
        <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
      </Field>
      <Field label="Name" theme={theme}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="First Last" />
      </Field>
      <Field label="Company / brand" theme={theme}>
        <Input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Glow Skin Co" />
      </Field>
      <Field label="Domain" theme={theme}>
        <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="glowskinco.com" />
      </Field>
      <Field label="Product types (comma-separated)" theme={theme}>
        <Input value={productTypes} onChange={(e) => setProductTypes(e.target.value)} placeholder="serums, moisturizers" />
      </Field>
      <Field label="Brand story / context" theme={theme}>
        <Input multiline rows={2} value={brandStory} onChange={(e) => setBrandStory(e.target.value)} placeholder="Optional — gives the AI more to work with." />
      </Field>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: theme.textMid, margin: "4px 0 12px" }}>
        <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
        Dry run (generate but do not send)
      </label>
      <Btn onClick={send} disabled={!campaignId || !email} loading={busy}>
        {dryRun ? "Generate (no send)" : "Send first message"}
      </Btn>

      {error && (
        <div style={{ marginTop: 12, color: "#DC2626", fontSize: 12 }}>{error}</div>
      )}
      {result && (
        <div style={{ marginTop: 12, padding: 10, background: theme.bg, border: `1px solid ${theme.border}`, borderRadius: 6, fontSize: 12, color: theme.textMid }}>
          {result.skipped && <div>Skipped: <code>{result.skipped}</code></div>}
          {result.ai && (
            <>
              <div style={{ fontWeight: 600, color: theme.text, marginBottom: 4 }}>{result.ai.subject}</div>
              <div style={{ whiteSpace: "pre-wrap", color: theme.text }}>{result.ai.body}</div>
              {result.send?.success && <div style={{ marginTop: 6, color: "#16A34A" }}>✓ sent · {result.send.resendId || "ok"}</div>}
              {result.send?.error && <div style={{ marginTop: 6, color: "#DC2626" }}>send error: {result.send.error}</div>}
              {result.send?.dryRun && <div style={{ marginTop: 6, color: theme.textMuted }}>(dry run — nothing sent)</div>}
            </>
          )}
        </div>
      )}
    </Card>
  );
}

// Lead discovery: kicks off StoreLeads → Apollo → Hunter pipeline,
// then shows the resulting prospect pool.
function LeadsPanel({ campaigns, theme }) {
  const [campaignId, setCampaignId] = useState("");
  const [country, setCountry] = useState("GB");
  const [minRevenue, setMinRevenue] = useState(50000);
  const [maxRevenue, setMaxRevenue] = useState(5000000);
  const [limit, setLimit] = useState(50);
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState([]);
  const [leads, setLeads] = useState([]);
  const [error, setError] = useState(null);
  const [showUnused, setShowUnused] = useState(true);

  useEffect(() => {
    if (!campaignId && campaigns.length) setCampaignId(campaigns[0].id);
  }, [campaigns, campaignId]);

  const refresh = async () => {
    try {
      const [r, l] = await Promise.all([
        api.listAiBulkRuns({ limit: 10 }),
        api.listAiLeads({ country: country || undefined, unused: showUnused, limit: 100 }),
      ]);
      setRuns((r || []).filter((row) => row.source === "discover_storeleads"));
      setLeads(l || []);
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country, showUnused]);

  async function discover() {
    if (!campaignId) return;
    setBusy(true);
    setError(null);
    try {
      await api.discoverLeads({
        campaignId,
        filters: {
          country: country || undefined,
          minRevenue: parseInt(minRevenue) || 50000,
          maxRevenue: parseInt(maxRevenue) || 5000000,
        },
        limit: parseInt(limit) || 50,
      });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 380px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
      <div>
        <Card>
          <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 4 }}>
            Find new leads (StoreLeads)
          </div>
          <p style={{ fontSize: 11, color: theme.textMuted, margin: "0 0 12px", lineHeight: 1.5 }}>
            Pulls Shopify brands matching your filters, finds the founder/marketing
            contact via Apollo + Hunter, verifies the email, and adds them to your
            prospect pool. Each lead costs roughly 1 StoreLeads + 1 Apollo + 1 Hunter call.
          </p>
          <Field label="Campaign (for tracking)" theme={theme}>
            <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} style={selectStyle(theme)}>
              <option value="">— pick a campaign —</option>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Country" theme={theme}>
            <select value={country} onChange={(e) => setCountry(e.target.value)} style={selectStyle(theme)}>
              <option value="GB">United Kingdom</option>
              <option value="US">United States</option>
              <option value="">All</option>
            </select>
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <Field label="Min revenue (USD/yr)" theme={theme}>
              <Input value={minRevenue} onChange={(e) => setMinRevenue(e.target.value)} placeholder="50000" />
            </Field>
            <Field label="Max revenue (USD/yr)" theme={theme}>
              <Input value={maxRevenue} onChange={(e) => setMaxRevenue(e.target.value)} placeholder="5000000" />
            </Field>
          </div>
          <Field label="Max prospects to find" theme={theme}>
            <Input value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="50" />
          </Field>
          <Btn onClick={discover} disabled={!campaignId} loading={busy}>Find leads</Btn>
          {error && <div style={{ marginTop: 12, color: "#DC2626", fontSize: 12 }}>{error}</div>}
        </Card>

        {runs.length > 0 && (
          <Card>
            <div style={{ fontSize: 11, fontWeight: 600, color: theme.textMid, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.3 }}>
              Recent discovery runs
            </div>
            {runs.map((r) => (
              <div key={r.id} style={{ fontSize: 11, color: theme.textMid, padding: "6px 0", borderTop: `1px solid ${theme.border}` }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <RunStatus status={r.status} theme={theme} />
                  <span style={{ color: theme.textMuted }}>{friendlyDate(r.started_at)}</span>
                </div>
                <div style={{ marginTop: 3 }}>
                  found <strong>{r.sent}</strong>, processed {r.processed}, skipped {r.skipped}, failed {r.failed} / target {r.total}
                </div>
                {r.error && <div style={{ color: "#DC2626", fontSize: 10, marginTop: 3 }}>{r.error}</div>}
              </div>
            ))}
          </Card>
        )}
      </div>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>
            Available leads ({leads.length})
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: theme.textMid, cursor: "pointer" }}>
            <input type="checkbox" checked={showUnused} onChange={(e) => setShowUnused(e.target.checked)} />
            Only unused
          </label>
        </div>
        {leads.length === 0 ? (
          <Card><div style={{ color: theme.textMuted, fontSize: 13 }}>No leads found yet. Click Find leads to populate.</div></Card>
        ) : (
          <Card style={{ padding: 0 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: theme.surfaceAlt, color: theme.textMid }}>
                  <Th>Brand</Th>
                  <Th>Contact</Th>
                  <Th>Email</Th>
                  <Th>Position</Th>
                  <Th>Country</Th>
                  <Th>Source</Th>
                  <Th>Used</Th>
                </tr>
              </thead>
              <tbody>
                {leads.slice(0, 50).map((l) => (
                  <tr key={l.domain} style={{ borderTop: `1px solid ${theme.border}`, color: theme.text }}>
                    <Td>{l.merchant_name || l.title || l.domain}</Td>
                    <Td>{[l.contact_first_name, l.contact_last_name].filter(Boolean).join(" ") || "—"}</Td>
                    <Td><code style={{ fontSize: 11 }}>{l.email}</code></Td>
                    <Td style={{ color: theme.textMuted, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {l.contact_position || "—"}
                    </Td>
                    <Td>{l.country_code || "—"}</Td>
                    <Td style={{ color: theme.textMuted }}>{l.contact_source || "storeleads"}</Td>
                    <Td>{l.contact_used ? "✓" : ""}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
            {leads.length > 50 && (
              <div style={{ padding: 8, fontSize: 11, color: theme.textMuted, textAlign: "center", borderTop: `1px solid ${theme.border}` }}>
                Showing 50 of {leads.length}. Use Bulk Start tab to outreach with source = storeleads.
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}

function MetricsPanel({ theme }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      const data = await api.getAiMetrics();
      setRows(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, []);

  async function unpause(id) {
    try {
      await api.unpauseAiCampaign(id);
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  }

  if (loading && rows.length === 0) {
    return (
      <Card style={{ padding: 0 }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} style={{ padding: "14px 16px", borderBottom: `1px solid ${theme.border}` }}>
            <SkeletonRow widths={["35%", "70%", "50%"]} />
          </div>
        ))}
      </Card>
    );
  }
  if (error) return <Card><div style={{ color: "#DC2626" }}>{error}</div></Card>;
  if (rows.length === 0) {
    return <Card><div style={{ color: theme.textMuted, fontSize: 13 }}>No campaigns yet.</div></Card>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {rows.map((c) => <CampaignMetricsCard key={c.id} c={c} theme={theme} onUnpause={() => unpause(c.id)} />)}
    </div>
  );
}

function CampaignMetricsCard({ c, theme, onUnpause }) {
  const replyRate = c.conversations > 0 ? Math.round((c.replied / c.conversations) * 100) : 0;
  const qualifiedRate = c.conversations > 0 ? Math.round(((c.qualified + c.booked) / c.conversations) * 100) : 0;
  const bookedRate = c.conversations > 0 ? Math.round((c.booked / c.conversations) * 100) : 0;
  const isPaused = c.status === "paused" || !!c.auto_paused_at;

  return (
    <Card style={{ padding: 0 }}>
      <div style={{ padding: "16px 20px", borderBottom: `1px solid ${theme.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>{c.name}</div>
          <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 2 }}>
            cap {c.daily_send_cap || "default"}/day · window {c.send_window_start_hour}:00–{c.send_window_end_hour}:00 {c.timezone}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {isPaused ? (
            <>
              <span style={{ background: "#FEE2E2", color: "#991B1B", fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 4, textTransform: "uppercase" }}>
                PAUSED
              </span>
              {c.auto_pause_reason && (
                <span style={{ fontSize: 11, color: theme.textMid, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.auto_pause_reason}
                </span>
              )}
              <button onClick={onUnpause} style={miniBtn(theme)}>Unpause</button>
            </>
          ) : (
            <span style={{ background: "#D1FAE5", color: "#065F46", fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 4, textTransform: "uppercase" }}>
              {c.status}
            </span>
          )}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 1, background: theme.border }}>
        <Metric label="Sent today" value={c.sent_today} sub={`/${c.daily_send_cap || "—"}`} theme={theme} />
        <Metric label="Pending" value={c.scheduled_pending} theme={theme} />
        <Metric label="Total sent" value={c.sent_total} theme={theme} />
        <Metric label="Replied" value={`${c.replied}`} sub={`${replyRate}%`} theme={theme} />
        <Metric label="Qualified" value={`${c.qualified + c.booked}`} sub={`${qualifiedRate}%`} accent="#065F46" theme={theme} />
        <Metric label="Booked" value={c.booked} sub={`${bookedRate}%`} accent="#065F46" theme={theme} />
        <Metric label="Dead/Out" value={c.dead + c.opted_out} accent="#991B1B" theme={theme} />
      </div>
    </Card>
  );
}

function Metric({ label, value, sub, theme, accent }) {
  return (
    <div style={{ background: theme.surface, padding: "12px 14px" }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 4 }}>
        <span style={{ fontSize: 18, fontWeight: 600, color: accent || theme.text }}>{value}</span>
        {sub && <span style={{ fontSize: 11, color: theme.textMuted }}>{sub}</span>}
      </div>
    </div>
  );
}

function SuppressionsPanel({ theme }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.listAiSuppressions({ limit: 200 })
      .then(setRows)
      .catch((e) => setError(e.message));
  }, []);
  if (error) return <Card><div style={{ color: "#DC2626" }}>{error}</div></Card>;
  return (
    <Card style={{ padding: 0 }}>
      {rows.length === 0 ? (
        <div style={{ padding: 16, color: theme.textMuted, fontSize: 13 }}>No suppressions yet.</div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: theme.surfaceAlt, color: theme.textMid }}>
              <Th>Email</Th><Th>Reason</Th><Th>Detail</Th><Th>When</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderTop: `1px solid ${theme.border}`, color: theme.text }}>
                <Td>{r.email}</Td>
                <Td>{r.reason}</Td>
                <Td style={{ color: theme.textMuted }}>{r.detail || "—"}</Td>
                <Td>{friendlyDate(r.created_at)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function EventsPanel({ theme }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.listAiEvents({ limit: 100 })
      .then(setRows)
      .catch((e) => setError(e.message));
  }, []);
  if (error) return <Card><div style={{ color: "#DC2626" }}>{error}</div></Card>;
  return (
    <Card style={{ padding: 0 }}>
      {rows.length === 0 ? (
        <div style={{ padding: 16, color: theme.textMuted, fontSize: 13 }}>No webhook events yet — once Resend posts inbound or status events, they show up here.</div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: theme.surfaceAlt, color: theme.textMid }}>
              <Th>When</Th><Th>Event</Th><Th>Source</Th><Th>Sig</Th><Th>Error</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderTop: `1px solid ${theme.border}`, color: theme.text }}>
                <Td>{friendlyDate(r.created_at)}</Td>
                <Td><code style={{ fontSize: 11 }}>{r.event_type || "—"}</code></Td>
                <Td>{r.source}</Td>
                <Td>{r.signature_valid === null ? "—" : r.signature_valid ? "✓" : "✗"}</Td>
                <Td style={{ color: r.handler_error ? "#DC2626" : theme.textMuted, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.handler_error || "ok"}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---------- presentational helpers ----------
function Field({ label, children, theme }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: theme.textMid, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function Th({ children }) {
  return <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>{children}</th>;
}
function Td({ children, style = {} }) {
  return <td style={{ padding: "8px 12px", ...style }}>{children}</td>;
}
function selectStyle(theme) {
  return {
    padding: "8px 12px", borderRadius: 8, fontSize: 13, fontFamily: "inherit",
    border: `1.5px solid ${theme.border}`, background: theme.bg, color: theme.text,
    minWidth: 160,
  };
}
function miniBtn(theme) {
  return {
    padding: "4px 10px", fontSize: 11, fontFamily: "inherit", fontWeight: 600,
    border: `1px solid ${theme.border}`, borderRadius: 4, background: theme.bg,
    color: theme.text, cursor: "pointer",
  };
}
function RunStatus({ status, theme }) {
  const colors = {
    running: { bg: "#DBEAFE", fg: "#1E40AF" },
    complete: { bg: "#D1FAE5", fg: "#065F46" },
    failed: { bg: "#FEE2E2", fg: "#991B1B" },
    stopped: { bg: "#F3F4F6", fg: "#374151" },
  }[status] || { bg: theme.surfaceAlt, fg: theme.textMid };
  return (
    <span style={{
      background: colors.bg, color: colors.fg, fontSize: 10, fontWeight: 700,
      padding: "2px 6px", borderRadius: 4, textTransform: "uppercase", letterSpacing: 0.4,
    }}>{status}</span>
  );
}
