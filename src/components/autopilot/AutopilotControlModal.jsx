import { useState } from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { api } from "../../lib/api";
import { Modal } from "../ui/Modal";
import { Btn } from "../ui/Button";

/**
 * Starting and stopping Autopilot, deliberately not a toggle.
 *
 * It was three chips — Autonomous, Assisted, Off — and pressing one took
 * effect immediately. That is the right control for a setting and the wrong
 * one for this: the first press spends about 65 provider credits and emails
 * roughly 300 strangers under the brand's name, and none of it can be taken
 * back. A control whose whole affordance is "click to switch" gives no moment
 * to notice that, and the row it sits on looks identical before and after.
 *
 * So: one primary action that says what it does, a screen that says what it
 * will cost before it happens, and a second press to agree. The mode is a
 * choice made INSIDE the launch rather than three buttons that each launch.
 *
 * Stopping gets the same treatment for the opposite reason — it is quiet
 * rather than expensive, and what it does not do is the part people get
 * wrong. Switching off ends the searching and the pushing; the sequence
 * already holding creators carries on sending its follow-ups, and only
 * pausing the campaign in Lemlist stops those.
 */

// What one search actually costs and reaches, from the production runs on
// 22-24 Sep 2026: Di'Amandea 362 discovered / 307 enriched / 66.5 credits, and
// 7 Day Starter Pack 505 / 455 / 81.9. Written down rather than computed
// because a campaign being launched for the first time has no history of its
// own, and a number somebody can check beats a shrug.
const CREDITS_PER_SEARCH = 70;
const CREATORS_PER_SEARCH = 300;
// The sequence's own pace, which is what turns a push into days of sending:
// prod's schedule leaves ~5 minutes between sends across a 14-hour window.
const EMAILS_PER_DAY = 120;

const MODES = [
  {
    value: "autonomous",
    title: "Run it for me",
    body: "Works out who to look for, searches, and emails everyone it finds — without asking again.",
  },
  {
    value: "assisted",
    title: "Find them for me",
    body: "Does the searching and writes the messages, then stops. Nobody is emailed until a person pushes the list.",
  },
];

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// Mounted per campaign — the call site gives it a key, so opening it on
// another row is a fresh component rather than one carrying the last
// campaign's mode and numbers. That is why every field below can be plain
// initial state with no effect resetting it.
export default function AutopilotControlModal({ row, onClose, onSaved, onError }) {
  const { theme } = useTheme();
  const running = row.mode !== "none" && row.mode !== "off";
  const launched = row.mode !== "none";

  const [step, setStep] = useState("settings"); // settings | launch | stop
  const [mode, setMode] = useState(running ? row.mode : "autonomous");
  const [goal, setGoal] = useState(String(row.goal_applications ?? 25));
  const [budget, setBudget] = useState(String(row.max_runs ?? 2));
  const [busy, setBusy] = useState(false);

  const wholeGoal = Math.floor(Number(goal));
  const wholeBudget = Math.floor(Number(budget));
  const numbersOk =
    Number.isFinite(wholeGoal) && wholeGoal >= 1 && wholeGoal <= 500 &&
    Number.isFinite(wholeBudget) && wholeBudget >= 1 && wholeBudget <= 10;

  async function save(nextMode) {
    setBusy(true);
    try {
      const d = await api.setAutopilotAgent(row.product_id, {
        mode: nextMode,
        goal_applications: wholeGoal,
        max_runs: wholeBudget,
      });
      onSaved?.(row.product_id, d.agent);
      onClose?.();
    } catch (e) {
      onError?.(e);
      setBusy(false);
    }
  }

  const label = { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: theme.textMuted };
  const input = {
    width: 72, padding: "7px 9px", borderRadius: 8, border: `1px solid ${theme.border}`,
    background: theme.bg, color: theme.text, fontSize: 13, fontFamily: "inherit",
  };
  const muted = { color: theme.textMuted, fontSize: 12, lineHeight: 1.5 };
  const foot = { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 };

  // --- what a launch is about to do, in the numbers it will actually spend --
  const consequences = mode === "autonomous"
    ? [
      `It searches up to ${plural(wholeBudget || 0, "time", "times")}, each costing about ${CREDITS_PER_SEARCH} Influencers Club credits.`,
      `Each search reaches roughly ${CREATORS_PER_SEARCH} creators with a findable address, and emails every one of them.`,
      `Emails leave Linkable's own mailboxes at about ${EMAILS_PER_DAY} a day, under this brand's name, and cannot be unsent.`,
      `It stops on its own at ${plural(wholeGoal || 0, "application", "applications")}, or when the searches run out.`,
    ]
    : [
      `It searches up to ${plural(wholeBudget || 0, "time", "times")}, each costing about ${CREDITS_PER_SEARCH} Influencers Club credits.`,
      "It stops before emailing anybody. The list waits for a person to push it.",
    ];

  const title = step === "settings"
    ? `Autopilot — ${row.campaign_name || "this campaign"}`
    : step === "launch" ? "Start emailing creators?" : "Stop Autopilot?";

  return (
    <Modal open onClose={busy ? undefined : onClose} title={title} width={560}>
      {step === "settings" && (
        <>
          <div style={{ ...muted, marginBottom: 16 }}>
            {running
              ? `Running for ${row.brand_name || "this brand"} — ${row.mode}, ${row.runs_used} of ${plural(row.max_runs, "search", "searches")} used.`
              : launched
                ? `Switched off for ${row.brand_name || "this brand"}. Nothing is being searched or sent.`
                : `Autopilot has never run for ${row.brand_name || "this brand"} on this campaign.`}
          </div>

          <div style={{ ...label, marginBottom: 8 }}>What it may do</div>
          <div style={{ display: "grid", gap: 8, marginBottom: 18 }}>
            {MODES.map((m) => {
              const on = mode === m.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setMode(m.value)}
                  style={{
                    textAlign: "left", padding: "12px 14px", borderRadius: 10, cursor: "pointer",
                    fontFamily: "inherit", background: on ? theme.accentLight : "transparent",
                    border: `1.5px solid ${on ? theme.text : theme.border}`, color: theme.text,
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{m.title}</div>
                  <div style={muted}>{m.body}</div>
                </button>
              );
            })}
          </div>

          <div style={{ display: "flex", gap: 14, alignItems: "flex-end", marginBottom: 8 }}>
            <div>
              <div style={{ ...label, marginBottom: 5 }}>Goal</div>
              <input style={input} type="number" min="1" max="500" value={goal}
                onChange={(e) => setGoal(e.target.value)} />
            </div>
            <div>
              <div style={{ ...label, marginBottom: 5 }}>Searches</div>
              <input style={input} type="number" min="1" max="10" value={budget}
                onChange={(e) => setBudget(e.target.value)} />
            </div>
            <div style={{ ...muted, flex: 1 }}>
              Applications to stop at, and the searches it may spend getting there.
              {row.search_allowance != null && (
                <> This brand has used {row.searches_used} of its {row.search_allowance} searches this month.</>
              )}
            </div>
          </div>
          {!numbersOk && (
            <div style={{ color: "#B45309", fontSize: 12 }}>
              Goal must be 1–500 and searches 1–10.
            </div>
          )}

          <div style={foot}>
            <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
            {running && (
              <Btn variant="outline" disabled={!numbersOk} loading={busy} onClick={() => save(mode)}>
                Save changes
              </Btn>
            )}
            {running ? (
              <Btn variant="danger" onClick={() => setStep("stop")}>Stop Autopilot</Btn>
            ) : (
              <Btn disabled={!numbersOk} onClick={() => setStep("launch")}>Launch Autopilot</Btn>
            )}
          </div>
        </>
      )}

      {step === "launch" && (
        <>
          <div style={{ fontSize: 13, color: theme.text, marginBottom: 12, lineHeight: 1.5 }}>
            <strong>{row.campaign_name}</strong> for {row.brand_name || "this brand"}, in
            {" "}<strong>{MODES.find((m) => m.value === mode)?.title.toLowerCase()}</strong> mode.
          </div>
          <ul style={{ ...muted, paddingLeft: 18, margin: "0 0 4px" }}>
            {consequences.map((line) => <li key={line} style={{ marginBottom: 6 }}>{line}</li>)}
          </ul>
          <div style={{ ...muted, marginTop: 12 }}>
            It takes its first action within a couple of minutes.
          </div>
          <div style={foot}>
            <Btn variant="secondary" onClick={() => setStep("settings")} disabled={busy}>Back</Btn>
            <Btn loading={busy} onClick={() => save(mode)}>
              {mode === "autonomous" ? "Launch and start emailing" : "Launch, without emailing"}
            </Btn>
          </div>
        </>
      )}

      {step === "stop" && (
        <>
          <div style={{ fontSize: 13, color: theme.text, marginBottom: 12, lineHeight: 1.5 }}>
            <strong>{row.campaign_name}</strong> stops searching, and stops handing new creators to
            the sequence.
          </div>
          <div style={{ ...muted, marginBottom: 10 }}>
            What this does <strong>not</strong> do: the {plural(row.emailed || 0, "creator", "creators")}
            {" "}already in the sequence carry on receiving its follow-ups. To stop those as well, pause
            the campaign in Lemlist.
          </div>
          <div style={muted}>
            Switching it back on later keeps the searches it has already spent.
          </div>
          <div style={foot}>
            <Btn variant="secondary" onClick={() => setStep("settings")} disabled={busy}>Back</Btn>
            <Btn variant="danger" loading={busy} onClick={() => save("off")}>Stop Autopilot</Btn>
          </div>
        </>
      )}
    </Modal>
  );
}
