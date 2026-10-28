import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useTheme } from "../../contexts/ThemeContext";
import { api } from "../../lib/api";
import { Card } from "../../components/ui/Card";
import { Btn } from "../../components/ui/Button";
import { Tag } from "../../components/ui/Tag";
import { Skeleton, SkeletonTableRows } from "../../components/ui/Skeleton";
import {
  useColumnWidths, SortLabel, nextSort, ColumnFilter, ResizeHandle, HeaderCell, headerCellStyle,
} from "../../components/table/tableTools";
import { HelpList, HelpTip } from "../../components/gtm/QueueParts";
import { Avatar, Who, StatTile, Banner } from "../../components/pitch/PitchParts";
import {
  PLAN_KIND_LABEL, PLAN_KIND_OPTIONS, PLAN_STATE_LABEL, PLAN_STATE_OPTIONS, PLAN_SOURCE_LABEL, PLAN_SOURCE_OPTIONS,
  CURRENCY_OPTIONS, planStatus, planPrice, planNext, stripeLinks, money, day,
} from "../../components/pitch/pitchLabels";

// Who pays for Pitch Pro (Federico, 28 Oct): one line per creator with a
// plan (creator_plans, which the main app writes from what Stripe returns),
// what it is, where it is, what it costs and who brought her. Read-only:
// Stripe's own pages are a button away. A row opens the creator in Users.

const PAGE = 25;

const COLUMNS = [
  { key: "creator", label: "Creator", width: 220, sort: "asc", sortField: "creator",
    filter: { type: "text", field: "creator", placeholder: "Name, email or handle…" } },
  { key: "plan", label: "Plan", width: 115, sort: "asc", sortField: "plan",
    filter: { type: "select", field: "plan", options: PLAN_KIND_OPTIONS } },
  { key: "status", label: "Status", width: 205, sort: "asc", sortField: "status",
    filter: { type: "select", field: "status", options: PLAN_STATE_OPTIONS } },
  { key: "price", label: "Price", width: 115, sort: "desc", sortField: "price",
    filter: { type: "select", field: "currency", options: CURRENCY_OPTIONS } },
  { key: "started", label: "Started", width: 125, sort: "desc", sortField: "started",
    filter: { type: "date", field: "started" } },
  { key: "next", label: "Next", width: 130, sort: "asc", sortField: "next",
    filter: { type: "date", field: "next" } },
  { key: "source", label: "Came via", width: 140, sort: "asc", sortField: "source",
    filter: { type: "select", field: "source", options: PLAN_SOURCE_OPTIONS } },
  { key: "country", label: "Country", width: 125, sort: "asc", sortField: "country",
    filter: { type: "text", field: "country", placeholder: "Country…" } },
  { key: "actions", label: "Actions", width: 195 },
];
const DEFAULT_WIDTHS = Object.fromEntries(COLUMNS.map((c) => [c.key, c.width]));
// What each column looks like while it loads.
const SKELETON_KIND = { creator: "who", status: "pill", next: "two-line", source: "two-line", actions: "button" };
const SKELETON_COLS = COLUMNS.map((c) => ({ kind: SKELETON_KIND[c.key] || "text" }));

// The summary's tiles, in the order an admin reads them. Disputed only shows
// when there is one.
const TILES = ["paying", "trial", "free", "cancels", "past_due", "ended", "refunded", "disputed"];
const TILE_SUB = {
  paying: "Pitch Pro renewing, or Founding paid",
  trial: "Card on file, first payment to come",
  free: "Pitch Pro given by Pitch Partners",
  cancels: "Won't renew after this period",
  past_due: "Card failing, Stripe retrying",
  ended: "Cancelled, ran out or not paid",
  refunded: "Money given back",
  disputed: "Payment taken back by her bank",
};

const HELP = [
  ["Who is here", "Every creator who has had Pitch Pro or Founding Creator, one line each, newest first. Founding Checkouts nobody paid are not plans and are left out."],
  ["Plan", "Pro monthly (£19, $19 or €19 a month) or Pro yearly (190 a year). Founding: 99 once, Pitch Pro for good (sold in launch week only). Partner trial: a Pro monthly or yearly in the free first month a Pitch Partner's link gives; it reads Pro monthly or yearly once she pays. Gift: Pitch Pro given by Pitch Partners (no card), or a paid Pitch Pro waiting for that gift to end."],
  ["Several plans", "When a creator has more than one row (an ended Pitch Pro and a new one, a gift next to a paid plan), the line shows the one that counts, as the app does: Founding, then a Pitch Pro that runs, then a gift, then her newest."],
  ["Status", "Paying, Trial, Gift running, Cancels on a date (paid or in trial up to then, won't renew), Past due (her card is failing; after 14 days she is back on Free, at once when it failed right after a free month), Ended, Refunded (or a refund due), Disputed (her bank took a Founding payment back; a Pitch Pro whose payment was taken back reads Ended)."],
  ["Price", "What the plan costs, in the currency she pays in. Amounts are never converted between currencies."],
  ["Paying totals", "Per currency, what the plans in Paying bill: monthly and yearly Pitch Pro that will renew, and Founding paid once. Trials, gifts and plans that cancel are not in them."],
  ["Came via", "Pitch Partner link or Creator referral: whose link she signed up with, as Stripe Checkout recorded it. Is a Pitch Partner: the gift is her own Pitch Pro from the programme. Direct: no link."],
  ["Stripe", "Opens the subscription (or Founding's payment) and the customer in the Stripe dashboard: test mode on dev, live on prod. Nothing here changes a plan: cancel or refund in Stripe, and the app follows."],
];

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// One currency's line: "GBP · 3 paying · £57 a month from 3 monthly · …".
function currencyLine(c) {
  const parts = [];
  if (c.monthly) parts.push(`${money(c.monthly_minor, c.currency)} a month from ${plural(c.monthly, "monthly plan", "monthly plans")}`);
  if (c.yearly) parts.push(`${money(c.yearly_minor, c.currency)} a year from ${plural(c.yearly, "yearly plan", "yearly plans")}`);
  if (c.founding) parts.push(`${money(c.founding_minor, c.currency)} once from ${plural(c.founding, "Founding Creator", "Founding Creators")}`);
  return parts.join(" · ");
}

export default function PitchProPage() {
  const { theme: t } = useTheme();
  const navigate = useNavigate();
  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState(null);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [stripeBase, setStripeBase] = useState("");
  const [available, setAvailable] = useState(true);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sort, setSort] = useState({ sortBy: "", sortDir: "desc" });
  const [colFilters, setColFilters] = useState({});
  const { widths, startResize, resetWidth } = useColumnWidths("pitch-pro", DEFAULT_WIDTHS);

  useEffect(() => {
    let live = true;
    api.getPitchPlanSummary()
      .then((r) => { if (live) setSummary(r); })
      .catch((e) => { if (live) setSummaryError(e.message); });
    return () => { live = false; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getPitchPlans({ limit: PAGE, offset, sortBy: sort.sortBy, sortDir: sort.sortDir, filters: colFilters });
      setAvailable(r.available);
      setRows(r.items);
      setTotal(r.total);
      setStripeBase(r.stripe_dashboard || "");
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [offset, sort.sortBy, sort.sortDir, colFilters]);
  useEffect(() => { load(); }, [load]);

  // The creator in Users (Creators tab), found by handle or email.
  const openCreator = (r) => {
    const q = r.instagram_username || r.email;
    if (!q || r.account_deleted) return;
    navigate(`/users?tab=creators&q=${encodeURIComponent(q)}`);
  };
  const handleSort = (field, defaultDir) => { setSort((cur) => nextSort(cur, field, defaultDir)); setOffset(0); };
  const setColFilter = (field, value) => { setColFilters((cur) => (cur[field] === value ? cur : { ...cur, [field]: value })); setOffset(0); };
  const filtered = Object.values(colFilters).some((v) => String(v || "").trim());

  const th = { position: "relative", textAlign: "left", fontSize: 11, fontWeight: 600, color: t.textMuted, textTransform: "uppercase", letterSpacing: 0.6, padding: "10px 14px", borderBottom: `1px solid ${t.border}`, whiteSpace: "nowrap" };
  const td = { padding: "12px 14px", borderBottom: `1px solid ${t.border}`, fontSize: 13, color: t.text, verticalAlign: "middle", overflow: "hidden" };
  const muted = (text) => <span style={{ color: t.textMuted }}>{text}</span>;
  const twoLines = (first, second, title) => (
    <div style={{ minWidth: 0 }} title={title}>
      <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{first}</div>
      {second && <div style={{ fontSize: 12, color: t.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{second}</div>}
    </div>
  );

  const renderCell = (key, r) => {
    switch (key) {
      case "creator":
        return <Who picture={<Avatar src={r.creator_avatar} name={r.name} />} title={r.name || r.email || "Unknown creator"}
                    sub={r.account_deleted ? "Account deleted" : [r.instagram_username && `@${r.instagram_username}`, r.email].filter(Boolean).join(" · ")} />;
      case "plan":
        return twoLines(PLAN_KIND_LABEL[r.kind] || r.plan,
          r.plan_rows > 1 ? `+${plural(r.plan_rows - 1, "other plan", "other plans")}` : "",
          r.plan_rows > 1 ? "She has had more than one plan. This line shows the one that counts now." : undefined);
      case "status": {
        const s = planStatus(r);
        return (
          <div style={{ minWidth: 0 }}>
            <div><Tag color={s.color}>{s.label}</Tag></div>
            {s.note && <div style={{ fontSize: 12, color: t.textMuted, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.note}>{s.note}</div>}
          </div>
        );
      }
      case "price":
        return planPrice(r) === "Free" ? muted("Free") : <span style={{ whiteSpace: "nowrap" }}>{planPrice(r)}</span>;
      case "started":
        return r.started_at
          ? <span style={{ color: t.textMid, whiteSpace: "nowrap" }} title={new Date(r.started_at).toLocaleString()}>{day(r.started_at)}</span>
          : muted("—");
      case "next": {
        const n = planNext(r);
        if (!n.verb) return muted("—");
        if (!n.at) return muted(n.verb);
        return twoLines(day(n.at), n.verb, new Date(n.at).toLocaleString());
      }
      case "source": {
        const label = PLAN_SOURCE_LABEL[r.source] || r.source;
        if (r.source === "direct") return muted(label);
        const who = r.referrer_name || (r.referrer_instagram ? `@${r.referrer_instagram}` : "");
        return twoLines(label, who);
      }
      case "country":
        return r.country ? <span style={{ color: t.textMid }}>{r.country}</span> : muted("—");
      case "actions": {
        const links = stripeLinks(r, stripeBase);
        const stop = (e) => e.stopPropagation();
        return (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
            {links.plan || links.customer ? <>
              {links.plan && (
                <Btn size="sm" variant="secondary" href={links.plan} target="_blank" onClick={stop}
                     title={r.plan === "founding" ? "Her Founding payment in Stripe" : "Her subscription in Stripe"}>
                  {r.plan === "founding" ? "Payment" : "Subscription"}
                </Btn>
              )}
              {links.customer && (
                <Btn size="sm" variant="secondary" href={links.customer} target="_blank" onClick={stop} title="Her Stripe customer: every payment and invoice">Customer</Btn>
              )}
            </> : (
              <Btn size="sm" variant="secondary" disabled title="Pitch Pro given by Pitch Partners has nothing in Stripe">Not in Stripe</Btn>
            )}
          </div>
        );
      }
      default:
        return null;
    }
  };

  if ((!available || summary?.available === false) && !loading) {
    return (
      <Card>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Pitch Pro isn't on this database yet</div>
        <div style={{ fontSize: 13, color: t.textMid }}>Its tables aren't here, so there are no plans to show.</div>
      </Card>
    );
  }

  const counts = summary?.counts || {};
  const currencies = summary?.currencies || [];
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE, total);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>Who pays for Pitch Pro</div>
        <HelpTip title="Pitch Pro"><HelpList items={HELP} /></HelpTip>
      </div>
      <div style={{ fontSize: 13, color: t.textMid, marginBottom: 14, maxWidth: 760, lineHeight: 1.5 }}>
        Every creator with Pitch Pro or Founding Creator, one line each: what she is on, where it is, what it costs and who brought her. Click a row to open her in Users.
      </div>

      {summaryError && <Banner tone="error">{summaryError}</Banner>}
      {!summaryError && <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 10 }}>
        {TILES.filter((s) => s !== "disputed" || counts.disputed > 0).map((s) => (
          <StatTile key={s} loading={!summary} strong={s === "paying"} label={PLAN_STATE_LABEL[s]} value={counts[s] ?? 0} sub={TILE_SUB[s]} />
        ))}
      </div>
      <div style={{ fontSize: 12, color: t.textMuted, marginBottom: 20, lineHeight: 1.7 }}>
        {!summary ? <Skeleton width={420} height={12} />
          : currencies.length === 0 ? "Nobody is paying yet, so there are no totals."
          : currencies.map((c) => (
            <div key={c.currency}>
              <strong style={{ color: t.textMid }}>{String(c.currency).toUpperCase()}</strong> · {plural(c.paying, "paying", "paying")} · {currencyLine(c)}
            </div>
          ))}
      </div>
      </>}

      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}

      <Card style={{ padding: 0, marginBottom: 0, overflow: "hidden" }}>
        {/* The real header stays while rows load, so sorting and filters never vanish. */}
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", minWidth: Object.values(widths).reduce((a, b) => a + b, 0), borderCollapse: "collapse", tableLayout: "fixed" }}>
            <colgroup>{COLUMNS.map((c) => <col key={c.key} style={{ width: widths[c.key] }} />)}</colgroup>
            <thead><tr>
              {COLUMNS.map((col) => (
                <th key={col.key} style={{ ...th, ...headerCellStyle }}>
                  <HeaderCell
                    trailing={col.filter && (
                      <ColumnFilter theme={t} label={col.label} type={col.filter.type} placeholder={col.filter.placeholder} options={col.filter.options}
                        value={colFilters[col.filter.field] || ""} onCommit={(v) => setColFilter(col.filter.field, v)} />
                    )}
                  >
                    {col.sort
                      ? <SortLabel theme={t} label={col.label} colKey={col.sortField} sortBy={sort.sortBy} sortDir={sort.sortDir} defaultDir={col.sort} onSort={handleSort} />
                      : col.label}
                  </HeaderCell>
                  <ResizeHandle colKey={col.key} startResize={startResize} resetWidth={resetWidth} theme={t} />
                </th>
              ))}
            </tr></thead>
            <tbody>
              {loading && <SkeletonTableRows rows={rows.length || 8} cols={SKELETON_COLS} rowHeight={34} cellPadding="12px 14px" />}
              {!loading && rows.length === 0 && (
                <tr><td style={{ ...td, color: t.textMuted }} colSpan={COLUMNS.length}>
                  {filtered ? "No creator matches." : "No creator has Pitch Pro or Founding Creator yet. A plan shows up here as soon as Stripe confirms her Checkout."}
                </td></tr>
              )}
              {!loading && rows.map((r) => {
                const opens = !r.account_deleted && (r.instagram_username || r.email);
                return (
                  <tr key={r.user_id} onClick={() => openCreator(r)} style={{ cursor: opens ? "pointer" : "default" }}
                      title={opens ? undefined : "Her account was deleted"}
                      onMouseEnter={(e) => { e.currentTarget.style.background = t.surfaceAlt; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                    {COLUMNS.map((col) => <td key={col.key} style={td}>{renderCell(col.key, r)}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, fontSize: 12, color: t.textMuted }}>
        <span>{loading ? <Skeleton width={70} height={12} /> : total === 0 ? "No plans" : `${pageStart}–${pageEnd} of ${total}`}</span>
        <div style={{ display: "flex", gap: 6 }}>
          <Btn size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Btn>
          <Btn size="sm" variant="secondary" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</Btn>
        </div>
      </div>
    </div>
  );
}
