import { Fragment, useEffect, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Select } from "../components/ui/Select";
import { Skeleton, SkeletonTableRows } from "../components/ui/Skeleton";
import { useColumnWidths, ResizeHandle } from "../components/table/tableTools";

/**
 * The synthetic creator roster.
 *
 * Invented people a brand can generate with, each frozen by an identity sheet
 * so the same face carries a whole campaign. It moved here from the main app's
 * /admin, which is gone: this is ops work, because both buttons spend and the
 * person they invent goes into a roster EVERY brand generates with.
 *
 * Two buttons, and the gap between them is the point. Casting writes the sheet
 * and costs one model call — a face on paper, nothing rendered. Rendering
 * photographs that face and costs GPU time, and re-rendering silently changes
 * the face on everything generated afterwards, which is why it asks first.
 */

// The fields a sheet is worth reading for, in the order a person reads them.
const SHEET_FIELDS = ["face", "eyes", "hair", "skin", "marks", "build", "voice"];

const GENDERS = [
  ["", "Either"],
  ["female", "Female"],
  ["male", "Male"],
];

// The roster table's columns. No server-side sort/filter here (the roster is
// small and unpaginated), just drag-resizable widths — the "actions" column
// holds two buttons and doesn't shrink below that.
const ROSTER_COLUMNS = [
  { key: "name",      label: "Name",      width: 220 },
  { key: "archetype", label: "Archetype", width: 160 },
  { key: "status",    label: "Status",    width: 170 },
  { key: "plates",    label: "Plates",    width: 160 },
  { key: "actions",   label: "Actions",   width: 200, resizable: false },
];
const ROSTER_DEFAULT_WIDTHS = Object.fromEntries(ROSTER_COLUMNS.map((c) => [c.key, c.width]));

export default function AiCreatorsPage() {
  const { theme, mode } = useTheme();
  const dark = mode === "dark";

  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [archetype, setArchetype] = useState("");
  const [gender, setGender] = useState("");
  const [openSheet, setOpenSheet] = useState("");
  const [confirmRender, setConfirmRender] = useState("");
  const [note, setNote] = useState("");

  const { widths, startResize, resetWidth } = useColumnWidths("ai-creators-roster", ROSTER_DEFAULT_WIDTHS);

  const load = () =>
    api
      .getAiCreators()
      .then(setData)
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  async function cast() {
    setBusy("cast");
    setError("");
    try {
      const d = await api.castAiCreator({ archetype_id: archetype, gender });
      setNote(`${d.avatar?.name || "A new creator"} cast — read the sheet, then render plates`);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  async function render(id) {
    setBusy(id);
    setError("");
    setConfirmRender("");
    try {
      await api.renderAiCreatorPlates(id);
      setNote("Rendering — a few minutes of GPU. Refresh to see the plates land.");
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  // Only a creator with plates is offered to brands. Without them the model
  // draws a different plausible person every time, which is the whole thing the
  // sheet exists to prevent.
  const offered = (a) => a.status === "ready" && a.plate_count > 0;

  const th = {
    padding: "8px 10px", fontSize: 11, fontWeight: 600, textTransform: "uppercase",
    letterSpacing: 0.4, color: theme.textMuted, borderBottom: `1px solid ${theme.border}`,
    whiteSpace: "nowrap", textAlign: "left",
  };
  const td = {
    padding: "10px", fontSize: 13, borderBottom: `1px solid ${theme.border}`,
    verticalAlign: "middle",
  };
  const pill = (text, tone) => {
    const tones = {
      good: { bg: dark ? "#0E2E22" : "#D1FAE5", fg: dark ? "#6EE7B7" : "#065F46" },
      bad: { bg: dark ? "#3F1313" : "#FEE2E2", fg: dark ? "#FCA5A5" : "#991B1B" },
      idle: { bg: dark ? "#1F2937" : "#F3F4F6", fg: dark ? "#9CA3AF" : "#4B5563" },
    };
    const c = tones[tone] || tones.idle;
    return (
      <span style={{
        display: "inline-block", padding: "2px 8px", borderRadius: 999,
        fontSize: 12, fontWeight: 600, background: c.bg, color: c.fg, whiteSpace: "nowrap",
      }}>
        {text}
      </span>
    );
  };

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>AI creators</h1>
      <p style={{ color: theme.textMuted, fontSize: 13, margin: "0 0 20px", maxWidth: 760 }}>
        Invented people a brand can generate with. Each is frozen by an identity sheet, so the same
        face carries a whole campaign. Casting writes the sheet and spends one model call;
        rendering photographs that face and spends GPU time. Only a creator with plates is offered
        to brands.
      </p>

      {data && !data.configured && (
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Not wired up on this deployment</div>
          <div style={{ color: theme.textMuted, fontSize: 13, lineHeight: 1.6 }}>
            The content gateway refuses a call without its shared secret, so this panel can do
            nothing until it has one. Set <code>CONTENT_GATEWAY_SECRET</code> (and{" "}
            <code>CONTENT_GATEWAY_SECRET_DEV</code> if dev uses a different one) in the ops
            environment — the same value the main app deploys with.
          </div>
        </Card>
      )}

      {data?.configured && !data.reachable && (
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>The content service isn't answering</div>
          <div style={{ color: theme.textMuted, fontSize: 13 }}>
            Showing nothing rather than everything. Nothing has been lost — try again in a moment.
          </div>
        </Card>
      )}

      {error && (
        <Card>
          <div style={{ color: "#B91C1C", fontSize: 13 }}>{error}</div>
        </Card>
      )}

      {note && (
        <Card>
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
            <span style={{ flex: 1 }}>{note}</span>
            <Btn size="sm" variant="outline" onClick={() => { setNote(""); load(); }}>
              Refresh
            </Btn>
          </div>
        </Card>
      )}

      {/* Cast ------------------------------------------------------------ */}
      {data?.configured && (
        <Card>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.4 }}>
                Archetype
              </span>
              <div style={{ minWidth: 260 }}>
                <Select
                  value={archetype}
                  onChange={setArchetype}
                  ariaLabel="Archetype"
                  placeholder="Pick for me"
                  options={[{ value: "", label: "Pick for me" },
                    ...(data.archetypes || []).map((a) => ({
                      value: a.id, label: a.label,
                      hint: a.verticals?.length ? a.verticals.join(", ") : "",
                    }))]}
                  searchPlaceholder="Archetype or vertical…"
                />
              </div>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.4 }}>
                Gender
              </span>
              <div style={{ width: 130 }}>
                <Select
                  value={gender}
                  onChange={setGender}
                  ariaLabel="Gender"
                  options={GENDERS.map(([value, text]) => ({ value, label: text }))}
                />
              </div>
            </label>
            <Btn size="sm" loading={busy === "cast"} onClick={cast}>
              Cast a creator
            </Btn>
            <span style={{ color: theme.textMuted, fontSize: 12 }}>
              One model call. Nothing is rendered yet.
            </span>
          </div>
        </Card>
      )}

      {/* Roster ---------------------------------------------------------- */}
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{
            width: "100%",
            minWidth: Object.values(widths).reduce((a, b) => a + b, 0),
            borderCollapse: "collapse", tableLayout: "fixed",
          }}>
            <colgroup>
              {ROSTER_COLUMNS.map((col) => (
                <col key={col.key} style={{ width: widths[col.key] }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {ROSTER_COLUMNS.map((col) => (
                  <th key={col.key} style={{
                    ...th,
                    position: "relative",
                    ...(col.key === "actions" ? { textAlign: "right" } : {}),
                  }}>
                    {col.label}
                    {col.resizable !== false && (
                      <ResizeHandle colKey={col.key} startResize={startResize} resetWidth={resetWidth} theme={theme} />
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {!data && <SkeletonTableRows rows={4} cols={5} />}

              {data && (data.avatars || []).length === 0 && (
                <tr>
                  <td style={{ ...td, color: theme.textMuted }} colSpan={5}>
                    {data.configured
                      ? "Nobody cast yet. Cast one above — it costs a model call and renders nothing."
                      : "Nothing to show until the gateway secret is set."}
                  </td>
                </tr>
              )}

              {(data?.avatars || []).map((a) => (
                <Fragment key={a.id}>
                  <tr>
                    <td style={{ ...td, fontWeight: 600 }}>
                      {a.name}
                      {a.identity_sheet?.age && (
                        <span style={{ color: theme.textMuted, fontWeight: 400 }}>
                          , {a.identity_sheet.age} · {a.identity_sheet.gender}
                        </span>
                      )}
                    </td>
                    <td style={{ ...td, color: theme.textMuted }}>{a.archetype || "—"}</td>
                    <td style={td}>
                      {offered(a)
                        ? pill("Offered to brands", "good")
                        : pill(a.status, a.status === "failed" ? "bad" : "idle")}
                    </td>
                    <td style={td}>
                      {a.plate_urls?.length ? (
                        <div style={{ display: "flex", gap: 4 }}>
                          {a.plate_urls.map((url, i) => (
                            <img
                              key={url}
                              src={url}
                              alt={`Reference plate ${i + 1} for ${a.name}`}
                              style={{ width: 44, height: 44, borderRadius: 6, objectFit: "cover" }}
                            />
                          ))}
                        </div>
                      ) : (
                        <span style={{ color: theme.textMuted }}>none</span>
                      )}
                    </td>
                    <td style={td}>
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <Btn
                          size="sm"
                          variant="outline"
                          onClick={() => setOpenSheet(openSheet === a.id ? "" : a.id)}
                        >
                          {openSheet === a.id ? "Hide sheet" : "Sheet"}
                        </Btn>
                        {/* Re-rendering changes the face on everything already
                            generated with this creator, so it asks first. A
                            first render has nothing to overwrite and does not. */}
                        <Btn
                          size="sm"
                          loading={busy === a.id}
                          disabled={a.status === "rendering"}
                          onClick={() => (a.plate_count ? setConfirmRender(a.id) : render(a.id))}
                        >
                          {a.plate_count ? "Re-render" : "Render plates"}
                        </Btn>
                      </div>
                    </td>
                  </tr>

                  {confirmRender === a.id && (
                    <tr>
                      <td style={{ ...td, background: theme.bg }} colSpan={5}>
                        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 13, flex: "1 1 420px" }}>
                            Re-render {a.name}? The new plates replace these ones, and every image
                            generated with {a.name} from now on will be a different face.
                          </span>
                          <div style={{ display: "flex", gap: 6 }}>
                            <Btn size="sm" variant="outline" onClick={() => setConfirmRender("")}>
                              Keep these
                            </Btn>
                            <Btn size="sm" loading={busy === a.id} onClick={() => render(a.id)}>
                              Re-render
                            </Btn>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}

                  {openSheet === a.id && (
                    <tr>
                      <td style={{ ...td, background: theme.bg }} colSpan={5}>
                        {a.identity_sheet ? (
                          <>
                            <div style={{
                              display: "grid", gap: "10px 28px",
                              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                            }}>
                              {SHEET_FIELDS.filter((k) => a.identity_sheet[k]).map((k) => (
                                <div key={k}>
                                  <div style={{
                                    fontSize: 11, fontWeight: 600, textTransform: "uppercase",
                                    letterSpacing: 0.4, color: theme.textMuted,
                                  }}>
                                    {k}
                                  </div>
                                  <div style={{ fontSize: 13, marginTop: 2 }}>{a.identity_sheet[k]}</div>
                                </div>
                              ))}
                            </div>
                            <div style={{ color: theme.textMuted, fontSize: 12, marginTop: 10 }}>
                              Re-rendering replaces these plates and changes the face on everything
                              generated afterwards.
                            </div>
                          </>
                        ) : (
                          <div style={{ color: theme.textMuted, fontSize: 13 }}>
                            No sheet was written for this one.
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {!data && (
        <div style={{ marginTop: 10 }}>
          <Skeleton width={180} height={12} />
        </div>
      )}
    </div>
  );
}
