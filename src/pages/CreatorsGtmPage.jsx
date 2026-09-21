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

  const tiles = [
    { label: "Tier A", value: stats?.byTier?.A ?? 0, hint: "posts about brands already" },
    { label: "Tier B", value: stats?.byTier?.B ?? 0, hint: "right size, reachable" },
    { label: "Posts about 2+", value: stats?.multiBrand ?? 0, hint: "doing it as a habit" },
    { label: "Reachable", value: stats?.contactable ?? 0, hint: "email, not held" },
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

      <Card>
        <div style={{ display: "flex", gap: 10, padding: 12, flexWrap: "wrap",
                      alignItems: "center", borderBottom: `1px solid ${theme.border}` }}>
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
                    <td style={{ padding: "8px 10px" }}>
                      <div style={{ display: "flex", gap: 4 }}>
                        {[["send", "invite"], ["hold", "hold"], ["hide", "hide"]].map(([value, label]) => (
                          <Btn key={value}
                               variant={c.decision === value ? "primary" : "secondary"}
                               disabled={saving === c.handle}
                               onClick={() => decide(c.handle, c.decision === value ? "pending" : value)}>
                            {label}
                          </Btn>
                        ))}
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
