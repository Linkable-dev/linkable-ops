import { useState, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTheme } from "../contexts/ThemeContext";
import { api } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Banner } from "../components/pitch/PitchParts";

// Add calls from the phone (Federico, 16 Nov 2026): one Instagram post at a
// time. The link (Share, Copy link) and, when our agent never saw the post,
// its screenshots. Claude reads them on the server (server/lib/callInbox.js);
// a Google Form sends the post to Campaigns from calls, anything else becomes
// a Pitch signal draft. Both wait for an Approve.

const MAX_SHOTS = 4;
const MAX_SIDE = 1600;

// A phone screenshot as a JPEG small enough to send (about 300 KB).
function shrink(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
      resolve({ media_type: "image/jpeg", data: dataUrl.split(",")[1], preview: dataUrl });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't a photo we can read.")); };
    img.src = url;
  });
}

const KIND = {
  campaign: { label: "Campaign from a call", where: "/ops/calls", review: "Review in Campaigns from calls" },
  signal: { label: "Pitch signal draft", where: "/ops/pitch/signals", review: "Review in Pitch signals" },
};

export default function CallInboxPage() {
  const { theme: t } = useTheme();
  const [params] = useSearchParams();
  const [link, setLink] = useState(params.get("url") || "");
  const [shots, setShots] = useState([]);
  const [more, setMore] = useState(false);
  const [form, setForm] = useState("");
  const [caption, setCaption] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [added, setAdded] = useState([]);
  const fileRef = useRef(null);

  const paste = async () => {
    try { setLink((await navigator.clipboard.readText()).trim()); }
    catch { setError("Your browser didn't let us read the clipboard. Long-press the field and paste."); }
  };

  const pick = async (e) => {
    const files = Array.from(e.target.files || []).slice(0, MAX_SHOTS - shots.length);
    e.target.value = "";
    try { setShots([...shots, ...(await Promise.all(files.map(shrink)))]); }
    catch (err) { setError(err.message); }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.addCallFromPhone({
        post_url: link,
        images: shots.map(({ media_type, data }) => ({ media_type, data })),
        form_url: form, caption,
      });
      setAdded([res, ...added]);
      setLink(""); setShots([]); setForm(""); setCaption(""); setMore(false);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const muted = { fontSize: 13, color: t.textMuted, lineHeight: 1.45 };
  return (
    <div style={{ maxWidth: 560, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ fontSize: 22, fontWeight: 600 }}>Add calls</div>
        <div style={{ ...muted, marginTop: 4 }}>
          One Instagram post at a time. In Instagram tap Share, then Copy link, and paste it here. Add screenshots of the post
          when our agent may not have seen it: we read the handle, caption, Google Form, website and email from them.
          With a Google Form it goes to Campaigns from calls, otherwise it becomes a Pitch signal draft. Nothing goes live until you approve it.
        </div>
      </div>

      <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Instagram post link</div>
          <div style={{ display: "flex", gap: 8 }}>
            <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://www.instagram.com/p/…"
                   inputMode="url" autoCapitalize="off" autoCorrect="off" />
            <Btn variant="secondary" onClick={paste}>Paste</Btn>
          </div>
        </div>

        <div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Screenshots (optional, up to {MAX_SHOTS})</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {shots.map((s, i) => (
              <button key={i} type="button" onClick={() => setShots(shots.filter((_, j) => j !== i))} title="Remove"
                      style={{ padding: 0, border: `1px solid ${t.border}`, borderRadius: 10, background: "none", cursor: "pointer" }}>
                <img src={s.preview} alt="" style={{ width: 64, height: 112, objectFit: "cover", borderRadius: 10, display: "block" }} />
              </button>
            ))}
            {shots.length < MAX_SHOTS && (
              <Btn variant="secondary" onClick={() => fileRef.current?.click()}>{shots.length ? "Add another" : "Add screenshots"}</Btn>
            )}
            <input ref={fileRef} type="file" accept="image/*" multiple onChange={pick} style={{ display: "none" }} />
          </div>
          {shots.length > 0 && <div style={{ ...muted, marginTop: 6 }}>Tap a screenshot to remove it.</div>}
        </div>

        {more ? (
          <>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Google Form link (if the screenshot doesn’t show it)</div>
              <Input value={form} onChange={(e) => setForm(e.target.value)} placeholder="https://forms.gle/…" inputMode="url" autoCapitalize="off" />
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Caption (if you’d rather paste it)</div>
              <Input multiline rows={3} value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={5000} />
            </div>
          </>
        ) : (
          <button type="button" onClick={() => setMore(true)}
                  style={{ alignSelf: "flex-start", background: "none", border: "none", padding: 0, color: t.textMuted, fontSize: 13, cursor: "pointer", textDecoration: "underline" }}>
            Add a form link or caption by hand
          </button>
        )}

        {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
        <Btn onClick={submit} loading={busy} disabled={!link.trim()} style={{ width: "100%" }}>
          {busy && shots.length ? "Reading the screenshots…" : "Add"}
        </Btn>
      </Card>

      {added.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Added now ({added.length})</div>
          {added.map((a) => {
            const k = KIND[a.kind] || KIND.signal;
            const who = a.read?.handle ? `@${a.read.handle}` : a.post_url;
            return (
              <Card key={`${a.kind}-${a.id}`} style={{ padding: 14, display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{who}</div>
                <div style={muted}>
                  {k.label}
                  {a.read?.has_caption ? "" : " · no caption yet: the agent fills it if it saw the post"}
                  {a.read?.not_a_call ? " · the screenshot didn’t look like a call for creators: check it" : ""}
                </div>
                <Link to={k.where} style={{ fontSize: 13, fontWeight: 600, color: t.text }}>{k.review}</Link>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
