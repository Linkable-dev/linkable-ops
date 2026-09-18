import { useEffect, useState } from "react";
import { api } from "../../lib/api";

// Read-only: neither provider publishes a rate that applies to us
// specifically (see rateHint below), so there's no number worth typing into
// this UI on a guess. A real rate goes into provider_costs directly, once an
// actual invoice is in hand, the same way any other one-off admin value is
// set — not through a form built to make guessing convenient.
export default function ProviderCosts({ theme, section }) {
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    api.getProviderCosts()
      .then((data) => {
        if (!active) return;
        setProviders(data.providers || []);
        setAvailable(data.available !== false);
      })
      .catch((e) => { if (active) setError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  return (
    <section style={section} aria-label="Provider costs">
      <h3 style={{ fontSize: 14, margin: "0 0 8px" }}>Provider costs</h3>
      <p style={{ fontSize: 12, color: theme.textMuted }}>
        This month’s recorded sourcing usage, estimated at the rate on file.
        Estimates exclude subscriptions, taxes and untracked usage; currencies are kept
        separate. Model tokens are not tracked here.
      </p>
      {loading && <p>Loading costs…</p>}
      {!loading && !available && <p style={{ fontSize: 12 }}>Provider costs are not available on this database yet.</p>}
      {providers.map((p) => (
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
          {p.configured && (
            <p style={{ fontSize: 12 }}>
              {p.currency} {Number(p.unit_cost).toFixed(6)} / {p.unit}
              {p.note && ` — ${p.note}`}
            </p>
          )}
          {p.updated_by && <p style={{ fontSize: 11, color: theme.textMuted }}>Last set by {p.updated_by}</p>}
        </div>
      ))}
      {error && <p role="alert" style={{ color: "#B91C1C", fontSize: 12 }}>{error}</p>}
    </section>
  );
}
