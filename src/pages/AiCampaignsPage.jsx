// AI Campaigns — list + create email outbound campaigns. Each campaign has
// its own target filters, daily cap, sender, A/B templates, and metrics.
// Clicking a row navigates to AiCampaignDetailPage for the deep view.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTheme } from "../contexts/ThemeContext";
import { api, friendlyDate } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { TabBar } from "../components/ui/TabBar";
import { Pagination } from "../components/ui/Pagination";

const STATUS_TINTS = {
  active:   { bg: "#D1FAE5", fg: "#065F46" },
  paused:   { bg: "#FEF3C7", fg: "#92400E" },
  archived: { bg: "#F3F4F6", fg: "#374151" },
  pending:  { bg: "#DBEAFE", fg: "#1E40AF" },
  running:  { bg: "#DBEAFE", fg: "#1E40AF" },
  complete: { bg: "#D1FAE5", fg: "#065F46" },
  failed:   { bg: "#FEE2E2", fg: "#991B1B" },
  stopped:  { bg: "#F3F4F6", fg: "#374151" },
};

const TABS = [
  ["all",      "All"],
  ["running",  "Running"],
  ["complete", "Complete"],
  ["failed",   "Failed"],
  ["paused",   "Paused"],
  ["pending",  "Pending"],
  ["archived", "Archived"],
];

export default function AiCampaignsPage() {
  const { theme } = useTheme();
  const [campaigns, setCampaigns] = useState([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const loadCounts = useCallback(() => {
    api.getOutboundCampaignStatusCounts()
      .then(setCounts)
      .catch(() => {});
  }, []);

  const reload = useCallback(() => {
    setLoading(true); setError(null);
    api.listOutboundCampaigns({
      status: tab,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    })
      .then((res) => { setCampaigns(res.rows || []); setTotal(res.total || 0); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [tab, page, pageSize]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { loadCounts(); }, [loadCounts]);
  useEffect(() => { setPage(1); }, [tab, pageSize]);

  return (
    <div>
      <div style={{ marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: theme.text, margin: 0 }}>AI Campaigns</h1>
          <p style={{ fontSize: 13, color: theme.textMuted, margin: "4px 0 0" }}>
            Email outbound campaigns. Each one targets a verticals × revenue × geo slice and runs a 3-touch sequence with A/B templates.
          </p>
        </div>
        <Btn onClick={() => setCreating(true)}>+ New campaign</Btn>
      </div>

      {error && (
        <Card style={{ borderColor: "#DC2626", marginBottom: 12 }}>
          <div style={{ color: "#DC2626", fontSize: 13 }}>{error}</div>
        </Card>
      )}

      {creating && (
        <CreateCampaignCard
          theme={theme}
          onCancel={() => setCreating(false)}
          onCreated={() => { setCreating(false); reload(); loadCounts(); }}
        />
      )}

      <TabBar
        tabs={TABS.map(([id, label]) => {
          const n = counts[id];
          return [id, n != null ? `${label} (${n})` : label];
        })}
        active={tab}
        onSelect={setTab}
      />

      {loading && campaigns.length === 0 ? (
        <Card><div style={{ color: theme.textMuted }}>Loading…</div></Card>
      ) : campaigns.length === 0 ? (
        <Card>
          <div style={{ color: theme.textMuted, fontSize: 13 }}>
            {tab === "all"
              ? "No campaigns yet. Create one to start outbound — it'll seed the 9 default templates (G1/G2/G3 × T+0/T+3/T+7) which you can edit or override with AI-generated drafts."
              : `No campaigns with status "${tab}".`}
          </div>
        </Card>
      ) : (
        <Card style={{ padding: 0, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${theme.border}`, color: theme.textMuted }}>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th>Daily cap</Th>
                <Th>Auto-reply</Th>
                <Th>Targets</Th>
                <Th>Created</Th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} style={{ borderBottom: `1px solid ${theme.border}` }}>
                  <Td>
                    <Link to={`/ai/campaigns/${c.id}`} style={{ color: theme.text, fontWeight: 500, textDecoration: "none" }}>
                      {c.name}
                    </Link>
                    {c.brief && (
                      <div style={{ color: theme.textMuted, fontSize: 11, marginTop: 2, maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {c.brief}
                      </div>
                    )}
                  </Td>
                  <Td><Pill tint={STATUS_TINTS[c.status] || {}}>{c.status}</Pill></Td>
                  <Td>{c.daily_cap}</Td>
                  <Td>{c.auto_reply ? <Pill tint={{ bg: "#E0E7FF", fg: "#3730A3" }}>auto</Pill> : <Pill tint={{ bg: "#F3F4F6", fg: "#374151" }}>manual</Pill>}</Td>
                  <Td style={{ color: theme.textMuted, fontSize: 11, maxWidth: 220 }}>
                    {summarizeTargets(c.target_filters)}
                  </Td>
                  <Td style={{ color: theme.textMuted, whiteSpace: "nowrap" }}>{friendlyDate(c.created_at)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {total > 0 && (
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      )}
    </div>
  );
}

function summarizeTargets(tf = {}) {
  const parts = [];
  if (tf.countries?.length) parts.push(tf.countries.slice(0, 3).join("/"));
  if (tf.min_revenue || tf.max_revenue) {
    const fmt = (n) => n ? `$${(n / 1_000_000).toFixed(1)}M` : "?";
    parts.push(`${fmt(tf.min_revenue)}–${fmt(tf.max_revenue)}/mo`);
  }
  if (tf.categories?.length) parts.push(`${tf.categories.length} sectors`);
  return parts.join(" · ") || "no filters";
}

function CreateCampaignCard({ theme, onCancel, onCreated }) {
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [dailyCap, setDailyCap] = useState(200);
  const [countries, setCountries] = useState("US,GB");
  const [minRevenue, setMinRevenue] = useState(5_000_000);
  const [maxRevenue, setMaxRevenue] = useState(10_000_000);
  const [categories, setCategories] = useState("beauty, wellness, skincare, haircare, fragrance");
  const [autoReply, setAutoReply] = useState(false);
  const [aiCampaignId, setAiCampaignId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function submit() {
    if (!name) { setErr("Name required"); return; }
    setBusy(true); setErr(null);
    try {
      const target_filters = {
        countries: countries.split(",").map((s) => s.trim()).filter(Boolean),
        min_revenue: Number(minRevenue) || undefined,
        max_revenue: Number(maxRevenue) || undefined,
        categories: categories.split(",").map((s) => s.trim()).filter(Boolean),
      };
      const body = {
        name,
        brief: brief || null,
        daily_cap: Number(dailyCap) || 200,
        target_filters,
        auto_reply: autoReply,
        ai_campaign_id: aiCampaignId || null,
      };
      await api.createOutboundCampaign(body);
      onCreated();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 12, color: theme.text }}>New campaign</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
        <Field label="Name" theme={theme}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Summer beauty US/UK Q3" />
        </Field>
        <Field label="Daily cap" theme={theme}>
          <Input type="number" value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} />
        </Field>
        <Field label="Countries (comma-separated ISO codes)" theme={theme}>
          <Input value={countries} onChange={(e) => setCountries(e.target.value)} placeholder="US,GB,CA" />
        </Field>
        <Field label="Categories / sectors (comma-separated)" theme={theme}>
          <Input value={categories} onChange={(e) => setCategories(e.target.value)} placeholder="beauty, wellness, skincare" />
        </Field>
        <Field label="Min monthly revenue (USD)" theme={theme}>
          <Input type="number" value={minRevenue} onChange={(e) => setMinRevenue(e.target.value)} />
        </Field>
        <Field label="Max monthly revenue (USD)" theme={theme}>
          <Input type="number" value={maxRevenue} onChange={(e) => setMaxRevenue(e.target.value)} />
        </Field>
        <Field label="Brief (used by AI for draft generation)" theme={theme} colSpan={2}>
          <textarea
            value={brief} onChange={(e) => setBrief(e.target.value)}
            placeholder="Linkable for D2C beauty brands — creator attribution + payouts on Shopify. Audience: founders / heads of marketing. ROI: cut wasted creator spend, double down on winners."
            rows={3}
            style={{
              width: "100%", padding: "8px 12px", borderRadius: 8, fontFamily: "inherit", fontSize: 13,
              border: `1.5px solid ${theme.border}`, background: theme.bg, color: theme.text, resize: "vertical",
            }}
          />
        </Field>
        <Field label="Reply mode" theme={theme} colSpan={2}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: theme.text }}>
            <input type="checkbox" checked={autoReply} onChange={(e) => setAutoReply(e.target.checked)} />
            Auto-reply with AI (requires linked AI campaign)
          </label>
          {autoReply && (
            <Input
              value={aiCampaignId} onChange={(e) => setAiCampaignId(e.target.value)}
              placeholder="ai_campaigns.id (UUID)" style={{ marginTop: 8 }}
            />
          )}
        </Field>
      </div>
      {err && <div style={{ color: "#DC2626", fontSize: 12, marginBottom: 8 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <Btn onClick={submit} disabled={busy}>{busy ? "Creating…" : "Create + seed 9 templates"}</Btn>
        <Btn onClick={onCancel} variant="secondary">Cancel</Btn>
      </div>
    </Card>
  );
}

function Field({ label, theme, colSpan, children }) {
  return (
    <div style={{ gridColumn: colSpan ? `span ${colSpan}` : undefined }}>
      <div style={{ fontSize: 11, color: theme.textMuted, textTransform: "uppercase", fontWeight: 600, letterSpacing: 0.4, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function Pill({ tint = {}, children }) {
  return (
    <span style={{
      display: "inline-block",
      background: tint.bg || "#F3F4F6", color: tint.fg || "#374151",
      fontSize: 10, fontWeight: 700, padding: "2px 6px",
      borderRadius: 4, textTransform: "uppercase", letterSpacing: 0.4,
    }}>{children}</span>
  );
}

function Th({ children }) {
  return <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>{children}</th>;
}
function Td({ children, style = {} }) {
  return <td style={{ padding: "8px 12px", verticalAlign: "top", ...style }}>{children}</td>;
}
