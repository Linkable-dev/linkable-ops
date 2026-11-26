import { useEffect, useState } from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { api, friendlyDate, friendlyNumber } from "../../lib/api";
import { Card } from "../ui/Card";
import { Btn } from "../ui/Button";
import { Pagination } from "../ui/Pagination";
import { Skeleton, SkeletonBars } from "../ui/Skeleton";

// The creator sign up, step by step (server/lib/signup-funnel.js): how many
// got at least that far, and who stopped before each step. Federico, 26 Nov:
// "is there a way to see why they drop at sign up?"

const PERIODS = [[7, "7 days"], [30, "30 days"], [90, "90 days"]];

const pct = (n, of) => (of > 0 ? Math.round((n / of) * 100) : 0);

export function SignupFunnel() {
  const { theme } = useTheme();
  const [days, setDays] = useState(30);
  // The answer, kept with the period it is for: a period still loading shows
  // the skeleton, never the last period's numbers.
  const [res, setRes] = useState(null);
  const [open, setOpen] = useState(null); // the step whose "stopped here" list is open
  const pick = (d) => { setDays(d); setOpen(null); };

  useEffect(() => {
    let alive = true;
    api.getSignupFunnel(days)
      .then((d) => { if (alive) setRes({ days, data: d }); })
      .catch((e) => { if (alive) setRes({ days, error: e.message }); });
    return () => { alive = false; };
  }, [days]);
  const current = res?.days === days ? res : null;
  const data = current?.data || null;
  const error = current?.error || null;

  const steps = data?.steps || [];
  const start = steps[0]?.count || 0;
  // The step that lost the most people is the one to look at first.
  let biggest = null;
  for (let i = 1; i < steps.length; i++) {
    const lost = steps[i - 1].count - steps[i].count;
    if (lost > 0 && (!biggest || lost > biggest.lost)) biggest = { key: steps[i].key, lost };
  }

  return (
    <Card style={{ padding: 0, marginBottom: 20 }}>
      <div style={{ padding: "14px 20px", borderBottom: `1px solid ${theme.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>Creator sign up, step by step</div>
          <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 2 }}>
            Creators who signed in themselves in the last {days} days, and how far they got.
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {PERIODS.map(([d, label]) => (
            <Btn key={d} size="sm" variant={d === days ? "solid" : "secondary"} onClick={() => pick(d)}>{label}</Btn>
          ))}
        </div>
      </div>

      <div style={{ padding: "14px 20px" }}>
        {error && <div style={{ fontSize: 13, color: "#DC2626" }}>{error}</div>}
        {!error && !data && <SkeletonBars rows={5} labelWidth={170} valueWidth={64} barHeight={8} gap={14} />}
        {data && start === 0 && (
          <div style={{ fontSize: 13, color: theme.textMuted }}>No creator signed in in the last {days} days.</div>
        )}
        {data && start > 0 && steps.map((s, i) => {
          const prev = i > 0 ? steps[i - 1].count : null;
          const lost = prev != null ? prev - s.count : 0;
          return (
            <div key={s.key}>
              {lost > 0 && (
                <StoppedRow
                  theme={theme} days={days} step={s} lost={lost} prev={prev}
                  reasons={s.key === "let_in" ? data.held_reasons : null}
                  biggest={biggest?.key === s.key}
                  open={open === s.key}
                  onToggle={() => setOpen(open === s.key ? null : s.key)}
                />
              )}
              <StepRow theme={theme} step={s} start={start} />
            </div>
          );
        })}
        {data && (
          <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 6 }}>
            Not counted: {friendlyNumber(data.invited)} account{data.invited === 1 ? "" : "s"} made in this period by a
            brand&apos;s invite or our outreach and never taken up (Impersonation, Status: Invited, never signed up).
          </div>
        )}
      </div>
    </Card>
  );
}

function StepRow({ theme, step, start }) {
  const p = pct(step.count, start);
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
        <span style={{ fontSize: 13, color: theme.text, fontWeight: 600 }}>
          {step.label}
          <span style={{ fontSize: 12, color: theme.textMuted, fontWeight: 400, marginLeft: 8 }}>{step.hint}</span>
        </span>
        <span style={{ fontSize: 13, color: theme.text, whiteSpace: "nowrap" }}>
          <strong>{friendlyNumber(step.count)}</strong>
          <span style={{ color: theme.textMuted, fontSize: 11, marginLeft: 6 }}>{p}%</span>
        </span>
      </div>
      <div style={{ height: 8, background: theme.surfaceAlt, borderRadius: 99, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${p}%`, background: theme.accent, borderRadius: 99, transition: "width 0.4s ease" }} />
      </div>
    </div>
  );
}

function StoppedRow({ theme, days, step, lost, prev, reasons, biggest, open, onToggle }) {
  const color = biggest ? "#B45309" : theme.textMuted;
  return (
    <div style={{ margin: "2px 0 12px 14px", paddingLeft: 12, borderLeft: `2px solid ${biggest ? "#B45309" : theme.border}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color }}>
          <strong>{friendlyNumber(lost)}</strong> stopped before {step.label} ({pct(lost, prev)}% of the step before)
          {biggest && <strong> · biggest drop</strong>}
        </span>
        <Btn size="sm" variant="secondary" onClick={onToggle}>{open ? "Hide" : "Show who"}</Btn>
      </div>
      {reasons?.length > 0 && (
        <div style={{ fontSize: 12, color: theme.textMid, marginTop: 6 }}>
          Held back by the sign up checks:{" "}
          {reasons.map((r, i) => (
            <span key={r.title}>{i > 0 && " · "}{r.title} <strong>{friendlyNumber(r.count)}</strong></span>
          ))}
          <span style={{ color: theme.textMuted }}> (one creator can fail several)</span>
        </div>
      )}
      {open && <StoppedList theme={theme} days={days} step={step.key} />}
    </div>
  );
}

function StoppedList({ theme, days, step }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [res, setRes] = useState(null); // { key, data | error }
  const key = `${days}|${step}|${page}|${pageSize}`;

  useEffect(() => {
    let alive = true;
    api.getSignupFunnelStopped({ days, step, limit: pageSize, offset: (page - 1) * pageSize })
      .then((d) => { if (alive) setRes({ key, data: d }); })
      .catch((e) => { if (alive) setRes({ key, error: e.message }); });
    return () => { alive = false; };
  }, [key, days, step, page, pageSize]);
  const current = res?.key === key ? res : null;
  const data = current?.data || null;
  const error = current?.error || null;

  const cell = { padding: "7px 10px", fontSize: 12, color: theme.textMid, borderTop: `1px solid ${theme.border}`, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 260 };
  return (
    <div style={{ marginTop: 10 }}>
      {error && <div style={{ fontSize: 12, color: "#DC2626" }}>{error}</div>}
      {!error && !data && <Skeleton width="100%" height={60} />}
      {data && (
        <>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  {["Creator", "Instagram / TikTok", "Email", "Signed in", ...(step === "let_in" ? ["Held because"] : [])].map((h) => (
                    <th key={h} style={{ ...cell, borderTop: "none", textAlign: "left", fontWeight: 600, color: theme.textMuted }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const handle = r.instagram_username ? `@${r.instagram_username}` : r.tiktok_username ? `@${r.tiktok_username} (TikTok)` : "";
                  return (
                    <tr key={r.user_id}>
                      <td style={{ ...cell, color: theme.text }}>
                        {[r.first_name, r.last_name].filter(Boolean).join(" ") || <span style={{ color: theme.textMuted, fontStyle: "italic" }}>(no name)</span>}
                      </td>
                      <td style={cell}>{handle || <span style={{ color: theme.textMuted }}>—</span>}</td>
                      <td style={cell} title={r.email}>{r.email}</td>
                      <td style={cell}>{friendlyDate(r.started_at)}</td>
                      {step === "let_in" && (
                        <td style={{ ...cell, whiteSpace: "normal" }}>{(r.failed_checks || []).join(", ") || <span style={{ color: theme.textMuted }}>Check not finished</span>}</td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {data.total > 25 && (
            <Pagination
              page={page} pageSize={pageSize} total={data.total}
              onPageChange={setPage}
              onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
            />
          )}
        </>
      )}
    </div>
  );
}
