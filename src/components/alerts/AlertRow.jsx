import { Link } from "react-router-dom";
import { friendlyDate } from "../../lib/api";
import { SEVERITY } from "../../lib/alerts";
import { BrandLink } from "../brand/BrandLink";

// One alert line, shared by the Alerts page and the Home "Needs attention" strip.
export function AlertRow({ alert: a, theme, isLast, snoozed, onSnooze, compact = false }) {
  const sev = SEVERITY[a.severity] || SEVERITY.info;
  return (
    <div style={{ display: "flex", gap: 14, alignItems: "flex-start", padding: compact ? "10px 14px" : "14px 16px", borderBottom: isLast ? "none" : `1px solid ${theme.border}`, opacity: snoozed ? 0.55 : 1 }}>
      <span title={sev.label} style={{ width: 8, height: 8, borderRadius: "50%", background: sev.color, flexShrink: 0, marginTop: 6 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>{a.title}</span>
          {a.brand && (
            <BrandLink userId={a.brand.user_id} style={{ fontSize: 13, color: theme.textMid }}>{a.brand.store_name || a.brand.email}</BrandLink>
          )}
          {a.campaign && !compact && <span style={{ fontSize: 12, color: theme.textMuted }}>· {a.campaign.title}</span>}
        </div>
        {!compact && <div style={{ fontSize: 12, color: theme.textMid, marginTop: 3, lineHeight: 1.5 }}>{a.detail}</div>}
      </div>
      <div style={{ textAlign: "right", flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
        <span style={{ fontSize: 11, color: theme.textMuted, whiteSpace: "nowrap" }}>{a.since ? friendlyDate(a.since) : ""}</span>
        {!compact && (
          <div style={{ display: "flex", gap: 6 }}>
            {a.href && <Link to={a.href} style={{ fontSize: 12, color: theme.textMid }}>Open</Link>}
            {onSnooze && (snoozed
              ? <button onClick={() => onSnooze(a.key, 0)} style={linkBtn(theme)}>Unsnooze</button>
              : <button onClick={() => onSnooze(a.key, 7)} style={linkBtn(theme)} title="Hide for 7 days on this browser">Snooze 7d</button>)}
          </div>
        )}
      </div>
    </div>
  );
}
const linkBtn = (theme) => ({ background: "none", border: "none", padding: 0, color: theme.textMuted, fontSize: 12, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" });
