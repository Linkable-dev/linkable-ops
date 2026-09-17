import { useEffect, useMemo, useState } from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { api } from "../../lib/api";
import { Modal } from "../ui/Modal";
import { Btn } from "../ui/Button";

/**
 * Putting content into a campaign, for a brand.
 *
 * Both of these act on a brand's behalf, which is a different kind of write
 * from the rest of this panel. The cases are real and constant: a creator
 * emails a file instead of uploading it, or a brand asks us to run a
 * generation. Doing either by hand meant a psql insert and a gsutil cp.
 *
 * Nothing is marked as ops-uploaded: a file a creator sent by email IS that
 * creator's delivery, and a row saying otherwise would make the brand's own
 * library lie about what it has. Who did it is in the log, with an email.
 */

function field(theme) {
  return {
    width: "100%", height: 34, padding: "0 10px", borderRadius: 8,
    border: `1px solid ${theme.border}`, background: theme.surface, color: theme.text,
    fontSize: 13, fontFamily: "inherit",
  };
}

function label(theme) {
  return {
    display: "block", fontSize: 11, fontWeight: 600, textTransform: "uppercase",
    letterSpacing: 0.4, color: theme.textMuted, marginBottom: 5,
  };
}

function creatorOf(link) {
  if (link.instagram_username) return `@${link.instagram_username}`;
  const name = [link.first_name, link.last_name].filter(Boolean).join(" ").trim();
  return name || "a creator";
}

/** Upload one file as the creator on a link. */
export function UploadModal({ onClose, onUploaded }) {
  const { theme } = useTheme();
  const [links, setLinks] = useState([]);
  const [linkId, setLinkId] = useState("");
  const [file, setFile] = useState(null);
  const [progress, setProgress] = useState(-1);
  const [error, setError] = useState("");

  // Mounted fresh each time the button is pressed (the page renders it only
  // while it is open), so there is nothing to reset here — just the one read.
  useEffect(() => {
    api.getContentLinks().then((d) => setLinks(d.links || [])).catch((e) => setError(e.message));
  }, []);

  const chosen = useMemo(() => links.find((l) => l.link_id === linkId), [links, linkId]);

  async function upload() {
    if (!file || !linkId) return;
    setError("");
    setProgress(0);
    try {
      // Signed first, then PUT straight to storage: the bytes never pass
      // through the panel, which has a request-body ceiling far under the
      // videos creators actually send.
      const { url, file_name } = await api.getContentUploadUrl({
        link_id: linkId, file_name: file.name, content_type: file.type || "application/octet-stream",
      });
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", url);
        xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
        // fetch() cannot report upload progress, and a 70MB video with no bar
        // is indistinguishable from a page that has hung.
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`Storage refused it (${xhr.status})`)));
        xhr.onerror = () => reject(new Error("The upload could not reach storage"));
        xhr.send(file);
      });
      // Only now does it exist as far as the brand is concerned — the row is
      // what the library reads.
      await api.recordContentUpload({ link_id: linkId, file_name, size_bytes: file.size });
      setProgress(-1);
      setFile(null);
      onUploaded?.();
      onClose?.();
    } catch (e) {
      setProgress(-1);
      setError(e.message);
    }
  }

  return (
    <Modal open onClose={onClose} title="Upload delivered content" width={560}>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ color: theme.textMuted, fontSize: 12, lineHeight: 1.6 }}>
          For a file a creator sent you outside the app. It lands in their campaign exactly as
          their own upload would, and the brand sees it as delivered by them.
        </div>

        <div>
          <span style={label(theme)}>Campaign and creator</span>
          <select style={field(theme)} value={linkId} onChange={(e) => setLinkId(e.target.value)}>
            <option value="">Pick one…</option>
            {links.map((l) => (
              <option key={l.link_id} value={l.link_id}>
                {l.campaign_title || "(untitled)"} — {creatorOf(l)}
                {l.brand_name ? ` · ${l.brand_name.trim()}` : ""}
                {l.files ? ` · ${l.files} already` : ""}
              </option>
            ))}
          </select>
        </div>

        <div>
          <span style={label(theme)}>File</span>
          <input
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            style={{ ...field(theme), height: "auto", padding: 8 }}
          />
          {file && (
            <div style={{ color: theme.textMuted, fontSize: 12, marginTop: 6 }}>
              {file.name} · {file.size > 1048576
                ? `${(file.size / 1048576).toFixed(1)} MB`
                : `${Math.round(file.size / 1024)} KB`}
            </div>
          )}
        </div>

        {progress >= 0 && (
          <div>
            <div style={{ height: 6, borderRadius: 999, background: theme.surfaceAlt, overflow: "hidden" }}>
              <div style={{ width: `${progress}%`, height: "100%", background: theme.text, transition: "width .2s" }} />
            </div>
            <div style={{ color: theme.textMuted, fontSize: 12, marginTop: 6 }}>
              {progress < 100 ? `Uploading — ${progress}%` : "Indexing…"}
            </div>
          </div>
        )}

        {error && <div style={{ color: "#B91C1C", fontSize: 13 }}>{error}</div>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn size="sm" variant="outline" onClick={onClose}>Cancel</Btn>
          <Btn size="sm" disabled={!file || !linkId || progress >= 0} onClick={upload}>
            {chosen ? `Upload as ${creatorOf(chosen)}` : "Upload"}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

const SUBJECTS = [
  ["product", "The product alone", "No people in the frame, and nobody's permission to wait for."],
  ["avatar", "An AI creator", "Someone we invented, from the roster. Needs rendered plates."],
  ["creator", "A real creator", "Only with their consent on file — the service checks, and refuses."],
];

/** Ask the content service for creatives, as the brand would. */
export function GenerateModal({ onClose, onQueued }) {
  const { theme } = useTheme();
  const [campaigns, setCampaigns] = useState([]);
  const [avatars, setAvatars] = useState([]);
  const [links, setLinks] = useState([]);
  const [productId, setProductId] = useState("");
  const [subject, setSubject] = useState("product");
  const [avatarId, setAvatarId] = useState("");
  const [creatorId, setCreatorId] = useState("");
  const [quantity, setQuantity] = useState(2);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.getContentFilters().then((d) => setCampaigns(d.campaigns || [])).catch(() => {});
    api.getAiCreators()
      // Only a creator with plates can be generated with; the rest would fail
      // every job they were given.
      .then((d) => setAvatars((d.avatars || []).filter((a) => a.plate_count > 0)))
      .catch(() => {});
  }, []);

  // The creators to offer are the ones actually on that campaign.
  useEffect(() => {
    if (!productId) return;
    api.getContentLinks({ product: productId })
      .then((d) => setLinks(d.links || []))
      .catch(() => {});
  }, [productId]);

  async function generate() {
    setBusy(true);
    setError("");
    try {
      const d = await api.generateContent({
        product_id: productId,
        subject,
        quantity,
        notes,
        ...(subject === "avatar" ? { avatar_id: avatarId } : {}),
        ...(subject === "creator" ? { creator_id: creatorId, creator_source: "influencer" } : {}),
      });
      onQueued?.(d.request);
      onClose?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const ready = productId
    && (subject !== "avatar" || avatarId)
    && (subject !== "creator" || creatorId);

  return (
    <Modal open onClose={onClose} title="Generate content" width={560}>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ color: theme.textMuted, fontSize: 12, lineHeight: 1.6 }}>
          Runs the same generation a brand's own studio runs, against this campaign. It spends —
          a model call per image, GPU time for video — and what comes back appears in the
          Generated tab as drafts.
        </div>

        <div>
          <span style={label(theme)}>Campaign</span>
          <select style={field(theme)} value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">Pick one…</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
          {campaigns.length === 0 && (
            <div style={{ color: theme.textMuted, fontSize: 12, marginTop: 6 }}>
              The list holds campaigns that already have content. Any campaign can be generated
              for — paste its product id if it is not here.
            </div>
          )}
        </div>

        <div>
          <span style={label(theme)}>Who is in it</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {SUBJECTS.map(([value, title, why]) => (
              <button
                key={value}
                onClick={() => setSubject(value)}
                style={{
                  textAlign: "left", padding: "8px 10px", borderRadius: 8, cursor: "pointer",
                  border: `1px solid ${subject === value ? theme.text : theme.border}`,
                  background: subject === value ? theme.accentLight : "transparent",
                  color: theme.text, fontFamily: "inherit",
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
                <div style={{ fontSize: 12, color: theme.textMuted }}>{why}</div>
              </button>
            ))}
          </div>
        </div>

        {subject === "avatar" && (
          <div>
            <span style={label(theme)}>Which AI creator</span>
            <select style={field(theme)} value={avatarId} onChange={(e) => setAvatarId(e.target.value)}>
              <option value="">Pick one…</option>
              {avatars.map((a) => (
                <option key={a.id} value={a.id}>{a.name} · {a.archetype}</option>
              ))}
            </select>
            {avatars.length === 0 && (
              <div style={{ color: "#B45309", fontSize: 12, marginTop: 6 }}>
                Nobody on the roster has rendered plates yet — cast and render one under AI
                creators first.
              </div>
            )}
          </div>
        )}

        {subject === "creator" && (
          <div>
            <span style={label(theme)}>Which creator</span>
            <select style={field(theme)} value={creatorId} onChange={(e) => setCreatorId(e.target.value)}>
              <option value="">Pick one…</option>
              {links.map((l) => (
                <option key={l.link_id} value={l.creator_user_id}>{creatorOf(l)}</option>
              ))}
            </select>
            <div style={{ color: theme.textMuted, fontSize: 12, marginTop: 6 }}>
              Their consent is checked by the service, not here: without it the request is refused
              and nothing is spent.
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ width: 110 }}>
            <span style={label(theme)}>How many</span>
            <select style={field(theme)} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))}>
              {[1, 2, 3, 4, 6, 8].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <span style={label(theme)}>Anything to say about it</span>
            <input
              style={field(theme)}
              placeholder="Optional — a scene, a mood, a thing to avoid"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        {error && <div style={{ color: "#B91C1C", fontSize: 13 }}>{error}</div>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn size="sm" variant="outline" onClick={onClose}>Cancel</Btn>
          <Btn size="sm" loading={busy} disabled={!ready} onClick={generate}>
            Generate {quantity}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}
