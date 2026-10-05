import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { useTheme } from "../../contexts/ThemeContext";
import { api, friendlyDate } from "../../lib/api";
import { Card } from "../../components/ui/Card";
import { Btn } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";
import { Tag } from "../../components/ui/Tag";
import { TabBar } from "../../components/ui/TabBar";
import { Skeleton, SkeletonTableRows } from "../../components/ui/Skeleton";
import {
  useColumnWidths, SortLabel, nextSort, ColumnFilter, ResizeHandle, HeaderCell, headerCellStyle,
} from "../../components/table/tableTools";
import { HelpList, HelpTip } from "../../components/gtm/QueueParts";
import { Avatar, Logo, Who, StatTile, Banner } from "../../components/pitch/PitchParts";
import { PitchDetailModal } from "../../components/pitch/PitchDetailModal";
import { pitchStatus, STATUS_OPTIONS, CHANNEL_LABEL, CHANNEL_OPTIONS } from "../../components/pitch/pitchLabels";

// Every pitch creators sent: who sent it, to which brand, to whom there,
// how it went out and how far it got. A row opens the whole pitch.
//
// ?creator=<user id> or ?brand=<pitch brand id> (with ?who=<name> for the
// chip) narrow the list; the Creators and Brands tabs link here that way.
// ?pitch=<id> opens one pitch, so a pitch can be shared as a link.

const PAGE = 25;

const VIEWS = [["sent", "Sent"], ["drafts", "Drafts"], ["all", "All"]];
const PERIODS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

const COLUMNS = [
  { key: "creator", label: "Creator", width: 230, sort: "asc", sortField: "creator",
    filter: { type: "text", field: "creator", placeholder: "Name, email or handle…" } },
  { key: "brand", label: "Brand", width: 210, sort: "asc", sortField: "brand",
    filter: { type: "text", field: "brand", placeholder: "Brand or store…" } },
  { key: "status", label: "Status", width: 210, sort: "asc", sortField: "status",
    filter: { type: "select", field: "status", options: STATUS_OPTIONS } },
  { key: "sent_to", label: "Sent to", width: 240, sort: "asc", sortField: "sent_to",
    filter: { type: "text", field: "sent_to", placeholder: "Email or name…" } },
  { key: "channel", label: "Channel", width: 150,
    filter: { type: "select", field: "channel", options: CHANNEL_OPTIONS } },
  { key: "sent", label: "Sent", width: 110, sort: "desc", sortField: "sent",
    filter: { type: "date", field: "sent" } },
  { key: "views", label: "Views", width: 110, sort: "desc", sortField: "views",
    filter: { type: "number", field: "views" } },
  { key: "actions", label: "Actions", width: 100 },
];
const DEFAULT_WIDTHS = Object.fromEntries(COLUMNS.map((c) => [c.key, c.width]));
// What each column looks like while it loads.
const SKELETON_KIND = { creator: "who", brand: "who", status: "pill", sent_to: "two-line", actions: "button" };
const SKELETON_COLS = COLUMNS.map((c) => ({ kind: SKELETON_KIND[c.key] || "text" }));

const HELP = [
  ["What this is", "Every pitch a creator sent to a brand through Pitch, newest first. Drafts are the pitches Linkable wrote that nobody has sent yet."],
  ["Sent", "The creator pressed Send. To a brand off Linkable it goes out through Lemlist from influencer@ (Sending, until Lemlist sends the first email); to a brand on Linkable it is delivered in Messages."],
  ["Views", "Times the brand opened the proposal page. Link previews and mail scanners are not counted. Email opens are not counted at all: Lemlist sends without tracking."],
  ["Paying per 100 sent", "Brands that paid, per 100 pitches sent in the period. It is the number Pitch is judged on."],
  ["Test send", "On dev every pitch goes to a tester instead of the brand."],
  ["Read only", "Nothing here sends, edits or opens a pitch's proposal: opening the proposal would count as the brand viewing it."],
];

function pct(n, of) {
  return of ? `${Math.round((n * 100) / of)}% of sent` : "";
}

function renderCell(key, p, { t, open }) {
  switch (key) {
    case "creator":
      return <Who picture={<Avatar src={p.creator_avatar} name={p.creator_name} />} title={p.creator_name || p.creator_email}
                  sub={p.creator_instagram ? `@${p.creator_instagram}` : p.creator_email} />;
    case "brand":
      return <Who picture={<Logo src={p.brand_logo} name={p.brand_name} />} title={p.brand_name} sub={p.brand_domain} />;
    case "status": {
      const s = pitchStatus(p);
      return (
        <div style={{ minWidth: 0 }}>
          <div><Tag color={s.color}>{s.label}</Tag>{p.replied_at && <Tag color="#059669">Replied</Tag>}</div>
          {s.note && <div style={{ fontSize: 12, color: t.textMuted, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.note}>{s.note}</div>}
        </div>
      );
    }
    case "sent_to":
      if (!p.sent_to) return <span style={{ color: t.textMuted }}>—</span>;
      return (
        <div style={{ minWidth: 0 }}>
          <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={p.sent_to}>{p.sent_to}</div>
          {(p.contact_name || p.contact_role) && (
            <div style={{ fontSize: 12, color: t.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={[p.contact_name, p.contact_role].filter(Boolean).join(", ")}>
              {[p.contact_name, p.contact_role].filter(Boolean).join(", ")}
            </div>
          )}
        </div>
      );
    case "channel":
      if (!p.channel) return <span style={{ color: t.textMuted }}>—</span>;
      return (
        <div>
          <div style={{ color: t.textMid }}>{CHANNEL_LABEL[p.channel] || p.channel}</div>
          {p.sandboxed && <div style={{ fontSize: 12, color: t.warning }} title="Sent on dev, to a tester instead of the brand">Test send</div>}
        </div>
      );
    case "sent":
      return p.sent_at
        ? <span style={{ color: t.textMid, whiteSpace: "nowrap" }} title={new Date(p.sent_at).toLocaleString()}>{friendlyDate(p.sent_at)}</span>
        : <span style={{ color: t.textMuted, whiteSpace: "nowrap" }} title="When Linkable wrote it">Written {friendlyDate(p.created)}</span>;
    case "views":
      return p.view_count ? <span>{p.view_count}</span> : <span style={{ color: t.textMuted }}>—</span>;
    case "actions":
      return (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Btn size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); open(p.id); }}>View</Btn>
        </div>
      );
    default:
      return null;
  }
}

export default function PitchesPage() {
  const { theme: t } = useTheme();
  const [params, setParams] = useSearchParams();
  const creatorId = params.get("creator") || "";
  const brandId = params.get("brand") || "";
  const who = params.get("who") || "";
  const openId = params.get("pitch") || "";

  const [period, setPeriod] = useState("30");
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [view, setView] = useState("sent");
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [available, setAvailable] = useState(true);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sort, setSort] = useState({ sortBy: "", sortDir: "desc" });
  const [colFilters, setColFilters] = useState({});
  const { widths, startResize, resetWidth } = useColumnWidths("pitch-pitches", DEFAULT_WIDTHS);

  useEffect(() => {
    let live = true;
    api.getPitchSummary({ days: period === "all" ? undefined : period })
      .then((r) => { if (live) setSummary(r); })
      .catch((e) => { if (live) setError(e.message); })
      .finally(() => { if (live) setSummaryLoading(false); });
    return () => { live = false; };
  }, [period]);
  const changePeriod = (p) => { if (p === period) return; setSummaryLoading(true); setPeriod(p); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const filters = { ...colFilters, creator_id: creatorId, brand_id: brandId };
      const r = await api.getPitches({ view, limit: PAGE, offset, sortBy: sort.sortBy, sortDir: sort.sortDir, filters });
      setAvailable(r.available);
      setRows(r.items);
      setTotal(r.total);
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [view, offset, sort.sortBy, sort.sortDir, colFilters, creatorId, brandId]);
  useEffect(() => { load(); }, [load]);

  // Opening a pitch is a step Back undoes; narrowing the list is not.
  const setParam = (changes, { push = false } = {}) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) { if (v) next.set(k, v); else next.delete(k); }
    setParams(next, { replace: !push });
  };
  const open = (id) => setParam({ pitch: id }, { push: true });
  const clearScope = () => { setParam({ creator: "", brand: "", who: "" }); setOffset(0); };
  const handleSort = (field, defaultDir) => { setSort((cur) => nextSort(cur, field, defaultDir)); setOffset(0); };
  const setColFilter = (field, value) => { setColFilters((cur) => (cur[field] === value ? cur : { ...cur, [field]: value })); setOffset(0); };

  const th = { position: "relative", textAlign: "left", fontSize: 11, fontWeight: 600, color: t.textMuted, textTransform: "uppercase", letterSpacing: 0.6, padding: "10px 14px", borderBottom: `1px solid ${t.border}`, whiteSpace: "nowrap" };
  const td = { padding: "12px 14px", borderBottom: `1px solid ${t.border}`, fontSize: 13, color: t.text, verticalAlign: "middle", overflow: "hidden" };

  if ((!available || summary?.available === false) && !loading) {
    return (
      <Card>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Pitch isn't on this database yet</div>
        <div style={{ fontSize: 13, color: t.textMid }}>Its tables aren't here, so there are no pitches to show.</div>
      </Card>
    );
  }

  const f = summary?.funnel || {};
  const now = summary?.now || {};
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE, total);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>How pitches are doing</div>
        <HelpTip title="Pitches"><HelpList items={HELP} /></HelpTip>
        <div style={{ marginLeft: "auto", width: 170 }}>
          <Select value={period} onChange={changePeriod} options={PERIODS} size="sm" ariaLabel="Period" />
        </div>
      </div>

      {summary?.sending_problem && (
        <Banner tone="warning">Pitch emails to brands off Linkable are not going out. {summary.sending_problem}</Banner>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 10 }}>
        <StatTile loading={summaryLoading} label="Sent" value={f.sent}
                  sub={`by ${f.creators} ${f.creators === 1 ? "creator" : "creators"} to ${f.brands} ${f.brands === 1 ? "brand" : "brands"}`} />
        <StatTile loading={summaryLoading} label="Viewed proposal" value={f.viewed} sub={pct(f.viewed, f.sent)} />
        <StatTile loading={summaryLoading} label="Replied" value={f.replied} sub={pct(f.replied, f.sent)} />
        <StatTile loading={summaryLoading} label="Accepted" value={f.accepted} sub={pct(f.accepted, f.sent)} />
        <StatTile loading={summaryLoading} label="Trials started" value={f.trials} />
        <StatTile loading={summaryLoading} label="Paying brands" value={f.paying} />
        <StatTile loading={summaryLoading} strong label="Paying per 100 sent" value={summary?.paying_per_100} sub="The number Pitch is judged on" />
      </div>
      <div style={{ fontSize: 12, color: t.textMuted, marginBottom: 20 }}>
        {summaryLoading ? <Skeleton width={460} height={12} /> : summary && <>
          Right now {now.sending} sending · {now.drafts} {now.drafts === 1 ? "draft" : "drafts"} waiting for their creator
          {now.no_contact > 0 && <> · <span style={{ color: t.danger }}>{now.no_contact} with no contact found</span></>}
          {" "}· {now.weekly_creators} {now.weekly_creators === 1 ? "creator" : "creators"} on weekly picks
        </>}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <TabBar tabs={VIEWS} active={view} onSelect={(v) => { setView(v); setOffset(0); }} />
        {(creatorId || brandId) && (
          <span style={{ marginBottom: 20, display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, padding: "5px 6px 5px 12px", borderRadius: 999, border: `1px solid ${t.border}`, background: t.surface, color: t.text }}>
            {creatorId ? "Creator" : "Brand"} <strong>{who || "selected"}</strong>
            <button onClick={clearScope} aria-label="Show every pitch" title="Show every pitch" style={{ border: "none", background: t.surfaceAlt, color: t.textMid, borderRadius: 999, width: 20, height: 20, cursor: "pointer", lineHeight: "18px", padding: 0 }}>×</button>
          </span>
        )}
      </div>

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
                    {view === "sent" ? "No pitch sent matches." : view === "drafts" ? "No draft matches." : "No pitch matches."}
                  </td></tr>
                )}
                {!loading && rows.map((p) => (
                  <tr key={p.id} onClick={() => open(p.id)} style={{ cursor: "pointer" }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = t.surfaceAlt; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                    {COLUMNS.map((col) => <td key={col.key} style={td}>{renderCell(col.key, p, { t, open })}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
        </div>
      </Card>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, fontSize: 12, color: t.textMuted }}>
        <span>{loading ? <Skeleton width={70} height={12} /> : total === 0 ? "No pitches" : `${pageStart}–${pageEnd} of ${total}`}</span>
        <div style={{ display: "flex", gap: 6 }}>
          <Btn size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Btn>
          <Btn size="sm" variant="secondary" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</Btn>
        </div>
      </div>

      <PitchDetailModal id={openId} onClose={() => setParam({ pitch: "" })} />
    </div>
  );
}
