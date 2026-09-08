import { useEffect, useState } from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { useDbTarget } from "../../contexts/DbTargetContext";
import { api, friendlyDate, friendlyNumber } from "../../lib/api";
import { Btn } from "../ui/Button";
import { TabBar } from "../ui/TabBar";
import { Skeleton, SkeletonStatGrid, SkeletonTable, SkeletonKeyValue } from "../ui/Skeleton";
import GrantTrialModal from "../trials/GrantTrialModal";
import ManageBrandModal from "../users/ManageBrandModal";
import { planLabel } from "../trials/planConfig";

const TABS = [["overview", "Overview"], ["campaigns", "Campaigns"], ["creators", "Creators"], ["outbound", "Outbound"], ["history", "History"]];

const money = (n, currency = "USD", cents = false) => {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 }).format(Number(n || 0)); }
  catch { return `${currency} ${Number(n || 0).toLocaleString()}`; }
};
// brands.location is a pipe-separated market list that can run to 100+ codes.
const shortList = (value, max = 8) => {
  const parts = String(value || "").split("|").map((s) => s.trim()).filter((s) => s && s !== "*");
  if (!parts.length) return "—";
  const unique = [...new Set(parts)];
  return unique.length > max ? `${unique.slice(0, max).join(", ")} +${unique.length - max} more` : unique.join(", ");
};
const planFromAccount = (accountId) => {
  if (!accountId) return null;
  if (/shopify_(499|4970|299)/.test(accountId)) return "Growth";
  if (/shopify_(199|1990|99|990)/.test(accountId)) return "Starter";
  if (/free/.test(accountId)) return "Free";
  return null;
};

// Slide-in panel with everything about one brand. Opened from any brand name
// through BrandDrawerContext; actions reuse the Users page modals.
export default function BrandDrawer({ userId, onClose }) {
  const { theme } = useTheme();
  const { target } = useDbTarget();
  const isDev = target === "dev";
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState("overview");
  const [trialRow, setTrialRow] = useState(null);
  const [manageRow, setManageRow] = useState(null);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);

  const load = (id) => {
    setLoading(true); setError(null);
    api.getBrand360(id).then((d) => setData(d)).catch((e) => setError(e.message)).finally(() => setLoading(false));
  };
  useEffect(() => {
    if (!userId) { setData(null); return; }
    setTab("overview"); setActionError(null);
    load(userId);
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    const onKey = (e) => { if (e.key === "Escape" && !trialRow && !manageRow) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [userId, onClose, trialRow, manageRow]);

  if (!userId) return null;

  const impersonate = async () => {
    setBusy("impersonate"); setActionError(null);
    try {
      const result = await api.impersonateUser(userId);
      window.open(result.gateway_url, "_blank", "noopener,noreferrer");
    } catch (e) { setActionError(e.message); }
    finally { setBusy(null); }
  };

  const p = data?.profile;
  const initials = (p?.store_name || p?.email || "?").replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  const label = { fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textMuted, marginBottom: 8 };
  const section = { background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 12, padding: 16, marginBottom: 12 };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 900, background: "rgba(18,20,25,0.35)", backdropFilter: "blur(2px)" }} />
      <aside
        role="dialog" aria-label="Brand details"
        style={{
          position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 901, width: "min(680px, 100vw)",
          background: theme.bg, borderLeft: `1px solid ${theme.border}`, boxShadow: theme.shadowMd,
          display: "flex", flexDirection: "column", animation: "lkSlideIn 0.18s ease-out",
        }}
      >
        {/* Header */}
        <div style={{ padding: "16px 20px 12px", borderBottom: `1px solid ${theme.border}`, background: theme.surface }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <div style={{ width: 44, height: 44, borderRadius: 10, background: theme.surfaceAlt, color: theme.text, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 14, flexShrink: 0 }}>
              {loading ? <Skeleton width={44} height={44} radius={10} /> : initials}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {loading || !p ? (
                <><Skeleton width={220} height={18} /><div style={{ height: 6 }} /><Skeleton width={260} height={12} /></>
              ) : (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <div style={{ fontSize: 17, fontWeight: 700, color: theme.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.store_name || "(unnamed brand)"}</div>
                    <SubscriptionPill data={data} theme={theme} />
                    {p.hidden && <Pill bg="#FEF3C7" fg="#92400E">hidden</Pill>}
                    {p.startup_programme && <Pill bg="#E0E7FF" fg="#3730A3">startup programme</Pill>}
                    {!p.active && <Pill bg="#FEE2E2" fg="#991B1B">deleted</Pill>}
                  </div>
                  <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 3, display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <span>{p.email}</span>
                    {p.store_website && <a href={/^https?:/.test(p.store_website) ? p.store_website : `https://${p.store_website}`} target="_blank" rel="noopener noreferrer" style={{ color: theme.textMid }}>{p.store_website.replace(/^https?:\/\//, "")}</a>}
                  </div>
                </>
              )}
            </div>
            <button onClick={onClose} title="Close" style={{ width: 32, height: 32, borderRadius: 999, border: `1px solid ${theme.border}`, background: "transparent", color: theme.textMid, cursor: "pointer", flexShrink: 0 }}>✕</button>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap", alignItems: "center" }}>
            <Btn size="sm" onClick={impersonate} loading={busy === "impersonate"} disabled={!p || !p.active}>Impersonate</Btn>
            <Btn size="sm" variant="outline" onClick={() => setTrialRow(data.row)} disabled={!data}>Grant trial</Btn>
            <Btn size="sm" variant="outline" onClick={() => setManageRow(data.row)} disabled={!data}>Manage</Btn>
            <Btn size="sm" variant="secondary" onClick={() => load(userId)} disabled={loading}>Refresh</Btn>
            {actionError && <span style={{ fontSize: 12, color: theme.danger }}>{actionError}</span>}
          </div>
        </div>

        <div style={{ padding: "12px 20px 0" }}>
          <TabBar tabs={TABS} active={tab} onSelect={setTab} />
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "12px 20px 32px" }}>
          {error && <div style={{ padding: 14, borderRadius: 10, background: "#FEF2F2", color: "#B91C1C", fontSize: 13 }}>{error}</div>}
          {!error && (loading || !data) && <DrawerSkeleton tab={tab} />}
          {!error && !loading && data && tab === "overview" && <Overview data={data} theme={theme} label={label} section={section} />}
          {!error && !loading && data && tab === "campaigns" && <Campaigns data={data} theme={theme} />}
          {!error && !loading && data && tab === "creators" && <Creators data={data} theme={theme} />}
          {!error && !loading && data && tab === "outbound" && <Outbound data={data} theme={theme} label={label} section={section} />}
          {!error && !loading && data && tab === "history" && <History data={data} theme={theme} label={label} section={section} />}
        </div>
      </aside>

      <GrantTrialModal row={trialRow} isDev={isDev} onClose={() => setTrialRow(null)} onGranted={() => { setTrialRow(null); load(userId); }} />
      <ManageBrandModal
        row={manageRow} isDev={isDev}
        onClose={() => setManageRow(null)}
        onStartupChanged={() => load(userId)}
        onHiddenChanged={() => load(userId)}
        onWiped={() => { setManageRow(null); load(userId); }}
        onGrantTrial={(row) => { setManageRow(null); setTrialRow(row); }}
      />
    </>
  );
}

function Pill({ bg, fg, children }) {
  return <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600, background: bg, color: fg, whiteSpace: "nowrap" }}>{children}</span>;
}

function SubscriptionPill({ data, theme }) {
  const s = data?.subscription;
  const p = data?.profile;
  const plan = planFromAccount(p?.account_id) || (s?.name ? String(s.name).replace(/^Linkable\s+/i, "").replace(/\s*\(.*\)$/, "") : null);
  const inTrial = p?.trial_expiration_date && p.trial_expiration_date !== "-infinity" && new Date(p.trial_expiration_date) > new Date();
  const status = (s?.status || "").toUpperCase();
  if (status === "FROZEN") return <Pill bg="#FEE2E2" fg="#991B1B">{plan || "Plan"} · payment failed</Pill>;
  if (status && status !== "ACTIVE") return <Pill bg={theme.surfaceAlt} fg={theme.textMid}>{plan || "Plan"} · {status.toLowerCase()}</Pill>;
  if (inTrial) return <Pill bg="#FEF3C7" fg="#92400E">{plan ? `${plan} · ` : ""}trial ends {friendlyDate(p.trial_expiration_date)}</Pill>;
  if (plan === "Free") return <Pill bg={theme.surfaceAlt} fg={theme.textMid}>Free plan</Pill>;
  if (plan) return <Pill bg="#D1FAE5" fg="#065F46">{plan} · paying</Pill>;
  return <Pill bg={theme.surfaceAlt} fg={theme.textMuted}>No plan</Pill>;
}

function Stat({ theme, label, value, sub }) {
  return (
    <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 12, padding: "12px 14px", minWidth: 0 }}>
      <div style={{ fontSize: 11, color: theme.textMuted, fontWeight: 500 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: theme.text, marginTop: 4, overflowWrap: "anywhere" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function KV({ theme, rows }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 14px", fontSize: 13 }}>
      {rows.filter(Boolean).map(([k, v]) => (
        <FragmentKV key={k} theme={theme} k={k} v={v} />
      ))}
    </div>
  );
}
function FragmentKV({ theme, k, v }) {
  return (
    <>
      <div style={{ color: theme.textMuted, whiteSpace: "nowrap" }}>{k}</div>
      <div style={{ color: theme.text, minWidth: 0, overflowWrap: "anywhere" }}>{v ?? "—"}</div>
    </>
  );
}

function Overview({ data, theme, label, section }) {
  const p = data.profile;
  const s = data.subscription;
  const cur = data.orders.byCurrency;
  const activeCampaigns = data.campaigns.filter((c) => c.status === 2).length;
  const acceptedCreators = data.creators.filter((c) => c.status === 3).length;
  const gmvValue = cur.length === 0 ? money(0, p.shopify_shop_default_currency || "USD") : cur.map((c) => money(c.gmv, c.currency)).join(" + ");
  const trialGrant = p.trial_plan_name ? `${planLabel(p.trial_plan_name)} · ${p.trial_days || 0}d · ${p.trial_interval || "—"}` : null;
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 12 }}>
        <Stat theme={theme} label="GMV attributed" value={gmvValue} sub={`${cur.reduce((a, c) => a + c.orders, 0)} orders`} />
        <Stat theme={theme} label="Commission" value={cur.length ? cur.map((c) => money(c.commission, c.currency, true)).join(" + ") : money(0)} />
        <Stat theme={theme} label="Campaigns" value={activeCampaigns} sub={`${data.campaigns.length} launched${data.notLaunched ? ` · ${data.notLaunched} synced, not launched` : ""}`} />
        <Stat theme={theme} label="Accepted creators" value={acceptedCreators} sub={`${data.creators.length} relationships`} />
        <Stat theme={theme} label="Link clicks" value={friendlyNumber(data.campaigns.reduce((a, c) => a + c.clicks, 0))} />
        <Stat theme={theme} label="Last sign-in" value={p.last_sign_in ? friendlyDate(p.last_sign_in) : "never"} sub={`signed up ${friendlyDate(p.user_created)}`} />
      </div>

      <div style={section}>
        <div style={label}>Subscription</div>
        {s ? (
          <KV theme={theme} rows={[
            ["Status", `${s.status}${s.test ? " (test)" : ""}${s.cancelled_at ? ` · cancelled ${friendlyDate(s.cancelled_at)}` : ""}`],
            ["Plan", `${s.name || planFromAccount(p.account_id) || "—"} · ${money(s.price_after_discount || s.price_amount, s.price_currency || "USD")} / ${s.interval || "month"}${s.price_after_discount && Number(s.price_after_discount) !== Number(s.price_amount) ? ` (list ${money(s.price_amount, s.price_currency || "USD")})` : ""}`],
            s.trial_ends_at && ["Shopify trial ends", friendlyDate(s.trial_ends_at)],
            s.current_period_end && ["Current period ends", friendlyDate(s.current_period_end)],
            ["account_id", p.account_id || "(empty)"],
            ["Synced", s.synced_at ? friendlyDate(s.synced_at) : "—"],
          ]} />
        ) : (
          <KV theme={theme} rows={[
            ["Plan", planFromAccount(p.account_id) ? `${planFromAccount(p.account_id)} (from account_id)` : p.account_id ? p.account_id : "No plan chosen"],
            ["account_id", p.account_id || "(empty)"],
            ["Shopify shop", p.shopify_shop || "—"],
          ]} />
        )}
      </div>

      <div style={section}>
        <div style={label}>Trial</div>
        <KV theme={theme} rows={[
          ["Linkable grant", trialGrant || "none"],
          ["Activated", p.trial_activation_date && p.trial_activation_date !== "-infinity" ? friendlyDate(p.trial_activation_date) : "—"],
          ["Expires", p.trial_expiration_date && p.trial_expiration_date !== "-infinity" ? friendlyDate(p.trial_expiration_date) : "—"],
          ["Card on file (Stripe)", p.default_payment_method_id ? "yes" : "no"],
        ]} />
      </div>

      <div style={section}>
        <div style={label}>Profile</div>
        <KV theme={theme} rows={[
          ["Owner", [p.first_name, p.last_name].filter(Boolean).join(" ") || "—"],
          ["Markets", shortList(p.location)],
          ["Niche", p.niche || "—"],
          ["Shop currency", p.shopify_shop_default_currency || "—"],
          ["Shopify shop", p.shopify_shop || "—"],
          p.deletion_scheduled_for && ["Purge scheduled", `${friendlyDate(p.deletion_scheduled_for)}${p.deletion_reason ? ` · ${p.deletion_reason}` : ""}`],
          ["User id", p.user_id],
        ]} />
        {p.description && <div style={{ fontSize: 12, color: theme.textMid, marginTop: 10, lineHeight: 1.5 }}>{p.description}</div>}
      </div>
    </>
  );
}

const th = (theme, right) => ({ textAlign: right ? "right" : "left", fontSize: 11, fontWeight: 600, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.5, padding: "8px 10px", borderBottom: `1px solid ${theme.border}`, whiteSpace: "nowrap" });
const td = (theme, right) => ({ textAlign: right ? "right" : "left", fontSize: 13, color: theme.text, padding: "9px 10px", borderBottom: `1px solid ${theme.border}`, verticalAlign: "top" });

function Table({ theme, columns, rows, empty }) {
  if (!rows.length) return <div style={{ padding: "18px 0", fontSize: 13, color: theme.textMuted }}>{empty}</div>;
  return (
    <div style={{ overflowX: "auto", background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 12 }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>{columns.map((c) => <th key={c.key} style={th(theme, c.right)}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id || r.link_id || i}>
              {columns.map((c) => <td key={c.key} style={{ ...td(theme, c.right), ...(i === rows.length - 1 ? { borderBottom: "none" } : {}) }}>{c.render ? c.render(r) : r[c.key]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_PILL = {
  active: ["#D1FAE5", "#065F46"], paused: ["#FEF3C7", "#92400E"], ended: ["#F3F4F6", "#4B5563"], new: ["#DBEAFE", "#1E40AF"],
  Sold: ["#D1FAE5", "#065F46"], Shipped: ["#DBEAFE", "#1E40AF"], "Sample accepted": ["#E0E7FF", "#3730A3"], Accepted: ["#D1FAE5", "#065F46"],
  Applied: ["#FEF3C7", "#92400E"], Invited: ["#F3F4F6", "#4B5563"], Rejected: ["#FEE2E2", "#991B1B"], Ended: ["#F3F4F6", "#4B5563"],
  sent: ["#DBEAFE", "#1E40AF"], bounced: ["#FED7AA", "#9A3412"], cancelled: ["#F3F4F6", "#4B5563"], scheduled: ["#FEF3C7", "#92400E"], pending: ["#FEF3C7", "#92400E"],
};
function StatusPill({ value, theme }) {
  const [bg, fg] = STATUS_PILL[value] || [theme.surfaceAlt, theme.textMid];
  return <Pill bg={bg} fg={fg}>{value}</Pill>;
}

function Campaigns({ data, theme }) {
  return (
    <Table theme={theme} empty={data.notLaunched ? `No campaign launched yet (${data.notLaunched} synced products waiting).` : "This brand has not created a campaign yet."} rows={data.campaigns} columns={[
      { key: "title", label: "Campaign", render: (c) => <div><div style={{ fontWeight: 600 }}>{c.title}</div><div style={{ fontSize: 11, color: theme.textMuted }}>{c.status === 2 && c.activated_at ? `live since ${friendlyDate(c.activated_at)}` : c.status >= 3 && c.activated_at ? `ran from ${friendlyDate(c.activated_at)}` : `created ${friendlyDate(c.created)}`}{c.sale_commission ? ` · ${c.sale_commission}% commission` : ""}{c.shipping ? " · ships samples" : ""}</div></div> },
      { key: "status_label", label: "Status", render: (c) => <StatusPill value={c.status_label} theme={theme} /> },
      { key: "invited", label: "Invited", right: true },
      { key: "applied", label: "Applied", right: true },
      { key: "accepted", label: "Accepted", right: true },
      { key: "shipped", label: "Shipped", right: true },
      { key: "clicks", label: "Clicks", right: true, render: (c) => friendlyNumber(c.clicks) },
      { key: "sales", label: "Sales", right: true, render: (c) => <span style={{ fontWeight: c.sales ? 600 : 400, color: c.sales ? theme.text : theme.textMuted }}>{c.sales}</span> },
    ]} />
  );
}

function Creators({ data, theme }) {
  return (
    <Table theme={theme} empty="No creators have been invited or applied yet." rows={data.creators} columns={[
      { key: "creator_name", label: "Creator", render: (c) => <div><div style={{ fontWeight: 600 }}>{c.creator_name}</div>{c.instagram_username && <div style={{ fontSize: 11, color: theme.textMuted }}>@{c.instagram_username}{c.instagram_followers_count ? ` · ${friendlyNumber(c.instagram_followers_count)} followers` : ""}</div>}</div> },
      { key: "campaign", label: "Campaign", render: (c) => <span style={{ color: theme.textMid }}>{c.campaign}</span> },
      { key: "status_label", label: "Status", render: (c) => <StatusPill value={c.status_label} theme={theme} /> },
      { key: "clicks", label: "Clicks", right: true, render: (c) => friendlyNumber(c.clicks) },
      { key: "sales", label: "Sales", right: true },
      { key: "created", label: "Since", render: (c) => <span style={{ color: theme.textMuted, whiteSpace: "nowrap" }}>{friendlyDate(c.accepted_at || c.created)}</span> },
    ]} />
  );
}

function Outbound({ data, theme, label, section }) {
  const o = data.outbound || {};
  return (
    <>
      {o.error && <div style={{ padding: 12, borderRadius: 10, background: "#FEF2F2", color: "#B91C1C", fontSize: 12, marginBottom: 12 }}>Outbound history unavailable: {o.error}</div>}
      <div style={section}>
        <div style={label}>StoreLeads record</div>
        {o.lead ? (
          <KV theme={theme} rows={[["Domain", o.lead.domain], ["Country", o.lead.country_code || "—"], ["Categories", Array.isArray(o.lead.categories) ? o.lead.categories.join(", ") : o.lead.categories || "—"], ["Emailed", o.lead.emailed ? `yes · ${friendlyDate(o.lead.emailed_at)}` : "no"], ["Imported", friendlyDate(o.lead.imported_at)]]} />
        ) : <div style={{ fontSize: 13, color: theme.textMuted }}>This shop is not in the StoreLeads pool (it probably signed up organically).</div>}
      </div>
      <div style={{ ...label, marginTop: 4 }}>Sequence emails ({o.sends?.length || 0})</div>
      <Table theme={theme} empty="No outbound emails were sent to this address." rows={o.sends || []} columns={[
        { key: "sent_at", label: "When", render: (s) => <span style={{ whiteSpace: "nowrap", color: theme.textMid }}>{friendlyDate(s.sent_at)}</span> },
        { key: "subject", label: "Email", render: (s) => <div><div>{s.subject}</div><div style={{ fontSize: 11, color: theme.textMuted }}>{s.campaign_name || "campaign"} · {s.brand_group || "—"} T{s.touch_number || "?"}</div></div> },
        { key: "status", label: "Status", render: (s) => <StatusPill value={s.status} theme={theme} /> },
        { key: "engagement", label: "Engagement", render: (s) => <span style={{ fontSize: 12, color: theme.textMid }}>{[s.opened_at && "opened", s.replied_at && "replied", s.bounced_at && "bounced"].filter(Boolean).join(" · ") || "—"}</span> },
      ]} />
      <div style={{ ...label, marginTop: 16 }}>AI conversations ({o.conversations?.length || 0})</div>
      <Table theme={theme} empty="No AI-handled thread with this brand." rows={o.conversations || []} columns={[
        { key: "thread_subject", label: "Thread", render: (c) => <div><div>{c.thread_subject || "(no subject)"}</div><div style={{ fontSize: 11, color: theme.textMuted }}>{c.campaign_name || "campaign"}</div></div> },
        { key: "status", label: "Status", render: (c) => <StatusPill value={c.status} theme={theme} /> },
        { key: "qualification_score", label: "Score", right: true, render: (c) => c.qualification_score ?? "—" },
        { key: "last_inbound_at", label: "Last reply", render: (c) => <span style={{ color: theme.textMuted, whiteSpace: "nowrap" }}>{c.last_inbound_at ? friendlyDate(c.last_inbound_at) : "—"}</span> },
      ]} />
    </>
  );
}

function History({ data, theme, label, section }) {
  const h = data.history || {};
  return (
    <>
      <div style={section}>
        <div style={label}>Trial grants</div>
        {h.grants?.length ? h.grants.map((g, i) => (
          <div key={i} style={{ fontSize: 13, color: theme.text, padding: "6px 0", borderBottom: i < h.grants.length - 1 ? `1px solid ${theme.border}` : "none" }}>
            <span style={{ color: theme.textMuted }}>{friendlyDate(g.granted_at)}</span> · {planLabel(g.plan)} · {g.days}d {g.interval || ""} <span style={{ color: theme.textMuted }}>by {g.admin_email}</span>
            {g.note && <div style={{ fontSize: 12, color: theme.textMid }}>{g.note}</div>}
          </div>
        )) : <div style={{ fontSize: 13, color: theme.textMuted }}>No trial has been granted to this brand.</div>}
      </div>
      <div style={section}>
        <div style={label}>Impersonations</div>
        {h.impersonations?.length ? h.impersonations.map((r, i) => (
          <div key={i} style={{ fontSize: 13, color: theme.text, padding: "6px 0", borderBottom: i < h.impersonations.length - 1 ? `1px solid ${theme.border}` : "none" }}>
            <span style={{ color: theme.textMuted }}>{friendlyDate(r.created)}</span> · {r.admin_email}
          </div>
        )) : <div style={{ fontSize: 13, color: theme.textMuted }}>Nobody has impersonated this brand.</div>}
      </div>
      <div style={section}>
        <div style={label}>Subscription history</div>
        {data.subscriptionHistory?.length ? (
          <KV theme={theme} rows={data.subscriptionHistory.map((s, i) => [friendlyDate(s.shopify_created_at) || `#${i + 1}`, `${s.name || "plan"} · ${s.status}${s.cancelled_at ? ` · cancelled ${friendlyDate(s.cancelled_at)}` : ""} · ${money(s.price_amount, s.price_currency || "USD")}/${s.interval || "month"}`])} />
        ) : <div style={{ fontSize: 13, color: theme.textMuted }}>No Shopify subscription records.</div>}
      </div>
      <div style={{ ...section, marginBottom: 0 }}>
        <div style={label}>Recent orders</div>
        <Table theme={theme} empty="No orders attributed to this brand's links." rows={data.orders.items} columns={[
          { key: "created", label: "When", render: (o) => <span style={{ whiteSpace: "nowrap", color: theme.textMid }}>{friendlyDate(o.created)}</span> },
          { key: "campaign", label: "Campaign / creator", render: (o) => <div><div>{o.campaign || "—"}</div><div style={{ fontSize: 11, color: theme.textMuted }}>{o.creator_name || "—"}</div></div> },
          { key: "shopify_amount", label: "Amount", right: true, render: (o) => money(o.shopify_amount, o.shopify_currency || "USD", true) },
          { key: "commission", label: "Commission", right: true, render: (o) => o.commission ? money(o.commission, o.shopify_currency || "USD", true) : "—" },
        ]} />
      </div>
    </>
  );
}

function DrawerSkeleton({ tab }) {
  if (tab === "overview") return (
    <>
      <SkeletonStatGrid count={6} minWidth={140} variant="send" style={{ marginBottom: 12 }} />
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ padding: 16, marginBottom: 12 }}>
          <Skeleton width={90} height={11} /><div style={{ height: 12 }} /><SkeletonKeyValue rows={4} labelWidth={90} />
        </div>
      ))}
    </>
  );
  if (tab === "campaigns") return <SkeletonTable rows={4} columns={[{ label: "Campaign", kind: "two-line" }, { label: "Status", kind: "pill" }, { label: "Invited", kind: "num" }, { label: "Applied", kind: "num" }, { label: "Accepted", kind: "num" }, { label: "Shipped", kind: "num" }, { label: "Clicks", kind: "num" }, { label: "Sales", kind: "num" }]} />;
  if (tab === "creators") return <SkeletonTable rows={5} columns={[{ label: "Creator", kind: "two-line" }, { label: "Campaign" }, { label: "Status", kind: "pill" }, { label: "Clicks", kind: "num" }, { label: "Sales", kind: "num" }, { label: "Since" }]} />;
  return <SkeletonTable rows={4} columns={[{ label: "When" }, { label: "Detail", kind: "two-line" }, { label: "Status", kind: "pill" }]} />;
}
