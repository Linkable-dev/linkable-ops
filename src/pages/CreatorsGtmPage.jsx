import { useCallback, useEffect, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Select } from "../components/ui/Select";
import { Skeleton, SkeletonTableRows } from "../components/ui/Skeleton";
import { Pagination } from "../components/ui/Pagination";

/**
 * Creator GTM: people worth inviting onto Linkable.
 *
 * Every creator here was found by the brand pipeline, not by a separate search.
 * They turned up because they posted about a brand we were looking at, which is
 * the one fact that makes a creator worth approaching — they already do this,
 * for brands of roughly the size Linkable serves. The brand side was collecting
 * them as evidence and throwing them away as people.
 *
 * Which is why the column that matters is "Brands": someone seen posting about
 * three different brands is doing it as a habit, where one could be a customer
 * who liked something.
 *
 * Same contract as Brands: hold and hide stop the invite going out, they do not
 * tidy the list.
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
  { value: "send", label: "Invite" },
  { value: "hold", label: "Hold" },
  { value: "hide", label: "Hidden" },
];

const PAGE_SIZE = 50;

// A count belongs on the thing it counts, where it also says whether an option
// is worth clicking before you click it.
function withCounts(options, counts) {
  if (!counts) return options;
  return options.map((o) => {
    const n = o.value ? counts[o.value] : null;
    return n ? { ...o, label: `${o.label} (${n})` } : o;
  });
}

export default function CreatorsGtmPage() {
  const { theme } = useTheme();
  const [creators, setCreators] = useState([]);
  const [stats, setStats] = useState(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState(null);
  const [page, setPage] = useState(0);
  const [tier, setTier] = useState("");
  const [decision, setDecision] = useState("");
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    try {
      const [rows, s] = await Promise.all([
        api.getProspectingCreators({ tier, decision, q, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
        api.getProspectingCreatorStats(),
      ]);
      setCreators(rows.creators || []);
      setTotal(rows.total || 0);
      setStats(s);
    } catch (err) {
      setProblem(err?.hint || err?.message || "could not load creators");
      setCreators([]);
    } finally {
      setLoading(false);
    }
  }, [tier, decision, q, page]);

  useEffect(() => { load(); }, [load]);

  async function decide(handle, next) {
    setSaving(handle);
    try {
      const updated = await api.setProspectingCreatorDecision(handle, next);
      setCreators((rows) => rows.map((r) => (r.handle === handle ? { ...r, ...updated } : r)));
      api.getProspectingCreatorStats().then(setStats).catch(() => {});
    } finally {
      setSaving(null);
    }
  }

  // Three, not five. Tier A and Tier B were both already a column in the table
  // and an option in the tier filter, so the page said the same thing three
  // times before showing a single creator; those counts are on the filter now.
  const tiles = [
    { label: "Reachable", value: stats?.contactable ?? 0, hint: "email, not held" },
    { label: "Posts about 2+", value: stats?.multiBrand ?? 0, hint: "doing it as a habit" },
    { label: "Invited", value: stats?.invited ?? 0, hint: "already contacted" },
  ];

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, color: theme.text }}>Creators</h1>
        <p style={{ margin: "6px 0 0", color: theme.textMuted, fontSize: 13, maxWidth: 700 }}>
          Found by the brand pipeline: they posted about a brand we were looking at, which
          means they already do this. Hold and hide stop the invite being sent.
        </p>
      </div>


      {problem && (
        <Card>
          <div style={{ padding: 16, color: theme.textMuted, fontSize: 13 }}>
            <strong style={{ color: theme.text }}>Not set up yet.</strong> {problem}
          </div>
        </Card>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        {tiles.map((t) => (
          <Card key={t.label}>
            <div style={{ padding: 14 }}>
              <div style={{ color: theme.textMuted, fontSize: 12 }}>{t.label}</div>
              {loading && !stats
                ? <Skeleton style={{ height: 26, width: 48, marginTop: 6 }} />
                : <div style={{ fontSize: 24, color: theme.text, fontWeight: 600 }}>{t.value}</div>}
              <div style={{ color: theme.textMuted, fontSize: 11, marginTop: 2 }}>{t.hint}</div>
            </div>
          </Card>
        ))}
      </div>

      <FindCreators theme={theme} onAdded={load} />

      <Card>
        <div style={{ display: "flex", gap: 10, padding: 12, flexWrap: "wrap",
                      alignItems: "center", borderBottom: `1px solid ${theme.border}` }}>
          <div style={{ width: 150 }}>
            <Select value={tier} onChange={(v) => { setTier(v); setPage(0); }}
                    options={withCounts(TIERS, stats?.byTier)} ariaLabel="Tier" size="sm" />
          </div>
          <div style={{ width: 150 }}>
            <Select value={decision} onChange={(v) => { setDecision(v); setPage(0); }}
                    options={DECISIONS} ariaLabel="Decision" size="sm" />
          </div>
          <input
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(0); }}
            placeholder="Search"
            aria-label="Search creators"
            style={{ width: 200, padding: "6px 10px", borderRadius: 8,
                     border: `1px solid ${theme.border}`, background: theme.inputBg,
                     color: theme.text, fontSize: 13 }}
          />
          <div style={{ flex: 1 }} />
          <span style={{ color: theme.textMuted, fontSize: 12 }}>
            {total} creator{total === 1 ? "" : "s"}
          </span>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ color: theme.textMuted, borderBottom: `1px solid ${theme.border}` }}>
                {["Tier", "Creator", "Followers", "Brands", "Email", "Decision"].map((h) => (
                  <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontWeight: 500 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonTableRows rows={6} cols={6} />
              ) : creators.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: 24, color: theme.textMuted, textAlign: "center" }}>
                    {problem ? "—" : "No creators match these filters."}
                  </td>
                </tr>
              ) : creators.map((c) => {
                const held = c.decision === "hold" || c.decision === "hide";
                return (
                  <tr key={c.handle} style={{ borderBottom: `1px solid ${theme.border}`,
                                              opacity: held ? 0.55 : 1 }}>
                    <td style={{ padding: "8px 10px", color: theme.text }}>{c.tier}</td>
                    <td style={{ padding: "8px 10px" }}>
                      <a href={c.instagram_url} target="_blank" rel="noreferrer"
                         style={{ color: theme.text, textDecoration: "none" }}>
                        @{c.handle}
                      </a>
                      <div style={{ color: theme.textMuted, fontSize: 11 }}>
                        {c.full_name || c.niche || ""}
                      </div>
                    </td>
                    <td style={{ padding: "8px 10px", color: theme.text }}>
                      {(c.followers || 0).toLocaleString()}
                    </td>
                    <td style={{ padding: "8px 10px", color: theme.text }}>
                      {c.brands_posted_about}
                      {c.example_brand && (
                        <div style={{ color: theme.textMuted, fontSize: 11 }}>
                          e.g. @{c.example_brand}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "8px 10px",
                                 color: c.contact_email ? theme.text : theme.textMuted }}>
                      {c.contact_email || "none found"}
                    </td>
                    <td style={{ padding: "6px 10px" }}>
                      {/* Small, and only the chosen one filled. Three full-size
                          buttons a row made the table a wall of identical
                          controls with the creators hidden between them. */}
                      <div style={{ display: "flex", gap: 4 }}>
                        {[["send", "invite", theme.success],
                          ["hold", "hold", theme.warning],
                          ["hide", "hide", theme.textMuted]].map(([value, label, colour]) => {
                          const chosen = c.decision === value;
                          return (
                            <Btn key={value}
                                 size="sm"
                                 variant={chosen ? "solid" : "secondary"}
                                 color={chosen ? colour : undefined}
                                 style={{ padding: "4px 12px", fontSize: 12,
                                          opacity: chosen || !c.decision || c.decision === "pending" ? 1 : 0.5 }}
                                 disabled={saving === c.handle}
                                 title={chosen ? `${label} - click to undo` : `Mark ${label}`}
                                 onClick={() => decide(c.handle, chosen ? "pending" : value)}>
                              {label}
                            </Btn>
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
      </Card>
    </div>
  );
}


/**
 * Describe the creators you want; a model writes the search; you read it before
 * it spends anything.
 *
 * Two steps on purpose. Planning is free and is the half most worth a human
 * eye - which words are in a creator's own bio is exactly where judgement still
 * beats the model. Running bills 0.01 credits per creator the provider returns,
 * which is cheap enough to do often and not cheap enough to do by accident.
 *
 * The plan is shown as the filters that will actually be sent, including the
 * parts the model does not get to choose: creators not businesses, no private
 * accounts, nothing dormant for a year, and an engagement ceiling, because
 * sustained 25% engagement on 20k followers is a bought audience and the
 * results are sorted by engagement.
 */
function FindCreators({ theme, onAdded }) {
  const [prompt, setPrompt] = useState("");
  const [plan, setPlan] = useState(null);
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [limit, setLimit] = useState(25);

  async function makePlan() {
    setBusy("plan"); setError(null); setResults(null);
    try {
      setPlan(await api.planCreatorSearch(prompt));
    } catch (err) {
      setError(err?.hint || err?.message || "could not plan the search");
    } finally {
      setBusy(null);
    }
  }

  async function run() {
    setBusy("run"); setError(null);
    try {
      setResults(await api.runCreatorSearch(plan.query, limit));
    } catch (err) {
      setError(err?.hint || err?.message || "the search failed");
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    setBusy("add"); setError(null);
    try {
      const fresh = results.creators.filter((c) => !c.known);
      await api.addFoundCreators(fresh, prompt);
      setResults(null); setPlan(null); setPrompt("");
      onAdded?.();
    } catch (err) {
      setError(err?.hint || err?.message || "could not add them");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        <div>
          <div style={{ color: theme.text, fontSize: 14, fontWeight: 600 }}>Find more creators</div>
          <div style={{ color: theme.textMuted, fontSize: 12, marginTop: 2 }}>
            Describe who you want. Nothing is spent until you run the search.
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && prompt.trim()) makePlan(); }}
            placeholder="UK skincare creators who already do UGC, 10-50k followers"
            aria-label="Describe the creators you want"
            style={{
              flex: 1, minWidth: 280, padding: "8px 12px", borderRadius: 8,
              border: `1px solid ${theme.border}`, background: theme.inputBg,
              color: theme.text, fontSize: 13,
            }}
          />
          <Btn onClick={makePlan} disabled={!prompt.trim() || busy === "plan"} loading={busy === "plan"}>
            Plan the search
          </Btn>
        </div>

        {error && <div style={{ color: "#dc2626", fontSize: 12 }}>{error}</div>}

        {plan && !results && (
          <div style={{ border: `1px solid ${theme.border}`, borderRadius: 8, padding: 12 }}>
            <div style={{ color: theme.text, fontSize: 13 }}>{plan.query.rationale}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "8px 0" }}>
              {Object.entries(plan.filters).map(([k, v]) => (
                <span key={k} style={{
                  fontSize: 11, color: theme.textMuted, background: theme.surfaceAlt,
                  border: `1px solid ${theme.border}`, borderRadius: 6, padding: "2px 8px",
                }}>
                  {k}: {typeof v === "object" ? JSON.stringify(v) : String(v)}
                </span>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ color: theme.textMuted, fontSize: 12 }}>Return at most</span>
              <input type="number" min={1} max={100} value={limit}
                     onChange={(e) => setLimit(Number(e.target.value))}
                     aria-label="How many creators"
                     style={{ width: 70, padding: "6px 8px", borderRadius: 8,
                              border: `1px solid ${theme.border}`, background: theme.inputBg,
                              color: theme.text, fontSize: 13 }} />
              <span style={{ color: theme.textMuted, fontSize: 12 }}>
                ≈ {(limit * (plan.creditsPerCreator || 0.01)).toFixed(2)} credits
              </span>
              <Btn onClick={run} disabled={!plan.configured || busy === "run"} loading={busy === "run"}>
                Run the search
              </Btn>
              {!plan.configured && (
                <span style={{ color: theme.textMuted, fontSize: 12 }}>
                  Provider key not set on this server.
                </span>
              )}
            </div>
          </div>
        )}

        {results && (
          <div style={{ border: `1px solid ${theme.border}`, borderRadius: 8 }}>
            <div style={{ padding: "10px 12px", borderBottom: `1px solid ${theme.border}`,
                          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ color: theme.text, fontSize: 13 }}>
                {results.creators.length} found, {results.newCount} new
              </span>
              <span style={{ color: theme.textMuted, fontSize: 12 }}>
                {results.creditsSpent} credits spent
              </span>
              <div style={{ flex: 1 }} />
              <Btn onClick={add} disabled={!results.newCount || busy === "add"} loading={busy === "add"}>
                Add {results.newCount} to creators
              </Btn>
            </div>
            {/* A dropped location is a much wider search than the one asked
                for, so it is said out loud rather than swallowed. */}
            {results.droppedLocations?.length > 0 && (
              <div style={{ padding: "8px 12px", color: "#b45309", fontSize: 12 }}>
                The provider does not know {results.droppedLocations.join(", ")}, so that part
                of the location filter was not applied.
              </div>
            )}
            <div style={{ maxHeight: 280, overflowY: "auto" }}>
              {results.creators.map((c) => (
                <div key={c.handle} style={{
                  display: "flex", gap: 10, alignItems: "center",
                  padding: "6px 12px", borderTop: `1px solid ${theme.border}`,
                  opacity: c.known ? 0.5 : 1, fontSize: 13,
                }}>
                  <span style={{ color: theme.text, minWidth: 200 }}>@{c.handle}</span>
                  <span style={{ color: theme.textMuted, fontVariantNumeric: "tabular-nums" }}>
                    {(c.followers ?? 0).toLocaleString()}
                  </span>
                  <span style={{ color: theme.textMuted }}>
                    {c.engagement != null ? `${Number(c.engagement).toFixed(1)}%` : ""}
                  </span>
                  <div style={{ flex: 1 }} />
                  {c.known && <span style={{ color: theme.textMuted, fontSize: 11 }}>already here</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
