import { useState, useEffect, useCallback, useRef } from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { api, friendlyDate } from "../../lib/api";
import { Card } from "../../components/ui/Card";
import { Btn } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Tag } from "../../components/ui/Tag";
import { Skeleton } from "../../components/ui/Skeleton";
import { HelpList, HelpTip } from "../../components/gtm/QueueParts";
import { Avatar, Logo, Who, Banner } from "../../components/pitch/PitchParts";
import { reviewAccount, reviewProfiles } from "../../components/pitch/pitchLabels";
import { SocialIcon } from "../../components/ui/SocialIcon";

// The In review queue (main app QA 112): a creator's first three pitches wait
// here before they go out. Each shows the creator, the pitch as the brand will
// read it, and where it goes. Approve sends it at once through the main app's
// usual send path; Reject asks for a reason, which the creator reads on her
// pitch and by email, and she can edit it and send it again.
//
// Never a link to the brand's proposal (/p/<token>): opening it counts as the
// brand viewing it and emails the creator. View as brand (QA 122) opens the
// main app's read-only copy of that page instead, by a link the main app
// signed for an hour when it listed the queue (brand_view_url). The links
// stay fresh: the list is read again once it is STALE_MS old (checked every
// few minutes and when the tab comes back), and a click on a link older than
// that reads the list first and opens the new one.

// The View as brand links work for an hour; past this, read the queue again.
const STALE_MS = 45 * 60 * 1000;
const STALE_CHECK_MS = 5 * 60 * 1000;

const PAGE = 10;

const HELP = [
  ["Who is here", "Every creator's first three pitches. After three are approved, hers go out without review. A bounce or a brand reporting her puts her back here."],
  ["Checks", "Every pitch is checked on its own first: a brand contact we can stand behind, a real looking name, an idea and a product, the brand still taking pitches, and no more than two other creators pitching the brand at once. A failed check is shown in red and stops Approve; Approve runs the checks again."],
  ["Flags", "In amber: something to look at, like a name in capitals. A flagged pitch comes here even from a creator past her first three, and you can approve it."],
  ["Contact", "Where the pitch goes. Change it before you approve to send it somewhere else; the address becomes the brand's contact for later pitches too. A brand on Linkable gets the pitch in its Messages, so there is nothing to change."],
  ["View as brand", "Opens the page the brand will get from this pitch, in a new tab, as it will look. Reply is off, and nothing is counted or sent. The link works for an hour; the list reads itself again before its links run out."],
  ["Approve", "Sends the pitch now: Messages for a brand on Linkable, otherwise the Lemlist queue like every other pitch, follow ups included."],
  ["Reject", "Asks for the reason. The creator reads it on her pitch and in an email, edits the pitch and sends it again, and it comes back here."],
];

const RESET = { bounce: "Back in review: one of her pitches bounced", complaint: "Back in review: a brand reported her" };

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

function ReviewCard({ r, onDone, onFailed, isStale, freshViewUrl }) {
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

  // A link from a list read too long ago may have expired: open the tab now
  // (a tab opened after the wait is a blocked pop-up), read the list, then
  // send the tab to the new link. A fresh one opens as the plain link it is.
  const viewAsBrand = async (e) => {
    if (!isStale()) return;
    e.preventDefault();
    const tab = window.open("", "_blank");
    const url = await freshViewUrl(r.pitch_id);
    if (!tab) return;
    if (url) {
      tab.opener = null;
      tab.location.href = url;
      return;
    }
    tab.close();
  };

  const mediaKit = r.creator_media_kit;
  const account = reviewAccount(r);
  const profiles = reviewProfiles(r);
  return (
    <Card style={{ padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <Who picture={<Avatar name={r.creator_name} />} title={r.creator_name || r.creator_email} sub={r.creator_email} />
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
          {profiles.accounts.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, minWidth: 0 }}>
              {profiles.main && (
                <a href={profiles.main.url} target="_blank" rel="noopener noreferrer" title={`Her ${profiles.main.label}`}
                   style={{ fontSize: 13, fontWeight: 600, color: t.text, textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  @{profiles.main.handle}
                </a>
              )}
              {profiles.accounts.map((a) => (
                <a key={a.platform} href={a.url} target="_blank" rel="noopener noreferrer"
                   title={`@${a.handle} on ${a.label}`} aria-label={`@${a.handle} on ${a.label}`}
                   style={{ color: t.text, display: "inline-flex" }}>
                  <SocialIcon platform={a.platform} size={16} />
                </a>
              ))}
            </div>
          )}
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>
            {account.line}
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

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        {/* The proposal page the brand will open, read only (QA 122). */}
        <Btn variant="secondary" href={r.brand_view_url || undefined} target="_blank" disabled={!r.brand_view_url} onClick={viewAsBrand}
             title={r.brand_view_url ? "Opens the page the brand will get, in a new tab. Nothing is counted or sent." : "Arrives with the main app's next deploy."}
             style={{ marginRight: "auto" }}>View as brand</Btn>
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

  const loadedAt = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getPitchReviews({ limit: PAGE, offset });
      setAvailable(r.available);
      setReason(r.reason || "");
      setRows(r.items || []);
      setTotal(r.total || 0);
      setError(null);
      loadedAt.current = Date.now();
      return r.items || [];
    } catch (e) { setError(e.message); return null; }
    finally { setLoading(false); }
  }, [offset]);
  useEffect(() => { load(); }, [load]);

  // View as brand's links expire an hour after the list was read.
  const isStale = useCallback(() => !!loadedAt.current && Date.now() - loadedAt.current > STALE_MS, []);
  const freshViewUrl = useCallback(async (pitchId) => {
    const items = await load();
    // Not read: its error shows above the list.
    if (!items) return "";
    const url = items.find((x) => x.pitch_id === pitchId)?.brand_view_url || "";
    // Said here: the card itself is gone once it left the queue.
    if (!url) setNotice("That pitch is no longer waiting for review. The list is up to date.");
    return url;
  }, [load]);

  // Read the list again once it is stale: on the tab coming back, and every
  // few minutes while it is shown, so a middle-click or cmd-click (which skip
  // the click check) also gets a live link.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === "visible" && isStale()) load();
    };
    document.addEventListener("visibilitychange", check);
    const timer = setInterval(check, STALE_CHECK_MS);
    return () => {
      document.removeEventListener("visibilitychange", check);
      clearInterval(timer);
    };
  }, [load, isStale]);

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
      {rows.map((r) => <ReviewCard key={r.pitch_id} r={r} onDone={done} onFailed={load} isStale={isStale} freshViewUrl={freshViewUrl} />)}

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
