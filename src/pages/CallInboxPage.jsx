import { useState, useRef, useEffect } from "react";
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
// Batch mode: one screenshot per post, up to this many at a time, two read at once.
const MAX_BATCH = 30;
const BATCH_AT_ONCE = 2;

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


// Batch mode (Federico, 17 Nov 2026: "ci metto 5 min per campagna"): one
// screenshot per post and nothing else. Each card reads its screenshot,
// finds the post on the account's profile by its caption, then adds it the
// way the single add does. When the post can't be found, the card asks for
// its link and keeps what it read.
const STEP = {
  queued: "Waiting",
  reading: "Reading the screenshot…",
  finding: "Finding the post on Instagram…",
  adding: "Adding…",
  need_link: "We couldn't find this post. Paste its link.",
  added: "",
  error: "",
};

function BatchCalls() {
  const { theme: t } = useTheme();
  const [items, setItems] = useState([]);
  const running = useRef(0);
  const started = useRef(new Set());
  const fileRef = useRef(null);

  const patch = (id, change) => setItems((list) => list.map((it) => (it.id === id ? { ...it, ...change } : it)));

  const add = async (it, postUrl, found, fromLink = false) => {
    patch(it.id, { state: "adding", error: null });
    const f = it.facts || {};
    let res;
    try {
      res = await api.addCallFromPhone({
      post_url: postUrl,
      caption: found?.caption || f.caption || "",
      instagram: f.handle || "",
      form_url: f.google_form_url || "",
      brand_name: f.brand_name || found?.full_name || "",
      website: f.website || found?.website || "",
      contact_email: f.contact_email || "",
      not_a_call: f.is_creator_call === false,
      });
    } catch (err) {
      patch(it.id, fromLink ? { state: "need_link" } : { state: "error", error: err.message });
      throw err;
    }
    patch(it.id, { state: "added", result: res });
  };

  const work = async (it) => {
    try {
      patch(it.id, { state: "reading" });
      const facts = await api.readCallScreenshot({ media_type: it.media_type, data: it.data });
      patch(it.id, { facts, state: "finding" });
      const found = facts.handle ? await api.findCallPost(facts.handle, facts.caption) : { post_url: "" };
      if (!found.post_url) {
        patch(it.id, { state: "need_link", found });
        return;
      }
      await add({ ...it, facts }, found.post_url, found);
    } catch (err) {
      patch(it.id, { state: "error", error: err.message });
    }
  };

  // Two cards at a time, in the order they were added.
  useEffect(() => {
    for (const next of items.filter((it) => it.state === "queued" && !started.current.has(`${it.id}:${it.tries || 0}`))) {
      if (running.current >= BATCH_AT_ONCE) break;
      started.current.add(`${next.id}:${next.tries || 0}`);
      running.current++;
      work(next).finally(() => {
        running.current--;
        setItems((list) => [...list]);
      });
    }
    // work only patches items by id; re-running on each change is the queue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const pick = async (e) => {
    const files = Array.from(e.target.files || []).slice(0, MAX_BATCH);
    e.target.value = "";
    const shrunk = await Promise.all(files.map((f) => shrink(f).catch(() => null)));
    const stamp = Date.now();
    setItems((list) => [
      ...shrunk.filter(Boolean).map((s, i) => ({ id: `${stamp}-${i}`, ...s, state: "queued" })),
      ...list,
    ]);
  };

  const muted = { fontSize: 13, color: t.textMuted, lineHeight: 1.45 };
  const done = items.filter((it) => it.state === "added").length;
  const busy = items.filter((it) => ["queued", "reading", "finding", "adding"].includes(it.state)).length;
  return (
    <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Screenshots only</div>
        <div style={{ ...muted, marginTop: 4 }}>
          One screenshot per post, showing the account's handle and the start of the caption. Pick as many as you like:
          we find each post on Instagram ourselves and add it. Keep this page open while it works.
        </div>
      </div>
      <Btn onClick={() => fileRef.current?.click()} style={{ width: "100%" }}>Pick screenshots</Btn>
      <input ref={fileRef} type="file" accept="image/*" multiple onChange={pick} style={{ display: "none" }} />
      {items.length > 0 && (
        <div style={muted}>{done} added{busy ? ` · ${busy} in progress` : ""}{items.length - done - busy ? ` · ${items.length - done - busy} need you` : ""}</div>
      )}
      {items.map((it) => <BatchCard key={it.id} it={it} onLink={add} onRetry={() => patch(it.id, { state: "queued", error: null, tries: (it.tries || 0) + 1 })} />)}
    </Card>
  );
}

function BatchCard({ it, onLink, onRetry }) {
  const { theme: t } = useTheme();
  const [link, setLink] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const k = it.result ? KIND[it.result.kind] || KIND.signal : null;
  const who = it.facts?.handle ? `@${it.facts.handle}` : "Screenshot";
  const muted = { fontSize: 13, color: t.textMuted, lineHeight: 1.45 };

  const saveLink = async () => {
    setSaving(true);
    setError(null);
    try { await onLink(it, link.trim(), it.found, true); }
    catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ display: "flex", gap: 10, padding: 10, border: `1px solid ${t.border}`, borderRadius: 12 }}>
      <img src={it.preview} alt="" style={{ width: 48, height: 84, objectFit: "cover", borderRadius: 8, flexShrink: 0 }} />
      <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{who}</div>
        {it.state === "added" && k ? (
          <>
            <div style={muted}>
              {k.label}
              {it.facts?.is_creator_call === false ? " · the screenshot didn’t look like a call for creators: check it" : ""}
            </div>
            <Link to={k.where} style={{ fontSize: 13, fontWeight: 600, color: t.text }}>{k.review}</Link>
          </>
        ) : it.state === "error" ? (
          <>
            <div style={{ ...muted, color: t.danger || t.text }}>{it.error}</div>
            <Btn variant="secondary" onClick={onRetry}>Try again</Btn>
          </>
        ) : it.state === "need_link" ? (
          <>
            <div style={muted}>{STEP.need_link}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://www.instagram.com/p/…"
                     inputMode="url" autoCapitalize="off" autoCorrect="off" />
              <Btn variant="secondary" onClick={saveLink} loading={saving} disabled={!link.trim()}>Add</Btn>
            </div>
            {error && <div style={{ ...muted, color: t.danger || t.text }}>{error}</div>}
          </>
        ) : (
          <div style={muted}>{STEP[it.state]}</div>
        )}
      </div>
    </div>
  );
}

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
          With a Google Form a post goes to Campaigns from calls, otherwise it becomes a Pitch signal draft. Nothing goes live until you approve it.
        </div>
      </div>

      <BatchCalls />

      <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>One post by its link</div>
          <div style={{ ...muted, marginTop: 4 }}>
            In Instagram tap Share, then Copy link, and paste it here. Add screenshots when our agent may not have seen the post.
          </div>
        </div>
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
