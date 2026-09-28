import { useCallback, useEffect, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";

/**
 * Instagram DMs to brands: the page drafts, a person sends.
 *
 * Instagram does not let software open a conversation - its API only answers
 * accounts that wrote first - so the send stays human. Everything around it
 * does not have to: the brand is already found, what it asked for is already
 * read, and the message is already written from that. One card is copy, open,
 * paste, mark sent.
 *
 * One brand, one channel. A brand already handed to the email sequence is not
 * offered here, and marking one sent keeps it out of the email sequence.
 */

const VIEWS = [
  { value: "todo", label: "To send" },
  { value: "sent", label: "Sent" },
  { value: "skipped", label: "Skipped" },
];

const LANGUAGE_LABEL = { en: "English", it: "Italiano" };
const dmLink = (handle) => `https://ig.me/m/${encodeURIComponent(handle)}`;

export default function InstagramDmPage() {
  const { theme } = useTheme();
  const [view, setView] = useState("todo");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState(null);
  const [drafting, setDrafting] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      setData(await api.getInstagramDms({ view, limit: 50 }));
      setProblem(null);
    } catch (err) {
      setProblem(err?.message || "could not load the queue");
    } finally {
      setLoading(false);
    }
  }, [view]);

  useEffect(() => { load(); }, [load]);

  // Replace one lead in place, or drop it when it has left this view.
  const settle = useCallback((updated, stillHere) => {
    setData((prev) => prev && ({
      ...prev,
      leads: stillHere
        ? prev.leads.map((l) => (l.handle === updated.handle ? { ...l, ...updated } : l))
        : prev.leads.filter((l) => l.handle !== updated.handle),
    }));
    load(true);
  }, [load]);

  async function draftNext() {
    setDrafting(true);
    setNotice(null);
    try {
      const out = await api.draftInstagramDms({});
      setNotice(summarise(out));
      await load(true);
    } catch (err) {
      setNotice({ tone: "danger", text: err?.message || "could not draft" });
    } finally {
      setDrafting(false);
    }
  }

  const counts = data?.counts || {};
  const tiles = [
    { label: "To send", value: counts.todo, hint: "not yet written to" },
    { label: "Drafted", value: counts.drafted, hint: "message ready" },
    { label: "Sent today", value: counts.sentToday, hint: "marked sent since midnight" },
    { label: "Sent", value: counts.sent, hint: "all time" },
    { label: "Replied", value: counts.replied, hint: "answered on Instagram" },
  ];
  const leads = data?.leads || [];
  const undrafted = view === "todo" && leads.some((l) => !l.dm_text);

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16, maxWidth: 980 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, color: theme.text }}>Instagram DMs</h1>
        <p style={{ margin: "6px 0 0", color: theme.textMuted, fontSize: 13, maxWidth: 720 }}>
          Instagram does not let software send a first message, so this page does everything
          else. Brands that asked for creators come first. Copy the message, send it in the
          conversation that opens, then mark it sent. A brand marked sent is kept out of the
          email sequence.
        </p>
      </div>

      {problem && (
        <Card style={{ padding: 16 }}>
          <div style={{ color: theme.textMuted, fontSize: 13 }}>
            <strong style={{ color: theme.text }}>Not set up yet.</strong> {problem}
          </div>
        </Card>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        {tiles.map((t) => (
          <Card key={t.label} style={{ padding: 14, marginBottom: 0 }}>
            <div style={{ color: theme.textMuted, fontSize: 12 }}>{t.label}</div>
            {loading && !data
              ? <Skeleton style={{ height: 26, width: 48, marginTop: 6 }} />
              : <div style={{ fontSize: 24, color: theme.text, fontWeight: 600 }}>{t.value ?? 0}</div>}
            <div style={{ color: theme.textMuted, fontSize: 11, marginTop: 2 }}>{t.hint}</div>
          </Card>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {VIEWS.map((v) => (
          <Btn key={v.value} size="sm" variant={view === v.value ? "solid" : "secondary"}
               onClick={() => { setView(v.value); setNotice(null); }}>
            {v.label}
          </Btn>
        ))}
        <div style={{ flex: 1 }} />
        {view === "todo" && (
          <Btn size="sm" onClick={draftNext} loading={drafting} disabled={!counts.todo}>
            Draft the next 10
          </Btn>
        )}
      </div>

      {notice && (
        <div style={{ fontSize: 13, color: notice.tone === "danger" ? theme.danger : theme.textMid }}>
          {notice.text}
        </div>
      )}

      {loading && !data ? (
        <Card><Skeleton style={{ height: 120 }} /></Card>
      ) : !leads.length ? (
        <Card style={{ padding: 16 }}>
          <div style={{ color: theme.textMuted, fontSize: 13 }}>{emptyText(view)}</div>
        </Card>
      ) : view === "todo" ? (
        <>
          {undrafted && !drafting && (
            <div style={{ fontSize: 12, color: theme.textMuted }}>
              Brands without a message yet: press Draft the next 10, or write one on its card.
            </div>
          )}
          {leads.map((lead) => (
            <DmCard key={lead.handle} lead={lead} maxChars={data?.maxChars || 500}
                    onSettled={settle} onNotice={setNotice} />
          ))}
        </>
      ) : (
        <Card style={{ padding: 0 }}>
          {leads.map((lead, i) => (
            <SentRow key={lead.handle} lead={lead} last={i === leads.length - 1}
                     onSettled={settle} onNotice={setNotice} />
          ))}
        </Card>
      )}

      {data && data.total > leads.length && (
        <div style={{ fontSize: 12, color: theme.textMuted }}>
          Showing the first {leads.length} of {data.total}. They move up as these are sent.
        </div>
      )}
    </div>
  );
}

function summarise(out) {
  const parts = [];
  if (out.drafted?.length) parts.push(`Drafted ${out.drafted.length}`);
  if (!out.drafted?.length && !out.failed?.length) parts.push("Nothing left to draft");
  if (out.costUsd) parts.push(`$${out.costUsd.toFixed(3)}`);
  if (out.failed?.length) {
    parts.push(`${out.failed.length} failed (${out.failed[0].handle}: ${out.failed[0].error})`);
  }
  return { tone: out.failed?.length && !out.drafted?.length ? "danger" : "info", text: parts.join(" · ") };
}

function emptyText(view) {
  if (view === "sent") return "Nothing sent yet.";
  if (view === "skipped") return "Nothing skipped.";
  return "No brands waiting. New ones arrive when the prospector finds them.";
}

function Tag({ children, tone }) {
  const { theme } = useTheme();
  const color = tone ? theme[tone] : theme.textMid;
  return (
    <span style={{
      fontSize: 11, padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap",
      border: `1px solid ${tone ? color : theme.border}`, color,
    }}>
      {children}
    </span>
  );
}

function DmCard({ lead, maxChars, onSettled, onNotice }) {
  const { theme } = useTheme();
  const [text, setText] = useState(lead.dm_text || "");
  const [busy, setBusy] = useState(null);
  const [copied, setCopied] = useState(false);

  // A redraft replaces the text; typing in the box does not come back here.
  useEffect(() => { setText(lead.dm_text || ""); }, [lead.dm_text]);

  const name = lead.brand_name || lead.ig_full_name || lead.handle;
  const language = lead.dm_language || lead.default_language || "en";
  const other = language === "it" ? "en" : "it";
  const dirty = text.trim() !== (lead.dm_text || "").trim();

  async function run(label, fn) {
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      onNotice({ tone: "danger", text: `@${lead.handle}: ${err?.message || "failed"}` });
    } finally {
      setBusy(null);
    }
  }

  const save = () => run("save", async () => {
    if (!dirty) return;
    onSettled(await api.updateInstagramDm(lead.handle, "edit", text), true);
  });

  const draft = (lang) => run(lang ? `draft-${lang}` : "draft", async () => {
    const out = await api.draftInstagramDms({ handles: [lead.handle], language: lang });
    if (out.failed?.length) throw new Error(out.failed[0].error);
    if (out.drafted?.[0]) onSettled(out.drafted[0], true);
  });

  // Copy first, then open: the conversation opens in another tab and the
  // message is already on the clipboard when it does.
  const copyAndOpen = () => run("copy", async () => {
    if (dirty) onSettled(await api.updateInstagramDm(lead.handle, "edit", text), true);
    await navigator.clipboard.writeText(text.trim());
    setCopied(true);
    window.open(dmLink(lead.handle), "_blank", "noopener");
  });

  const mark = (action) => run(action, async () => {
    if (action === "sent" && dirty) await api.updateInstagramDm(lead.handle, "edit", text);
    onSettled(await api.updateInstagramDm(lead.handle, action), false);
  });

  const caption = (lead.intent_caption || "").trim();

  return (
    <Card style={{ padding: 18, marginBottom: 0 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: theme.text }}>{name}</div>
          <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 2 }}>
            @{lead.handle}
            {lead.country ? ` · ${lead.country}` : ""}
            {lead.ig_category && lead.ig_category !== "None" ? ` · ${lead.ig_category}` : ""}
            {lead.ig_followers ? ` · ${lead.ig_followers.toLocaleString()} followers` : ""}
            {lead.domain ? ` · ${lead.domain}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {lead.intent_signal === "open_call" && <Tag tone="success">Asked for creators</Tag>}
          {lead.distinct_creators_90d > 0 && <Tag>{lead.distinct_creators_90d} creators posting</Tag>}
          {lead.tier && <Tag>Tier {lead.tier}</Tag>}
          {lead.email_queued && <Tag tone="warning">Queued for email</Tag>}
        </div>
      </div>

      {caption && (
        <div style={{
          marginTop: 12, padding: "8px 12px", borderLeft: `3px solid ${theme.border}`,
          color: theme.textMid, fontSize: 12, whiteSpace: "pre-wrap",
        }}>
          {caption.length > 280 ? `${caption.slice(0, 280)}…` : caption}
        </div>
      )}

      {lead.email_queued && (
        <div style={{ marginTop: 10, fontSize: 12, color: theme.warning }}>
          This brand goes to the email sequence on the next run. Marking the DM sent takes it out.
        </div>
      )}

      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setCopied(false); }}
        onBlur={save}
        rows={6}
        placeholder={busy?.startsWith("draft") ? "Writing…" : "No message yet. Draft one, or write it here."}
        aria-label={`Message to ${name}`}
        style={{
          width: "100%", marginTop: 12, padding: "10px 12px", borderRadius: 10,
          fontFamily: "inherit", fontSize: 13, lineHeight: 1.5,
          border: `1.5px solid ${theme.border}`, background: theme.bg, color: theme.text,
          resize: "vertical", boxSizing: "border-box",
        }}
      />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: theme.textMuted, marginTop: 4 }}>
        <span>{lead.dm_text ? `Drafted in ${LANGUAGE_LABEL[language] || language}` : ""}</span>
        <span style={{ color: text.length > maxChars ? theme.warning : theme.textMuted }}>
          {text.length} characters
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
        <Btn size="sm" onClick={copyAndOpen} loading={busy === "copy"} disabled={!text.trim() || Boolean(busy)}>
          {copied ? "Copied, open again" : "Copy and open DM"}
        </Btn>
        <Btn size="sm" variant="outline" onClick={() => mark("sent")} loading={busy === "sent"}
             disabled={!text.trim() || Boolean(busy)}>
          Mark sent
        </Btn>
        <div style={{ flex: 1 }} />
        <Btn size="sm" variant="secondary" onClick={() => draft()} loading={busy === "draft"} disabled={Boolean(busy)}>
          {lead.dm_text ? "Rewrite" : "Write message"}
        </Btn>
        <Btn size="sm" variant="secondary" onClick={() => draft(other)} loading={busy === `draft-${other}`}
             disabled={Boolean(busy)}>
          In {LANGUAGE_LABEL[other]}
        </Btn>
        {lead.intent_post_url && (
          <Btn size="sm" variant="secondary" href={lead.intent_post_url} target="_blank">Their post</Btn>
        )}
        <Btn size="sm" variant="secondary" href={lead.instagram_url || `https://www.instagram.com/${lead.handle}/`}
             target="_blank">
          Profile
        </Btn>
        <Btn size="sm" variant="secondary" onClick={() => mark("skip")} loading={busy === "skip"} disabled={Boolean(busy)}>
          Skip
        </Btn>
      </div>
    </Card>
  );
}

function SentRow({ lead, last, onSettled, onNotice }) {
  const { theme } = useTheme();
  const [busy, setBusy] = useState(null);
  const name = lead.brand_name || lead.ig_full_name || lead.handle;

  const act = async (action) => {
    setBusy(action);
    try {
      onSettled(await api.updateInstagramDm(lead.handle, action), action === "replied");
    } catch (err) {
      onNotice({ tone: "danger", text: `@${lead.handle}: ${err?.message || "failed"}` });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{
      display: "flex", gap: 12, alignItems: "center", padding: "12px 16px", flexWrap: "wrap",
      borderBottom: last ? "none" : `1px solid ${theme.border}`,
    }}>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>{name}</div>
        <div style={{ fontSize: 12, color: theme.textMuted }}>
          @{lead.handle}
          {lead.dm_sent_at ? ` · sent ${new Date(lead.dm_sent_at).toLocaleString()}` : ""}
          {lead.dm_sent_by ? ` by ${lead.dm_sent_by}` : ""}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end" }}>
        {lead.dm_state === "replied" && <Tag tone="success">Replied</Tag>}
        {lead.dm_state === "sent" && (
          <Btn size="sm" variant="secondary" onClick={() => act("replied")} loading={busy === "replied"}
               disabled={Boolean(busy)}>
            They replied
          </Btn>
        )}
        <Btn size="sm" variant="secondary" href={dmLink(lead.handle)} target="_blank">Open DM</Btn>
        <Btn size="sm" variant="secondary" onClick={() => act("reopen")} loading={busy === "reopen"}
             disabled={Boolean(busy)}>
          {lead.dm_state === "skipped" ? "Restore" : "Undo"}
        </Btn>
      </div>
    </div>
  );
}
