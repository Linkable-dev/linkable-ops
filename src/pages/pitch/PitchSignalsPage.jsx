import { useState, useEffect, useCallback } from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { api, friendlyDate } from "../../lib/api";
import { Card } from "../../components/ui/Card";
import { Btn } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Label } from "../../components/ui/Label";
import { Modal } from "../../components/ui/Modal";
import { Select } from "../../components/ui/Select";
import { Tag } from "../../components/ui/Tag";
import { Skeleton } from "../../components/ui/Skeleton";
import { HelpList, HelpTip } from "../../components/gtm/QueueParts";
import { Banner, StatTile } from "../../components/pitch/PitchParts";
import {
  SIGNAL_TABS, SIGNAL_STATUS, HOW_TO_APPLY, signalContactFrom, signalWants, signalSource, replyRate,
} from "../../components/pitch/pitchLabels";

// Pitch signals (main app QA 172): brands that asked for creators on
// Instagram without a Google Form. The agent finds them every hour and they
// go live on their own; a post the agent missed is added here from its link:
// the main app reads it, finds an email, and saves a draft to check and
// approve. Live for 30 days from the post, or until its deadline.

const PAGE = 25;

const HELP = [
  ["What", "A brand asked for creators in a public Instagram post (DM us, email us, comment below). Creators the post fits see the brand first in Brands to pitch, and their pitch answers what the post asked."],
  ["Agent", "Reads new posts every hour. Calls with a Google Form become campaigns instead. A call from an agency, an event or a creator, or with no email anywhere, is dropped."],
  ["Add from post", "Paste the post link. If the agent saw the post, its caption and picture come with it; if not, paste the caption and a picture link. Check the draft, then Approve."],
  ["Live", "30 days from the post, or until its deadline if sooner. The daily check hides it after that, or when the post is deleted. Pitches already sent carry on."],
  ["Emails", "Go to the contact email: the address in the post, else the one on their Instagram profile, else their website's."],
];

const blank = {
  brand_name: "", instagram: "", website: "", wants: "", spots: "", asks: "", offers: "", how_to_apply: "",
  apply_text: "", keyword: "", checklist: "", contact_email: "", regions: "", niches: "", min_followers: "",
  max_followers: "", deadline: "", caption: "", image_url: "",
};

// The editable fields of a signal, as the form holds them.
function formOf(s) {
  return {
    ...blank,
    brand_name: s.brand_name || "", instagram: s.instagram || "", website: s.website || "",
    wants: s.wants || "", spots: s.spots || "", asks: s.asks || "", offers: s.offers || "",
    how_to_apply: s.how_to_apply || "", apply_text: s.apply_text || "", keyword: s.keyword || "",
    checklist: (s.checklist || []).join("\n"), contact_email: s.contact_email || "",
    regions: (s.regions || []).join(", "), niches: (s.niches || []).join(", "),
    min_followers: s.min_followers ? String(s.min_followers) : "", max_followers: s.max_followers ? String(s.max_followers) : "",
    deadline: s.deadline || "", caption: s.caption || "",
  };
}

function payloadOf(f) {
  return { ...f, checklist: f.checklist.split("\n").map((x) => x.trim()).filter(Boolean) };
}

function Field({ label, children, wide }) {
  return <div style={{ gridColumn: wide ? "1 / -1" : undefined, minWidth: 0 }}><Label>{label}</Label>{children}</div>;
}

// Add from post: the link, and what to paste when the agent never saw it.
function AddModal({ open, onClose, onDrafted }) {
  const [form, setForm] = useState({ post_url: "", caption: "", image_url: "", brand_name: "", instagram: "", website: "", contact_email: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await api.draftPitchSignal(form);
      setForm({ post_url: "", caption: "", image_url: "", brand_name: "", instagram: "", website: "", contact_email: "" });
      onDrafted(s);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add a signal from a post" width={600}>
      <div style={{ padding: 20, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Field label="Instagram post link" wide>
          <Input value={form.post_url} onChange={set("post_url")} placeholder="https://www.instagram.com/p/…" />
        </Field>
        <Field label="Caption (only if the agent never saw the post)" wide>
          <Input multiline rows={4} value={form.caption} onChange={set("caption")} placeholder="Paste the post's caption" />
        </Field>
        <Field label="Picture link (optional)" wide>
          <Input value={form.image_url} onChange={set("image_url")} placeholder="https://…" />
        </Field>
        <Field label="Brand name (optional)"><Input value={form.brand_name} onChange={set("brand_name")} /></Field>
        <Field label="Instagram (optional)"><Input value={form.instagram} onChange={set("instagram")} placeholder="@handle" /></Field>
        <Field label="Website (optional)"><Input value={form.website} onChange={set("website")} placeholder="brand.com" /></Field>
        <Field label="Contact email (optional)"><Input value={form.contact_email} onChange={set("contact_email")} placeholder="hello@brand.com" /></Field>
        {error && <div style={{ gridColumn: "1 / -1" }}><Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner></div>}
        <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn onClick={submit} loading={busy} disabled={!form.post_url.trim()}>Read the post</Btn>
        </div>
      </div>
    </Modal>
  );
}

// One signal: what the read found, editable, with Save, Read again,
// Approve and Hide. Keyed by the signal's id, so another signal starts fresh.
function SignalModal({ signal, onClose, onChanged }) {
  const { theme: t } = useTheme();
  const [s, setS] = useState(signal);
  const [form, setForm] = useState(() => formOf(signal || {}));
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [hiding, setHiding] = useState(false);
  const [reason, setReason] = useState("");

  if (!signal || !s) return null;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const status = SIGNAL_STATUS[s.status] || { label: s.status, color: "#737C9A" };
  const editable = s.status !== "dropped";

  const run = async (what, fn, message) => {
    setBusy(what);
    setError(null);
    setNotice(null);
    try {
      const next = await fn();
      setS(next);
      setForm(formOf(next));
      setNotice(typeof message === "function" ? message(next) : message);
      onChanged();
      return next;
    } catch (e) { setError(e.message); return null; }
    finally { setBusy(""); }
  };

  const save = () => run("save", () => api.updatePitchSignal(s.id, payloadOf(form)), "Saved.");
  const approve = () => run("approve", async () => {
    await api.updatePitchSignal(s.id, payloadOf(form));
    return api.approvePitchSignal(s.id);
  }, (n) => `Live until ${friendlyDate(n.live_until)}. Creators the post fits see it first in Brands to pitch.`);
  const reread = () => run("reread", () => api.rereadPitchSignal(s.id, { caption: form.caption, image_url: form.image_url }),
    "Read again. Check what it found, then save.");
  const hide = async () => {
    if (!reason.trim()) { setError("Write why it's hidden, for the record."); return; }
    const next = await run("hide", () => api.hidePitchSignal(s.id, reason.trim()), "Hidden. Its brand is a normal card in Brands to pitch again.");
    if (next) { setHiding(false); setReason(""); }
  };

  const fact = (label, value) => value ? (
    <div style={{ fontSize: 13, lineHeight: 1.5 }}><span style={{ color: t.textMuted }}>{label}: </span>{value}</div>
  ) : null;

  return (
    <Modal open={!!signal} onClose={onClose} title={s.brand_name || "Signal"} width={760}>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          {s.image_url
            ? <img src={s.image_url} alt="" style={{ width: 120, height: 120, objectFit: "cover", borderRadius: 10, background: t.surfaceAlt }} />
            : <div style={{ width: 120, height: 120, borderRadius: 10, background: t.surfaceAlt, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: t.textMuted }}>No picture</div>}
          <div style={{ flex: 1, minWidth: 240, display: "flex", flexDirection: "column", gap: 4 }}>
            <div><Tag color={status.color}>{status.label}</Tag><Tag color="#2563EB">{signalSource(s)}</Tag></div>
            {fact("Posted", s.posted_at && friendlyDate(s.posted_at))}
            {fact("Live until", s.live_until && friendlyDate(s.live_until))}
            {fact("Contact", s.contact_email && `${s.contact_email} ${signalContactFrom(s.contact_from)}`.trim())}
            {fact("Hidden because", s.hidden_reason)}
            {fact("Approved", s.approved_at && `${friendlyDate(s.approved_at)}${s.approved_by ? ` by ${s.approved_by}` : ""}`)}
            {fact("Pitches", `${s.pitches_sent} sent, ${s.replies} replied`)}
            {s.post_url && <div style={{ marginTop: 4 }}><Btn size="sm" variant="secondary" href={s.post_url} target="_blank">Open the post</Btn></div>}
          </div>
        </div>
        {s.note && <Banner tone="warning">{s.note}</Banner>}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Field label="Brand name"><Input value={form.brand_name} onChange={set("brand_name")} disabled={!editable} /></Field>
          <Field label="Contact email"><Input value={form.contact_email} onChange={set("contact_email")} disabled={!editable} /></Field>
          <Field label="Instagram"><Input value={form.instagram} onChange={set("instagram")} placeholder="@handle" disabled={!editable} /></Field>
          <Field label="Website"><Input value={form.website} onChange={set("website")} placeholder="brand.com" disabled={!editable} /></Field>
          <Field label="Wants (who they want)"><Input value={form.wants} onChange={set("wants")} placeholder="Small or medium dogs" disabled={!editable} /></Field>
          <Field label="Spots (how many)"><Input value={form.spots} onChange={set("spots")} placeholder="5 creators" disabled={!editable} /></Field>
          <Field label="Asks"><Input value={form.asks} onChange={set("asks")} placeholder="1 Reel, 2 to 3 Stories" disabled={!editable} /></Field>
          <Field label="Offers"><Input value={form.offers} onChange={set("offers")} placeholder="Free bed, discount code" disabled={!editable} /></Field>
          <Field label="How to apply">
            <Select value={form.how_to_apply} onChange={(v) => setForm({ ...form, how_to_apply: v })} options={HOW_TO_APPLY} disabled={!editable} ariaLabel="How to apply" />
          </Field>
          <Field label="Keyword"><Input value={form.keyword} onChange={set("keyword")} placeholder="PDRN CREATOR" disabled={!editable} /></Field>
          <Field label="How to apply, in their words" wide>
            <Input value={form.apply_text} onChange={set("apply_text")} placeholder="Email us with your handle and a short clip" disabled={!editable} />
          </Field>
          <Field label="What applicants should send (one per line)" wide>
            <Input multiline rows={3} value={form.checklist} onChange={set("checklist")} disabled={!editable} />
          </Field>
          <Field label="Regions (country codes, empty for anywhere)"><Input value={form.regions} onChange={set("regions")} placeholder="GB, US" disabled={!editable} /></Field>
          <Field label="Niches (keys, empty for any)"><Input value={form.niches} onChange={set("niches")} placeholder="PETS, HOME_LIVING" disabled={!editable} /></Field>
          <Field label="Smallest audience (followers)"><Input type="number" min="0" value={form.min_followers} onChange={set("min_followers")} disabled={!editable} /></Field>
          <Field label="Largest audience (followers)"><Input type="number" min="0" value={form.max_followers} onChange={set("max_followers")} disabled={!editable} /></Field>
          <Field label="Deadline"><Input type="date" value={form.deadline} onChange={set("deadline")} disabled={!editable} /></Field>
          <Field label="New picture link (optional)"><Input value={form.image_url} onChange={set("image_url")} placeholder="https://…" disabled={!editable} /></Field>
          <Field label="Caption" wide><Input multiline rows={5} value={form.caption} onChange={set("caption")} disabled={!editable} /></Field>
        </div>

        {hiding && (
          <Input multiline rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300}
                 placeholder="Why it's hidden, e.g. the brand found its creators." aria-label="Reason" />
        )}
        {notice && <Banner onDismiss={() => setNotice(null)}>{notice}</Banner>}
        {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}

        {editable && (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
            {hiding ? <>
              <Btn variant="secondary" onClick={() => { setHiding(false); setReason(""); setError(null); }} disabled={!!busy}>Cancel</Btn>
              <Btn variant="danger" onClick={hide} loading={busy === "hide"}>Hide with this reason</Btn>
            </> : <>
              {s.status !== "hidden" && <Btn variant="secondary" onClick={() => setHiding(true)} disabled={!!busy}>Hide</Btn>}
              <Btn variant="secondary" onClick={reread} loading={busy === "reread"} disabled={!!busy && busy !== "reread"}>Read again</Btn>
              <Btn variant="secondary" onClick={save} loading={busy === "save"} disabled={!!busy && busy !== "save"}>Save</Btn>
              {(s.status === "draft" || s.status === "hidden") && (
                <Btn onClick={approve} loading={busy === "approve"} disabled={!!busy && busy !== "approve"}>Save and approve</Btn>
              )}
            </>}
          </div>
        )}
      </div>
    </Modal>
  );
}

// Reply rate on signal pitches against normal ones, by the signal's age
// when the pitch went.
function Stats({ reloadKey }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try { setStats(await api.getPitchSignalStats()); }
    catch { setStats(null); }
    finally { setLoading(false); }
    // reloadKey: a change in the list reloads the numbers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);
  useEffect(() => { load(); }, [load]);
  if (!loading && (!stats || stats.available === false)) return null;
  const rows = stats?.rows || [];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 16 }}>
      <StatTile label="Live signals" value={stats?.live ?? 0} loading={loading} strong />
      {(loading ? [{ label: "Reply rate" }] : rows).map((r) => (
        <StatTile key={r.label} label={r.label} value={replyRate(r.reply_rate)} loading={loading}
                  sub={`${r.replied} of ${r.sent} replied`} />
      ))}
    </div>
  );
}

export default function PitchSignalsPage() {
  const { theme: t } = useTheme();
  const [status, setStatus] = useState("live");
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [available, setAvailable] = useState(true);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getPitchSignals({ status, limit: PAGE, offset });
      setAvailable(r.available);
      setReason(r.reason || "");
      setRows(r.items || []);
      setTotal(r.total || 0);
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [status, offset]);
  useEffect(() => { load(); }, [load]);

  const changed = () => { load(); setReloadKey((k) => k + 1); };
  const current = SIGNAL_TABS.find((x) => x.value === status) || SIGNAL_TABS[0];
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE, total);
  const th = { textAlign: "left", fontSize: 11, fontWeight: 600, color: t.textMuted, textTransform: "uppercase", letterSpacing: 0.6, padding: "10px 14px", borderBottom: `1px solid ${t.border}`, whiteSpace: "nowrap" };
  const td = { padding: "12px 14px", borderBottom: `1px solid ${t.border}`, fontSize: 13, color: t.text, verticalAlign: "top" };
  const muted = { fontSize: 12, color: t.textMuted };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 6 }}>
          {SIGNAL_TABS.map((x) => (
            <Btn key={x.value} size="sm" variant={x.value === status ? "solid" : "secondary"}
                 onClick={() => { setStatus(x.value); setOffset(0); }}>
              {x.label}
            </Btn>
          ))}
        </div>
        <HelpTip title="Pitch signals"><HelpList items={HELP} /></HelpTip>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <Btn size="sm" variant="secondary" onClick={load} disabled={loading}>Refresh</Btn>
          <Btn size="sm" onClick={() => setAdding(true)} disabled={!available}>Add from post</Btn>
        </div>
      </div>

      {!available && <Banner tone="warning">{reason || "Pitch signals aren't available on this server."}</Banner>}
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      {available && <Stats reloadKey={reloadKey} />}

      <Card style={{ padding: 0, marginBottom: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", minWidth: 1100, borderCollapse: "collapse" }}>
            <thead><tr>
              {["Post", "Brand", "Wants or spots", "Asks", "Offers", "Contact", "Posted", "Live until", "Source", "Pitches", "Status"].map((h) => <th key={h} style={th}>{h}</th>)}
            </tr></thead>
            <tbody>
              {loading && rows.length === 0 && [0, 1, 2].map((i) => (
                <tr key={i}><td style={td} colSpan={11}><Skeleton width="100%" height={18} /></td></tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr><td style={{ ...td, color: t.textMuted }} colSpan={11}>{current.empty}</td></tr>
              )}
              {rows.map((s) => {
                const w = signalWants(s);
                const st = SIGNAL_STATUS[s.status] || { label: s.status, color: "#737C9A" };
                return (
                  <tr key={s.id} onClick={() => setOpen(s)} style={{ cursor: "pointer" }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = t.surfaceAlt; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                    <td style={td}>
                      {s.image_url
                        ? <img src={s.image_url} alt="" style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 8, display: "block" }} />
                        : <div style={{ width: 48, height: 48, borderRadius: 8, background: t.surfaceAlt }} />}
                    </td>
                    <td style={td}>
                      <div style={{ fontWeight: 600 }}>{s.brand_name || "Unnamed brand"}</div>
                      {s.instagram && <div style={muted}>@{s.instagram}</div>}
                    </td>
                    <td style={td}>{w.text ? <><span style={muted}>{w.label} </span>{w.text}</> : <span style={muted}>Not said</span>}</td>
                    <td style={td}>{s.asks || <span style={muted}>Not said</span>}</td>
                    <td style={td}>{s.offers || <span style={muted}>Not said</span>}</td>
                    <td style={td}>
                      {s.contact_email ? <><div style={{ wordBreak: "break-all" }}>{s.contact_email}</div><div style={muted}>{signalContactFrom(s.contact_from)}</div></> : <span style={muted}>None</span>}
                    </td>
                    <td style={td}>{s.posted_at ? friendlyDate(s.posted_at) : ""}</td>
                    <td style={td}>{s.live_until ? friendlyDate(s.live_until) : ""}</td>
                    <td style={td}>{signalSource(s)}</td>
                    <td style={td}>{`${s.pitches_sent} sent`}<div style={muted}>{`${s.replies} replied`}</div></td>
                    <td style={td}>
                      <Tag color={st.color}>{st.label}</Tag>
                      {(s.hidden_reason || s.note) && <div style={{ ...muted, marginTop: 4 }}>{s.hidden_reason || s.note}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, fontSize: 12, color: t.textMuted }}>
        <span>{total === 0 ? "" : `${pageStart}–${pageEnd} of ${total}`}</span>
        <div style={{ display: "flex", gap: 6 }}>
          <Btn size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Btn>
          <Btn size="sm" variant="secondary" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</Btn>
        </div>
      </div>

      <AddModal open={adding} onClose={() => setAdding(false)}
                onDrafted={(s) => { setAdding(false); setOpen(s); changed(); }} />
      <SignalModal key={open?.id || "none"} signal={open} onClose={() => setOpen(null)} onChanged={changed} />
    </div>
  );
}
