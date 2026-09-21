import { useCallback, useEffect, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Skeleton } from "../components/ui/Skeleton";

/**
 * Creator outreach: who is queued to be invited, who has been, and who cannot.
 *
 * The blocked list is the point of this page. A creator without an email cannot
 * be written to, and one without an observed post has nothing true to open with
 * — "saw your post about X" is the entire reason this is not a mailshot, so a
 * lead missing X is refused rather than sent with a gap.
 *
 * Nothing here sends. Lemlist does, and only when someone runs the command.
 */
export default function CreatorsOutreachPage() {
  const { theme } = useTheme();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.getProspectingCreatorOutreach());
      setProblem(null);
    } catch (err) {
      setProblem(err?.hint || err?.message || "could not load outreach");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const counts = data?.counts || {};
  const tiles = [
    { label: "Queued", value: counts.queued ?? 0, hint: "ready to invite" },
    { label: "Invited", value: counts.invited ?? 0, hint: "handed to Lemlist" },
    { label: "Blocked", value: counts.blocked ?? 0, hint: "held, or nothing to open with" },
  ];

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, color: theme.text }}>Creator outreach</h1>
        <p style={{ margin: "6px 0 0", color: theme.textMuted, fontSize: 13, maxWidth: 700 }}>
          Invites open with a post of theirs we actually saw. A creator with no observed
          post is not sent one, because the first line would not be true.
        </p>
      </div>

      {problem && (
        <Card>
          <div style={{ padding: 16, color: theme.textMuted, fontSize: 13 }}>
            <strong style={{ color: theme.text }}>Not set up yet.</strong> {problem}
          </div>
        </Card>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        {tiles.map((t) => (
          <Card key={t.label}>
            <div style={{ padding: 14 }}>
              <div style={{ color: theme.textMuted, fontSize: 12 }}>{t.label}</div>
              {loading
                ? <Skeleton style={{ height: 26, width: 48, marginTop: 6 }} />
                : <div style={{ fontSize: 24, color: theme.text, fontWeight: 600 }}>{t.value}</div>}
              <div style={{ color: theme.textMuted, fontSize: 11, marginTop: 2 }}>{t.hint}</div>
            </div>
          </Card>
        ))}
      </div>

      <Group title="Queued" rows={data?.queued} theme={theme} loading={loading}
             empty="Nothing queued. Mark creators invite on the Find tab."
             columns={["Creator", "Followers", "Opens with", "Decision"]}
             render={(c) => [
               `@${c.handle}`,
               (c.followers || 0).toLocaleString(),
               c.example_brand ? `@${c.example_brand}` : "—",
               c.decision === "send" ? "invite" : c.decision,
             ]} />

      <Group title="Blocked" rows={data?.blocked} theme={theme} loading={loading}
             empty="Nothing blocked."
             columns={["Creator", "Followers", "Why"]}
             render={(c) => [`@${c.handle}`, (c.followers || 0).toLocaleString(), c.why]} />

      <Group title="Invited" rows={data?.invited} theme={theme} loading={loading}
             empty="Nobody invited yet."
             columns={["Creator", "Followers", "Opened with", "When"]}
             render={(c) => [
               `@${c.handle}`,
               (c.followers || 0).toLocaleString(),
               c.example_brand ? `@${c.example_brand}` : "—",
               c.pushed_at ? new Date(c.pushed_at).toLocaleDateString() : "—",
             ]} />

      <p style={{ color: theme.textMuted, fontSize: 12, margin: 0 }}>
        Invites are sent by Lemlist, not from here:{" "}
        <code style={{ color: theme.text }}>prospector creators invite --send</code>. The
        sequence to paste into the campaign is in docs/lemlist-creator-sequence.md.
      </p>
    </div>
  );
}

function Group({ title, rows, columns, render, theme, loading, empty }) {
  return (
    <Card>
      <div style={{ padding: "12px 14px", borderBottom: `1px solid ${theme.border}`,
                    color: theme.text, fontSize: 13 }}>
        {title} {rows ? <span style={{ color: theme.textMuted }}>({rows.length})</span> : null}
      </div>
      {loading ? (
        <div style={{ padding: 14 }}><Skeleton style={{ height: 18 }} /></div>
      ) : !rows?.length ? (
        <div style={{ padding: 16, color: theme.textMuted, fontSize: 13 }}>{empty}</div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ color: theme.textMuted, borderBottom: `1px solid ${theme.border}` }}>
              {columns.map((c) => (
                <th key={c} style={{ padding: "8px 12px", textAlign: "left", fontWeight: 500 }}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.handle} style={{ borderBottom: `1px solid ${theme.border}` }}>
                {render(row).map((cell, i) => (
                  <td key={i} style={{ padding: "8px 12px", color: theme.text }}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
