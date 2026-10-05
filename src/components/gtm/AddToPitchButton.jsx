import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTheme } from "../../contexts/ThemeContext";
import { getDbTarget } from "../../contexts/DbTargetContext";
import { api } from "../../lib/api";
import { Btn } from "../ui/Button";
import { Modal } from "../ui/Modal";

// "Add to Pitch" on a GTM brand: sends the lead to Pitch brands on the
// database the admin picks (dev or prod), whichever one the header points at.
// Pitch reads the store itself; this only says which brand. The store address
// is sent when the lead has one (the surest way to the store), else the handle.
export function AddToPitchButton({ lead }) {
  const { theme: t } = useTheme();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(getDbTarget() === "dev" ? "dev" : "prod");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(null);

  const input = lead.domain || `@${lead.handle}`;
  const email = lead.contact_email && lead.contact_email.includes("@") ? lead.contact_email : "";

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.addPitchBrand({ input, contact_email: email }, target);
      setSent(target);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const close = () => { setOpen(false); setError(null); setSent(null); };

  const option = (value, label, hint) => (
    <label key={value} style={{
      display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", borderRadius: 8, cursor: "pointer",
      border: `1.5px solid ${target === value ? t.text : t.border}`, flex: 1,
    }}>
      <input type="radio" name="pitch-target" checked={target === value} onChange={() => setTarget(value)} style={{ marginTop: 3 }} />
      <span>
        <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: t.text }}>{label}</span>
        <span style={{ display: "block", fontSize: 12, color: t.textMuted }}>{hint}</span>
      </span>
    </label>
  );

  return (
    <>
      <Btn size="sm" variant="secondary" onClick={() => setOpen(true)}>Add to Pitch</Btn>
      <Modal open={open} onClose={close} title="Add to Pitch" width={460}>
        {sent ? (
          <>
            <p style={{ margin: "0 0 16px", fontSize: 13, color: t.textMid }}>
              Sent to Pitch on {sent}. Linkable reads the store and follower counts now, and the brand appears on Pitch brands in a few seconds.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              {sent === getDbTarget() && <Btn size="sm" variant="secondary" onClick={() => navigate("/ops/pitch/brands")}>Open Pitch brands</Btn>}
              <Btn size="sm" onClick={close}>Done</Btn>
            </div>
          </>
        ) : (
          <>
            <p style={{ margin: "0 0 12px", fontSize: 13, color: t.textMid }}>
              Creators will be able to pitch <strong style={{ color: t.text }}>{lead.brand_name || lead.full_name || `@${lead.handle}`}</strong> ({input}).
              {email ? ` Their contact goes as ${email}.` : " Linkable looks for a contact email on the store."}
            </p>
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              {option("dev", "Dev", "Test it first")}
              {option("prod", "Prod", "Real creators can pitch it")}
            </div>
            {error && <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 8, background: "#FEF2F2", color: "#B91C1C", fontSize: 13 }}>{error}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Btn size="sm" variant="outline" onClick={close}>Cancel</Btn>
              <Btn size="sm" loading={busy} disabled={busy} onClick={send}>Add to Pitch on {target}</Btn>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
