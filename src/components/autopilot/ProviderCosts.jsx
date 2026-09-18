import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Btn } from "../ui/Button";

export default function ProviderCosts({ theme, field, section }) {
  const [providers, setProviders] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  function apply(data) {
    setProviders(data.providers || []);
    setAvailable(data.available !== false);
    setDrafts(Object.fromEntries((data.providers || []).map((p) => [p.provider, {
      unit_cost: p.unit_cost ?? "", currency: p.currency || "USD", note: p.note || "",
    }])));
  }
  useEffect(() => {
    let active = true;
    api.getProviderCosts().then((data) => { if (active) apply(data); })
      .catch((e) => { if (active) setError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function save(provider, clear = false) {
    setBusy(provider);
    setError("");
    try {
      if (clear) await api.clearProviderCost(provider);
      else await api.setProviderCost(provider, drafts[provider]);
      apply(await api.getProviderCosts());
    } catch (e) { setError(e.message); }
    finally { setBusy(""); }
  }
  const patch = (provider, key, value) => setDrafts((previous) => ({
    ...previous, [provider]: { ...previous[provider], [key]: value },
  }));

  return (
    <section style={section} aria-label="Provider costs">
      <h3 style={{ fontSize: 14, margin: "0 0 8px" }}>Provider costs</h3>
      <p style={{ fontSize: 12, color: theme.textMuted }}>
        This month’s recorded sourcing usage, estimated at the rates you enter below.
        Rates affect reporting only. Estimates exclude subscriptions, taxes and untracked usage;
        currencies are kept separate. Model tokens are not tracked here.
      </p>
      {loading && <p>Loading costs…</p>}
      {!loading && !available && <p style={{ fontSize: 12 }}>Provider costs are not available on this database yet.</p>}
      {providers.map((p) => {
        const draft = drafts[p.provider];
        return (
          <div key={p.provider} style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 12, marginTop: 12 }}>
            <strong style={{ fontSize: 13 }}>{p.label}</strong>
            <p style={{ fontSize: 12, color: theme.textMuted }}>{p.help}</p>
            <p style={{ fontSize: 13 }}>
              {p.quantity ?? "—"} {p.unit}s · {p.configured
                ? `${p.currency} ${Number(p.estimated_cost).toFixed(4)} estimated`
                : "Rate unset"}
            </p>
            {p.rateHint && !p.configured && (
              <p style={{ fontSize: 11, color: theme.textMuted, fontStyle: "italic" }}>{p.rateHint}</p>
            )}
            <label style={{ display: "block", fontSize: 12 }}>
              Cost per {p.unit}
              <input aria-label={`${p.label} cost per ${p.unit}`} type="number" min="0" max="999999.999999" step="0.000001"
                placeholder={p.rateHint ? "e.g. from the real invoice" : undefined}
                value={draft.unit_cost} onChange={(e) => patch(p.provider, "unit_cost", e.target.value)} style={field} />
            </label>
            <label style={{ display: "block", fontSize: 12, marginTop: 8 }}>
              Currency
              <input aria-label={`${p.label} currency`} maxLength={3} value={draft.currency}
                onChange={(e) => patch(p.provider, "currency", e.target.value.toUpperCase())} style={field} />
            </label>
            <label style={{ display: "block", fontSize: 12, marginTop: 8 }}>
              Rate source or contract
              <input aria-label={`${p.label} rate source`} maxLength={500} value={draft.note}
                onChange={(e) => patch(p.provider, "note", e.target.value)} style={field} />
            </label>
            {p.updated_by && <p style={{ fontSize: 11, color: theme.textMuted }}>Last set by {p.updated_by}</p>}
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <Btn size="sm" loading={busy === p.provider} disabled={Boolean(busy) || draft.unit_cost === ""}
                onClick={() => save(p.provider)}>Save rate</Btn>
              {p.configured && <Btn size="sm" disabled={Boolean(busy)} onClick={() => save(p.provider, true)}>Clear rate</Btn>}
            </div>
          </div>
        );
      })}
      {error && <p role="alert" style={{ color: "#B91C1C", fontSize: 12 }}>{error}</p>}
    </section>
  );
}
