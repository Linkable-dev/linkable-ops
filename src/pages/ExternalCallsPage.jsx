import { useState, useEffect, useCallback } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api, friendlyDate } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Tag } from "../components/ui/Tag";
import { Select } from "../components/ui/Select";
import { Skeleton } from "../components/ui/Skeleton";
import { HelpList, HelpTip } from "../components/gtm/QueueParts";
import { Banner } from "../components/pitch/PitchParts";
import {
  CALL_TABS, CLOSE_REASONS, NICHES, QUESTION_FIELDS, STATUS_LABELS, SUBMISSION_LABELS,
  countryList, draftProblems, parseJSON, sourceLabel, wordList,
} from "../components/externalCalls/externalCallLabels";

// Campaigns from calls (main app QA 171): brands' Instagram posts asking
// creators to apply through a Google Form. The agent drafts them, or add one
// here from the post link and the form link; check the draft, then Approve
// publishes it as a normal campaign. Creators apply in the app and Linkable
// fills the brand's form for them. Everything goes through the main app.

const PAGE = 10;

const HELP = [
  ["To review", "Calls the agent found in the last 14 days, and ones added here. The form was open, needs no Google sign in and takes no file upload. Check the brand, the offer and how each question is filled, then Approve."],
  ["Approve", "Publishes it as a campaign. Creators see it in Live campaigns only if they live in its countries and create in its niches (empty means everyone). It stays live until the deadline, and never more than 30 days after the post (30 days after adding, for one added here)."],
  ["Questions", "Each form question is filled from her profile, from her pitch, or asked in the pop-up under “[Brand] also asks” (saved to her profile for next time). A required question is never left blank."],
  ["Photo", "A product photo from the brand’s website, matched to the product. Pick another of the website’s photos or paste any photo link. No photo: the card shows the logo on a plain tile. Never the post itself."],
  ["Read again", "Checks the form again and reads the post again (one AI read). Paste the caption when the agent never saw the post."],
  ["Closing", "Every day: a form that stopped taking responses, a deleted post, a passed deadline or 30 days closes it. Her application moves to Ended, “Closed by [Brand]”."],
  ["Held", "Google didn’t confirm an application. Retry sends it again; Dismiss leaves it. She sees Applied either way."],
  ["Brands", "Who applied through Linkable, per brand: proof for the sales pitch."],
];

const section = (t) => ({ fontSize: 11, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase", color: t.textMuted, marginBottom: 8 });

function Field({ label, children, hint }) {
  const { theme: t } = useTheme();
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: t.textMid }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 11, color: t.textMuted }}>{hint}</span>}
    </label>
  );
}

function AddCall({ onAdded }) {
  const { theme: t } = useTheme();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ post_url: "", form_url: "", caption: "", owner_handle: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.addExternalCall(form);
      setForm({ post_url: "", form_url: "", caption: "", owner_handle: "" });
      setOpen(false);
      onAdded(res);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (!open) return <Btn size="sm" onClick={() => setOpen(true)}>Add a call</Btn>;
  return (
    <Card style={{ padding: 20, marginBottom: 16, width: "100%" }}>
      <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>Add a call</div>
      <div style={{ fontSize: 13, color: t.textMuted, marginBottom: 14 }}>
        The brand’s Instagram post and its Google Form. We check the form, read both and draft the campaign for you to check. The 14 day rule doesn’t apply.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
        <Field label="Instagram post link"><Input value={form.post_url} onChange={set("post_url")} placeholder="https://www.instagram.com/p/…" /></Field>
        <Field label="Google Form link"><Input value={form.form_url} onChange={set("form_url")} placeholder="https://forms.gle/…" /></Field>
        <Field label="Brand’s Instagram handle" hint="Only if the post link doesn’t carry it."><Input value={form.owner_handle} onChange={set("owner_handle")} placeholder="@kora.matcha" /></Field>
      </div>
      <div style={{ marginTop: 12 }}>
        <Field label="Caption" hint="Paste it when our agent never saw the post, so the read has the brand’s words.">
          <Input multiline rows={3} value={form.caption} onChange={set("caption")} maxLength={5000} />
        </Field>
      </div>
      {error && <div style={{ marginTop: 12 }}><Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner></div>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        <Btn variant="secondary" onClick={() => { setOpen(false); setError(null); }} disabled={busy}>Cancel</Btn>
        <Btn onClick={submit} loading={busy}>Add and read</Btn>
      </div>
    </Card>
  );
}

function PhotoPicker({ call, draft, onSaved }) {
  const { theme: t } = useTheme();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const use = async (url) => {
    setBusy(url || "none");
    setError(null);
    try { onSaved(await api.setExternalCallImage(call.id, url)); setLink(""); }
    catch (e) { setError(e.message); }
    finally { setBusy(""); }
  };
  const tile = { width: 72, height: 72, borderRadius: 10, objectFit: "cover", background: t.surfaceAlt, display: "block" };
  return (
    <div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
        {draft.image_url ? <img src={draft.image_url} alt="" style={{ ...tile, width: 120, height: 120 }} />
          : <div style={{ ...tile, width: 120, height: 120, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: t.textMuted, textAlign: "center", padding: 8, boxSizing: "border-box" }}>No photo: the logo on a plain tile</div>}
        {(draft.image_candidates || []).filter((u) => u !== draft.image_url).map((u) => (
          <button key={u} type="button" onClick={() => use(u)} disabled={!!busy} title="Use this website photo"
                  style={{ padding: 0, border: `1px solid ${t.border}`, borderRadius: 10, background: "none", cursor: "pointer", opacity: busy && busy !== u ? 0.5 : 1 }}>
            <img src={u} alt="" style={tile} />
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Paste a product photo link" />
        <Btn size="sm" variant="secondary" onClick={() => use(link.trim())} disabled={!link.trim()} loading={busy === link.trim() && !!link.trim()}>Use</Btn>
        {draft.image_url && <Btn size="sm" variant="secondary" onClick={() => use("")} loading={busy === "none"}>No photo</Btn>}
      </div>
      {error && <div style={{ marginTop: 8 }}><Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner></div>}
    </div>
  );
}

function DraftEditor({ call, onSaved, onClose }) {
  const { theme: t } = useTheme();
  const form = parseJSON(call.form_json, { fields: [] });
  const [draft, setDraft] = useState(() => parseJSON(call.draft_json, {}));
  const [text, setText] = useState(() => {
    const d = parseJSON(call.draft_json, {});
    return { platforms: (d.platforms || []).join(", "), countries: (d.countries || []).join(", ") };
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, cast = (v) => v) => (e) => setDraft((d) => ({ ...d, [k]: cast(e.target.value) }));
  const num = (v) => (v === "" ? 0 : Number(v) || 0);
  const fieldOf = (entry) => (draft.questions || []).find((q) => q.entry === entry)?.field || "also_asks";
  const setField = (entry, title, field) => setDraft((d) => {
    const qs = (d.questions || []).filter((q) => q.entry !== entry);
    return { ...d, questions: [...qs, { entry, title, field }] };
  });
  const toggleNiche = (key) => setDraft((d) => {
    const now = d.niches || [];
    return { ...d, niches: now.includes(key) ? now.filter((n) => n !== key) : [...now, key] };
  });
  const problems = draftProblems(draft, form);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { ...draft, platforms: wordList(text.platforms), countries: countryList(text.countries) };
      onSaved(await api.updateExternalCall(call.id, body));
      onClose();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 };
  return (
    <div style={{ marginTop: 16, borderTop: `1px solid ${t.border}`, paddingTop: 16 }}>
      <div style={section(t)}>Brand and product</div>
      <div style={grid}>
        <Field label="Brand name"><Input value={draft.brand_name || ""} onChange={set("brand_name")} /></Field>
        <Field label="Website" hint="Where the product photos come from."><Input value={draft.website || ""} onChange={set("website")} placeholder="kora.example" /></Field>
        <Field label="Logo link" hint="Optional. Copied to Linkable when published."><Input value={draft.logo_url || ""} onChange={set("logo_url")} /></Field>
        <Field label="Product (the campaign’s title)"><Input value={draft.product_title || ""} onChange={set("product_title")} /></Field>
      </div>
      <div style={{ marginTop: 12 }}>
        <Field label="About the product"><Input multiline rows={2} value={draft.product_description || ""} onChange={set("product_description")} /></Field>
      </div>
      <div style={{ marginTop: 12 }}>
        <Field label="Photo"><PhotoPicker call={call} draft={draft} onSaved={(c) => { onSaved(c); setDraft((d) => ({ ...d, ...pick(parseJSON(c.draft_json, {}), ["image_url", "image_source"]) })); }} /></Field>
      </div>

      <div style={{ ...section(t), marginTop: 20 }}>Offer, in the brand’s words</div>
      <div style={grid}>
        <Field label="Free product" hint="Empty: nothing is sent."><Input value={draft.free_product || ""} onChange={set("free_product")} /></Field>
        <Field label="Fee" hint="As the brand wrote it. Empty: unpaid."><Input value={draft.fee || ""} onChange={set("fee")} /></Field>
        <Field label="Fee amount and currency" hint="Only a number the brand gave.">
          <div style={{ display: "flex", gap: 6 }}>
            <Input type="number" min="0" value={draft.fee_amount || ""} onChange={set("fee_amount", num)} />
            <Input value={draft.fee_currency || ""} onChange={set("fee_currency", (v) => v.toUpperCase().slice(0, 3))} placeholder="GBP" style={{ width: 80 }} />
          </div>
        </Field>
        <Field label="Commission" hint="As the brand wrote it."><Input value={draft.commission || ""} onChange={set("commission")} /></Field>
        <Field label="Commission %" hint="Only a rate the brand gave."><Input type="number" min="0" max="100" value={draft.commission_rate || ""} onChange={set("commission_rate", num)} /></Field>
      </div>

      <div style={{ ...section(t), marginTop: 20 }}>Content and who it’s for</div>
      <div style={grid}>
        <Field label="What to create"><Input value={draft.content || ""} onChange={set("content")} /></Field>
        <Field label="Platforms" hint="Comma separated: instagram, tiktok, shopee…"><Input value={text.platforms} onChange={(e) => setText((x) => ({ ...x, platforms: e.target.value }))} /></Field>
        <Field label="Countries" hint="ISO codes, comma separated. Empty: everywhere."><Input value={text.countries} onChange={(e) => setText((x) => ({ ...x, countries: e.target.value }))} placeholder="GB, AE" /></Field>
        <Field label="Followers, at least / at most" hint="0: no limit.">
          <div style={{ display: "flex", gap: 6 }}>
            <Input type="number" min="0" value={draft.followers_min || ""} onChange={set("followers_min", num)} />
            <Input type="number" min="0" value={draft.followers_max || ""} onChange={set("followers_max", num)} />
          </div>
        </Field>
        <Field label="Deadline" hint="Last day to apply. Empty: 30 days.">
          <Input type="date" value={draft.deadline || ""} onChange={set("deadline")} />
        </Field>
        <Field label="Content only" hint="Creators make content and don’t post it.">
          <Select value={draft.content_only ? "yes" : "no"} onChange={(v) => setDraft((d) => ({ ...d, content_only: v === "yes" }))}
                  options={[["no", "No, they post it"], ["yes", "Yes, content only"]]} />
        </Field>
      </div>
      <div style={{ marginTop: 12 }}>
        <Field label="Niches" hint="Empty: every creator.">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {NICHES.map(([key, label]) => (
              <Btn key={key} size="sm" variant={(draft.niches || []).includes(key) ? "solid" : "secondary"} onClick={() => toggleNiche(key)}>{label}</Btn>
            ))}
          </div>
        </Field>
      </div>
      <div style={{ ...grid, marginTop: 12 }}>
        <Field label="The brief"><Input multiline rows={3} value={draft.brief || ""} onChange={set("brief")} /></Field>
        <Field label="Usage rights" hint="Only if the brand said how it uses the content."><Input multiline rows={3} value={draft.usage_rights || ""} onChange={set("usage_rights")} /></Field>
      </div>

      <div style={{ ...section(t), marginTop: 20 }}>The form’s questions</div>
      {(form.fields || []).length === 0 && <div style={{ fontSize: 13, color: t.textMuted }}>The form hasn’t been read. Press Read again.</div>}
      {(form.fields || []).map((f) => (
        <div key={f.entry} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(220px, 1fr)", gap: 12, alignItems: "center", padding: "8px 0", borderTop: `1px solid ${t.border}` }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13 }}>{f.title}{f.required && <span style={{ color: t.danger }}> *</span>}</div>
            <div style={{ fontSize: 11, color: t.textMuted }}>
              {[f.kind, (f.options || []).map((o) => (o.other ? "Other" : o.value)).join(" / ")].filter(Boolean).join(" · ")}
            </div>
          </div>
          <Select value={fieldOf(f.entry)} onChange={(v) => setField(f.entry, f.title, v)} options={QUESTION_FIELDS} />
        </div>
      ))}

      {problems.length > 0 && <div style={{ marginTop: 12 }}><Banner tone="warning">{problems.join(" ")}</Banner></div>}
      {error && <div style={{ marginTop: 12 }}><Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner></div>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
        <Btn onClick={save} loading={busy}>Save draft</Btn>
      </div>
    </div>
  );
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
}

function CallCard({ call: initial, onDone }) {
  const { theme: t } = useTheme();
  // The card's own copy after an edit; the list's next load remounts it
  // (keyed by id and status).
  const [local, setCall] = useState(null);
  const call = local || initial;
  const [full, setFull] = useState(null);
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [closing, setClosing] = useState(false);
  const [rereading, setRereading] = useState(false);
  const [reason, setReason] = useState("");
  const [caption, setCaption] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const draft = parseJSON(call.draft_json, {});

  const loadFull = async () => {
    const c = await api.getExternalCall(call.id);
    setFull(c);
    setCall(c);
    return c;
  };
  const edit = async () => {
    setError(null);
    try { await loadFull(); setEditing(true); } catch (e) { setError(e.message); }
  };
  const act = async (fn, after) => {
    setError(null);
    try { const c = await fn(); after(c); } catch (e) { setError(e.message); }
    finally { setBusy(""); }
  };
  const decide = (decision) => {
    if (decision === "reject" && !reason.trim()) { setError("Write why, for the record."); return; }
    setBusy(decision);
    act(() => api.decideExternalCall(call.id, decision, reason.trim()), (c) => onDone(
      decision === "approve" ? `${c.brand_name || "The call"} is live: creators in its region and niches see it in Live campaigns.`
        : decision === "close" ? `${c.brand_name || "The call"} is closed. Applications moved to Ended.`
        : `${c.brand_name || "The call"} is rejected.`,
    ));
  };
  const reread = () => {
    setBusy("read");
    act(() => api.rereadExternalCall(call.id, caption.trim()), () => onDone("Reading it again. It shows in To review when done."));
  };

  const problems = full ? draftProblems(parseJSON(full.draft_json, {}), parseJSON(full.form_json, { fields: [] })) : [];
  const offer = [draft.free_product && "Free product", (draft.fee || draft.fee_amount) && "Fee", (draft.commission || draft.commission_rate) && "Commission"].filter(Boolean).join(" · ");

  return (
    <Card style={{ padding: 20, marginBottom: 12 }}>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        {call.image_url ? <img src={call.image_url} alt="" style={{ width: 72, height: 72, borderRadius: 10, objectFit: "cover" }} />
          : <div style={{ width: 72, height: 72, borderRadius: 10, background: t.surfaceAlt }} />}
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600, fontSize: 15 }}>{call.brand_name || `@${call.owner_handle}`}</span>
            {call.owner_handle && <span style={{ fontSize: 12, color: t.textMuted }}>@{call.owner_handle}</span>}
            <Tag color={call.source === "manual" ? "#7C3AED" : "#2563EB"}>{sourceLabel(call.source)}</Tag>
            <Tag>{STATUS_LABELS[call.status] || call.status}</Tag>
          </div>
          <div style={{ fontSize: 14, marginTop: 4 }}>{call.product_title || <span style={{ color: t.textMuted }}>No product yet</span>}</div>
          <div style={{ fontSize: 12, color: t.textMuted, marginTop: 4 }}>
            {[offer, call.posted_at && `Posted ${friendlyDate(call.posted_at)}`, call.deadline && `Deadline ${friendlyDate(call.deadline)}`,
              call.closes_at && call.status === "live" && `Closes ${friendlyDate(call.closes_at)}`,
              (call.applicants > 0 || call.status === "live" || call.status === "closed") && `${call.applicants} applied`,
              call.held > 0 && `${call.held} held`].filter(Boolean).join(" · ")}
          </div>
          {call.fail_reason && <div style={{ fontSize: 13, marginTop: 6, color: t.danger }}>{call.fail_reason}</div>}
          {call.reject_reason && <div style={{ fontSize: 13, marginTop: 6, color: t.textMid }}>{call.reject_reason}</div>}
          {call.close_reason && <div style={{ fontSize: 13, marginTop: 6, color: t.textMid }}>{CLOSE_REASONS[call.close_reason] || call.close_reason}{call.closed_at ? `, ${friendlyDate(call.closed_at)}` : ""}</div>}
          {call.approved_by && <div style={{ fontSize: 12, marginTop: 4, color: t.textMuted }}>Approved by {call.approved_by}</div>}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {call.post_url && <Btn size="sm" variant="secondary" href={call.post_url} target="_blank">Post</Btn>}
          {call.form_url && <Btn size="sm" variant="secondary" href={call.form_url} target="_blank">Form</Btn>}
        </div>
      </div>

      {call.caption && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ fontSize: 12, color: t.textMuted, cursor: "pointer" }}>Caption</summary>
          <div style={{ fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap", marginTop: 6 }}>{call.caption}</div>
        </details>
      )}

      {editing && full && (
        <DraftEditor call={full} onSaved={(c) => { setFull(c); setCall(c); }} onClose={() => setEditing(false)} />
      )}
      {!editing && problems.length > 0 && <div style={{ marginTop: 12 }}><Banner tone="warning">{problems.join(" ")}</Banner></div>}

      {(rejecting || closing) && (
        <div style={{ marginTop: 12 }}>
          <Input multiline rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500}
                 placeholder={closing ? "Why it closes now (optional)." : "Why not, for the record (not a brand, an event, a duplicate…)."} />
        </div>
      )}
      {rereading && (
        <div style={{ marginTop: 12 }}>
          <Input multiline rows={3} value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={5000}
                 placeholder="Paste the caption if the stored one is missing or wrong (optional)." />
        </div>
      )}
      {error && <div style={{ marginTop: 12 }}><Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner></div>}

      {!editing && (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          {rejecting || closing || rereading ? <>
            <Btn variant="secondary" onClick={() => { setRejecting(false); setClosing(false); setRereading(false); setReason(""); setError(null); }} disabled={!!busy}>Cancel</Btn>
            {rejecting && <Btn variant="danger" onClick={() => decide("reject")} loading={busy === "reject"}>Reject</Btn>}
            {closing && <Btn variant="danger" onClick={() => decide("close")} loading={busy === "close"}>Close the campaign</Btn>}
            {rereading && <Btn onClick={reread} loading={busy === "read"}>Read again</Btn>}
          </> : <>
            {["draft", "rejected", "failed"].includes(call.status) && <Btn variant="secondary" onClick={() => setRereading(true)}>Read again</Btn>}
            {["draft", "rejected", "live"].includes(call.status) && <Btn variant="secondary" onClick={edit}>{call.status === "live" ? "Edit live campaign" : "Check and edit"}</Btn>}
            {call.status === "draft" && <Btn variant="secondary" onClick={() => setRejecting(true)}>Reject</Btn>}
            {call.status === "live" && <Btn variant="secondary" onClick={() => setClosing(true)}>Close</Btn>}
            {["draft", "rejected"].includes(call.status) && <Btn onClick={() => decide("approve")} loading={busy === "approve"}>Approve</Btn>}
          </>}
        </div>
      )}
    </Card>
  );
}

function Pager({ total, offset, setOffset, size = PAGE }) {
  const { theme: t } = useTheme();
  if (total <= size) return null;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, fontSize: 12, color: t.textMuted }}>
      <span>{`${offset + 1}–${Math.min(offset + size, total)} of ${total}`}</span>
      <div style={{ display: "flex", gap: 6 }}>
        <Btn size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - size))}>Previous</Btn>
        <Btn size="sm" variant="secondary" disabled={offset + size >= total} onClick={() => setOffset(offset + size)}>Next</Btn>
      </div>
    </div>
  );
}

function Submissions({ status, brand, onNotice }) {
  const { theme: t } = useTheme();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getExternalSubmissions({ status, brand, limit: PAGE, offset });
      setRows(r.items || []);
      setTotal(r.total || 0);
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [status, brand, offset]);
  useEffect(() => { load(); }, [load]);
  const act = async (row, action) => {
    setBusy(`${row.id}:${action}`);
    try {
      const r = await api.actOnExternalSubmission(row.id, action);
      onNotice(action === "dismiss" ? "Dismissed." : r.status === "held" ? "Google still didn’t confirm it. It stays held." : "Sent: Google confirmed it.");
      load();
    } catch (e) { setError(e.message); }
    finally { setBusy(""); }
  };
  return (
    <div>
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      {loading && rows.length === 0 && <Card style={{ padding: 20 }}><Skeleton width="100%" height={40} /></Card>}
      {!loading && rows.length === 0 && (
        <Card style={{ padding: 20, color: t.textMuted, fontSize: 13 }}>
          {status === "held" ? "Nothing held. Every application Google was asked about was confirmed." : "No applications yet."}
        </Card>
      )}
      {rows.length > 0 && (
        <Card style={{ padding: "4px 20px" }}>
          {rows.map((r) => (
            <div key={r.id} style={{ display: "flex", gap: 12, alignItems: "center", padding: "12px 0", borderTop: `1px solid ${t.border}`, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{r.creator_name || r.creator_email}</div>
                <div style={{ fontSize: 12, color: t.textMuted }}>
                  {[r.creator_handle && `@${r.creator_handle}`, r.creator_email].filter(Boolean).join(" · ")}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 200, fontSize: 13 }}>
                <div>{r.brand_name}{r.product_title ? ` · ${r.product_title}` : ""}</div>
                <div style={{ fontSize: 12, color: t.textMuted }}>Applied {friendlyDate(r.created)}{r.attempts > 1 ? ` · ${r.attempts} tries` : ""}</div>
                {r.last_error && <div style={{ fontSize: 12, color: t.danger }}>{r.last_error}</div>}
              </div>
              <Tag color={r.status === "held" ? "#B45309" : r.status === "sent" ? "#16A34A" : undefined}>{SUBMISSION_LABELS[r.status] || r.status}</Tag>
              {r.status === "held" && (
                <div style={{ display: "flex", gap: 6 }}>
                  <Btn size="sm" variant="secondary" onClick={() => act(r, "dismiss")} loading={busy === `${r.id}:dismiss`} disabled={!!busy}>Dismiss</Btn>
                  <Btn size="sm" onClick={() => act(r, "retry")} loading={busy === `${r.id}:retry`} disabled={!!busy}>Retry</Btn>
                </div>
              )}
            </div>
          ))}
        </Card>
      )}
      <Pager total={total} offset={offset} setOffset={setOffset} />
    </div>
  );
}

function Brands({ onOpen }) {
  const { theme: t } = useTheme();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getExternalCallBrands({ limit: PAGE, offset });
      setRows(r.items || []);
      setTotal(r.total || 0);
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [offset]);
  useEffect(() => { load(); }, [load]);
  return (
    <div>
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      {loading && rows.length === 0 && <Card style={{ padding: 20 }}><Skeleton width="100%" height={40} /></Card>}
      {!loading && rows.length === 0 && <Card style={{ padding: 20, color: t.textMuted, fontSize: 13 }}>No published calls yet.</Card>}
      {rows.length > 0 && (
        <Card style={{ padding: "4px 20px" }}>
          {rows.map((b) => (
            <div key={b.handle} style={{ display: "flex", gap: 12, alignItems: "center", padding: "12px 0", borderTop: `1px solid ${t.border}`, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{b.brand_name || `@${b.handle}`}</div>
                <div style={{ fontSize: 12, color: t.textMuted }}>{[`@${b.handle}`, b.website].filter(Boolean).join(" · ")}</div>
              </div>
              <div style={{ fontSize: 13, minWidth: 220 }}>
                {`${b.applicants} applied · ${b.calls} ${b.calls === 1 ? "call" : "calls"}, ${b.live_calls} live`}
                {b.last_applied_at && <div style={{ fontSize: 12, color: t.textMuted }}>Last applied {friendlyDate(b.last_applied_at)}</div>}
              </div>
              <Btn size="sm" variant="secondary" onClick={() => onOpen(b.handle)} disabled={!b.applicants}>Applicants</Btn>
            </div>
          ))}
        </Card>
      )}
      <Pager total={total} offset={offset} setOffset={setOffset} />
    </div>
  );
}

export default function ExternalCallsPage() {
  const { theme: t } = useTheme();
  const [tab, setTab] = useState("draft");
  const [source, setSource] = useState("");
  const [brand, setBrand] = useState("");
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [available, setAvailable] = useState(true);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const isCalls = CALL_TABS.some((c) => c.value === tab);

  const load = useCallback(async () => {
    if (!isCalls) return;
    setLoading(true);
    try {
      const r = await api.getExternalCalls({ status: tab, source, limit: PAGE, offset });
      setAvailable(r.available !== false);
      setReason(r.reason || "");
      setRows(r.items || []);
      setTotal(r.total || 0);
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [tab, source, offset, isCalls]);
  useEffect(() => { load(); }, [load]);

  const done = (message) => {
    setNotice(message);
    if (rows.length === 1 && offset > 0) setOffset(Math.max(0, offset - PAGE));
    else load();
  };
  const go = (value) => { setTab(value); setOffset(0); setNotice(null); setBrand(""); };
  const current = CALL_TABS.find((c) => c.value === tab);

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 22, fontWeight: 600 }}>Campaigns from calls</div>
        <div style={{ fontSize: 13, color: t.textMuted, marginTop: 4 }}>
          Brands’ Instagram calls with a Google Form, published as campaigns. Creators apply in Linkable and we fill the brand’s form.
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {CALL_TABS.map((c) => (
            <Btn key={c.value} size="sm" variant={c.value === tab ? "solid" : "secondary"} onClick={() => go(c.value)}>{c.label}</Btn>
          ))}
          <Btn size="sm" variant={tab === "held" ? "solid" : "secondary"} onClick={() => go("held")}>Held</Btn>
          <Btn size="sm" variant={tab === "brands" ? "solid" : "secondary"} onClick={() => go("brands")}>Brands</Btn>
        </div>
        <HelpTip title="Campaigns from calls"><HelpList items={HELP} /></HelpTip>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {isCalls && (
            <div style={{ width: 200 }}>
              <Select value={source} onChange={(v) => { setSource(v); setOffset(0); }}
                      options={[["", "Every source"], ["agent", "Found by the agent"], ["manual", "Added manually"]]} />
            </div>
          )}
          {isCalls && <Btn size="sm" variant="secondary" onClick={load} disabled={loading}>Refresh</Btn>}
        </div>
      </div>

      <div style={{ display: "flex", marginBottom: 12 }}>
        <AddCall onAdded={(c) => { setNotice(`Reading the call from @${c.owner_handle || "the brand"}. It shows in To review in a minute, or in Couldn’t use with the reason.`); go("reading"); }} />
      </div>

      {!available && <Banner tone="warning">{reason || "Campaigns from calls aren't available on this server."}</Banner>}
      {notice && <Banner onDismiss={() => setNotice(null)}>{notice}</Banner>}
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}

      {tab === "held" && <Submissions status="held" onNotice={setNotice} />}
      {tab === "brands" && !brand && <Brands onOpen={(handle) => setBrand(handle)} />}
      {tab === "brands" && brand && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <Btn size="sm" variant="secondary" onClick={() => setBrand("")}>All brands</Btn>
            <span style={{ fontWeight: 600 }}>Applicants to @{brand}</span>
          </div>
          <Submissions status="" brand={brand} onNotice={setNotice} />
        </div>
      )}

      {isCalls && (
        <>
          {!loading && <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 10 }}>{`${total} ${total === 1 ? "call" : "calls"}`}</div>}
          {loading && rows.length === 0 && [0, 1].map((i) => (
            <Card key={i} style={{ padding: 20, marginBottom: 12 }}>
              <Skeleton width={320} height={16} />
              <div style={{ marginTop: 16 }}><Skeleton width="100%" height={60} /></div>
            </Card>
          ))}
          {!loading && available && rows.length === 0 && (
            <Card style={{ padding: 20, color: t.textMuted, fontSize: 13 }}>{current?.empty}</Card>
          )}
          {rows.map((c) => <CallCard key={`${c.id}:${c.status}:${c.draft_json.length}`} call={c} onDone={done} />)}
          <Pager total={total} offset={offset} setOffset={setOffset} />
        </>
      )}
    </div>
  );
}
