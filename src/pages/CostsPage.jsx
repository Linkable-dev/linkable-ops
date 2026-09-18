import { useEffect, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api } from "../lib/api";
import { SkeletonStat, SkeletonBars } from "../components/ui/Skeleton";
import ProviderCosts from "../components/autopilot/ProviderCosts";

// One page for the question "what does recruiting cost us, and what does that
// leave": this month's provider spend against this month's revenue. It reuses
// the existing sources rather than recomputing them — /analytics/home already
// gets MRR right (trials excluded, yearly normalized), and /provider-costs
// already gets this month's billed usage right. Recomputing either here would
// risk quietly drifting from the numbers those pages show.

const RED = "#EF4444";
const GREEN = "#10B981";

const money = (n, { currency = "USD" } = {}) => {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(Number(n || 0));
  } catch {
    return `${currency} ${Number(n || 0).toLocaleString("en-US")}`;
  }
};
const num = (n) => Number(n || 0).toLocaleString("en-US");

function Section({ title, hint, children }) {
  const { theme } = useTheme();
  return (
    <div style={{ marginBottom: 34 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
        <h2 style={{ fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, color: theme.textMid, margin: 0 }}>
          {title}
        </h2>
        {hint && <span style={{ fontSize: 12, color: theme.textMuted }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Card({ children, span = 3, pad = 18, style }) {
  const { theme } = useTheme();
  return (
    <div className={`lk-c${span}`} style={{
      background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 12,
      padding: pad, minWidth: 0, boxSizing: "border-box", ...style,
    }}>
      {children}
    </div>
  );
}

function Stat({ label, value, sub, accent, span = 3 }) {
  const { theme } = useTheme();
  return (
    <Card span={span}>
      <div style={{ fontSize: 12, color: theme.textMuted, fontWeight: 500, marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: accent || theme.text, lineHeight: 1.1, letterSpacing: -0.5, overflowWrap: "anywhere" }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 6 }}>{sub}</div>}
    </Card>
  );
}

export default function CostsPage() {
  const { theme } = useTheme();
  const [home, setHome] = useState(null);
  const [costs, setCosts] = useState(null);
  const [economics, setEconomics] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    Promise.all([api.getHome(), api.getProviderCosts(), api.getSearchEconomics()])
      .then(([h, c, e]) => { if (alive) { setHome(h); setCosts(c); setEconomics(e); } })
      .catch((err) => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, []);

  const loading = !error && (!home || !costs || !economics);

  if (loading) {
    return (
      <div>
        <div style={{ fontSize: 22, fontWeight: 700, color: theme.text, marginBottom: 24 }}>Costs & margin</div>
        <Section title="This month">
          <div className="lk-grid">
            {[0, 1, 2].map((i) => <div key={i} className="lk-c4"><SkeletonStat variant="stat" seed={i} /></div>)}
          </div>
        </Section>
        <div style={{ marginBottom: 34 }}>
          <Card pad={20}><SkeletonBars rows={2} labelWidth={150} valueWidth={110} barHeight={12} gap={14} /></Card>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <div style={{ fontSize: 22, fontWeight: 700, color: theme.text, marginBottom: 12 }}>Costs & margin</div>
        <div style={{ padding: 16, borderRadius: 10, border: `1px solid ${RED}`, color: RED, fontSize: 13 }}>
          Failed to load: {error}
        </div>
      </div>
    );
  }

  const mrr = home.revenue?.mrr ?? 0;
  const providers = costs.providers || [];
  // Only USD, only providers with a rate set: an unconfigured provider has no
  // honest cost to net out, and a rate in another currency cannot be summed
  // with MRR (which /analytics/home bills in USD) without a conversion this
  // page does not have.
  const usdCosted = providers.filter((p) => p.configured && (p.currency || "USD").toUpperCase() === "USD");
  const otherCurrency = providers.filter((p) => p.configured && (p.currency || "USD").toUpperCase() !== "USD");
  const totalCost = usdCosted.reduce((sum, p) => sum + Number(p.estimated_cost || 0), 0);
  const margin = mrr - totalCost;
  const marginPct = mrr > 0 ? Math.round((margin / mrr) * 1000) / 10 : null;
  const uncosted = providers.filter((p) => !p.configured);

  // One readable sentence covering all four shapes: some/none costed in USD,
  // some/none costed in another currency (which cannot be netted against MRR).
  // Distinct from "available: false" (e.g. prod, which has no sourcing
  // schema) — that is not "no rates", it is "nothing to rate yet".
  const costsSub = costs.available === false ? "not available on this database" : [
    usdCosted.length > 0 ? usdCosted.map((p) => p.label).join(", ") : "no provider has a rate set",
    otherCurrency.length > 0 ? `+ ${otherCurrency.map((p) => `${p.label} (${p.currency})`).join(", ")} not in USD` : null,
  ].filter(Boolean).join(" ");

  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 700, color: theme.text, marginBottom: 24 }}>Costs & margin</div>

      <Section title="This month" hint="MRR from Home; provider costs from the rates set below — not a full P&L">
        <div className="lk-grid">
          <Stat span={4} label="MRR" value={money(mrr)} sub={`${num(home.revenue?.payingBrands)} paying brand${home.revenue?.payingBrands === 1 ? "" : "s"}`} />
          <Stat span={4} label="Provider costs" value={money(totalCost)} accent={totalCost > 0 ? undefined : theme.textMuted} sub={costsSub} />
          <Stat span={4} label="Margin" value={costs.available === false ? "—" : money(margin)}
            accent={costs.available === false ? theme.textMuted : margin >= 0 ? GREEN : RED}
            sub={costs.available === false ? "provider costs unavailable on this database" : marginPct != null ? `${marginPct}% of MRR` : "no MRR this month"} />
        </div>
        <p style={{ fontSize: 12, color: theme.textMuted, marginTop: 12 }}>
          Margin nets this month's provider costs off MRR. It does not include hosting, infrastructure,
          payroll, or any other cost — only the providers tracked below, and only once a rate is entered for them.
          {uncosted.length > 0 && ` ${uncosted.map((p) => p.label).join(", ")} ${uncosted.length === 1 ? "has" : "have"} usage but no rate set yet, so ${uncosted.length === 1 ? "it isn't" : "they aren't"} in the total.`}
        </p>
      </Section>

      {/* No outer heading here: ProviderCosts renders its own ("Provider
          costs") plus the explanation of what it measures — a Section title
          on top of that would just repeat it. */}
      <div style={{ marginBottom: 34 }}>
        <Card pad={0} style={{ padding: 16 }}>
          <ProviderCosts theme={theme}
            field={{ width: "100%", padding: "7px 9px", borderRadius: 7, border: `1px solid ${theme.border}`, background: theme.bg, color: theme.text, fontSize: 13, fontFamily: "inherit" }}
            section={{ background: "transparent", border: "none", padding: 0, margin: 0 }} />
        </Card>
      </div>

      <Section title="Search economics" hint="lifetime, from billed provider data — what one search actually costs and finds">
        {economics.available && economics.runs > 0 ? (
          <div className="lk-grid">
            <Stat span={3} label="Searches run" value={num(economics.runs)} />
            <Stat span={3} label="Avg credits / search" value={num(economics.avg_credits)} sub={`${num(economics.min_credits)}–${num(economics.max_credits)} seen`} />
            <Stat span={3} label="Avg creators found" value={num(economics.avg_found)} sub={`~${num(economics.avg_contactable)} with an email`} />
            <Stat span={3} label="Total credits" value={num(economics.total_credits)} sub="lifetime, all searches" />
          </div>
        ) : (
          <Card pad={16}>
            <p style={{ fontSize: 13, color: theme.textMuted, margin: 0 }}>
              {economics.available === false ? "Not available on this database." : "No completed searches yet."}
            </p>
          </Card>
        )}
      </Section>
    </div>
  );
}
