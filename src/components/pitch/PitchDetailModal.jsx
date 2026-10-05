import { useEffect, useState } from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { api } from "../../lib/api";
import { Modal } from "../ui/Modal";
import { Tag } from "../ui/Tag";
import { Avatar, Logo, Who, Banner } from "./PitchParts";
import { pitchStatus, pitchTerms, eventLabel, eventNote, when, CHANNEL_LABEL } from "./pitchLabels";

// One pitch, whole: who sent it to whom, the email, the proposal's terms,
// the brand's replies, and every step in order.
//
// There is no link to the proposal page on purpose: service-grpc counts any
// browser visit to /p/<token> as the brand viewing it, moves the pitch to
// Viewed and emails the creator. What the proposal says is shown here.

const COLLAB = { share: "Create and share", content: "Create content only" };

export function PitchDetailModal({ id, onClose }) {
  const [title, setTitle] = useState("Pitch");
  return (
    <Modal open={!!id} onClose={onClose} title={title} width={820}>
      {/* Keyed by the pitch, so opening another starts from empty. */}
      {id && <PitchLoader key={id} id={id} onTitle={setTitle} />}
    </Modal>
  );
}

function PitchLoader({ id, onTitle }) {
  const { theme: t } = useTheme();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [showIgnored, setShowIgnored] = useState(false);

  useEffect(() => {
    let live = true;
    api.getPitch(id)
      .then((r) => {
        if (!live) return;
        setData(r);
        onTitle(`${r.pitch.creator_name || r.pitch.creator_email} → ${r.pitch.brand_name}`);
      })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; onTitle("Pitch"); };
  }, [id, onTitle]);

  if (error) return <Banner tone="error">{error}</Banner>;
  if (!data) return <div style={{ fontSize: 13, color: t.textMuted, padding: "24px 0" }}>Loading the pitch…</div>;
  return <PitchBody p={data.pitch} events={data.events} replies={data.replies} showIgnored={showIgnored} setShowIgnored={setShowIgnored} />;
}

function PitchBody({ p, events, replies, showIgnored, setShowIgnored }) {
  const { theme: t } = useTheme();
  const s = pitchStatus(p);
  const ignored = events.filter((e) => e.event === "view_ignored").length;
  const timeline = showIgnored ? events : events.filter((e) => e.event !== "view_ignored");
  const lemlistSteps = events.filter((e) => /^lemlist_step_\d+_sent$/.test(e.event)).length;
  const followUps = events.filter((e) => /^followup_\d_sent$/.test(e.event)).length;

  const section = { fontSize: 11, fontWeight: 700, color: t.textMuted, textTransform: "uppercase", letterSpacing: 0.8, margin: "22px 0 10px" };
  const box = { background: t.surfaceAlt, borderRadius: 10, padding: "12px 14px", fontSize: 13, color: t.text, lineHeight: 1.55 };
  const muted = { color: t.textMuted };

  const facts = [
    ["Sent", p.sent_at ? when(p.sent_at) : "Not sent"],
    ["Sent to", p.sent_to ? [p.sent_to, [p.contact_name, p.contact_role].filter(Boolean).join(", ")].filter(Boolean).join(" · ") : "—"],
    ["Proposal views", p.view_count ? `${p.view_count} · first ${when(p.first_viewed_at)}${p.view_count > 1 ? ` · last ${when(p.last_viewed_at)}` : ""}` : "None yet"],
    ["Replied", p.replied_at ? when(p.replied_at) : "No"],
    ["Follow ups", p.delivery === "lemlist"
      ? `${lemlistSteps} of 3 Lemlist emails sent`
      : p.auto_follow_up ? `${followUps} sent, automatic` : followUps ? `${followUps} sent` : "Off"],
    ["Accepted", p.accepted_at ? when(p.accepted_at) : p.accept_started_at ? `Started ${when(p.accept_started_at)}` : "No"],
    ["Trial", p.trial_started_at ? `Started ${when(p.trial_started_at)}` : "—"],
    ["Paying", p.brand_paid_at ? `Since ${when(p.brand_paid_at)}` : "—"],
  ];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <Who picture={<Avatar src={p.creator_avatar} name={p.creator_name} size={40} />}
               title={p.creator_name || p.creator_email}
               sub={[p.creator_instagram && `@${p.creator_instagram}`, p.creator_email].filter(Boolean).join(" · ")} />
        </div>
        <span style={{ color: t.textMuted, fontSize: 18 }} aria-hidden="true">→</span>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <Who picture={<Logo src={p.brand_logo} name={p.brand_name} size={40} />}
               title={p.brand_name} sub={p.brand_domain} subHref={`https://${p.brand_domain}`} />
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, marginTop: 14 }}>
        <Tag color={s.color}>{s.label}</Tag>
        {p.replied_at && <Tag color="#059669">Replied</Tag>}
        {p.channel && <Tag color="#50576B">{CHANNEL_LABEL[p.channel] || p.channel}</Tag>}
        {p.sandboxed && <Tag color="#B45309">Test send</Tag>}
        {p.brand_on_linkable && <Tag color="#2563EB">Brand on Linkable</Tag>}
        <Tag color="#737C9A">{`Tier ${p.tier}${p.bonus ? " · bonus" : ""}`}</Tag>
        {s.note && <span style={{ fontSize: 12, color: t.textMid, marginLeft: 4 }}>{s.note}</span>}
      </div>
      {p.sandboxed && <div style={{ fontSize: 12, ...muted, marginTop: 8 }}>Sent on dev, so it went to a tester instead of the brand.</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px 20px", marginTop: 18 }}>
        {facts.map(([k, v]) => (
          <div key={k} style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, ...muted }}>{k}</div>
            <div style={{ fontSize: 13, color: t.text, overflowWrap: "anywhere" }}>{v}</div>
          </div>
        ))}
      </div>

      <div style={section}>{p.sent_at ? "The email" : "The email, as drafted"}</div>
      {p.subject || p.body ? (
        <div style={box}>
          {p.subject && <div style={{ fontWeight: 600, marginBottom: 8 }}>{p.subject}</div>}
          <div style={{ whiteSpace: "pre-wrap" }}>{p.body || <span style={muted}>No message</span>}</div>
        </div>
      ) : <div style={{ fontSize: 13, ...muted }}>Not written yet.</div>}

      <div style={section}>The proposal</div>
      <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
        {p.product?.image_url && (
          <img src={p.product.image_url} alt="" style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 10, border: `1px solid ${t.border}`, background: "#fff", flexShrink: 0 }} />
        )}
        <div style={{ flex: "1 1 300px", minWidth: 0, fontSize: 13, lineHeight: 1.55 }}>
          {p.idea && <div style={{ fontWeight: 600, marginBottom: 4 }}>{p.idea}</div>}
          {(p.proposal_idea || p.idea_description) && <div style={{ color: t.textMid, marginBottom: 10 }}>{p.proposal_idea || p.idea_description}</div>}
          <div style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 14px" }}>
            {p.product?.title && <>
              <span style={muted}>Product</span>
              <span>
                {p.product.url
                  ? <a href={p.product.url} target="_blank" rel="noopener noreferrer" style={{ color: t.text }}>{p.product.title}</a>
                  : p.product.title}
                {p.product.price && <span style={muted}> · {p.product.price}</span>}
              </span>
            </>}
            {p.collab_mode && <><span style={muted}>Collaboration</span><span>{COLLAB[p.collab_mode] || p.collab_mode}</span></>}
            {Array.isArray(p.deliverables) && p.deliverables.length > 0 && <><span style={muted}>Deliverables</span><span>{p.deliverables.join(" · ")}</span></>}
            <span style={muted}>In return</span><span>{pitchTerms(p)}</span>
          </div>
        </div>
      </div>
      <div style={{ fontSize: 12, ...muted, marginTop: 10 }}>
        The proposal page isn't linked here: opening it would count as the brand viewing it and email the creator.
      </div>

      {replies.length > 0 && <>
        <div style={section}>Replies</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {replies.map((r) => (
            <div key={r.id} style={box}>
              <div style={{ fontSize: 12, ...muted, marginBottom: 6 }}>
                {r.direction === "brand" ? "Brand" : "Creator"}{r.from_email ? ` · ${r.from_email}` : ""} · {when(r.received_at)}
              </div>
              {r.subject && <div style={{ fontWeight: 600, marginBottom: 6 }}>{r.subject}</div>}
              <div style={{ whiteSpace: "pre-wrap" }}>{r.body}</div>
            </div>
          ))}
        </div>
      </>}

      {p.accept_started_at && <>
        <div style={section}>Accepting</div>
        <div style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 14px", fontSize: 13 }}>
          {p.accept_email && <><span style={muted}>Email</span><span>{p.accept_email}</span></>}
          {p.accept_store_url && <><span style={muted}>Store</span><span>{p.accept_store_url}</span></>}
          {p.accept_shop_domain && <><span style={muted}>Shopify</span><span>{p.accept_shop_domain}</span></>}
          {p.accept_commission != null && <><span style={muted}>Commission</span><span>{p.accept_commission}%</span></>}
          {p.brand_account_email && <><span style={muted}>Brand account</span><span>{p.brand_account_email}</span></>}
          {p.product_id && <><span style={muted}>Campaign</span><span>{p.product_id}</span></>}
          {p.completion_note && <><span style={muted}>Note</span><span>{p.completion_note}</span></>}
        </div>
      </>}

      {p.delivery === "lemlist" && <>
        <div style={section}>Lemlist</div>
        <div style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 14px", fontSize: 13 }}>
          <span style={muted}>State</span><span>{p.lemlist_state || "—"}{p.lemlist_attempts ? ` · ${p.lemlist_attempts} contact ${p.lemlist_attempts === 1 ? "try" : "tries"}` : ""}</span>
          {p.lemlist_error && <><span style={muted}>Problem</span><span style={{ color: t.danger }}>{p.lemlist_error}</span></>}
          {p.lemlist_enrolled_at && <><span style={muted}>Enrolled</span><span>{when(p.lemlist_enrolled_at)}</span></>}
          {p.lemlist_last_step_at && <><span style={muted}>Last email</span><span>{when(p.lemlist_last_step_at)}</span></>}
          {p.lemlist_ended_at && <><span style={muted}>Ended</span><span>{when(p.lemlist_ended_at)}</span></>}
          {p.lemlist_lead_id && <><span style={muted}>Lead</span><span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{p.lemlist_lead_id}</span></>}
          {p.brand_contact_source && <><span style={muted}>Contact from</span><span>{p.brand_contact_source.replace(/_/g, " ")}</span></>}
          {p.brand_contact_bounced?.length > 0 && <><span style={muted}>Bounced</span><span>{p.brand_contact_bounced.join(", ")}</span></>}
        </div>
      </>}

      <div style={{ ...section, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span>Timeline</span>
        {ignored > 0 && (
          <button onClick={() => setShowIgnored((v) => !v)} style={{ border: "none", background: "transparent", color: t.textMid, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600, textTransform: "none", letterSpacing: 0, padding: 0 }}>
            {showIgnored ? "Hide" : "Show"} {ignored} uncounted {ignored === 1 ? "visit" : "visits"}
          </button>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {timeline.map((e) => {
          const note = eventNote(e);
          const quiet = e.event === "view_ignored";
          return (
            <div key={e.id} style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 12, padding: "6px 0", borderBottom: `1px solid ${t.border}`, fontSize: 13, color: quiet ? t.textMuted : t.text }}>
              <span style={{ color: t.textMuted, whiteSpace: "nowrap" }}>{when(e.created)}</span>
              <span>{eventLabel(e)}{note && <span style={{ color: t.textMuted }}> · {note}</span>}</span>
            </div>
          );
        })}
        {timeline.length === 0 && <div style={{ fontSize: 13, ...muted }}>Nothing recorded yet.</div>}
      </div>
    </div>
  );
}
