// Per-brand management hub — one "Manage" button on the /users brand rows
// opens this modal, grouping the actions that used to be separate row buttons:
//
//   · Startup Programme — enroll/remove (writes brands.startup_programme; the
//     main app gives enrolled brands the $99/mo-for-3-months intro price on
//     their first monthly Growth subscription).
//   · Grant trial — hands off to the existing GrantTrialModal flow.
//
// The startup toggle writes immediately (with its own busy/error state) so an
// operator can flip it and still grant a trial in one visit.

import { useEffect, useState } from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { api } from "../../lib/api";
import { Modal } from "../ui/Modal";
import { Btn } from "../ui/Button";
import { planLabel } from "../trials/planConfig";
import { friendlyDate } from "../../lib/api";

export default function ManageBrandModal({ row, isDev, onClose, onStartupChanged, onGrantTrial, onWiped }) {
  const { theme, mode } = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [wiping, setWiping] = useState(false);
  const [wipeConfirm, setWipeConfirm] = useState("");
  const [wipeResult, setWipeResult] = useState(null);

  useEffect(() => { setError(""); setWipeConfirm(""); setWipeResult(null); }, [row?.user_id]);

  if (!row) return null;

  const enrolled = !!row.startup_programme;

  async function toggleStartup() {
    setError("");
    setBusy(true);
    try {
      await api.setStartupProgramme(row.user_id, !enrolled);
      onStartupChanged(row.user_id, !enrolled);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Type-to-confirm target: the store name (falls back to email) so an operator
  // can't wipe the wrong brand by reflex.
  const wipeExpected = (row.store_name || row.email || "").trim();
  const wipeArmed = wipeConfirm.trim().toLowerCase() === wipeExpected.toLowerCase() && wipeExpected !== "";

  async function wipeBrand() {
    if (!wipeArmed) return;
    setError("");
    setWiping(true);
    try {
      const out = await api.wipeBrand(row.user_id);
      setWipeResult(out);
      onWiped?.(); // refresh the list; the modal stays open showing the result
    } catch (err) {
      setError(err.message);
    } finally {
      setWiping(false);
    }
  }

  const sectionStyle = {
    border: `1px solid ${theme.border}`, borderRadius: 10,
    padding: "14px 16px", background: theme.bg,
  };
  const titleStyle = { fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 4 };
  const hintStyle = { fontSize: 12, color: theme.textMuted, lineHeight: 1.5 };

  return (
    <Modal open={!!row} onClose={onClose} title={`Manage — ${row.store_name || row.email}`} width={520}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Context strip */}
        <div style={{
          fontSize: 12, color: theme.textMuted, display: "flex",
          alignItems: "center", justifyContent: "space-between", gap: 12,
        }}>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {row.email}
          </span>
          <span style={{
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
            fontSize: 10, fontWeight: 600, padding: "2px 6px",
            borderRadius: 4, letterSpacing: 0.4, flexShrink: 0,
            background: isDev ? "#FEF3C7" : "#DCFCE7",
            color: isDev ? "#78350F" : "#14532D",
          }}>
            {isDev ? "DEV" : "PROD"}
          </span>
        </div>

        {/* Startup Programme */}
        <div style={sectionStyle}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14 }}>
            <div style={{ minWidth: 0 }}>
              <div style={titleStyle}>
                Startup Programme
                {enrolled && (
                  <span style={{
                    marginLeft: 8, fontSize: 10, fontWeight: 600, padding: "2px 7px",
                    borderRadius: 9, background: mode === "dark" ? "#0B3A2A" : "#DCFCE7",
                    color: "#10B981", verticalAlign: "middle",
                  }}>ENROLLED</span>
                )}
              </div>
              <div style={hintStyle}>
                Hidden discount: first monthly Growth subscription bills $99/mo for
                3 months, then $199. Only affects brands who haven't subscribed yet —
                flipping it after purchase changes nothing.
              </div>
            </div>
            <Btn
              size="sm"
              variant={enrolled ? "outline" : "solid"}
              onClick={toggleStartup}
              loading={busy}
              style={{ flexShrink: 0 }}
            >
              {enrolled ? "Remove" : "Enroll"}
            </Btn>
          </div>
        </div>

        {/* Trial */}
        <div style={sectionStyle}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14 }}>
            <div style={{ minWidth: 0 }}>
              <div style={titleStyle}>Free trial</div>
              <div style={hintStyle}>
                <TrialSummary row={row} />
                {" "}Granting re-arms the "Start Free Trial" button in the main app.
              </div>
            </div>
            <Btn size="sm" variant="outline" onClick={() => onGrantTrial(row)} style={{ flexShrink: 0 }}>
              Grant trial…
            </Btn>
          </div>
        </div>

        {/* Danger zone — dev only. Hard-wipes the brand + all its data so the
            account can re-onboard from scratch. */}
        {isDev && (
          <div style={{ ...sectionStyle, borderColor: mode === "dark" ? "#5B1717" : "#FECACA" }}>
            <div style={{ ...titleStyle, color: "#EF4444" }}>Danger zone — wipe brand (dev only)</div>
            <div style={hintStyle}>
              Permanently deletes this brand and everything hanging off it —
              campaigns, variants, AI matches, payout settings, and the brand +
              user rows. Irreversible. Use to reset a test account for a clean
              re-onboard.
            </div>
            {wipeResult ? (
              <div style={{
                marginTop: 10, fontSize: 12, color: mode === "dark" ? "#86EFAC" : "#14532D",
                background: mode === "dark" ? "#0B3A2A" : "#DCFCE7",
                border: `1px solid ${mode === "dark" ? "#14532D" : "#BBF7D0"}`,
                padding: "10px 12px", borderRadius: 8,
              }}>
                Wiped <strong>{wipeResult.store_name || wipeResult.email}</strong>.{" "}
                {Object.entries(wipeResult.deleted || {})
                  .filter(([, n]) => n > 0)
                  .map(([t, n]) => `${t}: ${n}`)
                  .join(" · ") || "nothing to delete"}
              </div>
            ) : (
              <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10 }}>
                <input
                  value={wipeConfirm}
                  onChange={(e) => setWipeConfirm(e.target.value)}
                  placeholder={`Type "${wipeExpected}" to confirm`}
                  disabled={wiping}
                  style={{
                    flex: 1, minWidth: 0, fontSize: 12, padding: "8px 10px",
                    borderRadius: 8, border: `1px solid ${theme.border}`,
                    background: theme.surface, color: theme.text,
                  }}
                />
                <Btn
                  size="sm"
                  color="#DC2626"
                  onClick={wipeBrand}
                  loading={wiping}
                  disabled={!wipeArmed}
                  style={{ flexShrink: 0 }}
                >
                  Wipe brand
                </Btn>
              </div>
            )}
          </div>
        )}

        {error && (
          <div style={{
            fontSize: 12, color: "#EF4444",
            background: mode === "dark" ? "#3B1111" : "#FEF2F2",
            border: `1px solid ${mode === "dark" ? "#5B1717" : "#FECACA"}`,
            padding: "10px 12px", borderRadius: 8,
          }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Btn size="md" variant="outline" onClick={onClose}>Close</Btn>
        </div>
      </div>
    </Modal>
  );
}

// One-line current trial state, mirroring deriveTrialState on the page.
function TrialSummary({ row }) {
  const [now] = useState(() => Date.now());
  const activated = row.trial_activation_date && row.trial_activation_date !== "-infinity"
    ? new Date(row.trial_activation_date) : null;
  const expires = row.trial_expiration_date && row.trial_expiration_date !== "-infinity"
    ? new Date(row.trial_expiration_date) : null;

  if (activated && expires && expires.getTime() > now) {
    const daysLeft = Math.max(0, Math.ceil((expires.getTime() - now) / 86_400_000));
    return <>Currently active: {planLabel(row.trial_plan_name || "trial")}, {daysLeft} day{daysLeft === 1 ? "" : "s"} left.</>;
  }
  if (row.trial_plan_name && !activated) {
    return <>Granted ({planLabel(row.trial_plan_name)} · {row.trial_days || 0}d) but not yet activated.</>;
  }
  if (activated && expires) {
    return <>Last trial expired {friendlyDate(row.trial_expiration_date)}.</>;
  }
  return <>No trial on file.</>;
}
