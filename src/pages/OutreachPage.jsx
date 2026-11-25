// Outreach: everything our own sender and the reply agent are doing.
//
// One screen to watch it run: whether it is sending, how each mailbox is
// doing, who needs a person, what leaves next, and every person we wrote to
// with the whole exchange. It only reads; the switches live on the brand
// Email page. It refreshes itself every minute.

import { useCallback, useEffect, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api, friendlyDate } from "../lib/api";
import { useVisibleInterval } from "../lib/useVisibleInterval";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Tag } from "../components/ui/Tag";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { Input } from "../components/ui/Input";
import { Pagination } from "../components/ui/Pagination";
import { SkeletonListRows } from "../components/ui/Skeleton";

const WHO = { brand: "Brands", creator: "Creators" };
const WORDING = {
  brand_a: "No affiliate app", brand_b: "Has an affiliate app",
  creator: "Saw their post", creator_cold: "Found by search",
};
const STAGE = {
  waiting: "Waiting to start", in_progress: "In progress", finished: "Finished, no reply",
  replied: "Replied", needs_person: "Needs you", unsubscribed: "Unsubscribed",
  marked_spam: "Marked as spam", bounced: "Bounced", failed: "Could not send",
};
const INTENT = {
  interested: "Interested", question: "Asked a question", not_interested: "Not interested",
  not_now: "Not now", wrong_person: "Wrong person", other: "Other",
};
const STAGE_OPTIONS = [
  { value: "", label: "Everyone" },
  ...["waiting", "in_progress", "opened", "replied", "needs_person", "interested", "signed_up", "finished", "unsubscribed", "bounced"]
    .map((v) => ({ value: v, label: { opened: "Opened", interested: "Interested", signed_up: "Signed up" }[v] || STAGE[v] })),
];

const clock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const dayAndClock = (iso) => new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const pct = (n, of) => (of > 0 ? `${Math.round((n / of) * 100)}%` : "");

function stageColor(theme, stage) {
  if (["needs_person"].includes(stage)) return theme.warning;
  if (["replied"].includes(stage)) return theme.success;
  if (["bounced", "marked_spam", "failed"].includes(stage)) return theme.danger;
  return theme.textMuted;
}

function Figure({ label, value, note, color }) {
  const { theme } = useTheme();
  return (
    <div style={{ minWidth: 88 }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textMuted }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || theme.text, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {note ? <div style={{ fontSize: 11.5, color: theme.textMuted, marginTop: 2 }}>{note}</div> : null}
    </div>
  );
}

// The numbers that say whether outreach is working, both mailboxes together,
// each with how brands and creators split.
function KeyNumbers({ boxes, cost }) {
  const { theme } = useTheme();
  const sum = (key) => boxes.brand[key] + boxes.creator[key];
  const emailed = sum("people_emailed");
  const tiles = [
    { key: "people_emailed", label: "People emailed", note: "got at least one email" },
    { key: "opened", label: "Opened", rate: true },
    { key: "replied", label: "Replied", rate: true, color: theme.success },
    { key: "interested", label: "Interested", rate: true, color: theme.success },
    { key: "signed_up", label: "Signed up", rate: true, color: theme.success },
    { key: "activated", label: "Used it", note: "pitch sent or campaign live", color: theme.success },
  ];
  return (
    <Card style={{ padding: 20 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        {tiles.map((t) => {
          const value = sum(t.key);
          return (
            <div key={t.key} style={{ border: `1px solid ${theme.border}`, borderRadius: 12, padding: "14px 16px", minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textMuted }}>{t.label}</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 6 }}>
                <span style={{ fontSize: 32, lineHeight: 1, fontWeight: 700, color: value && t.color ? t.color : theme.text, fontVariantNumeric: "tabular-nums" }}>{value}</span>
                {t.rate && emailed > 0 ? <span style={{ fontSize: 15, fontWeight: 600, color: theme.textMid, fontVariantNumeric: "tabular-nums" }}>{pct(value, emailed)}</span> : null}
              </div>
              <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 8, lineHeight: 1.5 }}>
                Brands {boxes.brand[t.key]} · Creators {boxes.creator[t.key]}
                {t.note ? <div>{t.note}</div> : t.rate ? <div>of people emailed</div> : null}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 12.5, color: theme.textMuted, marginTop: 14, lineHeight: 1.5 }}>
        Since the first email. An open can be a mail filter, so read replies and sign-ups first.
        {" "}Replies answered automatically: {sum("answered_by_itself")}{cost > 0 ? ` ($${cost.toFixed(2)} so far)` : ""}. Passed to you: {sum("needs_person")}.
      </div>
    </Card>
  );
}

// How far through today's allowance each mailbox is, and what is queued behind it.
function Today({ boxes }) {
  const { theme } = useTheme();
  return (
    <Card style={{ flex: "1 1 420px", minWidth: 0, marginBottom: 0, padding: 20 }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: theme.text }}>Today</div>
      {Object.entries(boxes).map(([audience, box]) => {
        const part = box.allowed_new > 0 ? Math.min(1, box.started_today / box.allowed_new) : 0;
        return (
          <div key={audience} style={{ marginTop: 16 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: theme.text }}>{WHO[audience]}</span>
              <span style={{ fontSize: 12.5, color: theme.textMuted, overflowWrap: "anywhere" }}>{box.mailbox}</span>
              <span style={{ marginLeft: "auto", fontSize: 14, fontWeight: 700, color: theme.text, fontVariantNumeric: "tabular-nums" }}>
                {box.started_today} of {box.allowed_new} new people
              </span>
            </div>
            <div style={{ height: 8, borderRadius: 4, background: theme.border, marginTop: 8, overflow: "hidden" }}>
              <div style={{ width: `${part * 100}%`, height: "100%", borderRadius: 4, background: audience === "brand" ? theme.accent : theme.success }} />
            </div>
            <div style={{ fontSize: 12.5, color: theme.textMid, marginTop: 8, lineHeight: 1.5 }}>
              {box.emails_timed} timed to leave · {box.waiting} waiting to start · {box.in_progress} in follow-up
              {box.allowed_new < 20 ? " · the daily limit grows each week to 20" : ""}
            </div>
          </div>
        );
      })}
    </Card>
  );
}

// What would get a mailbox blocked, against the limits that pause sending.
function Health({ boxes }) {
  const { theme } = useTheme();
  return (
    <Card style={{ flex: "1 1 420px", minWidth: 0, marginBottom: 0, padding: 20 }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: theme.text }}>Mailbox health, last 7 days</div>
      {Object.entries(boxes).map(([audience, box]) => {
        const ok = !box.trouble;
        return (
          <div key={audience} style={{ marginTop: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: ok ? theme.success : theme.danger, flexShrink: 0 }} />
              <span style={{ fontSize: 14, fontWeight: 700, color: theme.text }}>{WHO[audience]}</span>
              <span style={{ fontSize: 13, color: ok ? theme.textMid : theme.danger }}>{ok ? "Healthy" : "In trouble"}</span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "12px 26px", marginTop: 10 }}>
              <Figure label="Bounced" value={`${box.week_bounced} of ${box.week_people}`} note="pauses above 4 in 100" color={box.week_bounced ? theme.danger : null} />
              <Figure label="Spam reports" value={box.week_complaints} note="pauses at 2" color={box.week_complaints ? theme.danger : null} />
              <Figure label="Unsubscribed" value={box.unsubscribed + box.marked_spam} note="all time" />
              {box.failed > 0 && <Figure label="Could not send" value={box.failed} color={theme.danger} />}
            </div>
            {!ok && <div style={{ fontSize: 12.5, color: theme.danger, marginTop: 8, lineHeight: 1.5 }}>{box.trouble}</div>}
          </div>
        );
      })}
    </Card>
  );
}

// Emails a day for the last two weeks, as two stacked bars and a dot for replies.
function Days({ days }) {
  const { theme } = useTheme();
  const top = Math.max(1, ...days.map((d) => d.brand_sent + d.creator_sent));
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 96 }}>
        {days.map((d) => {
          const total = d.brand_sent + d.creator_sent;
          return (
            <div key={d.day} title={`${d.day}: ${d.brand_sent} to brands, ${d.creator_sent} to creators, ${d.replies} replies`}
                 style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center", height: "100%" }}>
              <div style={{ fontSize: 10.5, color: theme.textMuted, marginBottom: 3, fontVariantNumeric: "tabular-nums" }}>{total || ""}</div>
              <div style={{ width: "100%", maxWidth: 34, height: `${(d.creator_sent / top) * 70}px`, background: theme.success, opacity: 0.75, borderRadius: d.brand_sent ? "4px 4px 0 0" : 4 }} />
              <div style={{ width: "100%", maxWidth: 34, height: `${(d.brand_sent / top) * 70}px`, background: theme.accent, borderRadius: d.creator_sent ? "0 0 4px 4px" : 4 }} />
              {!total && <div style={{ width: "100%", maxWidth: 34, height: 2, background: theme.border, borderRadius: 2 }} />}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        {days.map((d) => (
          <div key={d.day} style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 10.5, color: theme.textMuted }}>
            {new Date(`${d.day}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric" })}
            <div style={{ color: d.replies ? theme.success : "transparent", fontWeight: 700 }}>{d.replies ? `${d.replies}↩` : "·"}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: 11.5, color: theme.textMuted }}>
        <span><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: theme.accent, marginRight: 5 }} />To brands</span>
        <span><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: theme.success, opacity: 0.75, marginRight: 5 }} />To creators</span>
        <span><span style={{ color: theme.success, fontWeight: 700, marginRight: 5 }}>↩</span>Replies that day</span>
      </div>
    </div>
  );
}

function Conversation({ id, onClose }) {
  const { theme } = useTheme();
  const [one, setOne] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    if (!id) return undefined;
    api.getOutreachPerson(id).then((d) => alive && setOne(d)).catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [id]);

  const bubble = (mine) => ({
    maxWidth: "86%", alignSelf: mine ? "flex-end" : "flex-start", background: mine ? theme.surfaceAlt : theme.bg,
    border: `1px solid ${theme.border}`, borderRadius: 12, padding: "10px 13px",
  });
  return (
    <Modal open={!!id} onClose={onClose} title={one ? (one.handle ? `@${one.handle}` : one.to_email) : "Conversation"} width={680}>
      {error && <div style={{ color: theme.danger, fontSize: 13 }}>{error}</div>}
      {!one && !error && <SkeletonListRows rows={4} />}
      {one && (
        <div>
          <div style={{ fontSize: 13, color: theme.textMid, lineHeight: 1.7 }}>
            {one.to_email} · {WHO[one.audience]} · {WORDING[one.sequence] || one.sequence}
            {one.language !== "en" ? ` · ${one.language === "it" ? "Italian" : "Spanish"}` : ""}
            <br />
            <Tag color={stageColor(theme, one.stage)}>{STAGE[one.stage]}</Tag>
            {one.intent ? <Tag color={theme.textMuted}>{INTENT[one.intent] || one.intent}</Tag> : null}
            {one.signed_up_at ? <Tag color={theme.success}>Signed up {friendlyDate(one.signed_up_at)}</Tag> : null}
            {one.activated_at ? <Tag color={theme.success}>Used it</Tag> : null}
          </div>
          {one.needs_person && one.needs_person_reason && (
            <div style={{ fontSize: 13, color: theme.warning, marginTop: 10, lineHeight: 1.5 }}>
              Passed to a person: {one.needs_person_reason} Answer it from {one.audience === "brand" ? "brand@" : "influencer@"}linkable.link.
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
            {one.messages.length === 0 && (
              <div style={{ fontSize: 13, color: theme.textMuted }}>Nothing has been sent to them yet.</div>
            )}
            {one.messages.map((m, i) => (
              <div key={i} style={bubble(m.from === "us")}>
                <div style={{ fontSize: 11, color: theme.textMuted, marginBottom: 4 }}>
                  {m.from === "us" ? (m.auto ? "We answered, automatically" : "We wrote") : "They wrote"} · {dayAndClock(m.at)}
                  {m.subject ? ` · ${m.subject}` : ""}
                </div>
                <div style={{ fontSize: 13.5, color: theme.text, whiteSpace: "pre-wrap", lineHeight: 1.55, overflowWrap: "anywhere" }}>{m.text}</div>
              </div>
            ))}
          </div>

          {one.next_email && !one.next_email.problem && (
            <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${theme.border}` }}>
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textMuted }}>
                Next email, due {friendlyDate(one.next_email.due)} · {one.next_email.subject}
              </div>
              <div style={{ fontSize: 13, color: theme.textMid, whiteSpace: "pre-wrap", lineHeight: 1.55, marginTop: 8, overflowWrap: "anywhere" }}>{one.next_email.text}</div>
            </div>
          )}
          {one.next_email?.problem && (
            <div style={{ fontSize: 13, color: theme.danger, marginTop: 14 }}>The next email cannot be written: {one.next_email.problem}.</div>
          )}

          {one.emails.length > 0 && (
            <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${theme.border}`, fontSize: 12.5, color: theme.textMid, lineHeight: 1.8 }}>
              {one.emails.map((e, i) => (
                <div key={i}>
                  {e.kind === "answer" ? "Answer" : `Email ${e.step}`} · {dayAndClock(e.scheduled_for)} ·{" "}
                  {e.cancelled_at ? "called back before it left"
                    : e.bounced_at ? `bounced${e.bounce_reason ? `: ${e.bounce_reason}` : ""}`
                    : e.complained_at ? "marked as spam"
                    : e.opened_at ? `delivered, opened${e.opens > 1 ? ` ${e.opens} times` : ""}${e.clicked_at ? ", link clicked" : ""}`
                    : e.delivered_at ? "delivered, not opened"
                    : new Date(e.scheduled_for) > new Date() ? "timed to leave" : "sent, delivery not confirmed yet"}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function People({ onOpen, refreshKey }) {
  const { theme } = useTheme();
  const [audience, setAudience] = useState("");
  const [stage, setStage] = useState("");
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  // Search once they stop typing.
  useEffect(() => {
    const t = setTimeout(() => { setQ(typed.trim()); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [typed]);

  useEffect(() => {
    let alive = true;
    api.getOutreachPeople({ audience, stage, q, limit: pageSize, offset: (page - 1) * pageSize })
      .then((d) => { if (alive) { setData(d); setError(""); } })
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [audience, stage, q, page, pageSize, refreshKey]);

  const th = { textAlign: "left", padding: "8px 10px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textMuted, whiteSpace: "nowrap" };
  const td = { padding: "10px", fontSize: 13, color: theme.text, borderTop: `1px solid ${theme.border}`, verticalAlign: "top" };
  const rows = data?.rows || [];

  return (
    <Card style={{ padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: theme.text, flex: "1 1 160px" }}>Everyone we wrote to</div>
        <div style={{ width: 220 }}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search an email or a handle" aria-label="Search people" style={{ padding: "7px 12px", fontSize: 13 }} />
        </div>
        <div style={{ width: 196 }}>
          <Select size="sm" value={audience} ariaLabel="Brands or creators" onChange={(v) => { setAudience(v); setPage(1); }}
                  options={[{ value: "", label: "Brands and creators" }, { value: "brand", label: "Brands" }, { value: "creator", label: "Creators" }]} />
        </div>
        <div style={{ width: 170 }}>
          <Select size="sm" value={stage} ariaLabel="Where they are" onChange={(v) => { setStage(v); setPage(1); }} options={STAGE_OPTIONS} />
        </div>
      </div>
      {error && <div style={{ color: theme.danger, fontSize: 13, marginTop: 12 }}>{error}</div>}
      {!data && !error && <div style={{ marginTop: 12 }}><SkeletonListRows rows={5} /></div>}
      {data && (
        <>
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["Who", "Kind", "Where they are", "Emails", "Next", "Last change", "Actions"].map((h) => <th key={h} style={th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td style={td}>
                      <div style={{ fontWeight: 600 }}>{r.handle ? `@${r.handle}` : r.to_email}</div>
                      <div style={{ fontSize: 12, color: theme.textMuted, overflowWrap: "anywhere" }}>{r.to_email}</div>
                    </td>
                    <td style={td}>
                      {WHO[r.audience]}
                      <div style={{ fontSize: 12, color: theme.textMuted }}>{WORDING[r.sequence] || r.sequence}</div>
                    </td>
                    <td style={td}>
                      <Tag color={stageColor(theme, r.stage)}>{STAGE[r.stage]}</Tag>
                      {r.opened_at && r.stage === "in_progress" ? <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 4 }}>Opened{r.clicked_at ? ", clicked the link" : ""}</div> : null}
                      {r.intent ? <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 4 }}>{INTENT[r.intent] || r.intent}</div> : null}
                      {r.signed_up_at ? <div style={{ fontSize: 12, color: theme.success, marginTop: 4 }}>Signed up{r.activated_at ? " and used it" : ""}</div> : null}
                    </td>
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                      {r.step}{r.auto_answers ? ` + ${r.auto_answers} ${r.auto_answers === 1 ? "answer" : "answers"}` : ""}
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap", color: theme.textMid }}>
                      {r.stage === "waiting" ? "In the queue" : r.stage === "in_progress" ? friendlyDate(r.next_at) : ""}
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap", color: theme.textMid }}>{friendlyDate(r.updated_at)}</td>
                    <td style={td}>
                      <Btn size="sm" variant="secondary" onClick={() => onOpen(r.id)}>Open</Btn>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={7} style={{ ...td, color: theme.textMuted }}>Nobody matches that yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <Pagination page={page} pageSize={pageSize} total={data.total} onPageChange={setPage}
                      onPageSizeChange={(n) => { setPageSize(n); setPage(1); }} />
        </>
      )}
    </Card>
  );
}

export default function OutreachPage() {
  const { theme } = useTheme();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(() => {
    api.getOutreach().then((d) => { setData(d); setError(""); }).catch((e) => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);
  useVisibleInterval(() => { load(); setTick((n) => n + 1); }, 60000);

  if (error && !data) return <Card><div style={{ color: theme.danger, fontSize: 14 }}>{error}</div></Card>;
  if (!data) return <Card><SkeletonListRows rows={6} /></Card>;

  const s = data.switches;
  const running = !s.paused;
  const onOff = (label, on) => <Tag color={on ? theme.success : theme.textMuted}>{label}: {on ? "on" : "off"}</Tag>;
  const label = { fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textMuted };

  return (
    <div>
      <Card style={{ padding: 20 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 420px", minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: running ? theme.success : theme.danger, flexShrink: 0 }} />
              <div style={{ fontSize: 18, fontWeight: 700, color: theme.text }}>{running ? "Sending is running" : "Sending is paused"}</div>
            </div>
            <div style={{ fontSize: 13.5, color: running ? theme.textMid : theme.danger, marginTop: 6, lineHeight: 1.55 }}>
              {running
                ? `Next emails leave ${data.next_run ? dayAndClock(data.next_run) : "on the next working day"}, a few at a time over the following ${data.window_minutes} minutes.`
                : data.health?.reason
                  ? `It paused itself ${friendlyDate(data.health.paused_at)}: ${data.health.reason}`
                  : "Someone paused it. Nothing leaves until it is switched back on."}
              {data.worker?.at ? ` The worker last looked for people ${friendlyDate(data.worker.at)}.` : ""}
            </div>
            <div style={{ marginTop: 12 }}>
              {onOff("Brands", s.brands)}{onOff("Creators", s.creators)}{onOff("Automatic answers", s.answers)}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 12, color: theme.textMuted }}>Updated {clock(data.at)}</span>
            <Btn size="sm" variant="secondary" onClick={() => { load(); setTick((n) => n + 1); }}>Refresh</Btn>
            <Btn size="sm" variant="secondary" href="/gtm/brands">Switches</Btn>
          </div>
        </div>
      </Card>

      <KeyNumbers boxes={data.boxes} cost={data.answer_cost_usd} />

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
        <Today boxes={data.boxes} />
        <Health boxes={data.boxes} />
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
        <Card style={{ flex: "1 1 420px", minWidth: 0, marginBottom: 0, padding: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: theme.text }}>Needs you</div>
          <div style={{ fontSize: 13, color: theme.textMid, marginTop: 4 }}>
            Replies the agent would not answer by itself. Each one is also in the mailbox as an email titled &quot;Needs you&quot;.
          </div>
          {data.needs_person.length === 0 && (
            <div style={{ fontSize: 13.5, color: theme.textMuted, marginTop: 14 }}>Nothing is waiting for a person.</div>
          )}
          {data.needs_person.map((p) => (
            <div key={p.id} style={{ display: "flex", gap: 12, alignItems: "flex-start", marginTop: 12, paddingTop: 12, borderTop: `1px solid ${theme.border}` }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: theme.text }}>
                  {p.handle ? `@${p.handle}` : p.to} <span style={{ fontWeight: 400, color: theme.textMuted }}>· {WHO[p.audience]} · {friendlyDate(p.at)}</span>
                </div>
                <div style={{ fontSize: 13, color: theme.textMid, marginTop: 3, lineHeight: 1.5 }}>{p.reason}</div>
              </div>
              <Btn size="sm" variant="secondary" onClick={() => setOpen(p.id)}>Open</Btn>
            </div>
          ))}
        </Card>

        <Card style={{ flex: "1 1 420px", minWidth: 0, marginBottom: 0, padding: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: theme.text }}>Leaving next</div>
          <div style={{ fontSize: 13, color: theme.textMid, marginTop: 4 }}>Emails already timed, soonest first.</div>
          {data.upcoming.length === 0 && (
            <div style={{ fontSize: 13.5, color: theme.textMuted, marginTop: 14 }}>
              Nothing is timed right now. {running && data.next_run ? `The next ones are picked ${dayAndClock(data.next_run)}.` : ""}
            </div>
          )}
          {data.upcoming.map((e, i) => (
            <div key={i} style={{ display: "flex", gap: 12, marginTop: 10, fontSize: 13, color: theme.text }}>
              <span style={{ width: 52, flexShrink: 0, fontVariantNumeric: "tabular-nums", color: theme.textMid }}>{clock(e.at)}</span>
              <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                {e.to} <span style={{ color: theme.textMuted }}>· {e.kind === "answer" ? "answer" : `email ${e.step}`} · {e.subject}</span>
              </span>
            </div>
          ))}
        </Card>
      </div>

      <Card style={{ padding: 20 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: theme.text }}>Emails a day, last two weeks</div>
        </div>
        <Days days={data.days} />
      </Card>

      {data.results.length > 0 && (
        <Card style={{ padding: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: theme.text, marginBottom: 10 }}>Results by week</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
              <thead>
                <tr>
                  {["Week of", "Who", "People", "Reached", "Opened", "Replied", "Interested", "Answered by itself", "Needed a person", "Unsubscribed", "Bounced", "Signed up", "Used it"].map((h, i) => (
                    <th key={h} style={{ ...label, textAlign: i < 2 ? "left" : "right", padding: "6px 8px", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.results.map((r) => (
                  <tr key={`${r.week}-${r.sequence}`} style={{ borderTop: `1px solid ${theme.border}` }}>
                    <td style={{ padding: "8px", color: theme.textMid, whiteSpace: "nowrap" }}>{new Date(`${r.week}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</td>
                    <td style={{ padding: "8px", color: theme.text, whiteSpace: "nowrap" }}>{WHO[r.audience]}, {(WORDING[r.sequence] || r.sequence).toLowerCase()}</td>
                    {[r.people, r.reached, `${r.opened ?? 0}${r.reached ? ` (${pct(r.opened ?? 0, r.reached)})` : ""}`, `${r.replied}${r.reached ? ` (${pct(r.replied, r.reached)})` : ""}`, r.interested ?? 0, r.answered_by_itself ?? 0,
                      r.passed_to_a_person ?? 0, r.unsubscribed + r.marked_spam, r.bounced, r.signed_up, r.activated].map((v, i) => (
                      <td key={i} style={{ padding: "8px", textAlign: "right", color: theme.text, whiteSpace: "nowrap" }}>{v}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <People onOpen={setOpen} refreshKey={tick} />
      {/* Keyed by the person, so opening another starts from an empty panel. */}
      <Conversation key={open || "none"} id={open} onClose={() => setOpen(null)} />
    </div>
  );
}
