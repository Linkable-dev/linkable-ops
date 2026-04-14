export function SlackNotification({ lead, onDismiss }) {
  return (
    <div style={{ background: "#4A154B", borderRadius: 10, padding: "14px 18px", marginBottom: 12, display: "flex", alignItems: "flex-start", gap: 12 }}>
      <div style={{ fontSize: 20, flexShrink: 0 }}>&#x1F514;</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", marginBottom: 3 }}>Slack · #outbound-replies</div>
        <div style={{ fontSize: 13, color: "#e8d5e9" }}>
          <strong style={{ color: "#fff" }}>{lead.name}</strong> at <strong style={{ color: "#fff" }}>{lead.company}</strong> replied positively via {lead.channel}. Action required.
        </div>
      </div>
      <button onClick={onDismiss} style={{ background: "none", border: "none", color: "#e8d5e9", cursor: "pointer", fontSize: 16 }}>x</button>
    </div>
  );
}
