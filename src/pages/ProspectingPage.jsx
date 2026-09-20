import { Fragment, useCallback, useEffect, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Select } from "../components/ui/Select";
import { Skeleton, SkeletonTableRows } from "../components/ui/Skeleton";
import { Pagination } from "../components/ui/Pagination";
import { GtmTabs, BRAND_TABS } from "../components/gtm/GtmTabs";

/**
 * Outbound prospecting: Shopify brands that look like candidates to install
 * Linkable.
 *
 * The signal behind every row is one pair of facts. A brand with creators
 * posting about it and no affiliate app installed is running influencer
 * marketing it cannot attribute — which is the entire pitch, and which no store
 * database sells, because it only exists by crossing Instagram activity with
 * storefront technographics.
 *
 * What this page is for is the decision, not the browsing. The pipeline
 * proposes; a person here says send, hold or hide, and the pipeline reads that
 * back before it hands anything to Lemlist. Holding a lead is therefore not a
 * view filter — it is what stops the email. Hiding one suppresses it outright.
 *
 * The pipeline itself runs outside this app and is not startable from here.
 * That is deliberate for now rather than missing: it spends money per run, and
 * a button that quietly bills is worse than no button.
 */

const TIERS = [
  { value: "", label: "All tiers" },
  { value: "A", label: "Tier A" },
  { value: "B", label: "Tier B" },
  { value: "C", label: "Tier C" },
];

const DECISIONS = [
  { value: "", label: "All decisions" },
  { value: "pending", label: "Undecided" },
  { value: "send", label: "Send" },
  { value: "hold", label: "Hold" },
  { value: "hide", label: "Hidden" },
];

const PAGE_SIZE = 50;

export default function ProspectingPage() {
  const { theme } = useTheme();
  const [leads, setLeads] = useState([]);
  const [stats, setStats] = useState(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState(null);
  const [page, setPage] = useState(0);
  const [tier, setTier] = useState("");
  const [decision, setDecision] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [saving, setSaving] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    try {
      const [rows, s] = await Promise.all([
        api.getProspectingLeads({ tier, decision, q, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
        api.getProspectingStats(),
      ]);
      setLeads(rows.leads || []);
      setTotal(rows.total || 0);
      setStats(s);
    } catch (err) {
      // The table ships with the pipeline, not with this app, so "not set up
      // yet" is a normal state and should read as one.
      setProblem(err?.hint || err?.message || "could not load leads");
      setLeads([]);
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, [tier, decision, q, page]);

  useEffect(() => { load(); }, [load]);

  async function decide(handle, next, note) {
    setSaving(handle);
    try {
      const updated = await api.setProspectingDecision(handle, next, note);
      setLeads((rows) => rows.map((r) => (r.handle === handle ? { ...r, ...updated } : r)));
      api.getProspectingStats().then(setStats).catch(() => {});
    } finally {
      setSaving(null);
    }
  }

  async function decideMany(next) {
    const handles = [...selected];
    if (!handles.length) return;
    setSaving("bulk");
    try {
      await api.setProspectingDecisions(handles, next, null);
      setSelected(new Set());
      await load();
    } finally {
      setSaving(null);
    }
  }

  function toggle(handle) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(handle) ? next.delete(handle) : next.add(handle);
      return next;
    });
  }

  const allShown = leads.length > 0 && leads.every((l) => selected.has(l.handle));

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, color: theme.text }}>Brands</h1>
        <p style={{ margin: "6px 0 0", color: theme.textMuted, fontSize: 13, maxWidth: 680 }}>
          Shopify brands with creators posting about them. Tier A have no affiliate app,
          so they cannot attribute any of it. Decide here: hold and hide stop the email
          being sent, they do not just tidy the list.
        </p>
      </div>

      <GtmTabs tabs={BRAND_TABS} />

      {problem && (
        <Card>
          <div style={{ padding: 16, color: theme.textMuted, fontSize: 13 }}>
            <strong style={{ color: theme.text }}>Not set up yet.</strong> {problem}
          </div>
        </Card>
      )}

      <StatTiles stats={stats} loading={loading && !stats} theme={theme} />

      <Card>
        {/* Filters sized to their contents, like everywhere else in ops: a
            full-width select reads as a form, and this is a toolbar. */}
        <div style={{
          display: "flex", gap: 10, padding: 12, flexWrap: "wrap", alignItems: "center",
          borderBottom: `1px solid ${theme.border}`,
        }}>
          <div style={{ width: 150 }}>
            <Select value={tier} onChange={(v) => { setTier(v); setPage(0); }}
                    options={TIERS} ariaLabel="Tier" size="sm" />
          </div>
          <div style={{ width: 150 }}>
            <Select value={decision} onChange={(v) => { setDecision(v); setPage(0); }}
                    options={DECISIONS} ariaLabel="Decision" size="sm" />
          </div>
          <input
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(0); }}
            placeholder="Search"
            aria-label="Search leads"
            style={{
              width: 200, padding: "6px 10px", borderRadius: 8,
              border: `1px solid ${theme.border}`, background: theme.inputBg,
              color: theme.text, fontSize: 13,
            }}
          />
          <div style={{ flex: 1 }} />
          <span style={{ color: theme.textMuted, fontSize: 12 }}>
            {total} lead{total === 1 ? "" : "s"}
          </span>
          {selected.size > 0 && (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ color: theme.textMuted, fontSize: 12 }}>{selected.size} selected</span>
              <Btn onClick={() => decideMany("send")} disabled={saving === "bulk"}>Send</Btn>
              <Btn variant="secondary" onClick={() => decideMany("hold")} disabled={saving === "bulk"}>Hold</Btn>
              <Btn variant="secondary" onClick={() => decideMany("hide")} disabled={saving === "bulk"}>Hide</Btn>
            </div>
          )}
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${theme.border}`, color: theme.textMuted }}>
                <th style={{ padding: "8px 10px", width: 32 }}>
                  <input
                    type="checkbox"
                    checked={allShown}
                    onChange={() =>
                      setSelected(allShown ? new Set() : new Set(leads.map((l) => l.handle)))
                    }
                  />
                </th>
                {["Tier", "Brand", "Creators", "Affiliate app", "Email", "Decision", ""].map((h) => (
                  <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontWeight: 500 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonTableRows rows={6} cols={7} />
              ) : leads.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: 24, color: theme.textMuted, textAlign: "center" }}>
                    {problem ? "—" : "No leads match these filters."}
                  </td>
                </tr>
              ) : (
                leads.map((lead) => (
                  <Fragment key={lead.handle}>
                    <LeadRow
                      lead={lead}
                      theme={theme}
                      selected={selected.has(lead.handle)}
                      onToggle={() => toggle(lead.handle)}
                      onOpen={() => setOpen(open === lead.handle ? null : lead.handle)}
                      onDecide={decide}
                      saving={saving === lead.handle}
                      expanded={open === lead.handle}
                    />
                    {open === lead.handle && <LeadDetail lead={lead} theme={theme} />}
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>

        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          onPageChange={setPage}
        />
      </Card>

      <p style={{ color: theme.textMuted, fontSize: 12, margin: 0 }}>
        Leads are produced by the linkable-prospector pipeline, which runs outside this app
        and syncs here. It is not startable from this page on purpose: every run spends money,
        and a button that quietly bills is worse than no button.
      </p>
    </div>
  );
}

function StatTiles({ stats, loading, theme }) {
  const tiles = [
    { label: "Tier A", value: stats?.byTier?.A ?? 0, hint: "creators, no tracking" },
    { label: "Tier B", value: stats?.byTier?.B ?? 0, hint: "competitor installed" },
    { label: "Ready to contact", value: stats?.contactable ?? 0, hint: "routed, with an email, not held" },
    { label: "Already sent", value: stats?.sent ?? 0, hint: "handed to Lemlist" },
    { label: "Undecided", value: stats?.byDecision?.pending ?? 0, hint: "waiting on a call" },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
      {tiles.map((t) => (
        <Card key={t.label}>
          <div style={{ padding: 14 }}>
            <div style={{ color: theme.textMuted, fontSize: 12 }}>{t.label}</div>
            {loading ? (
              <Skeleton style={{ height: 26, width: 48, marginTop: 6 }} />
            ) : (
              <div style={{ fontSize: 24, color: theme.text, fontWeight: 600 }}>{t.value}</div>
            )}
            <div style={{ color: theme.textMuted, fontSize: 11, marginTop: 2 }}>{t.hint}</div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function LeadRow({ lead, theme, selected, onToggle, onOpen, onDecide, saving, expanded }) {
  const held = lead.decision === "hold" || lead.decision === "hide";
  return (
    <tr
      style={{
        borderBottom: `1px solid ${theme.border}`,
        opacity: held ? 0.55 : 1,
        background: selected ? theme.hoverBg : "transparent",
      }}
    >
      <td style={{ padding: "8px 10px" }}>
        <input type="checkbox" checked={selected} onChange={onToggle} />
      </td>
      <td style={{ padding: "8px 10px" }}>
        <TierBadge tier={lead.tier} theme={theme} />
      </td>
      <td style={{ padding: "8px 10px" }}>
        <div style={{ color: theme.text }}>{lead.brand_name || lead.handle}</div>
        <a
          href={lead.domain ? `https://${lead.domain}` : lead.instagram_url}
          target="_blank" rel="noreferrer"
          style={{ color: theme.textMuted, fontSize: 12, textDecoration: "none" }}
        >
          {lead.domain || `@${lead.handle}`}
        </a>
      </td>
      <td style={{ padding: "8px 10px", color: theme.text }}>
        {lead.distinct_creators_90d ?? 0}
        <span style={{ color: theme.textMuted, fontSize: 12 }}>
          {" "}({(lead.creator_activity_score ?? 0).toFixed(2)})
        </span>
      </td>
      <td style={{ padding: "8px 10px", color: theme.text }}>
        {lead.affiliate_app && lead.affiliate_app !== "none" ? lead.affiliate_app : "—"}
      </td>
      <td style={{ padding: "8px 10px", color: lead.contact_email ? theme.text : theme.textMuted }}>
        {lead.contact_email || "none found"}
      </td>
      <td style={{ padding: "8px 10px" }}>
        <div style={{ display: "flex", gap: 4 }}>
          {["send", "hold", "hide"].map((d) => (
            <Btn
              key={d}
              variant={lead.decision === d ? "primary" : "secondary"}
              disabled={saving}
              onClick={() => onDecide(lead.handle, lead.decision === d ? "pending" : d)}
            >
              {d}
            </Btn>
          ))}
        </div>
      </td>
      <td style={{ padding: "8px 10px", textAlign: "right" }}>
        <Btn variant="secondary" onClick={onOpen}>{expanded ? "Less" : "Details"}</Btn>
      </td>
    </tr>
  );
}

function TierBadge({ tier, theme }) {
  const colours = { A: theme.success, B: theme.warning, C: theme.textMuted };
  return (
    <span
      style={{
        display: "inline-block", minWidth: 20, textAlign: "center",
        padding: "2px 8px", borderRadius: 6, fontSize: 12, fontWeight: 600,
        color: colours[tier] || theme.textMuted,
        border: `1px solid ${colours[tier] || theme.border}`,
      }}
    >
      {tier || "—"}
    </span>
  );
}

function LeadDetail({ lead, theme }) {
  const facts = [
    ["Why this tier", lead.tier_reason],
    ["Creators seen", lead.top_creators],
    ["Open call", lead.intent_post_url],
    ["Products", lead.product_count],
    ["Entity", lead.entity_type
      ? `${lead.entity_type}${lead.entity_verified ? " (verified)" : " (unverified)"}`
      : null],
    ["Founder", lead.founder_name],
    ["Country", lead.country],
    ["Found via", lead.source],
    ["Pipeline status", lead.status],
    ["Note", lead.ops_note],
  ].filter(([, v]) => v !== null && v !== undefined && v !== "");

  return (
    <tr>
      <td colSpan={8} style={{ background: theme.hoverBg, padding: "12px 16px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
          {facts.map(([label, value]) => (
            <div key={label}>
              <div style={{ color: theme.textMuted, fontSize: 11 }}>{label}</div>
              <div style={{ color: theme.text, fontSize: 13, wordBreak: "break-word" }}>
                {String(value).startsWith("http")
                  ? <a href={String(value)} target="_blank" rel="noreferrer" style={{ color: theme.accent }}>{String(value)}</a>
                  : String(value)}
              </div>
            </div>
          ))}
        </div>
      </td>
    </tr>
  );
}
