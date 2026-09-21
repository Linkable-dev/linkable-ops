import { Fragment, useCallback, useEffect, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Select } from "../components/ui/Select";
import { Skeleton, SkeletonTableRows } from "../components/ui/Skeleton";
import { Pagination } from "../components/ui/Pagination";

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

// "Tier A (11)" rather than a tile saying 11 somewhere else on the page. A
// count is most useful attached to the thing it counts, where it also tells you
// whether a filter is worth clicking before you click it.
function withCounts(options, counts) {
  if (!counts) return options;
  return options.map((o) => {
    const n = o.value ? counts[o.value] : null;
    return n ? { ...o, label: `${o.label} (${n})` } : o;
  });
}

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
                    options={withCounts(TIERS, stats?.byTier)} ariaLabel="Tier" size="sm" />
          </div>
          <div style={{ width: 170 }}>
            <Select value={decision} onChange={(v) => { setDecision(v); setPage(0); }}
                    options={withCounts(DECISIONS, stats?.byDecision)} ariaLabel="Decision" size="sm" />
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
                {[
                  ["Tier", "left"], ["Brand", "left"], ["Creators", "right"],
                  ["Affiliate app", "left"], ["Email", "left"],
                  ["Decision", "left"], ["Actions", "left"],
                ].map(([h, align]) => (
                  <th key={h} style={{
                    padding: "8px 10px", textAlign: align, fontWeight: 500,
                    whiteSpace: "nowrap",
                  }}>{h}</th>
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

      {/* Below the leads, deliberately. This page is for the decision, and the
          decision is the table: campaigns are what produced it, which is
          context rather than the job. */}
      <Campaigns theme={theme} />

      <p style={{ color: theme.textMuted, fontSize: 12, margin: 0 }}>
        Leads are produced by the linkable-prospector pipeline, which runs outside this app
        and syncs here. It is not startable from this page on purpose: every run spends money,
        and a button that quietly bills is worse than no button.
      </p>
    </div>
  );
}

/**
 * Campaigns: a goal, a budget, and the opinion to stop.
 *
 * Two state columns, not one. The campaign reports `state`; a person sets
 * `desired_state`. The runner lives elsewhere and on its own clock, so if this
 * page wrote `state` directly, a pass finishing a second later would overwrite
 * the instruction it was meant to be following.
 *
 * Which is also why Start reads as "asked to start" until the runner agrees.
 * Anything else would be this page claiming something it cannot know.
 */
function Campaigns({ theme }) {
  const [campaigns, setCampaigns] = useState([]);
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);

  const load = useCallback(async () => {
    try {
      const { campaigns: rows } = await api.getProspectingCampaigns();
      setCampaigns(rows || []);
      setProblem(null);
    } catch (err) {
      setProblem(err?.hint || err?.message || "could not load campaigns");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function setState(name, desired) {
    setBusy(name);
    try {
      await api.setProspectingCampaignState(name, desired);
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (problem) return null;

  return (
    <Card>
      <NewCampaign theme={theme} onCreated={load} />
      {!campaigns.length && (
        <div style={{ padding: 16, color: theme.textMuted, fontSize: 13 }}>
          No campaigns yet. A campaign is a goal and a budget: it runs until it has the
          leads it was asked for or has spent what it was given.
        </div>
      )}
      {campaigns.length > 0 && (
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ color: theme.textMuted, borderBottom: `1px solid ${theme.border}` }}>
            {["Campaign", "State", "Progress", "Spent", "Passes", ""].map((h) => (
              <th key={h} style={{ padding: "8px 12px", textAlign: "left", fontWeight: 500 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {campaigns.map((c) => {
            const asked = c.desired_state === "running";
            const actually = c.state === "running";
            return (
              <tr key={c.name} style={{ borderBottom: `1px solid ${theme.border}` }}>
                <td style={{ padding: "8px 12px", color: theme.text }}>
                  {c.name}
                  <div style={{ color: theme.textMuted, fontSize: 11 }}>
                    tier {c.goal_tiers} · {c.source}
                  </div>
                </td>
                <td style={{ padding: "8px 12px" }}>
                  <span style={{ color: actually ? theme.success : theme.textMuted }}>
                    {c.state}
                  </span>
                  {asked && !actually && (
                    <div style={{ color: theme.textMuted, fontSize: 11 }}>asked to start</div>
                  )}
                  {c.stopped_reason && (
                    <div style={{ color: theme.textMuted, fontSize: 11 }}>{c.stopped_reason}</div>
                  )}
                  {c.last_error && (
                    <div style={{ color: theme.danger, fontSize: 11 }}>{c.last_error}</div>
                  )}
                </td>
                <td style={{ padding: "8px 12px", color: theme.text }}>
                  {c.leads_found}/{c.goal_leads}
                </td>
                <td style={{ padding: "8px 12px", color: theme.text }}>
                  ${Number(c.spent_usd || 0).toFixed(2)}
                  <span style={{ color: theme.textMuted }}> of ${Number(c.budget_usd).toFixed(2)}</span>
                </td>
                <td style={{ padding: "8px 12px", color: theme.textMuted }}>{c.passes}</td>
                <td style={{ padding: "8px 12px", textAlign: "right" }}>
                  <Btn
                    variant={asked ? "secondary" : "primary"}
                    disabled={busy === c.name}
                    onClick={() => setState(c.name, asked ? "off" : "running")}
                  >
                    {asked ? "Hold" : "Start"}
                  </Btn>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      )}
    </Card>
  );
}

/**
 * Naming a campaign is choosing what to spend and when to stop, so the form
 * asks for exactly that and nothing else. Source, hashtags and countries have
 * sensible defaults; a goal and a budget do not, because they are the decision.
 *
 * It is created switched off. A campaign that starts the moment it is named
 * spends before anyone has read back what they typed.
 */
function NewCampaign({ theme, onCreated }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({
    name: "", goal_leads: 20, goal_tiers: "A", budget_usd: 5,
    source: "creator_calls", hashtags: "", countries: "",
  });

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const field = {
    padding: "6px 10px", borderRadius: 8, border: `1px solid ${theme.border}`,
    background: theme.inputBg, color: theme.text, fontSize: 13,
  };

  async function create() {
    setBusy(true); setError(null);
    try {
      await api.createProspectingCampaign({
        ...form,
        goal_leads: Number(form.goal_leads),
        budget_usd: Number(form.budget_usd),
        hashtags: form.hashtags || null,
        countries: form.countries || null,
      });
      setForm((f) => ({ ...f, name: "", hashtags: "" }));
      setOpen(false);
      await onCreated();
    } catch (err) {
      setError(err?.error || err?.message || "could not create it");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div style={{ padding: "12px 14px", borderBottom: `1px solid ${theme.border}`,
                    display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ color: theme.textMuted, fontSize: 12 }}>
          Campaigns — each has a goal and a budget, and stops itself when it has one or
          has spent the other.
        </span>
        <Btn onClick={() => setOpen(true)}>New campaign</Btn>
      </div>
    );
  }

  return (
    <div style={{ padding: 14, borderBottom: `1px solid ${theme.border}`,
                  display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
      <Labelled label="Name" theme={theme} width={190}>
        <input value={form.name} onChange={set("name")} placeholder="UK skincare"
               style={{ ...field, width: "100%" }} />
      </Labelled>
      <Labelled label="Leads wanted" theme={theme} width={110}>
        <input type="number" min="1" value={form.goal_leads} onChange={set("goal_leads")}
               style={{ ...field, width: "100%" }} />
      </Labelled>
      <Labelled label="Tiers" theme={theme} width={90}>
        <input value={form.goal_tiers} onChange={set("goal_tiers")} placeholder="A"
               style={{ ...field, width: "100%" }} />
      </Labelled>
      <Labelled label="Budget ($)" theme={theme} width={100}>
        <input type="number" min="0.5" step="0.5" value={form.budget_usd} onChange={set("budget_usd")}
               style={{ ...field, width: "100%" }} />
      </Labelled>
      <Labelled label="Hashtags" theme={theme} width={220}>
        <input value={form.hashtags} onChange={set("hashtags")}
               placeholder="ugccreatorwanted, creatorswanted"
               style={{ ...field, width: "100%" }} />
      </Labelled>
      <Btn onClick={create} disabled={busy || !form.name.trim()}>Create</Btn>
      <Btn variant="secondary" onClick={() => { setOpen(false); setError(null); }}>Cancel</Btn>
      <div style={{ width: "100%", color: theme.textMuted, fontSize: 11 }}>
        {error
          ? <span style={{ color: theme.danger }}>{error}</span>
          : "Created switched off. Press Start when you want it running."}
      </div>
    </div>
  );
}

function Labelled({ label, width, theme, children }) {
  return (
    <div style={{ width }}>
      <div style={{ color: theme.textMuted, fontSize: 11, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

/**
 * Three numbers, not five.
 *
 * Tier A and Tier B were two of them, and both were already a column in the
 * table and an option in the tier filter - so the page said the same thing
 * three times before showing a single lead. They are counts on the filter now,
 * where they are useful as a label rather than as a headline.
 *
 * What is left is the three that describe work: how many could be written to,
 * how many nobody has ruled on, how many have gone.
 */
function StatTiles({ stats, loading, theme }) {
  const tiles = [
    { label: "Ready to contact", value: stats?.contactable ?? 0, hint: "routed, with an email, not held" },
    { label: "Undecided", value: stats?.byDecision?.pending ?? 0, hint: "waiting on a call" },
    { label: "Already sent", value: stats?.sent ?? 0, hint: "handed to Lemlist" },
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
      {/* Right-aligned and stacked: two numbers side by side in one cell read
          as one number with a bracket after it, and neither could be compared
          down the column. */}
      <td style={{ padding: "6px 10px", textAlign: "right", whiteSpace: "nowrap" }}>
        <div style={{ color: theme.text, fontVariantNumeric: "tabular-nums" }}>
          {lead.distinct_creators_90d ?? 0}
        </div>
        <div style={{ color: theme.textMuted, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
          {(lead.creator_activity_score ?? 0).toFixed(2)}
        </div>
      </td>
      <td style={{ padding: "6px 10px", color: theme.text }}>
        {lead.affiliate_app && lead.affiliate_app !== "none"
          ? lead.affiliate_app
          : <span style={{ color: theme.textMuted }}>none</span>}
      </td>
      <td style={{
        padding: "6px 10px", maxWidth: 220, overflow: "hidden",
        textOverflow: "ellipsis", whiteSpace: "nowrap",
        color: lead.contact_email ? theme.text : theme.textMuted,
      }} title={lead.contact_email || ""}>
        {lead.contact_email || "none found"}
      </td>
      <td style={{ padding: "6px 10px" }}>
        <Decision lead={lead} theme={theme} saving={saving} onDecide={onDecide} />
      </td>
      {/* Actions: header left, content grouped right. */}
      <td style={{ padding: "6px 10px" }}>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Btn variant="secondary" size="sm" onClick={onOpen}>
            {expanded ? "Less" : "Details"}
          </Btn>
        </div>
      </td>
    </tr>
  );
}

/**
 * Three small buttons instead of three large ones, and only the chosen one is
 * filled.
 *
 * At full size this was three pill buttons on every row - eighty-one of them
 * on a screen of twenty-seven leads - and they were the loudest thing on the
 * page by a distance. The table became a wall of identical controls with the
 * brands hidden between them, which is the opposite of what a page for
 * deciding needs: you have to be able to read the row before you can decide
 * anything about it.
 *
 * Clicking the current decision clears it back to undecided, which is why the
 * chosen one stays a button rather than becoming a label.
 */
function Decision({ lead, theme, saving, onDecide }) {
  const options = [
    ["send", theme.success],
    ["hold", theme.warning],
    ["hide", theme.textMuted],
  ];
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {options.map(([value, colour]) => {
        const chosen = lead.decision === value;
        return (
          <Btn
            key={value}
            size="sm"
            variant={chosen ? "solid" : "secondary"}
            color={chosen ? colour : undefined}
            disabled={saving}
            title={chosen ? `${value} - click to undo` : `Mark ${value}`}
            style={{
              padding: "4px 12px", fontSize: 12,
              // A row nobody has decided on should not look like three
              // rejected options. Quiet until it means something.
              opacity: chosen || lead.decision === "pending" || !lead.decision ? 1 : 0.5,
            }}
            onClick={() => onDecide(lead.handle, chosen ? "pending" : value)}
          >
            {value}
          </Btn>
        );
      })}
    </div>
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
