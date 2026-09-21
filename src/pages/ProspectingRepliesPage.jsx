import { useCallback, useEffect, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Skeleton } from "../components/ui/Skeleton";
import { Btn } from "../components/ui/Button";

/**
 * What came back after the send — the only page in GTM showing a fact rather
 * than a prediction.
 *
 * Everything else about a lead is the pipeline's opinion: Tier A because a
 * score said so, worth contacting because a creator posted about them. This
 * page is where those opinions get marked. A tier that never replies is a tier
 * that is wrong, and until this existed there was no way to find that out.
 *
 * Read-only on purpose. There is no decision to make here, because a reply is
 * not an opinion — the actions live on Find, where the queue is.
 *
 * The counts are over people, not events: someone who opened four times is one
 * open. A funnel counted in events flatters itself.
 */
export default function ProspectingRepliesPage({ kind = "brand" }) {
  const { theme } = useTheme();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState(null);
  // Drafts are per reply and never stored: they exist for as long as somebody
  // is looking at them. A saved draft is a draft somebody sends later without
  // reading, which is the failure this is trying to avoid.
  const [drafts, setDrafts] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.getProspectingReplies(kind));
      setProblem(null);
    } catch (err) {
      setProblem(err?.hint || err?.message || "could not load replies");
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => { load(); }, [load]);

  const draft = useCallback(async (activityId) => {
    setDrafts((d) => ({ ...d, [activityId]: { loading: true } }));
    try {
      const out = await api.draftProspectingReply(activityId);
      setDrafts((d) => ({ ...d, [activityId]: out }));
    } catch (err) {
      setDrafts((d) => ({
        ...d,
        [activityId]: { error: err?.hint || err?.message || "could not draft" },
      }));
    }
  }, []);

  const f = data?.funnel || {};
  const replied = (f.replied || 0) + (f.interested || 0);
  const tiles = [
    { label: "Contacted", value: f.contacted ?? 0, hint: "handed to Lemlist" },
    { label: "Opened", value: f.opened ?? 0, hint: "people, not opens" },
    { label: "Replied", value: replied, hint: "answered something" },
    { label: "Stopped", value: (f.bounced || 0) + (f.unsubscribed || 0),
      hint: "bounced or opted out" },
  ];

  const events = data?.events || [];
  const noun = kind === "creator" ? "creator" : "brand";

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, color: theme.text }}>Replies</h1>
        <p style={{ margin: "6px 0 0", color: theme.textMuted, fontSize: 13, maxWidth: 720 }}>
          Read back from Lemlist. Bounces and opt-outs are added to the suppression
          list as they arrive, so a {noun} that says stop is not written to again —
          that happens whether or not anyone opens this page.
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

      <Card>
        <div style={{ padding: "12px 14px", borderBottom: `1px solid ${theme.border}`,
                      color: theme.text, fontSize: 13 }}>
          What they said {events.length ? (
            <span style={{ color: theme.textMuted }}>({events.length})</span>
          ) : null}
        </div>
        {loading ? (
          <div style={{ padding: 14 }}><Skeleton style={{ height: 18 }} /></div>
        ) : !events.length ? (
          <div style={{ padding: 16, color: theme.textMuted, fontSize: 13 }}>
            {f.contacted
              ? `${f.silent ?? 0} still out there and nothing back yet.`
              : "Nothing sent yet, so nothing to read back."}
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ color: theme.textMuted, borderBottom: `1px solid ${theme.border}` }}>
                {["When", "Who", "What", "They wrote"].map((c) => (
                  <th key={c} style={{ padding: "8px 12px", textAlign: "left", fontWeight: 500 }}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.activity_id} style={{ borderBottom: `1px solid ${theme.border}` }}>
                  <td style={{ padding: "8px 12px", color: theme.textMuted, whiteSpace: "nowrap" }}>
                    {e.occurred_at ? new Date(e.occurred_at).toLocaleDateString() : "—"}
                  </td>
                  <td style={{ padding: "8px 12px", color: theme.text }}>
                    {e.handle ? `@${e.handle}` : e.email}
                  </td>
                  <td style={{ padding: "8px 12px", color: theme.text, whiteSpace: "nowrap" }}>
                    <Pill event={e.event} theme={theme} />
                  </td>
                  <td style={{ padding: "8px 12px", color: theme.textMuted }}>
                    {e.preview || e.subject || "—"}
                    {TONE[e.event] === "good" && (
                      <DraftBlock
                        theme={theme}
                        state={drafts[e.activity_id]}
                        onDraft={() => draft(e.activity_id)}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <p style={{ color: theme.textMuted, fontSize: 12, margin: 0 }}>
        Pulled by the worker on every tick, or by hand with{" "}
        <code style={{ color: theme.text }}>prospector replies</code>.
      </p>
    </div>
  );
}

// Green for an answer, red for a door closing, plain for the rest. A bounce and
// an unsubscribe read the same here because they mean the same thing to us: do
// not write to this address again.
const TONE = {
  replied: "good", interested: "good",
  bounced: "bad", unsubscribed: "bad", not_interested: "bad",
};

function Pill({ event, theme }) {
  const tone = TONE[event];
  const color = tone === "good" ? "#16a34a" : tone === "bad" ? "#dc2626" : theme.textMuted;
  return (
    <span style={{
      color,
      border: `1px solid ${color}33`,
      background: `${color}14`,
      borderRadius: 4,
      padding: "2px 6px",
      fontSize: 12,
    }}>
      {String(event).replace("_", " ")}
    </span>
  );
}


// Only offered on a reply somebody actually wrote something in, and only for
// the ones worth answering. A bounce has nobody on the other end.
function DraftBlock({ state, onDraft, theme }) {
  if (!state) {
    return (
      <div style={{ marginTop: 6 }}>
        <Btn onClick={onDraft} style={{ fontSize: 12, padding: "3px 8px" }}>
          Draft a reply
        </Btn>
      </div>
    );
  }
  if (state.loading) {
    return <div style={{ marginTop: 6 }}><Skeleton style={{ height: 40 }} /></div>;
  }
  if (state.error) {
    return (
      <div style={{ marginTop: 6, color: "#dc2626", fontSize: 12 }}>{state.error}</div>
    );
  }
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{
        whiteSpace: "pre-wrap",
        background: theme.bg,
        border: `1px solid ${theme.border}`,
        borderRadius: 6,
        padding: 10,
        color: theme.text,
        fontSize: 13,
      }}>{state.draft}</div>
      {state.issues?.length ? (
        <div style={{ color: "#b45309", fontSize: 11, marginTop: 4 }}>
          Reads like a machine wrote it: {state.issues.join(", ")}
        </div>
      ) : null}
      <div style={{ color: theme.textMuted, fontSize: 11, marginTop: 4 }}>
        A draft. Nothing here sends it — copy it into Lemlist once you have read it.
      </div>
    </div>
  );
}
