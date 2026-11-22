// Automatic first contact, on the brand Email page.
//
// Two things in one card. The balance: creators who finished signing up
// against live campaigns, which says which side of the marketplace is short
// (server/lib/gtm-balance.js). And the switch: with it on, the prospector's
// worker hands the strongest leads over by itself, up to the daily number,
// instead of waiting for someone to mark each one Send. It reads both at
// every run, so a change here needs no deploy. The emails themselves are sent
// by ops (server/lib/direct-outreach.js), from brand@ and influencer@.

import { useEffect, useState } from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { api, friendlyDate } from "../../lib/api";
import { Card } from "../ui/Card";
import { Toggle } from "../ui/Toggle";
import { Select } from "../ui/Select";
import { useConfirm } from "../ui/ConfirmDialog";

const CAPS = [5, 10, 20, 30, 50, 100];

// Why nothing can go out, in a sentence; "" when something can.
function sendBlocker(status) {
  const notLive = Object.values(status?.not_live || {});
  if (!notLive.length) return "";
  const states = [...new Set(notLive)].join(" and ");
  return `The campaign for these emails is ${states}, so nothing can be sent until the worker is set to send by itself.`;
}

export function AutoContactCard() {
  const { theme } = useTheme();
  const { ask, dialog } = useConfirm();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api.getEmailAutomation()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, []);

  if (error) return <Card style={{ padding: 16, marginBottom: 0 }}><div style={{ color: theme.danger, fontSize: 13 }}>We couldn't read the automatic sending: {error}</div></Card>;
  if (!data) return null;

  const on = data.settings.email_auto_send;
  const cap = data.settings.email_auto_send_daily_cap;
  const balance = data.balance;
  const pausedByBalance = balance?.short_side === "creators";
  const blocker = sendBlocker(data.status);
  const creatorsOn = data.settings.creator_auto_send;
  const creatorCap = data.settings.creator_auto_send_daily_cap;
  const paused = data.settings.direct_send_paused;
  const sending = data.sending?.ready ? data.sending : null;
  // "12 in progress, 4 sent today, 1 reply" for one mailbox.
  const sendingLine = (s) =>
    `From ${s.mailbox}: ${s.active} in progress, ${s.sent_today} sent today, ${s.replied} ${s.replied === 1 ? "reply" : "replies"}.`;

  async function flipPause(next) {
    const ok = await ask({
      title: next ? "Pause all sending?" : "Resume sending?",
      body: next
        ? "Nothing more leaves brand@ or influencer@linkable.link, first emails and follow-ups alike, until this is switched off. Nobody loses their place."
        : "Emails that are due go out at the next send time, on working days.",
      confirmLabel: next ? "Pause" : "Resume",
      danger: next,
    });
    if (ok) await save("direct_send_paused", next);
  }

  async function flipCreators(next) {
    const ok = await ask({
      title: next ? "Invite creators automatically?" : "Stop automatic creator invitations?",
      body: next
        ? `From the next run, up to ${creatorCap} creators a day are invited to join Linkable by email, from influencer@linkable.link, without anyone marking them Send. They are creators the worker watched post about a brand, with an address on their profile. Hold and Hide still win.`
        : "From the next run, a creator is invited only when someone marks them Send. Invitations already started carry on.",
      confirmLabel: next ? "Switch on" : "Switch off",
      danger: !next,
    });
    if (ok) await save("creator_auto_send", next);
  }

  async function save(key, value) {
    setSaving(true);
    setError("");
    try {
      const settings = await api.setProspectingSetting(key, value);
      setData((d) => ({ ...d, settings: {
        email_auto_send: settings.email_auto_send === true,
        email_auto_send_daily_cap: settings.email_auto_send_daily_cap,
        creator_auto_send: settings.creator_auto_send === true,
        creator_auto_send_daily_cap: settings.creator_auto_send_daily_cap,
        direct_send_paused: settings.direct_send_paused === true,
      } }));
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function flip(next) {
    const ok = await ask({
      title: next ? "Send first emails automatically?" : "Stop automatic first emails?",
      body: next
        ? `From the next run, up to ${cap} brands a day get the first email without anyone marking them Send. Only the strongest leads go: Tier A, with a creator call or a creator's post to show, a named inbox, and through every check a marked lead passes. Hold and Hide still win.`
        : "From the next run, a brand is emailed only when someone marks it Send. Emails already started carry on.",
      confirmLabel: next ? "Switch on" : "Switch off",
      danger: !next,
    });
    if (ok) await save("email_auto_send", next);
  }

  const label = { fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textMuted };
  const figure = { fontSize: 22, fontWeight: 700, color: theme.text, marginTop: 4, fontVariantNumeric: "tabular-nums" };

  return (
    <Card style={{ padding: 16, marginBottom: 0 }}>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 320px", minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>Balance</div>
          <div style={{ fontSize: 13, color: theme.textMid, marginTop: 4, lineHeight: 1.5 }}>
            {balance ? balance.line : "The balance could not be read just now."}
          </div>
          {balance && (
            <div style={{ display: "flex", gap: 28, marginTop: 12, flexWrap: "wrap" }}>
              {[["Creators", balance.creators], ["Live campaigns", balance.campaigns],
                ["Short of creators", balance.short], ["Applications waiting", balance.waiting]].map(([k, n]) => (
                <div key={k}>
                  <div style={label}>{k}</div>
                  <div style={figure}>{Number(n || 0).toLocaleString("en-GB")}</div>
                </div>
              ))}
            </div>
          )}
          {balance?.open?.length > 0 && (
            <div style={{ fontSize: 12.5, color: theme.textMid, marginTop: 12, lineHeight: 1.5 }}>
              Creators waiting with no live campaign:{" "}
              <b style={{ color: theme.text }}>
                {balance.open.map((n) => `${n.label} (${n.creators.toLocaleString("en-GB")})`).join(", ")}
              </b>. Brands in these categories are the ones to reach first.
            </div>
          )}
        </div>

        <div style={{ flex: "1 1 320px", minWidth: 0, borderLeft: `1px solid ${theme.border}`, paddingLeft: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: theme.text, flex: 1 }}>Send first emails automatically</div>
            <Toggle checked={on} disabled={saving} label={`Automatic first emails: ${on ? "on" : "off"}`} onChange={flip} />
          </div>
          <div style={{ fontSize: 13, color: theme.textMid, marginTop: 4, lineHeight: 1.5 }}>
            {on
              ? pausedByBalance
                ? "On, but paused while creators are the short side."
                : `On. The strongest leads go by themselves, up to ${cap} a day. Everything else still waits for Send.`
              : `Off. A brand is emailed only when someone marks it Send. ${data.waiting} Tier A ${data.waiting === 1 ? "lead is" : "leads are"} waiting for a decision.`}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
            <span style={{ fontSize: 12, color: theme.textMuted }}>At most</span>
            <div style={{ width: 150 }}>
              <Select value={cap} disabled={saving}
                      options={[...new Set([...CAPS, cap])].sort((a, b) => a - b).map((n) => ({ value: n, label: `${n} a day` }))}
                      onChange={(v) => save("email_auto_send_daily_cap", Number(v))} />
            </div>
          </div>
          {blocker && (
            <div style={{ fontSize: 12.5, color: theme.danger, marginTop: 10, lineHeight: 1.5 }}>{blocker}</div>
          )}
          {sending && (
            <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 8 }}>{sendingLine(sending.brand)}</div>
          )}
          {data.status?.at && (
            <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 8 }}>
              Last run {friendlyDate(data.status.at)}: {data.status.auto || 0} sent automatically, {data.status.auto_today ?? 0} today.
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16, paddingTop: 14, borderTop: `1px solid ${theme.border}` }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: theme.text, flex: 1 }}>Invite creators automatically</div>
            <Toggle checked={creatorsOn} disabled={saving} label={`Automatic creator invitations: ${creatorsOn ? "on" : "off"}`} onChange={flipCreators} />
          </div>
          <div style={{ fontSize: 13, color: theme.textMid, marginTop: 4, lineHeight: 1.5 }}>
            {creatorsOn
              ? `On. Up to ${creatorCap} creators a day are invited by email from influencer@linkable.link.`
              : "Off. A creator is invited only when someone marks them Send."}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
            <span style={{ fontSize: 12, color: theme.textMuted }}>At most</span>
            <div style={{ width: 150 }}>
              <Select value={creatorCap} disabled={saving}
                      options={[...new Set([...CAPS, creatorCap])].sort((a, b) => a - b).map((n) => ({ value: n, label: `${n} a day` }))}
                      onChange={(v) => save("creator_auto_send_daily_cap", Number(v))} />
            </div>
          </div>
          {sending && (
            <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 8 }}>{sendingLine(sending.creator)}</div>
          )}
          {data.status?.at && creatorsOn && (
            <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 8 }}>
              Last run: {data.status.creators_auto || 0} invited automatically, {data.status.creators_auto_today ?? 0} today.
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16, paddingTop: 14, borderTop: `1px solid ${theme.border}` }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: theme.text, flex: 1 }}>Pause all sending</div>
            <Toggle checked={paused} disabled={saving} label={`All sending: ${paused ? "paused" : "running"}`} onChange={flipPause} />
          </div>
          <div style={{ fontSize: 13, color: paused ? theme.danger : theme.textMid, marginTop: 4, lineHeight: 1.5 }}>
            {paused
              ? "Paused. Nothing leaves brand@ or influencer@linkable.link until this is switched off."
              : "Running. Emails go out four times a working day, and stop for anyone who replies or unsubscribes."}
          </div>
        </div>
      </div>
      {dialog}
    </Card>
  );
}
