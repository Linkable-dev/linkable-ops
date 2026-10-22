import { useState, useEffect, useCallback } from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { api, friendlyDate } from "../../lib/api";
import { Card } from "../../components/ui/Card";
import { Btn } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Tag } from "../../components/ui/Tag";
import { Skeleton } from "../../components/ui/Skeleton";
import { HelpList, HelpTip } from "../../components/gtm/QueueParts";
import { Avatar, Logo, Who, Banner } from "../../components/pitch/PitchParts";
import { count } from "../../components/pitch/pitchLabels";

// The In review queue (main app QA 112): a creator's first three pitches wait
// here before they go out. Each shows the creator, the pitch as the brand will
// read it, and where it goes. Approve sends it at once through the main app's
// usual send path; Reject asks for a reason, which the creator reads on her
// pitch and by email, and she can edit it and send it again.
//
// Never a link to the brand's proposal (/p/<token>): opening it counts as the
// brand viewing it and emails the creator. Everything it says is shown here.

const PAGE = 10;

const HELP = [
  ["Who is here", "Every creator's first three pitches. After three are approved, hers go out without review. A bounce or a brand reporting her puts her back here."],
  ["Checks", "Every pitch is checked on its own first: a brand contact we can stand behind, a real looking name, an idea and a product, the brand still taking pitches, and no more than two other creators pitching the brand at once. A failed check is shown in red and stops Approve; Approve runs the checks again."],
  ["Flags", "In amber: something to look at, like a name in capitals. A flagged pitch comes here even from a creator past her first three, and you can approve it."],
  ["Contact", "Where the pitch goes. Change it before you approve to send it somewhere else; the address becomes the brand's contact for later pitches too. A brand on Linkable gets the pitch in its Messages, so there is nothing to change."],
  ["Approve", "Sends the pitch now: Messages for a brand on Linkable, otherwise the Lemlist queue like every other pitch, follow ups included."],
  ["Reject", "Asks for the reason. The creator reads it on her pitch and in an email, edits the pitch and sends it again, and it comes back here."],
];

const RESET = { bounce: "Back in review: one of her pitches bounced", complaint: "Back in review: a brand reported her" };

function followers(n) {
  return n ? `${count(n)} followers` : "";
}

function Section({ title, children }) {
  const { theme: t } = useTheme();
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase", color: t.textMuted, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

function Line({ label, children }) {
  const { theme: t } = useTheme();
  if (!children) return null;
  return (
    <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
      <span style={{ color: t.textMuted }}>{label} </span>{children}
    </div>
  );
}

function ReviewCard({ r, onDone, onFailed }) {
  const { theme: t } = useTheme();
  const [contact, setContact] = useState(r.contact_email || "");
  // After a failed Approve the list is reloaded: the field shows the brand's
  // contact as the server has it, not what was typed.
  useEffect(() => { setContact(r.contact_email || ""); }, [r.contact_email]);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);

  const approve = async () => {
    setBusy("approve");
    setError(null);
    try {
      const changed = !r.brand_on_linkable && contact.trim().toLowerCase() !== (r.contact_email || "").toLowerCase();
      const res = await api.approvePitchReview(r.pitch_id, changed ? contact.trim() : "");
      onDone(`${r.creator_name || "The creator"}’s pitch to ${r.brand_name} is approved and ${res.status === "scheduled" ? "going out through Lemlist" : "sent"}.`);
    } catch (e) {
      setError(e.message);
      setContact(r.contact_email || "");
      onFailed();
    }
    finally { setBusy(""); }
  };

  const reject = async () => {
    if (!reason.trim()) { setError("Write the reason the creator will read."); return; }
    setBusy("reject");
    setError(null);
    try {
      await api.rejectPitchReview(r.pitch_id, reason.trim());
      onDone(`${r.creator_name || "The creator"} has your reason and can edit the pitch to ${r.brand_name} and send it again.`);
    } catch (e) { setError(e.message); }
    finally { setBusy(""); }
  };

  const mediaKit = r.creator_media_kit;
  return (
    <Card style={{ padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <Who picture={<Avatar name={r.creator_name} />} title={r.creator_name || r.creator_email}
             sub={[r.creator_handle && `@${r.creator_handle}`, r.creator_email].filter(Boolean).join(" · ")} />
        <span style={{ color: t.textMuted }}>→</span>
        <Who picture={<Logo name={r.brand_name} />} title={r.brand_name} sub={r.brand_domain} />
        <span style={{ marginLeft: "auto", fontSize: 12, color: t.textMuted }}>Sent for review {friendlyDate(r.submitted_at)}</span>
      </div>

      {r.problems.length > 0 && (
        <Banner tone="error">
          {r.problems.length === 1 ? r.problems[0] : r.problems.map((p) => <div key={p}>{p}</div>)}
        </Banner>
      )}
      {(r.flags || []).length > 0 && (
        <Banner tone="warning">
          {r.flags.map((f) => <div key={f}>{f} You can still approve it.</div>)}
        </Banner>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 20 }}>
        <Section title="Creator">
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>
            {[followers(r.creator_followers), r.creator_engagement ? `${r.creator_engagement}% engagement` : ""].filter(Boolean).join(" · ") || "No Instagram stats"}
          </div>
          <Line label="Approved so far">{`${r.creator_reviews_passed} of 3`}</Line>
          <Line label="Pitches sent before">{String(r.creator_pitches_sent)}</Line>
          {RESET[r.creator_review_reset] && <div style={{ fontSize: 13, marginTop: 6, color: t.warning }}>{RESET[r.creator_review_reset]}</div>}
          <div style={{ fontSize: 13, marginTop: 10, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
            {r.creator_about || <span style={{ color: t.danger }}>No About</span>}
          </div>
          {mediaKit && (
            /^https?:\/\//.test(mediaKit)
              ? <div style={{ marginTop: 10 }}><Btn size="sm" variant="secondary" href={mediaKit} target="_blank">Media kit</Btn></div>
              : <Line label="Media kit">{mediaKit}</Line>
          )}
        </Section>

        <Section title="The pitch, as the brand reads it">
          <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.4 }}>{r.idea || <span style={{ color: t.danger }}>No idea title</span>}</div>
          <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{r.idea_description}</div>
          {r.product_title && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
              {r.product_image && <img src={r.product_image} alt="" style={{ width: 40, height: 40, borderRadius: 8, objectFit: "cover", border: `1px solid ${t.border}` }} />}
              <div style={{ fontSize: 13, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{r.product_title}</div>
                {r.product_url && <div style={{ marginTop: 4 }}><Btn size="sm" variant="secondary" href={r.product_url} target="_blank">Product page</Btn></div>}
              </div>
            </div>
          )}
          <Line label="She offers">{r.offers}</Line>
          <Line label="In return">{r.asks}</Line>
        </Section>

        <Section title="Where it goes">
          {r.brand_on_linkable ? (
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>
              {r.brand_name} is on Linkable: the pitch lands in its Messages{r.contact_email ? ` and ${r.contact_email} gets an email` : ""}.
            </div>
          ) : (
            <>
              <Input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Found when it goes out" aria-label="Contact email" />
              <div style={{ marginTop: 8 }}>
                {r.contact_email
                  ? (r.contact_verified ? <Tag color="#16A34A">Verified</Tag> : <Tag color="#B45309">Not verified</Tag>)
                  : <span style={{ fontSize: 12, color: t.textMuted }}>No address yet: the main app looks one up and checks it before sending. Type one to choose it yourself.</span>}
              </div>
            </>
          )}
        </Section>
      </div>

      {error && <div style={{ marginTop: 16 }}><Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner></div>}

      {rejecting && (
        <div style={{ marginTop: 16 }}>
          <Input multiline rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500}
                 placeholder="What she should change. She reads this on her pitch and in an email." aria-label="Reason" />
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        {rejecting ? <>
          <Btn variant="secondary" onClick={() => { setRejecting(false); setReason(""); setError(null); }} disabled={!!busy}>Cancel</Btn>
          <Btn variant="danger" onClick={reject} loading={busy === "reject"}>Reject with this reason</Btn>
        </> : <>
          <Btn variant="secondary" onClick={() => setRejecting(true)} disabled={!!busy}>Reject</Btn>
          <Btn onClick={approve} loading={busy === "approve"}>Approve and send</Btn>
        </>}
      </div>
    </Card>
  );
}

export default function PitchReviewPage() {
  const { theme: t } = useTheme();
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
      const r = await api.getPitchReviews({ limit: PAGE, offset });
      setAvailable(r.available);
      setReason(r.reason || "");
      setRows(r.items || []);
      setTotal(r.total || 0);
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [offset]);
  useEffect(() => { load(); }, [load]);

  const done = (message) => {
    setNotice(message);
    // The last card of the last page: step back a page (that reloads).
    if (rows.length === 1 && offset > 0) setOffset(Math.max(0, offset - PAGE));
    else load();
  };

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE, total);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>
          {loading ? "Pitches waiting for review" : `${total} ${total === 1 ? "pitch" : "pitches"} waiting for review`}
        </div>
        <HelpTip title="In review"><HelpList items={HELP} /></HelpTip>
        <Btn size="sm" variant="secondary" style={{ marginLeft: "auto" }} onClick={load} disabled={loading}>Refresh</Btn>
      </div>

      {!available && <Banner tone="warning">{reason || "Pitch review isn't available on this server."}</Banner>}
      {notice && <Banner onDismiss={() => setNotice(null)}>{notice}</Banner>}
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}

      {loading && rows.length === 0 && [0, 1].map((i) => (
        <Card key={i} style={{ padding: 20 }}>
          <Skeleton width={320} height={16} />
          <div style={{ marginTop: 16 }}><Skeleton width="100%" height={80} /></div>
        </Card>
      ))}
      {!loading && available && rows.length === 0 && (
        <Card style={{ padding: 20, color: t.textMuted, fontSize: 13 }}>Nothing waiting. New first pitches show up here as creators send them.</Card>
      )}
      {rows.map((r) => <ReviewCard key={r.pitch_id} r={r} onDone={done} onFailed={load} />)}

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
