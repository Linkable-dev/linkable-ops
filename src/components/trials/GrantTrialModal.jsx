// Friendly trial-grant modal — used by /trials and /users.
//
// Two-step flow designed for non-technical admins:
//
//   Step 1 (PICK):  Big quick-pick buttons for the 80% cases —
//                   "Same as last", "14-day Grow", "30-day extension".
//                   "Custom..." reveals the full plan/days/interval form
//                   for the long tail.
//
//   Step 2 (CONFIRM): Plain-English summary of what's about to happen,
//                     then Cancel / Confirm. Reduces fat-finger risk on
//                     the irreversible-feeling "I just gave Sephora 30
//                     days" action.
//
// The modal hides DB-target jargon ("PROD DB" / "DEV DB") behind a small
// monospace pill — present so the operator can spot dev/prod mistakes,
// but no longer the dominant visual.
//
// Backend contract: POST /admin-users/:userId/grant-trial — same as before.
// We don't add new server endpoints; this is purely a UI re-wrap.

import { useEffect, useMemo, useState } from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { api, friendlyDate } from "../../lib/api";
import { Modal } from "../ui/Modal";
import { Btn } from "../ui/Button";
import { Input } from "../ui/Input";
import {
  TRIAL_PLANS, DEFAULT_PLAN, DEFAULT_DAYS, DEFAULT_INTERVAL,
  formatPlanLine, planLabel,
} from "./planConfig";

// Quick-pick presets surfaced as big buttons. Each preset is a function of
// the row's current trial state so "Same as last" can resolve to the
// brand's previous plan/interval; the others are static.
function buildPresets(row) {
  const prevPlan     = row?.trial_plan_name || null;
  const prevDays     = Number(row?.trial_days) > 0 ? Number(row.trial_days) : null;
  const prevInterval = row?.trial_interval === "annual" ? "annual" : "monthly";
  const prevExpiresRaw = row?.trial_expiration_date;
  const prevExpires = prevExpiresRaw && prevExpiresRaw !== "-infinity"
    ? new Date(prevExpiresRaw) : null;
  const missingDays = prevExpires
    ? Math.ceil((prevExpires.getTime() - Date.now()) / 86_400_000)
    : 0;
  const presets = [];

  if (prevPlan && prevDays) {
    presets.push({
      key: "same",
      title: "Same as last trial",
      hint: `${planLabel(prevPlan)} · ${prevDays} days · ${prevInterval}`,
      plan: prevPlan,
      days: prevDays,
      interval: prevInterval,
    });
  }
  // Restore-missing-days preset: only shown when the brand still has a
  // future expiry on file, so the operator can re-grant a trial that
  // ends on the originally-promised date instead of starting fresh.
  if (prevPlan && prevExpires && missingDays >= 1 && missingDays <= 90) {
    presets.push({
      key: "missing",
      title: `Restore missing days (${missingDays})`,
      hint: `Same plan, ends ${friendlyDate(prevExpiresRaw)} — as originally granted`,
      plan: prevPlan,
      days: missingDays,
      interval: prevInterval,
    });
  }
  presets.push({
    key: "grow_14",
    title: "14-day Grow trial",
    hint: "Default new-brand offering",
    plan: "grow",
    days: 14,
    interval: "monthly",
  });
  presets.push({
    key: "grow_30",
    title: "30-day extension",
    hint: "Same plan, extra time after a demo or ask",
    plan: prevPlan && TRIAL_PLANS.some(p => p.value === prevPlan) ? prevPlan : "grow",
    days: 30,
    interval: prevInterval,
  });
  return presets;
}

export default function GrantTrialModal({ row, isDev, onClose, onGranted }) {
  const { theme, mode } = useTheme();

  // Step machine: "pick" (presets + custom toggle) → "confirm" (summary + write)
  const [step, setStep] = useState("pick");

  // Selected values (driven by either a preset or the custom form)
  const [plan, setPlan] = useState(DEFAULT_PLAN);
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [billingInterval, setBillingInterval] = useState(DEFAULT_INTERVAL);
  const [note, setNote] = useState("");

  // UI state
  const [customOpen, setCustomOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const userId = row?.user_id;
  const initialPlan = row?.trial_plan_name;
  const initialDays = row?.trial_days;
  const initialInterval = row?.trial_interval;

  // Reset on row change so reopening the modal for a different brand doesn't
  // inherit the previous brand's note / step / custom toggle.
  useEffect(() => {
    if (!userId) return;
    setStep("pick");
    setCustomOpen(false);
    setNote("");
    setError("");
    // Default the custom form to the brand's prior trial when present, else
    // to the global defaults — so opening Custom doesn't surprise the operator.
    setPlan(initialPlan && TRIAL_PLANS.some(p => p.value === initialPlan) ? initialPlan : DEFAULT_PLAN);
    setDays(Number(initialDays) > 0 ? Number(initialDays) : DEFAULT_DAYS);
    setBillingInterval(initialInterval === "annual" ? "annual" : DEFAULT_INTERVAL);
  }, [userId, initialPlan, initialDays, initialInterval]);

  const presets = useMemo(() => buildPresets(row), [row]);

  if (!row) return null;

  const expires = row.trial_expiration_date && row.trial_expiration_date !== "-infinity"
    ? new Date(row.trial_expiration_date) : null;
  const isExpired = expires && expires.getTime() <= Date.now();
  const hasActivePlan = !!row.trial_plan_name;
  const activated = !!row.trial_activation_date && row.trial_activation_date !== "-infinity";
  const daysLeft = expires && !isExpired
    ? Math.max(0, Math.ceil((expires.getTime() - Date.now()) / 86_400_000))
    : null;
  const looksLikeActiveSubscription = activated && expires && !isExpired;

  // Apply a preset and jump straight to the confirm step. This is the
  // happy path for non-techy admins: 2 clicks (preset → confirm) and done.
  function applyPresetAndConfirm(preset) {
    setPlan(preset.plan);
    setDays(preset.days);
    setBillingInterval(preset.interval);
    setStep("confirm");
  }

  // Custom path: user opened the custom form, edited values, hit "Continue".
  // We validate then jump to the same confirm step.
  function continueFromCustom() {
    if (!Number.isFinite(Number(days)) || Number(days) < 1 || Number(days) > 90) {
      setError("Days must be between 1 and 90");
      return;
    }
    setError("");
    setStep("confirm");
  }

  async function handleConfirm() {
    setError("");
    setSubmitting(true);
    try {
      await api.grantTrial(row.user_id, {
        plan,
        days: Number(days),
        interval: billingInterval,
        note: note.trim() || undefined,
      });
      onGranted();
    } catch (err) {
      setError(err.message);
      // Bounce back to the pick step on failure so the operator can adjust.
      setStep("pick");
    } finally {
      setSubmitting(false);
    }
  }

  const labelStyle = {
    display: "block", fontSize: 11, fontWeight: 600, textTransform: "uppercase",
    letterSpacing: 0.4, color: theme.textMuted, marginBottom: 6,
  };
  const selectStyle = {
    width: "100%", boxSizing: "border-box", background: theme.bg,
    border: `1.5px solid ${theme.border}`, borderRadius: 8, color: theme.text,
    fontFamily: "inherit", fontSize: 14, padding: "10px 13px", outline: "none",
  };

  // ---------- STEP 2: CONFIRM ----------
  if (step === "confirm") {
    return (
      <Modal open={!!row} onClose={onClose} title="Confirm — Grant trial" width={520}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 14, color: theme.text, lineHeight: 1.55 }}>
            You're about to give:
          </div>

          <div style={{
            background: theme.surfaceAlt, borderRadius: 10,
            border: `1px solid ${theme.border}`, padding: "16px 18px",
          }}>
            <div style={{ fontSize: 18, fontWeight: 600, color: theme.text, marginBottom: 4 }}>
              {row.store_name || row.email}
            </div>
            <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 14 }}>
              {row.email}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "8px 16px", fontSize: 13 }}>
              <span style={{ color: theme.textMuted }}>Plan</span>
              <span style={{ color: theme.text }}>{formatPlanLine(plan, billingInterval)}</span>
              <span style={{ color: theme.textMuted }}>Trial length</span>
              <span style={{ color: theme.text }}>{days} days</span>
              <span style={{ color: theme.textMuted }}>Effective</span>
              <span style={{ color: theme.text }}>
                When the brand clicks "Start Free Trial" in the main app
              </span>
            </div>
          </div>

          {looksLikeActiveSubscription && (
            <div style={{
              fontSize: 12, color: "#92400E",
              background: mode === "dark" ? "#3D2A05" : "#FFFBEB",
              border: `1px solid ${mode === "dark" ? "#5B4015" : "#FDE68A"}`,
              padding: "10px 12px", borderRadius: 8,
            }}>
              <b>Heads up:</b> this brand currently has an active trial / subscription.
              If they're already paying, the new "Start Free Trial" button may not work
              until you cancel their existing subscription on the Shopify side.
            </div>
          )}

          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            fontSize: 11, color: theme.textMuted,
          }}>
            <span>Audit log entry will be created with your admin email.</span>
            <DbTargetPill isDev={isDev} theme={theme} />
          </div>

          {error && <ErrorBox error={error} mode={mode} />}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <Btn size="md" variant="outline" onClick={() => { setStep("pick"); setError(""); }} disabled={submitting}>
              Back
            </Btn>
            <Btn size="md" onClick={handleConfirm} loading={submitting}>
              Confirm — grant trial
            </Btn>
          </div>
        </div>
      </Modal>
    );
  }

  // ---------- STEP 1: PICK ----------
  return (
    <Modal open={!!row} onClose={onClose} title={`Grant trial — ${row.store_name || row.email}`} width={560}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Brand context strip */}
        <div style={{
          fontSize: 13, color: theme.textMid, padding: "10px 12px",
          background: theme.surfaceAlt, borderRadius: 8, border: `1px solid ${theme.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: theme.text, fontWeight: 500, marginBottom: 2 }}>{row.email}</div>
            <TrialStatusLine
              row={row}
              hasActivePlan={hasActivePlan}
              activated={activated}
              isExpired={isExpired}
              daysLeft={daysLeft}
              expires={expires}
              theme={theme}
            />
          </div>
          <DbTargetPill isDev={isDev} theme={theme} />
        </div>

        {/* Quick-pick presets */}
        <div>
          <div style={{ ...labelStyle, marginBottom: 10 }}>Pick a quick option</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {presets.map((p) => (
              <PresetButton
                key={p.key}
                title={p.title}
                hint={p.hint}
                onClick={() => applyPresetAndConfirm(p)}
                theme={theme}
              />
            ))}
          </div>
        </div>

        {/* Custom toggle */}
        <div>
          <button
            type="button"
            onClick={() => setCustomOpen((x) => !x)}
            style={{
              background: "transparent", border: "none", padding: 0, cursor: "pointer",
              color: theme.textMid, fontSize: 13, fontFamily: "inherit",
              display: "inline-flex", alignItems: "center", gap: 6,
            }}
          >
            <span style={{ display: "inline-block", transform: customOpen ? "rotate(90deg)" : "rotate(0)", transition: "transform 0.15s" }}>▶</span>
            Custom — pick your own plan, length, interval
          </button>

          {customOpen && (
            <div style={{
              marginTop: 12, padding: "14px 14px 4px", border: `1px solid ${theme.border}`,
              borderRadius: 10, background: theme.bg,
              display: "flex", flexDirection: "column", gap: 14,
            }}>
              <div>
                <label style={labelStyle}>Plan</label>
                <select value={plan} onChange={(e) => setPlan(e.target.value)} style={selectStyle}>
                  {TRIAL_PLANS.map(p => (
                    <option key={p.value} value={p.value}>
                      {p.label}{p.description ? ` — ${p.description}` : ""}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={labelStyle}>Trial length (days)</label>
                  <Input type="number" min={1} max={90} value={days}
                    onChange={(e) => setDays(e.target.value === "" ? "" : Math.max(1, Math.min(90, Number(e.target.value))))} />
                </div>
                <div>
                  <label style={labelStyle}>Billing interval</label>
                  <select value={billingInterval} onChange={(e) => setBillingInterval(e.target.value)} style={selectStyle}>
                    <option value="monthly">Monthly</option>
                    <option value="annual">Annual</option>
                  </select>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
                <Btn size="sm" onClick={continueFromCustom}>Continue →</Btn>
              </div>
            </div>
          )}
        </div>

        {/* Optional note (always visible — encourages an audit reason) */}
        <div>
          <label style={labelStyle}>Note (optional, saved to audit log)</label>
          <Input multiline rows={2} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. ‘Re-extended trial after demo call’" />
        </div>

        {error && <ErrorBox error={error} mode={mode} />}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
          <Btn size="md" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Btn>
        </div>
      </div>
    </Modal>
  );
}

function PresetButton({ title, hint, onClick, theme }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: "left", padding: "12px 14px", borderRadius: 10, cursor: "pointer",
        background: theme.bg, border: `1.5px solid ${theme.border}`, color: theme.text,
        fontFamily: "inherit", display: "block", width: "100%",
        transition: "border-color 0.12s, background 0.12s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = theme.text; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = theme.border; }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>{title}</div>
      <div style={{ fontSize: 12, color: theme.textMuted }}>{hint}</div>
    </button>
  );
}

// Colored-dot status indicator for the brand's current trial state.
// Three states, each with a distinct dot color so an operator can read
// the row at a glance before deciding what to grant.
function TrialStatusLine({ row, hasActivePlan, activated, isExpired, daysLeft, expires, theme }) {
  if (!hasActivePlan) {
    return <StatusLine theme={theme} color={theme.textMuted} text="No trial set" />;
  }
  const planDetails = `${planLabel(row.trial_plan_name)} · ${row.trial_days}d · ${row.trial_interval || "—"}`;
  if (!activated) {
    return <StatusLine theme={theme} color="#F59E0B" text={`Assigned, not activated — ${planDetails}`} />;
  }
  if (isExpired) {
    const endedOn = expires ? friendlyDate(row.trial_expiration_date) : "unknown date";
    return <StatusLine theme={theme} color="#EF4444" text={`Expired on ${endedOn} — ${planDetails}`} />;
  }
  const left = daysLeft != null ? ` · ${daysLeft} day${daysLeft === 1 ? "" : "s"} left` : "";
  return <StatusLine theme={theme} color="#10B981" text={`Active — ${planDetails}${left}`} />;
}

function StatusLine({ theme, color, text }) {
  return (
    <div style={{ fontSize: 12, color: theme.textMuted, display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{
        width: 8, height: 8, borderRadius: "50%",
        background: color, flexShrink: 0,
        boxShadow: `0 0 0 2px ${color}22`,
      }} />
      <span>{text}</span>
    </div>
  );
}

function DbTargetPill({ isDev, theme }) {
  return (
    <span style={{
      fontFamily: "ui-monospace, SFMono-Regular, monospace",
      fontSize: 10, fontWeight: 600, padding: "2px 6px",
      borderRadius: 4, letterSpacing: 0.4,
      background: isDev ? "#FEF3C7" : "#DCFCE7",
      color: isDev ? "#78350F" : "#14532D",
    }}>
      {isDev ? "DEV" : "PROD"}
    </span>
  );
}

function ErrorBox({ error, mode }) {
  return (
    <div style={{
      fontSize: 12, color: "#EF4444",
      background: mode === "dark" ? "#3B1111" : "#FEF2F2",
      border: `1px solid ${mode === "dark" ? "#5B1717" : "#FECACA"}`,
      padding: "10px 12px", borderRadius: 8,
    }}>
      {error}
    </div>
  );
}
