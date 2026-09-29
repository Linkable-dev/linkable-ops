import { useCallback, useEffect, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Toggle } from "../components/ui/Toggle";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { Trash2 } from "lucide-react";
import { HelpList, HelpTip } from "../components/gtm/QueueParts";

/**
 * Where brand leads come from: the prospector's campaigns.
 *
 * Its own tab because both outreach channels draw on what these find. A
 * campaign sitting on top of the email queue read as if it only fed email,
 * when the Instagram queue is filled from the same leads.
 */
// What the "?" beside the title says.
const SOURCES_HELP = [
  ["What this is", "The searches the pipeline runs to find brands: a Shopify store list, gifted posts, creator programme pages, Linkable creators' posts, calls for creators. Each one is a campaign."],
  ["Where the brands go", "Every brand a campaign finds goes to both queues, Email and Instagram, and is contacted on one of them."],
  ["Goal and budget", "Each campaign stops itself when it has found the leads it was asked for or has spent its budget. A daily one runs every day on a monthly budget and never stops on its own."],
  ["On and off", "A campaign is created switched off, because every pass spends money. Switch it on and it runs on the next pipeline run; switch it off to stop it."],
  ["Delete", "The bin removes a campaign and its history for good. The brands it found stay in Email and Instagram."],
  ["Right now", "Find new brands on Email or Instagram runs the pipeline immediately instead of waiting for the schedule."],
];

export default function SourcesPage() {
  const { theme } = useTheme();
  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h1 style={{ margin: 0, fontSize: 22, color: theme.text }}>Sources</h1>
          <HelpTip title="Where brand leads come from">
            <HelpList items={SOURCES_HELP} />
          </HelpTip>
        </div>
        <p style={{ margin: "6px 0 0", color: theme.textMuted, fontSize: 13, maxWidth: 680 }}>
          The searches that find brands. Every lead they find goes to both queues,
          Email and Instagram, and each brand is contacted on one of them.
        </p>
      </div>
      <Campaigns theme={theme} />
      <p style={{ color: theme.textMuted, fontSize: 12, margin: 0 }}>
        Leads are produced by the linkable-prospector pipeline, which runs outside this app
        and syncs here. A campaign spends money on every pass, so it is created switched
        off and only runs once somebody switches it on.
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
 * Which is also why switching one on reads as "asked to start" until the runner agrees.
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

  // A switch that silently springs back is worse than one that says why.
  const [failed, setFailed] = useState(null);
  const { ask, dialog } = useConfirm();

  async function remove(c) {
    const yes = await ask({
      title: `Delete ${c.name}?`,
      body: `It stops and is removed for good, with its ${c.passes} pass${c.passes === 1 ? "" : "es"} of history. `
        + `The ${c.leads_found} brand${c.leads_found === 1 ? "" : "s"} it found stay in Email and Instagram. This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!yes) return;
    setBusy(c.name);
    setFailed(null);
    try {
      await api.deleteProspectingCampaign(c.name);
      await load();
    } catch (err) {
      setFailed(`${c.name}: ${err?.message || "could not delete it"}`);
    } finally {
      setBusy(null);
    }
  }
  async function setState(name, desired) {
    setBusy(name);
    setFailed(null);
    try {
      await api.setProspectingCampaignState(name, desired);
      await load();
    } catch (err) {
      setFailed(`${name}: ${err?.message || "could not switch it"}`);
    } finally {
      setBusy(null);
    }
  }

  // Alone on its page now, so a failure is said rather than left blank.
  if (problem) {
    return (
      <Card>
        <div style={{ padding: 16, color: theme.textMuted, fontSize: 13 }}>
          <strong style={{ color: theme.text }}>Not set up yet.</strong> {problem}
        </div>
      </Card>
    );
  }

  return (
    <Card>
      {dialog}
      <NewCampaign theme={theme} onCreated={load} />
      {failed && <div style={{ padding: "8px 14px", color: theme.danger, fontSize: 12 }}>{failed}</div>}
      {!campaigns.length && (
        <div style={{ padding: 16, color: theme.textMuted, fontSize: 13 }}>
          No campaigns yet. A campaign is a goal and a budget: it runs until it has the
          leads it was asked for or has spent what it was given.
        </div>
      )}
      {/* One line each, not a table.
          Three lines per campaign - the state, "asked to start", and the
          sentence explaining why it stopped - made two campaigns taller than
          the leads they produced, and it was the first thing on the page.
          The explanation is still there, on hover, where it costs nothing to
          have until you want it. */}
      {campaigns.map((c) => {
        const asked = c.desired_state === "running";
        const actually = c.state === "running";
        const why = [
          asked && !actually ? "asked to start" : null,
          c.stopped_reason,
          c.last_error,
        ].filter(Boolean).join(" · ");
        return (
          <div key={c.name} style={{
            display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
            padding: "10px 14px", borderTop: `1px solid ${theme.border}`, fontSize: 13,
          }}>
            <span style={{ color: theme.text, fontWeight: 500 }}>{c.name}</span>
            <span
              title={why || undefined}
              style={{
                color: actually ? theme.success : theme.textMuted,
                borderBottom: why ? `1px dotted ${theme.border}` : "none",
                cursor: why ? "help" : "default",
              }}
            >
              {c.state}{asked && !actually ? " (starting)" : ""}
            </span>
            <span style={{ color: theme.textMuted, fontSize: 12 }}>
              tier {c.goal_tiers} · {c.source}{c.continuous ? " · daily" : ""}
            </span>
            <div style={{ flex: 1 }} />
            <span style={{ color: theme.text, fontVariantNumeric: "tabular-nums" }}>
              {c.leads_found}/{c.goal_leads}
            </span>
            <span style={{ color: theme.textMuted, fontVariantNumeric: "tabular-nums" }}>
              {c.continuous
                ? `$${Number(c.budget_usd).toFixed(2)}/month · $${Number(c.spent_usd || 0).toFixed(2)} spent`
                : `$${Number(c.spent_usd || 0).toFixed(2)} of $${Number(c.budget_usd).toFixed(2)}`}
            </span>
            <span style={{ color: theme.textMuted, fontSize: 12 }}>
              {c.passes} pass{c.passes === 1 ? "" : "es"}
            </span>
            {/* On means asked to run (desired_state), which is what a person
                controls; the word beside the name says what the runner did. */}
            <Toggle
              checked={asked}
              disabled={busy === c.name}
              onChange={(next) => setState(c.name, next ? "running" : "off")}
              label={`${c.name} on`}
              title={asked ? "On: runs on the next pipeline run. Switch off to stop it." : "Off: switch on to run it."}
            />
            <Btn size="sm" variant="secondary" disabled={busy === c.name} onClick={() => remove(c)}
                 aria-label={`Delete ${c.name}`} title="Delete this campaign for good"
                 style={{ padding: 7 }}>
              <Trash2 size={14} />
            </Btn>
          </div>
        );
      })}
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
    source: "creator_calls", hashtags: "", countries: "", continuous: false,
  });

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const field = {
    padding: "6px 10px", borderRadius: 8, border: `1px solid ${theme.border}`,
    background: theme.surface, color: theme.text, fontSize: 13,
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
        continuous: form.continuous,
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
      <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12,
                      color: theme.textMid, paddingBottom: 8 }}
             title="Runs once a day on a rotating slice of its hashtags and never stops on its own. The budget is per calendar month.">
        <input type="checkbox" checked={form.continuous} style={{ margin: 0 }}
               onChange={(e) => setForm((f) => ({ ...f, continuous: e.target.checked }))} />
        Daily, budget per month
      </label>
      <Btn onClick={create} disabled={busy || !form.name.trim()}>Create</Btn>
      <Btn variant="secondary" onClick={() => { setOpen(false); setError(null); }}>Cancel</Btn>
      <div style={{ width: "100%", color: theme.textMuted, fontSize: 11 }}>
        {error
          ? <span style={{ color: theme.danger }}>{error}</span>
          : "Created switched off. Switch it on when you want it running."}
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
