import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useTheme } from "../../contexts/ThemeContext";
import { api, friendlyDate } from "../../lib/api";
import { Card } from "../../components/ui/Card";
import { Btn } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Toggle } from "../../components/ui/Toggle";
import { TabBar } from "../../components/ui/TabBar";
import { SkeletonTable } from "../../components/ui/Skeleton";
import {
  useColumnWidths, SortLabel, nextSort, ColumnFilter, ResizeHandle, HeaderCell, headerCellStyle,
} from "../../components/table/tableTools";
import { HelpList, HelpTip } from "../../components/gtm/QueueParts";
import { Avatar, Who, Banner } from "../../components/pitch/PitchParts";
import { count } from "../../components/pitch/pitchLabels";

// Every creator who opened Pitch: when they first did, what Linkable wrote
// for them, what they sent and how it went, and the one switch ops holds
// over them, weekly picks (pitch_creators.enabled).

const PAGE = 25;
const VIEWS = [["all", "Opened Pitch"], ["sent", "Sent a pitch"], ["weekly", "On weekly picks"]];

const COLUMNS = [
  { key: "creator", label: "Creator", width: 250, sort: "asc", sortField: "name",
    filter: { type: "text", field: "name", placeholder: "Name, email or handle…" } },
  { key: "opened", label: "Opened Pitch", width: 175, sort: "desc", sortField: "opened",
    filter: { type: "date", field: "opened" } },
  { key: "drafts", label: "Drafts waiting", width: 170, sort: "desc", sortField: "drafts" },
  { key: "sent", label: "Sent", width: 110, sort: "desc", sortField: "sent",
    filter: { type: "number", field: "sent" } },
  { key: "viewed", label: "Viewed", width: 90, sort: "desc", sortField: "viewed" },
  { key: "replied", label: "Replied", width: 100, sort: "desc", sortField: "replied" },
  { key: "accepted", label: "Accepted", width: 110, sort: "desc", sortField: "accepted" },
  { key: "last_sent", label: "Last sent", width: 145, sort: "desc", sortField: "last_sent",
    filter: { type: "date", field: "last_sent" } },
  { key: "profile", label: "Profile", width: 120 },
  { key: "followers", label: "Followers", width: 120, sort: "desc", sortField: "followers" },
  { key: "weekly", label: "Weekly picks", width: 160, sort: "desc", sortField: "weekly",
    filter: { type: "boolean", field: "weekly" } },
  { key: "actions", label: "Actions", width: 120 },
];
const DEFAULT_WIDTHS = Object.fromEntries(COLUMNS.map((c) => [c.key, c.width]));

const HELP = [
  ["Who is here", "Every creator who has opened the Pitch tab in the app. Any creator can; nobody is invited or added by hand."],
  ["Opened Pitch", "The first time they opened it. Linkable writes them three draft pitches at that moment, each to a brand picked for them."],
  ["Drafts waiting", "Drafts written for them this week that they have not sent. Unsent drafts expire when the week ends on Sunday night, and new ones are written the next time they open Pitch."],
  ["None written", "They opened Pitch but no draft was ever written for them, which means writing failed. The grpc logs say why."],
  ["Sent", "Pitches the creator pressed Send on. Viewed, Replied and Accepted count how many of those the brand opened, answered and accepted."],
  ["Weekly picks", "On, Linkable writes the creator three pitches every Monday, ready before they open Pitch. Off, pitches are written when they open it. Each pitch is written by AI, so weekly picks cost a little every week whether or not the creator comes back."],
  ["Profile", "The About and media kit a pitch shows the brand. Pitch asks for them until they are saved."],
];

function num(n, t) {
  return n ? <span>{n}</span> : <span style={{ color: t.textMuted }}>0</span>;
}

export default function PitchCreatorsPage() {
  const { theme: t } = useTheme();
  const navigate = useNavigate();
  const [view, setView] = useState("all");
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState(null);
  const [available, setAvailable] = useState(true);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [sort, setSort] = useState({ sortBy: "", sortDir: "desc" });
  const [colFilters, setColFilters] = useState({});
  const [busy, setBusy] = useState(null);
  const [email, setEmail] = useState("");
  const [adding, setAdding] = useState(false);
  const { widths, startResize, resetWidth } = useColumnWidths("pitch-creators", DEFAULT_WIDTHS);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getPitchCreators({ view, limit: PAGE, offset, sortBy: sort.sortBy, sortDir: sort.sortDir, filters: colFilters });
      setAvailable(r.available);
      setRows(r.items);
      setTotal(r.total);
      setCounts(r.counts || null);
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [view, offset, sort.sortBy, sort.sortDir, colFilters]);
  useEffect(() => { load(); }, [load]);

  const setWeekly = async (c, weekly) => {
    setBusy(c.user_id);
    setRows((cur) => cur.map((x) => (x.user_id === c.user_id ? { ...x, weekly } : x)));
    try {
      await api.setPitchCreatorWeekly(c.user_id, weekly);
      setNotice(weekly
        ? `${c.name || c.email} gets three pitches written every Monday from now on.`
        : `${c.name || c.email} is off weekly picks. Their pitches are written when they open Pitch.`);
    } catch (e) {
      setRows((cur) => cur.map((x) => (x.user_id === c.user_id ? { ...x, weekly: !weekly } : x)));
      setError(e.message);
    } finally { setBusy(null); }
  };

  const add = async (e) => {
    e?.preventDefault();
    if (!email.trim()) { setError("Enter the creator's account email."); return; }
    setAdding(true);
    try {
      await api.addPitchCreator(email.trim());
      setNotice(`${email.trim()} is on weekly picks. Their first pitches are written within the hour.`);
      setEmail("");
      setError(null);
      await load();
    } catch (err) { setError(err.message); }
    finally { setAdding(false); }
  };

  const showPitches = (c) => navigate(`/ops/pitch?creator=${c.user_id}&who=${encodeURIComponent(c.name || c.email)}`);
  const handleSort = (field, defaultDir) => { setSort((cur) => nextSort(cur, field, defaultDir)); setOffset(0); };
  const setColFilter = (field, value) => { setColFilters((cur) => (cur[field] === value ? cur : { ...cur, [field]: value })); setOffset(0); };

  const th = { position: "relative", textAlign: "left", fontSize: 11, fontWeight: 600, color: t.textMuted, textTransform: "uppercase", letterSpacing: 0.6, padding: "10px 14px", borderBottom: `1px solid ${t.border}`, whiteSpace: "nowrap" };
  const td = { padding: "12px 14px", borderBottom: `1px solid ${t.border}`, fontSize: 13, color: t.text, verticalAlign: "middle", overflow: "hidden" };

  const renderCell = (key, c) => {
    switch (key) {
      case "creator":
        return <Who picture={<Avatar src={c.creator_avatar} name={c.name} />} title={c.name || c.email}
                    sub={[c.instagram_username && `@${c.instagram_username}`, c.email].filter(Boolean).join(" · ")} />;
      case "followers":
        return count(c.instagram_followers_count) || <span style={{ color: t.textMuted }}>—</span>;
      case "sent": return num(c.sent, t);
      case "viewed": return num(c.viewed, t);
      case "replied": return num(c.replied, t);
      case "accepted": return num(c.accepted, t);
      case "opened":
        return c.opened_at
          ? <span style={{ color: t.textMid, whiteSpace: "nowrap" }} title={new Date(c.opened_at).toLocaleString()}>{friendlyDate(c.opened_at)}</span>
          : <span style={{ color: t.textMuted }}>—</span>;
      case "drafts":
        // Nothing was ever written: opening Pitch should have written three.
        if (!c.written) {
          return <span style={{ color: t.danger }} title="They opened Pitch but no draft was ever written for them. The grpc logs say why.">None written</span>;
        }
        return (
          <span>
            {num(c.drafts, t)}
            {c.expired > 0 && <span style={{ color: t.textMuted, fontSize: 12 }} title="Drafts from an earlier week they never sent. New ones are written the next time they open Pitch."> · {c.expired} expired</span>}
            {c.no_contact > 0 && <span style={{ color: t.danger, fontSize: 12 }} title="Sent, but no contact was found for the brand, so it came back as a draft"> · {c.no_contact} no contact</span>}
          </span>
        );
      case "last_sent":
        return c.last_sent_at
          ? <span style={{ color: t.textMid, whiteSpace: "nowrap" }} title={new Date(c.last_sent_at).toLocaleString()}>{friendlyDate(c.last_sent_at)}</span>
          : <span style={{ color: t.textMuted }}>Never</span>;
      case "profile": {
        const parts = [c.has_about && "About", c.has_media_kit && "Media kit"].filter(Boolean);
        return parts.length ? <span style={{ color: t.textMid }}>{parts.join(" · ")}</span> : <span style={{ color: t.textMuted }}>Not filled</span>;
      }
      case "weekly":
        return <Toggle checked={c.weekly} disabled={busy === c.user_id} label={`Weekly picks for ${c.name || c.email}`} onChange={(v) => setWeekly(c, v)} />;
      case "actions":
        return (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn size="sm" variant="secondary" disabled={!c.sent && !c.drafts} onClick={() => showPitches(c)}>Pitches</Btn>
          </div>
        );
      default:
        return null;
    }
  };

  if (!available && !loading) {
    return (
      <Card>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Pitch isn't on this database yet</div>
        <div style={{ fontSize: 13, color: t.textMid }}>Its tables aren't here, so there are no creators to show.</div>
      </Card>
    );
  }

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE, total);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 320px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>Creators who opened Pitch</div>
            <HelpTip title="Creators"><HelpList items={HELP} /></HelpTip>
          </div>
          <div style={{ fontSize: 13, color: t.textMid, marginTop: 4, maxWidth: 720, lineHeight: 1.5 }}>
            Every creator who has opened the Pitch tab in the app. Opening it writes them three draft pitches, each to a brand picked for them. Sent is how many they actually sent.
          </div>
        </div>
        <form onSubmit={add} style={{ display: "flex", gap: 8, alignItems: "center", flex: "0 1 420px" }}>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Creator's account email" type="email" style={{ flex: 1 }} />
          <Btn size="sm" type="submit" loading={adding} disabled={adding}>Add to weekly picks</Btn>
        </form>
      </div>

      <TabBar tabs={VIEWS.map(([id, label]) => [id, counts ? `${label} · ${counts[id] ?? 0}` : label])}
              active={view} onSelect={(v) => { setView(v); setOffset(0); }} />

      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}
      {notice && <Banner onDismiss={() => setNotice(null)}>{notice}</Banner>}

      <Card style={{ padding: 0, marginBottom: 0, overflow: "hidden" }}>
        {loading && rows.length === 0 ? (
          <SkeletonTable rows={8} headerBackground="transparent" columns={COLUMNS.map((c) => ({ key: c.key, label: c.label, kind: c.key === "creator" ? "two-line" : "text" }))} />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", minWidth: Object.values(widths).reduce((a, b) => a + b, 0), borderCollapse: "collapse", tableLayout: "fixed" }}>
              <colgroup>{COLUMNS.map((c) => <col key={c.key} style={{ width: widths[c.key] }} />)}</colgroup>
              <thead><tr>
                {COLUMNS.map((col) => (
                  <th key={col.key} style={{ ...th, ...headerCellStyle }}>
                    <HeaderCell
                      trailing={col.filter && (
                        <ColumnFilter theme={t} label={col.label} type={col.filter.type} placeholder={col.filter.placeholder}
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
                {rows.length === 0 && <tr><td style={{ ...td, color: t.textMuted }} colSpan={COLUMNS.length}>No creator matches.</td></tr>}
                {rows.map((c) => (
                  <tr key={c.user_id}>
                    {COLUMNS.map((col) => <td key={col.key} style={td}>{renderCell(col.key, c)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, fontSize: 12, color: t.textMuted }}>
        <span>{total === 0 ? "No creators" : `${pageStart}–${pageEnd} of ${total}`}</span>
        <div style={{ display: "flex", gap: 6 }}>
          <Btn size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Btn>
          <Btn size="sm" variant="secondary" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</Btn>
        </div>
      </div>
    </div>
  );
}
