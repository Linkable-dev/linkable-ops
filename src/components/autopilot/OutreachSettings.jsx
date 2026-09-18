import { useEffect, useState } from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { Btn } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";
import { api } from "../../lib/api";
import ProviderCosts from "./ProviderCosts";

/**
 * Everything the sending obeys, behind one cog.
 *
 * These were environment variables and Go constants, so each was a pull
 * request and a deploy — which is the wrong shape for the settings you most
 * want to move while outreach is misbehaving. They are editable now, but they
 * are not what this page is FOR: the page is the machine's state, and a column
 * of form fields above the table buries it. So they live in a drawer, the same
 * one the brand panel uses, opened from a cog and closed with Escape.
 *
 * Unset reads "built-in" rather than as a blank field. The service falls back
 * to the variable each one replaced and then to the value compiled in, so an
 * empty field means "whatever shipped", not "nothing".
 */
const cog = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

export default function OutreachSettings({ defaultLimit, onDefaultLimitChange }) {
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [limitDraft, setLimitDraft] = useState(String(defaultLimit ?? ""));
  const [economics, setEconomics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => setLimitDraft(String(defaultLimit ?? "")), [defaultLimit]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

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

  // Loaded when it is opened, not on mount: the page behind it is the point,
  // and a settings read on every visit is a query nobody asked for.
  useEffect(() => {
    if (open) load();
  }, [open]);

  // What a search actually costs and finds, loaded once per opening -- real
  // billed data, not an estimate, so the number in the field above is set
  // against a fact rather than a guess.
  useEffect(() => {
    if (!open) return;
    let active = true;
    api
      .getSearchEconomics()
      .then((d) => active && setEconomics(d))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [open]);

  async function save(key) {
    setBusy(key);
    setError("");
    try {
      await api.setOutreachSetting(key, { value: drafts[key] ?? "" });
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

  async function saveLimit() {
    const searches = Number(limitDraft);
    if (!/^\d+$/.test(limitDraft) || !Number.isInteger(searches) || searches < 0 || searches > 1000) {
      setError("Enter a whole number from 0 to 1000");
      return;
    }
    setBusy("__limit");
    setError("");
    try {
      await api.setAutopilotAllowance("default", { monthly_searches: searches });
      onDefaultLimitChange?.(searches);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  const field = {
    width: "100%",
    padding: "7px 9px",
    borderRadius: 7,
    border: `1px solid ${theme.border}`,
    background: theme.surface,
    color: theme.text,
    fontSize: 13,
    fontFamily: "inherit",
  };
  const label = {
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.textMuted,
    marginBottom: 8,
  };
  const section = {
    background: theme.surface,
    border: `1px solid ${theme.border}`,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Outreach settings"
        aria-label="Outreach settings"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          height: 32,
          padding: "0 12px",
          borderRadius: 8,
          border: `1px solid ${theme.border}`,
          background: theme.surface,
          color: theme.textMid,
          fontSize: 12.5,
          fontWeight: 500,
          fontFamily: "inherit",
          cursor: "pointer",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = theme.accentLight)}
        onMouseLeave={(e) => (e.currentTarget.style.background = theme.surface)}
      >
        {cog}
        Settings
      </button>

      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 900,
              background: "rgba(18,20,25,0.35)",
              backdropFilter: "blur(2px)",
            }}
          />
          <aside
            role="dialog"
            aria-label="Outreach settings"
            style={{
              position: "fixed",
              top: 0,
              right: 0,
              bottom: 0,
              zIndex: 901,
              width: "min(560px, 100vw)",
              background: theme.bg,
              borderLeft: `1px solid ${theme.border}`,
              boxShadow: theme.shadowMd,
              display: "flex",
              flexDirection: "column",
              animation: "lkSlideIn 0.18s ease-out",
            }}
          >
            <div
              style={{
                padding: "16px 20px 12px",
                borderBottom: `1px solid ${theme.border}`,
                background: theme.surface,
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>Outreach settings</div>
                <div style={{ color: theme.textMuted, fontSize: 12, marginTop: 2 }}>
                  Changes are picked up within a minute and used at the next relevant action.
                  Launch defaults apply to new agents; existing schedules and sequences keep their values.
                  Leave a setting empty to use its environment or built-in default.
                </div>
              </div>
              <button
                onClick={() => setOpen(false)}
                title="Close"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 999,
                  border: `1px solid ${theme.border}`,
                  background: "transparent",
                  color: theme.textMid,
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                ✕
              </button>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
              {/* The limit lives here too now. It is a setting, and it was
                  taking a card's worth of the page above the machine's state. */}
              <div style={section}>
                <div style={label}>Credits</div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Searches a brand gets each month</div>
                <div style={{ color: theme.textMuted, fontSize: 12, margin: "2px 0 10px" }}>
                  Every brand, unless one has a limit of its own — set that on the brand's row.
                  Each search spends provider credits, which is the whole reason for a limit.
                  Agents read it on their next tick, so raising one un-parks it within the hour.
                </div>
                {economics?.available && economics.runs > 0 && (
                  <div
                    style={{
                      background: theme.bg,
                      border: `1px solid ${theme.border}`,
                      borderRadius: 8,
                      padding: "8px 10px",
                      fontSize: 12,
                      color: theme.textMuted,
                      marginBottom: 10,
                    }}
                  >
                    A real search costs{" "}
                    <strong style={{ color: theme.text }}>~{economics.avg_credits} credits</strong>{" "}
                    ({economics.min_credits}–{economics.max_credits} seen) and finds{" "}
                    <strong style={{ color: theme.text }}>~{economics.avg_found} creators</strong>,{" "}
                    ~{economics.avg_contactable} with an email — from {economics.runs} real run
                    {economics.runs === 1 ? "" : "s"} so far ({economics.total_credits} credits
                    total). This is billed data from the provider's own API, not an estimate.
                    Credits only — see Provider costs below for what that comes to in money.
                  </div>
                )}
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    type="number"
                    min="0"
                    max="1000"
                    step="1"
                    value={limitDraft}
                    onChange={(e) => setLimitDraft(e.target.value)}
                    style={{ ...field, width: 110 }}
                  />
                  <Btn
                    size="sm"
                    loading={busy === "__limit"}
                    disabled={String(defaultLimit ?? "") === String(limitDraft)}
                    onClick={saveLimit}
                  >
                    Save
                  </Btn>
                </div>
              </div>

              {loading && <Skeleton height={200} />}

              {!loading && !available && (
                <div style={{ ...section, color: theme.textMuted, fontSize: 13 }}>
                  The settings table is not on this database yet. It is created at boot by the
                  gRPC service, so it appears after the next deploy — or switch the database
                  target to one that has it.
                </div>
              )}

              {!loading &&
                available &&
                settings.map((s) => {
                  const changed = (drafts[s.key] ?? "") !== s.value;
                  return (
                    <div key={s.key} style={section}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "baseline",
                          gap: 8,
                          flexWrap: "wrap",
                        }}
                      >
                        <div style={{ fontSize: 13, fontWeight: 600 }} title={s.key}>
                          {s.label || s.key}
                        </div>
                        {!s.set && (
                          <span style={{ color: theme.textMuted, fontSize: 11 }}>· built-in</span>
                        )}
                        {s.updated_by && (
                          <span style={{ color: theme.textMuted, fontSize: 11 }}>
                            · last set by {s.updated_by}
                          </span>
                        )}
                      </div>
                      <div style={{ color: theme.textMuted, fontSize: 12, margin: "2px 0 10px" }}>
                        {s.help}
                      </div>
                      {s.kind === "steps" ? (
                        <StepsEditor
                          theme={theme}
                          field={field}
                          value={drafts[s.key] ?? ""}
                          onChange={(v) => setDrafts({ ...drafts, [s.key]: v })}
                        />
                      ) : s.kind === "schedule" ? (
                        <ScheduleEditor
                          theme={theme}
                          field={field}
                          value={drafts[s.key] ?? ""}
                          onChange={(v) => setDrafts({ ...drafts, [s.key]: v })}
                        />
                      ) : s.kind === "choice" ? (
                        <select
                          value={drafts[s.key] ?? ""}
                          onChange={(e) => setDrafts({ ...drafts, [s.key]: e.target.value })}
                          style={field}
                        >
                          <option value="">Use the built-in setting</option>
                          {(s.options || []).map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type={s.kind === "number" ? "number" : "text"}
                          min={s.kind === "number" ? 1 : undefined}
                          max={s.kind === "number" ? (s.max ?? 100000) : undefined}
                          step={s.kind === "number" ? 1 : undefined}
                          value={drafts[s.key] ?? ""}
                          placeholder={s.placeholder || ""}
                          onChange={(e) => setDrafts({ ...drafts, [s.key]: e.target.value })}
                          style={field}
                        />
                      )}
                      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
                        <Btn
                          size="sm"
                          loading={busy === s.key}
                          disabled={!changed}
                          onClick={() => save(s.key)}
                        >
                          Save
                        </Btn>
                        {s.set && (
                          <button
                            onClick={() => clear(s.key)}
                            disabled={busy === s.key}
                            style={{
                              background: "none",
                              border: "none",
                              padding: 0,
                              color: theme.textMuted,
                              fontSize: 12,
                              cursor: "pointer",
                              fontFamily: "inherit",
                            }}
                          >
                            reset to built-in
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}

              <ProviderCosts theme={theme} field={field} section={section} />

              {error && (
                <div style={{ color: "#B91C1C", fontSize: 12, marginTop: 4 }}>{error}</div>
              )}
            </div>
          </aside>
        </>
      )}
    </>
  );
}

/**
 * The default emails, as emails.
 *
 * They are stored as JSON because that is what the service reads, but nobody
 * should have to write JSON to change a subject line — and a stray comma there
 * saves as invalid and silently falls back to the built-in copy, which looks
 * exactly like a save that worked. So the JSON stays underneath and this edits
 * the steps: a delay in days, a subject, and the body.
 */
/**
 * When a campaign's emails are allowed to go out. Lemlist attaches a schedule
 * to every campaign it creates and defaults it to its own hours (Paris,
 * 9-to-6, weekdays) unless told otherwise — which is why a push at 7pm can
 * sit quietly until the next working morning. Days as toggles rather than a
 * multi-select, because a week is seven things a person recognises at a
 * glance faster than they read a list.
 */
const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function ScheduleEditor({ theme, field, value, onChange }) {
  let sched = { timezone: "", start: "09:00", end: "18:00", weekdays: [] };
  let broken = false;
  try {
    if (value) sched = { ...sched, ...JSON.parse(value) };
  } catch {
    broken = true;
  }

  const write = (next) => onChange(JSON.stringify(next));
  const patch = (key, v) => write({ ...sched, [key]: v });
  const toggleDay = (day) =>
    patch(
      "weekdays",
      sched.weekdays.includes(day)
        ? sched.weekdays.filter((d) => d !== day)
        : [...sched.weekdays, day].sort((a, b) => a - b),
    );

  if (broken) {
    return (
      <>
        <div style={{ color: "#B91C1C", fontSize: 12, marginBottom: 6 }}>
          This is not valid JSON, so it cannot be shown as a schedule. Fix it here or clear it.
        </div>
        <textarea
          rows={4}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...field, fontFamily: "ui-monospace, monospace", fontSize: 12 }}
        />
      </>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {!value && (
        <div style={{ color: theme.textMuted, fontSize: 12 }}>
          Nothing set, so Lemlist uses its own default hours. Fill this in to take control of
          when a campaign's emails go out.
        </div>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {WEEKDAY_NAMES.map((name, i) => {
          const day = i + 1;
          const on = sched.weekdays.includes(day);
          return (
            <button
              key={day}
              type="button"
              onClick={() => toggleDay(day)}
              title={name}
              style={{
                padding: "5px 9px",
                borderRadius: 7,
                border: `1px solid ${on ? theme.text : theme.border}`,
                background: on ? theme.accentLight : "transparent",
                color: theme.text,
                fontSize: 12,
                fontWeight: on ? 600 : 400,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {name.slice(0, 3)}
            </button>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ fontSize: 12, color: theme.textMuted, display: "flex", flexDirection: "column", gap: 4 }}>
          From
          <input
            type="time"
            value={sched.start}
            onChange={(e) => patch("start", e.target.value)}
            style={{ ...field, width: 110 }}
          />
        </label>
        <label style={{ fontSize: 12, color: theme.textMuted, display: "flex", flexDirection: "column", gap: 4 }}>
          To
          <input
            type="time"
            value={sched.end}
            onChange={(e) => patch("end", e.target.value)}
            style={{ ...field, width: 110 }}
          />
        </label>
        <label style={{ fontSize: 12, color: theme.textMuted, display: "flex", flexDirection: "column", gap: 4, flex: "1 1 180px" }}>
          Timezone
          <input
            value={sched.timezone}
            placeholder="Europe/London"
            onChange={(e) => patch("timezone", e.target.value)}
            style={field}
          />
        </label>
      </div>
    </div>
  );
}

function StepsEditor({ theme, field, value, onChange }) {
  let steps = [];
  let broken = false;
  try {
    const parsed = value ? JSON.parse(value) : { steps: [] };
    steps = Array.isArray(parsed?.steps) ? parsed.steps : [];
  } catch {
    broken = true;
  }

  const write = (next) => onChange(JSON.stringify({ steps: next }));
  const patch = (i, key, v) => write(steps.map((s, n) => (n === i ? { ...s, [key]: v } : s)));

  if (broken) {
    return (
      <>
        <div style={{ color: "#B91C1C", fontSize: 12, marginBottom: 6 }}>
          This is not valid JSON, so it cannot be shown as steps. Fix it here or clear it.
        </div>
        <textarea
          rows={8}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...field, fontFamily: "ui-monospace, monospace", fontSize: 12 }}
        />
      </>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {steps.length === 0 && (
        <div style={{ color: theme.textMuted, fontSize: 12 }}>
          Nothing set, so the emails that ship with the service are used. Add a step to write your
          own.
        </div>
      )}
      {steps.map((step, i) => (
        <div
          key={i}
          style={{
            border: `1px solid ${theme.border}`,
            borderRadius: 10,
            padding: 12,
            background: theme.bg,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>
              {i === 0 ? "First email" : `Follow-up ${i}`}
            </span>
            <span style={{ color: theme.textMuted, fontSize: 12 }}>
              {i === 0 ? "sent straight away" : "sent"}
            </span>
            {i > 0 && (
              <>
                <input
                  type="number"
                  min="0"
                  value={step.delay ?? 0}
                  onChange={(e) => patch(i, "delay", Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                  style={{ ...field, width: 64, padding: "4px 6px" }}
                />
                <span style={{ color: theme.textMuted, fontSize: 12 }}>days later</span>
              </>
            )}
            <button
              onClick={() => write(steps.filter((_, n) => n !== i))}
              title="Remove this email"
              style={{
                marginLeft: "auto",
                background: "none",
                border: "none",
                color: theme.textMuted,
                fontSize: 12,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              remove
            </button>
          </div>
          <input
            value={step.subject ?? ""}
            placeholder="Subject"
            onChange={(e) => patch(i, "subject", e.target.value)}
            style={{ ...field, marginBottom: 6 }}
          />
          <textarea
            rows={5}
            value={step.message ?? ""}
            placeholder="<p>Hi {{firstName}},</p>"
            onChange={(e) => patch(i, "message", e.target.value)}
            style={{ ...field, fontFamily: "ui-monospace, monospace", fontSize: 12 }}
          />
        </div>
      ))}
      <button
        onClick={() => write([...steps, { delay: steps.length ? 3 : 0, subject: "", message: "" }])}
        style={{
          alignSelf: "flex-start",
          padding: "5px 10px",
          borderRadius: 7,
          border: `1px dashed ${theme.border}`,
          background: "none",
          color: theme.textMid,
          fontSize: 12,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        + Add a follow-up
      </button>
    </div>
  );
}
