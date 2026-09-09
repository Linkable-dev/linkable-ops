// Read-and-send dialog for the nudge behind one alert.
//
// Claude writes the first version from the alert's own context; the operator
// is the one who decides it goes. Both fields stay editable and the recipient
// is shown, because "sends email to a customer" is not a button anybody should
// press blind. The server re-derives the recipient from the alert regardless
// of what this component holds.

import { useEffect, useState } from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { api, friendlyDate } from "../../lib/api";
import { Modal } from "../ui/Modal";
import { Btn } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";
import { SEVERITY } from "../../lib/alerts";

export default function NudgeModal({ alert, onClose, onSent }) {
  const { theme } = useTheme();
  const [draft, setDraft] = useState(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [alsoDone, setAlsoDone] = useState(true);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

  const load = () => {
    setError(""); setDraft(null);
    api.draftNudge(alert.key)
      .then((d) => { setDraft(d); setSubject(d.subject); setBody(d.body); })
      .catch((e) => setError(e.message));
  };

  useEffect(load, [alert.key]);

  const send = async () => {
    setSending(true); setError("");
    try {
      const res = await api.sendNudge({ key: alert.key, subject, body, alsoDone });
      onSent(res.to);
    } catch (e) { setError(e.message); }
    finally { setSending(false); }
  };

  const sev = SEVERITY[alert.severity] || SEVERITY.info;
  const label = { fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textMuted, marginBottom: 5 };
  const field = {
    width: "100%", boxSizing: "border-box", background: theme.bg, color: theme.text,
    border: `1px solid ${theme.border}`, borderRadius: 8, fontFamily: "inherit",
    fontSize: 13, padding: "9px 11px", outline: "none",
  };
  const ready = draft && subject.trim() && body.trim();

  return (
    <Modal open onClose={sending ? () => {} : onClose} title="Send a nudge" width={620}>
      {/* What this is about, so the draft can be judged against the situation. */}
      <div style={{ display: "flex", gap: 10, padding: "10px 12px", borderRadius: 10, background: theme.surfaceAlt, marginBottom: 16 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: sev.color, flexShrink: 0, marginTop: 5 }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>{alert.title}</div>
          <div style={{ fontSize: 12, color: theme.textMid, marginTop: 2, lineHeight: 1.45 }}>{alert.detail}</div>
        </div>
      </div>

      {alert.nudge && (
        <div style={{ fontSize: 12, color: theme.textMid, background: theme.surfaceAlt, border: `1px solid ${theme.border}`, borderRadius: 8, padding: "8px 11px", marginBottom: 14 }}>
          Already nudged {friendlyDate(alert.nudge.at)}{alert.nudge.by ? ` by ${alert.nudge.by}` : ""}. Send again only if something has changed.
        </div>
      )}

      {draft?.warning && (
        <div style={{ fontSize: 12, color: theme.text, background: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: 8, padding: "8px 11px", marginBottom: 14 }}>
          {draft.warning}
        </div>
      )}

      {error && (
        <div style={{ fontSize: 13, color: theme.danger, border: "1px solid #FCA5A5", borderRadius: 8, padding: "9px 11px", marginBottom: 14 }}>
          {error}
        </div>
      )}

      {!draft && !error ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 12, color: theme.textMuted }}>Writing the draft…</div>
          <Skeleton width="55%" height={13} />
          <Skeleton width="100%" height={92} radius={8} />
        </div>
      ) : draft ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
            <div>
              <div style={label}>To</div>
              <div style={{ fontSize: 13, color: theme.text, overflow: "hidden", textOverflow: "ellipsis" }}>
                {draft.to}
                {draft.toName && <span style={{ color: theme.textMuted }}> · {draft.toName}</span>}
              </div>
            </div>
            <div>
              <div style={label}>From</div>
              <div style={{ fontSize: 13, color: theme.textMid, overflow: "hidden", textOverflow: "ellipsis" }}>{draft.from}</div>
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={label}>Subject</div>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} style={field} />
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={label}>Message</div>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={12}
              style={{ ...field, resize: "vertical", lineHeight: 1.55, minHeight: 200 }}
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: theme.textMid, cursor: "pointer" }}>
              <input type="checkbox" checked={alsoDone} onChange={(e) => setAlsoDone(e.target.checked)} />
              mark the alert done
            </label>
            <span style={{ fontSize: 11, color: theme.textMuted }}>
              {draft.costUsd != null && `drafted for $${draft.costUsd.toFixed(3)}`}
            </span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <Btn size="sm" variant="secondary" onClick={load} disabled={sending}>Rewrite</Btn>
              <Btn size="sm" variant="outline" onClick={onClose} disabled={sending}>Cancel</Btn>
              <Btn size="sm" onClick={send} loading={sending} disabled={!ready}>Send</Btn>
            </div>
          </div>
        </>
      ) : (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn size="sm" variant="outline" onClick={onClose}>Close</Btn>
          <Btn size="sm" onClick={load}>Try again</Btn>
        </div>
      )}
    </Modal>
  );
}
