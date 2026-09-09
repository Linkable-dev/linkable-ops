// The creator base ranked against one campaign, with the reason for each rank.
//
// "No applications" was a state the console could find and not act on, which
// is the state that decides whether a new brand ever sees value. This produces
// the shortlist. It invites nobody — sending invitations changes marketplace
// state and notifies creators, so that stays a deliberate, separate step.

import { useEffect, useState } from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { api, friendlyDate, friendlyNumber } from "../../lib/api";
import { Modal } from "../ui/Modal";
import { Btn } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";

const band = (score) =>
  score >= 75 ? { label: "Strong", color: "#059669", bg: "#D1FAE5" }
  : score >= 55 ? { label: "Good", color: "#0369A1", bg: "#E0F2FE" }
  : score >= 35 ? { label: "Possible", color: "#B45309", bg: "#FEF3C7" }
  : { label: "Weak", color: "#6B7280", bg: "#F3F4F6" };

export default function CreatorMatchesModal({ campaign, onClose }) {
  const { theme } = useTheme();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  // The modal is mounted fresh per campaign, so state starts empty already —
  // no need to reset it here, which also keeps the effect free of synchronous
  // setState calls.
  useEffect(() => {
    let alive = true;
    api.getCreatorMatches(campaign.id, { limit: 25 })
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [campaign.id]);

  const copyList = () => {
    const text = (data?.matches || [])
      .map((m, i) => `${i + 1}. ${m.name}${m.handle ? ` (@${m.handle})` : ""} — ${friendlyNumber(m.followers)} followers, ${m.score}/100`)
      .join("\n");
    navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <Modal open onClose={onClose} title="Creators for this campaign" width={720}>
      <div style={{ fontSize: 13, color: theme.textMid, marginBottom: 4 }}>
        <b style={{ color: theme.text }}>{campaign.campaign_name}</b>
        {campaign.brand_name ? <span style={{ color: theme.textMuted }}> · {campaign.brand_name}</span> : null}
      </div>
      <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 14 }}>
        Ranked on niche fit, track record, audience, whether a sample can reach them, and how
        recently they signed in. Nobody is invited from here.
      </div>

      {error && <div style={{ fontSize: 13, color: theme.danger, marginBottom: 12 }}>{error}</div>}

      {!data && !error ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} width="100%" height={54} radius={8} />)}
        </div>
      ) : data ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12, color: theme.textMuted, marginBottom: 12 }}>
            <span>{data.pool.toLocaleString()} creators considered</span>
            {data.campaign.brand_niche && <span>· brand niche {data.campaign.brand_niche.toLowerCase().replace(/_/g, " ")}</span>}
            {data.campaign.shipping && (
              <span>· ships to {data.campaign.ships_to === "everywhere" ? "everywhere" : `${data.campaign.ships_to || "?"} countries`}</span>
            )}
            <Btn size="sm" variant="outline" style={{ marginLeft: "auto" }} onClick={copyList}>
              {copied ? "Copied" : "Copy shortlist"}
            </Btn>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "52vh", overflowY: "auto" }}>
            {data.matches.map((m) => {
              const b = band(m.score);
              return (
                <div key={m.user_id} style={{
                  display: "flex", gap: 12, alignItems: "flex-start",
                  padding: "10px 12px", borderRadius: 10, border: `1px solid ${theme.border}`, background: theme.surface,
                }}>
                  <div style={{ flexShrink: 0, textAlign: "center", minWidth: 46 }}>
                    <div style={{ fontSize: 17, fontWeight: 700, color: b.color, fontVariantNumeric: "tabular-nums" }}>{m.score}</div>
                    <div style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: b.color, background: b.bg, borderRadius: 4, padding: "1px 4px", marginTop: 2 }}>{b.label}</div>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>{m.name}</span>
                      {m.handle && (
                        <a href={`https://instagram.com/${String(m.handle).replace(/^@+/, "")}`} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize: 12, color: theme.textMid }}>@{String(m.handle).replace(/^@+/, "")}</a>
                      )}
                      {m.last_sign_in && <span style={{ fontSize: 11, color: theme.textMuted }}>· seen {friendlyDate(m.last_sign_in)}</span>}
                    </div>
                    <ul style={{ margin: "4px 0 0", padding: 0, listStyle: "none", display: "flex", flexWrap: "wrap", gap: "2px 10px" }}>
                      {m.reasons.map((r) => (
                        <li key={r} style={{ fontSize: 11.5, color: r.includes("does not ship") || r.includes("Dormant") || r.includes("never signed in") ? "#B45309" : theme.textMid }}>{r}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              );
            })}
            {data.matches.length === 0 && (
              <div style={{ padding: 20, textAlign: "center", color: theme.textMuted, fontSize: 13 }}>
                Every creator is already attached to this campaign.
              </div>
            )}
          </div>
        </>
      ) : null}

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
        <Btn size="sm" variant="outline" onClick={onClose}>Close</Btn>
      </div>
    </Modal>
  );
}
