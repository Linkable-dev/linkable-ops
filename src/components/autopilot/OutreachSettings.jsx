import { useEffect, useState } from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { Card } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";
import { api } from "../../lib/api";

/**
 * The outreach knobs, on the page where their effects are visible.
 *
 * All of these were environment variables or Go constants, so every one of
 * them — which Lemlist sequence a campaign clones, whether copy is written per
 * campaign, how many test sends a push makes, what a new agent aims for, the
 * house emails themselves — was a pull request and a deploy. None is a code
 * change, and the ones you most want to change are the ones you want to change
 * while outreach is misbehaving.
 *
 * Unset is shown as "built-in", not as blank: the service falls back to the
 * variable it replaced and then to the value compiled in, so an empty field
 * here means "whatever shipped", not "nothing".
 */
export default function OutreachSettings() {
  const { theme } = useTheme();
  const [settings, setSettings] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const load = () =>
    api
      .getOutreachSettings()
      .then((d) => {
        setAvailable(d.available !== false);
        setSettings(d.settings || []);
        setDrafts(Object.fromEntries((d.settings || []).map((s) => [s.key, s.value])));
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
  }, []);

  async function save(key) {
    setBusy(key);
    setError("");
    setSaved("");
    try {
      await api.setOutreachSetting(key, { value: drafts[key] ?? "" });
      setSaved(key);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  async function clear(key) {
    setBusy(key);
    setError("");
    try {
      await api.clearOutreachSetting(key);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  if (!available && !loading) return null;

  const input = {
    width: "100%",
    padding: "6px 8px",
    borderRadius: 6,
    border: `1px solid ${theme.border}`,
    background: theme.surface,
    color: theme.text,
    fontSize: 13,
    fontFamily: "inherit",
  };

  return (
    <Card>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>Outreach settings</div>
      <div style={{ color: theme.textMuted, fontSize: 12, marginBottom: 12 }}>
        Read on every send, so a change is live within the minute — no deploy. Leave one empty and
        the service uses what it shipped with.
      </div>

      {loading && <Skeleton height={120} />}

      {!loading &&
        settings.map((s) => {
          const changed = (drafts[s.key] ?? "") !== s.value;
          const big = s.kind === "json";
          return (
            <div
              key={s.key}
              style={{
                display: "flex",
                gap: 12,
                alignItems: big ? "flex-start" : "center",
                flexWrap: "wrap",
                padding: "10px 0",
                borderTop: `1px solid ${theme.border}`,
              }}
            >
              <div style={{ flex: "1 1 280px", minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {s.key}{" "}
                  {!s.set && (
                    <span style={{ color: theme.textMuted, fontWeight: 400, fontSize: 11 }}>
                      · built-in
                    </span>
                  )}
                </div>
                <div style={{ color: theme.textMuted, fontSize: 12, marginTop: 2 }}>{s.help}</div>
                {s.updated_by && (
                  <div style={{ color: theme.textMuted, fontSize: 11, marginTop: 2 }}>
                    last set by {s.updated_by}
                  </div>
                )}
              </div>
              <div style={{ flex: big ? "1 1 100%" : "0 1 280px", display: "flex", gap: 6 }}>
                {big ? (
                  <textarea
                    rows={8}
                    value={drafts[s.key] ?? ""}
                    onChange={(e) => setDrafts({ ...drafts, [s.key]: e.target.value })}
                    placeholder='{"steps":[{"delay":0,"subject":"…","message":"<p>…</p>"}]}'
                    style={{ ...input, fontFamily: "ui-monospace, monospace", fontSize: 12 }}
                  />
                ) : (
                  <input
                    type={s.kind === "number" ? "number" : "text"}
                    value={drafts[s.key] ?? ""}
                    onChange={(e) => setDrafts({ ...drafts, [s.key]: e.target.value })}
                    style={input}
                  />
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <button
                    onClick={() => save(s.key)}
                    disabled={!changed || busy === s.key}
                    style={{
                      padding: "6px 10px",
                      borderRadius: 6,
                      border: `1px solid ${theme.border}`,
                      background: changed ? theme.accentLight : theme.surface,
                      color: theme.text,
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: changed ? "pointer" : "default",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {busy === s.key ? "…" : saved === s.key && !changed ? "Saved" : "Save"}
                  </button>
                  {s.set && (
                    <button
                      onClick={() => clear(s.key)}
                      disabled={busy === s.key}
                      style={{
                        padding: "4px 10px",
                        borderRadius: 6,
                        border: "none",
                        background: "none",
                        color: theme.textMuted,
                        fontSize: 11,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      reset
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}

      {error && (
        <div style={{ color: "#B91C1C", fontSize: 12, marginTop: 10 }}>{error}</div>
      )}
    </Card>
  );
}
