import { useState, useEffect, useCallback } from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { api, friendlyDate } from "../../lib/api";
import { Card } from "../../components/ui/Card";
import { Btn } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Tag } from "../../components/ui/Tag";
import { Skeleton } from "../../components/ui/Skeleton";
import { HelpList, HelpTip } from "../../components/gtm/QueueParts";
import { Avatar, Who, Banner } from "../../components/pitch/PitchParts";
import { partnerAccount, PARTNER_QUEUES } from "../../components/pitch/pitchLabels";

// Pitch Partners (main app QA 132): creators who promote Pitch. They apply
// with their main account and what they would post; Approve gives them 30
// days of Pitch Pro and their partner link. Once they paste their video's
// link, check it is live: Live adds 2 more months (3 in all), Not found sends
// it back with the reason. Everything goes through the main app.

const PAGE = 10;

const HELP = [
  ["Applications", "Creators who want to promote Pitch: their main account, what they would post, and whether they let Linkable reuse the video (they must, to apply). We tell them we reply within 2 days."],
  ["Approve", "Gives her 30 days of Pitch Pro and her link. Creators who sign up with it get their first month of Pitch Pro free with a card; she earns 50% of every Pitch Pro payment they make for 12 months. Brands opening the same link still get 60 days free and her 30%."],
  ["Reject", "Asks for the reason. She reads it by email and on her Pitch Partners page, and can apply again."],
  ["Videos", "Open the link and check the video is live and pitches a brand with Linkable. Live adds 2 more months of Pitch Pro, 3 in all. Not found sends it back with your reason; she can paste another link."],
  ["Paid Pitch Pro", "A partner already paying for Pitch Pro keeps her plan: its next payment moves to the end of the free months. A Founding Creator keeps Founding."],
];

function ApplicationCard({ r, queue, onDone, onFailed }) {
  const { theme: t } = useTheme();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const account = partnerAccount(r);
  const isVideo = queue === "videos";

  const act = async (decision) => {
    if (decision === "reject" && !reason.trim()) { setError("Write the reason the creator will read."); return; }
    setBusy(decision);
    setError(null);
    try {
      const res = isVideo
        ? await api.verifyPitchPartnerVideo(r.user_id, decision, reason.trim())
        : await api.decidePitchPartner(r.user_id, decision, reason.trim());
      const name = r.name || r.email;
      const until = res.pro_until ? ` Pitch Pro until ${friendlyDate(res.pro_until)}.` : "";
      onDone(
        decision === "reject"
          ? `${name} has your reason${isVideo ? " and can paste another link" : " and can apply again"}.`
          : isVideo ? `${name}’s video is live.${until}` : `${name} is a Pitch Partner.${until}`,
      );
    } catch (e) { setError(e.message); onFailed(); }
    finally { setBusy(""); }
  };

  return (
    <Card style={{ padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <Who picture={<Avatar name={r.name} />} title={r.name || r.email} sub={r.email} />
        <span style={{ marginLeft: "auto", fontSize: 12, color: t.textMuted }}>
          {isVideo ? `Video sent ${friendlyDate(r.video_submitted_at)}` : `Applied ${friendlyDate(r.applied_at)}`}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 20 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase", color: t.textMuted, marginBottom: 8 }}>Main account</div>
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>{account.line || <span style={{ color: t.danger }}>No Instagram or TikTok connected</span>}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            {account.links.map((l) => <Btn key={l.href} size="sm" variant="secondary" href={l.href} target="_blank">{l.label}</Btn>)}
          </div>
          {r.status === "approved" && (
            <div style={{ fontSize: 13, marginTop: 10, lineHeight: 1.5, color: t.textMuted }}>
              {[r.pro_until && `Pitch Pro until ${friendlyDate(r.pro_until)}`, `${r.signups} signed up`, `${r.on_pro} on Pitch Pro`].filter(Boolean).join(" · ")}
            </div>
          )}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase", color: t.textMuted, marginBottom: 8 }}>What she would post</div>
          <div style={{ fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{r.post_idea}</div>
          <div style={{ marginTop: 8 }}>
            {r.usage_rights ? <Tag color="#16A34A">Video reuse agreed</Tag> : <Tag color="#B45309">No reuse agreed</Tag>}
          </div>
        </div>
        {(isVideo || r.video_url) && (
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase", color: t.textMuted, marginBottom: 8 }}>Her video</div>
            {r.video_url && <Btn size="sm" variant="secondary" href={r.video_url} target="_blank">Open the video</Btn>}
            <div style={{ fontSize: 12, marginTop: 8, color: t.textMuted, wordBreak: "break-all" }}>{r.video_url}</div>
            {r.video_status === "verified" && <div style={{ marginTop: 8 }}><Tag color="#16A34A">Live</Tag></div>}
            {r.video_status === "rejected" && r.video_note && <div style={{ fontSize: 13, marginTop: 8 }}>Sent back: {r.video_note}</div>}
          </div>
        )}
      </div>

      {r.status === "rejected" && r.reject_reason && (
        <div style={{ fontSize: 13, marginTop: 16, color: t.textMuted }}>
          Rejected {friendlyDate(r.decided_at)}{r.decided_by ? ` by ${r.decided_by}` : ""}: {r.reject_reason}
        </div>
      )}

      {error && <div style={{ marginTop: 16 }}><Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner></div>}

      {(queue === "applications" || isVideo) && (
        <>
          {rejecting && (
            <div style={{ marginTop: 16 }}>
              <Input multiline rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500}
                     placeholder={isVideo ? "Why it isn't accepted, e.g. the account is private. She reads this." : "Why not, in a sentence she reads by email."}
                     aria-label="Reason" />
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            {rejecting ? <>
              <Btn variant="secondary" onClick={() => { setRejecting(false); setReason(""); setError(null); }} disabled={!!busy}>Cancel</Btn>
              <Btn variant="danger" onClick={() => act("reject")} loading={busy === "reject"}>
                {isVideo ? "Send back with this reason" : "Reject with this reason"}
              </Btn>
            </> : <>
              <Btn variant="secondary" onClick={() => setRejecting(true)} disabled={!!busy}>{isVideo ? "Not found" : "Reject"}</Btn>
              <Btn onClick={() => act(isVideo ? "verify" : "approve")} loading={!!busy}>
                {isVideo ? "Live: add 2 months" : "Approve: 30 days of Pitch Pro"}
              </Btn>
            </>}
          </div>
        </>
      )}
    </Card>
  );
}

export default function PitchPartnersPage() {
  const { theme: t } = useTheme();
  const [queue, setQueue] = useState("applications");
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [available, setAvailable] = useState(true);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getPitchPartners({ queue, limit: PAGE, offset });
      setAvailable(r.available);
      setReason(r.reason || "");
      setRows(r.items || []);
      setTotal(r.total || 0);
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [queue, offset]);
  useEffect(() => { load(); }, [load]);

  const done = (message) => {
    setNotice(message);
    if (rows.length === 1 && offset > 0) setOffset(Math.max(0, offset - PAGE));
    else load();
  };
  const current = PARTNER_QUEUES.find((q) => q.value === queue) || PARTNER_QUEUES[0];
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE, total);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 6 }}>
          {PARTNER_QUEUES.map((q) => (
            <Btn key={q.value} size="sm" variant={q.value === queue ? "solid" : "secondary"}
                 onClick={() => { setQueue(q.value); setOffset(0); setNotice(null); }}>
              {q.label}
            </Btn>
          ))}
        </div>
        <HelpTip title="Pitch Partners"><HelpList items={HELP} /></HelpTip>
        <Btn size="sm" variant="secondary" style={{ marginLeft: "auto" }} onClick={load} disabled={loading}>Refresh</Btn>
      </div>

      {!available && <Banner tone="warning">{reason || "Pitch Partners isn't available on this server."}</Banner>}
      {notice && <Banner onDismiss={() => setNotice(null)}>{notice}</Banner>}
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}

      {!loading && <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 10 }}>{current.count(total)}</div>}
      {loading && rows.length === 0 && [0, 1].map((i) => (
        <Card key={i} style={{ padding: 20 }}>
          <Skeleton width={320} height={16} />
          <div style={{ marginTop: 16 }}><Skeleton width="100%" height={80} /></div>
        </Card>
      ))}
      {!loading && available && rows.length === 0 && (
        <Card style={{ padding: 20, color: t.textMuted, fontSize: 13 }}>{current.empty}</Card>
      )}
      {rows.map((r) => <ApplicationCard key={r.user_id} r={r} queue={queue} onDone={done} onFailed={load} />)}

      {total > PAGE && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, fontSize: 12, color: t.textMuted }}>
          <span>{`${pageStart}–${pageEnd} of ${total}`}</span>
          <div style={{ display: "flex", gap: 6 }}>
            <Btn size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Btn>
            <Btn size="sm" variant="secondary" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</Btn>
          </div>
        </div>
      )}
    </div>
  );
}
