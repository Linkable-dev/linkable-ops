// Outside agents: reaching brands, creators and partners outside the app.
//
// Three lists. Listening is public posts where a brand asks for creators or a
// creator asks for brands, found each day on LinkedIn, Reddit, TikTok, X,
// Facebook, Threads and YouTube. Posts are for Linkable's own accounts, from
// the day's blog article. Partners are people who already have the audience.
// Each item comes with a draft; a person copies it, posts or sends it, and
// marks it done. Nothing here is posted or sent by a machine: the platforms
// forbid automated messages to strangers.

import { useCallback, useEffect, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api, friendlyDate } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Toggle } from "../components/ui/Toggle";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { ListPager, Tag } from "../components/gtm/QueueParts";
import { SkeletonListRows } from "../components/ui/Skeleton";

const TABS = [
  { kind: "signal", label: "Listening", empty: "No new posts to answer. The next search runs tomorrow morning." },
  { kind: "post", label: "Posts", empty: "No post waiting. A new one is written from each day's article." },
  { kind: "partner", label: "Partners", empty: "No new partner to write to. The next search runs tomorrow morning." },
];
const STATES = [["new", "To do"], ["done", "Done"], ["dismissed", "Not relevant"]];
const PLATFORM = {
  linkedin: "LinkedIn", reddit: "Reddit", tiktok: "TikTok", x: "X", facebook: "Facebook", threads: "Threads",
  youtube: "YouTube", instagram: "Instagram", community: "Community", newsletter: "Newsletter",
  agency: "Agency", coach: "Coach",
};
// Where a post of ours is published from.
const COMPOSE = {
  linkedin: (text) => `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(text)}`,
  instagram: () => "https://www.instagram.com/",
  tiktok: () => "https://www.tiktok.com/upload",
};
const PAGE_SIZE = 10;

function Item({ item, theme, onChanged, onError }) {
  const [text, setText] = useState(item.draft_text || "");
  const [busy, setBusy] = useState("");
  const [copied, setCopied] = useState(false);
  const dirty = text.trim() !== (item.draft_text || "").trim();
  const isPartner = item.kind === "partner";
  const isPost = item.kind === "post";
  const open = item.state === "new";

  async function act(action, extra = {}) {
    setBusy(action);
    try { onChanged(await api.actOutside(item.id, { action, ...extra }), action); }
    catch (e) { onError(`We couldn't save that: ${e.message}`); }
    finally { setBusy(""); }
  }

  // Copy, then open where it goes: the post to answer, our own composer, or
  // an email to the partner. The person presses send there.
  async function copyAndOpen() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2500); }
    catch { onError("We couldn't copy the text. Select it and copy it yourself."); return; }
    const target = isPartner
      ? (item.email
        ? `mailto:${item.email}?subject=${encodeURIComponent(item.draft_subject || "")}&body=${encodeURIComponent(text)}`
        : item.url)
      : isPost ? (COMPOSE[item.platform] || (() => item.url))(text) : item.url;
    window.open(target, "_blank", "noopener");
  }

  const goLabel = isPartner ? (item.email ? "Copy and open email" : "Copy and open their site")
    : isPost ? `Copy and open ${PLATFORM[item.platform] || "it"}` : "Copy and open the post";

  return (
    <div style={{ padding: "14px 16px", borderBottom: `1px solid ${theme.border}`, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <Tag>{PLATFORM[item.platform] || item.platform}</Tag>
        {item.kind === "signal" && <Tag tone={item.side === "brand" ? "success" : undefined}>{item.side === "brand" ? "Brand asking for creators" : "Creator asking for brands"}</Tag>}
        <span style={{ fontSize: 11, color: theme.textMuted }}>
          {item.posted_at ? `posted ${friendlyDate(item.posted_at)}` : `found ${friendlyDate(item.found_at)}`}
        </span>
        {isPartner && <span style={{ fontSize: 11, color: theme.textMuted }}>{item.email || "no address on their site"}</span>}
      </div>
      <a href={isPost ? item.meta?.article_url || item.url : item.url} target="_blank" rel="noopener noreferrer"
         style={{ fontSize: 13, fontWeight: 600, color: theme.text, textDecoration: "none" }}>
        {item.title || item.url}
      </a>
      {item.snippet && <div style={{ fontSize: 12.5, color: theme.textMid, lineHeight: 1.5 }}>{item.snippet}</div>}

      {isPartner && item.draft_subject && (
        <div style={{ fontSize: 12, color: theme.textMuted }}>Subject: <span style={{ color: theme.text }}>{item.draft_subject}</span></div>
      )}
      {item.draft_text || !open ? (
        <textarea value={text} onChange={(e) => setText(e.target.value)} readOnly={!open}
                  rows={Math.min(16, Math.max(4, text.split("\n").length + Math.ceil(text.length / 130)))}
                  aria-label="Draft"
                  style={{
                    width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 10, resize: "vertical",
                    border: `1px solid ${theme.border}`, background: theme.bg, color: theme.text,
                    fontSize: 13, lineHeight: 1.5, fontFamily: "inherit",
                  }} />
      ) : (
        <div style={{ fontSize: 12.5, color: theme.textMuted }}>The draft is being written. Press Write drafts now, or come back in a minute.</div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {open ? (
          <>
            <Btn size="sm" disabled={!text.trim()} onClick={copyAndOpen}>{copied ? "Copied" : goLabel}</Btn>
            {dirty && <Btn size="sm" variant="secondary" loading={busy === "save"} onClick={() => act("save", { text })}>Save changes</Btn>}
            <Btn size="sm" variant="secondary" loading={busy === "done"} onClick={() => act("done")}>
              {isPartner ? "Mark sent" : "Mark posted"}
            </Btn>
            <Btn size="sm" variant="secondary" loading={busy === "dismiss"} onClick={() => act("dismiss")}>Not relevant</Btn>
          </>
        ) : (
          <>
            <span style={{ fontSize: 12, color: theme.textMuted }}>
              {item.state === "done" ? (isPartner ? "Sent" : "Posted") : "Marked not relevant"}
              {item.acted_by ? ` by ${item.acted_by}` : ""}{item.acted_at ? `, ${friendlyDate(item.acted_at)}` : ""}
            </span>
            <Btn size="sm" variant="secondary" loading={busy === "reopen"} onClick={() => act("reopen")}>Put back</Btn>
          </>
        )}
      </div>
    </div>
  );
}

export default function OutsideAgentsPage() {
  const { theme } = useTheme();
  const { ask, dialog } = useConfirm();
  const [kind, setKind] = useState("signal");
  const [state, setState] = useState("new");
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setError("");
    return Promise.all([
      api.getOutside({ kind, state, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
      api.getOutsideSummary(),
    ]).then(([list, sum]) => { setData(list); setSummary(sum); })
      .catch((e) => setError(e.message));
  }, [kind, state, page]);

  useEffect(() => { setData(null); load(); }, [load]);

  async function writeDrafts() {
    setDrafting(true);
    try { await api.draftOutside(); await load(); }
    catch (e) { setError(`We couldn't write the drafts: ${e.message}`); }
    finally { setDrafting(false); }
  }

  async function flip(next) {
    const ok = await ask({
      title: next ? "Switch the outside agents on?" : "Switch the outside agents off?",
      body: next
        ? "From tomorrow morning the daily search runs again and drafts are written for what it finds. It costs about $2 a month."
        : "The daily search and the drafting stop. Everything already found stays in these lists.",
      confirmLabel: next ? "Switch on" : "Switch off",
      danger: !next,
    });
    if (!ok) return;
    setSaving(true);
    try { await api.setProspectingSetting("outside_agents", next); await load(); }
    catch (e) { setError(`We couldn't change that: ${e.message}`); }
    finally { setSaving(false); }
  }

  const tab = TABS.find((t) => t.kind === kind);
  const counts = summary?.counts || {};
  const last = summary?.last_run;

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: theme.text, margin: 0 }}>Outside agents</h1>
        <p style={{ fontSize: 13, color: theme.textMuted, margin: "4px 0 0", maxWidth: 780 }}>
          Every morning the agents look outside the app for brands asking for creators, creators asking for
          brands, and partners worth writing to, and write a draft for each. You copy it, post or send it,
          and mark it done. Nothing is posted or sent for you.
        </p>
      </div>

      <Card style={{ padding: 16, marginBottom: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <Toggle checked={summary?.on !== false} disabled={saving || !summary}
                  label={`Outside agents: ${summary?.on !== false ? "on" : "off"}`} onChange={flip} />
          <div style={{ flex: 1, minWidth: 220, fontSize: 13, color: theme.textMid }}>
            {summary?.on === false ? "Off. Nothing new is searched for or drafted."
              : last ? `Last search ${friendlyDate(last.at)}: ${last.signals || 0} posts to answer and ${last.partners || 0} partners found, in ${last.queries || 0} searches ($${Number(last.spent_usd || 0).toFixed(2)}).`
              : "On. The first search runs within a few hours."}
          </div>
          <Btn size="sm" variant="secondary" loading={drafting} onClick={writeDrafts}>Write drafts now</Btn>
        </div>
      </Card>

      {error && <Card style={{ padding: 16, marginBottom: 0 }}><div style={{ color: theme.danger, fontSize: 13 }}>{error}</div></Card>}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <Btn key={t.kind} size="sm" variant={kind === t.kind ? "solid" : "secondary"}
               onClick={() => { setKind(t.kind); setPage(0); }}>
            {t.label}{summary ? ` ${counts[t.kind] ?? 0}` : ""}
          </Btn>
        ))}
        <div style={{ flex: 1 }} />
        {STATES.map(([value, label]) => (
          <Btn key={value} size="sm" variant={state === value ? "solid" : "secondary"}
               onClick={() => { setState(value); setPage(0); }}>{label}</Btn>
        ))}
      </div>

      <Card style={{ padding: 0, overflow: "hidden", marginBottom: 0 }}>
        {!data && !error ? (
          <SkeletonListRows rows={3} padding="14px 16px" lines={[["35%", 13], ["80%", 12], ["60%", 12]]} />
        ) : data && data.ready === false ? (
          <div style={{ padding: 16, fontSize: 13, color: theme.textMuted }}>
            The list isn't set up on this database yet.
          </div>
        ) : data && data.items.length === 0 ? (
          <div style={{ padding: 16, fontSize: 13, color: theme.textMuted }}>
            {state === "new" ? tab.empty : "Nothing here yet."}
          </div>
        ) : data ? (
          <>
            {data.items.map((item) => (
              <Item key={`${item.id}:${item.drafted_at || ""}:${item.state}`} item={item} theme={theme}
                    onError={setError}
                    onChanged={(row, action) => {
                      if (action === "save") setData((d) => ({ ...d, items: d.items.map((x) => (x.id === row.id ? row : x)) }));
                      else load();
                    }} />
            ))}
            <ListPager theme={theme} page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} />
          </>
        ) : null}
      </Card>
      {dialog}
    </div>
  );
}
