import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { api } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { FindBrands, HelpList, HelpTip, ListPager, MultiPicker, SortPicker, Stat, Tag } from "../components/gtm/QueueParts";
import { countedOptions, useRowsThatFit, useWide } from "../components/gtm/queueHooks";
import { AddToPitchButton } from "../components/gtm/AddToPitchButton";

/**
 * Instagram DMs to brands: the page drafts, a person sends.
 *
 * Instagram does not let software open a conversation - its API only answers
 * accounts that wrote first - so the send stays human. Everything around it
 * does not have to: the brand is found, what it asked for is read, and the
 * message is written before anybody needs it.
 *
 * Laid out as a queue, not a feed. A compact list on the left, one brand open
 * on the right, and "Mark sent" moves to the next one. The first version gave
 * every brand a full-width card with its own text box, which made fifty brands
 * fifty screens of scrolling.
 *
 * One brand, one channel. A brand already handed to the email sequence is not
 * offered here, and marking one sent keeps it out of the email sequence.
 */

const VIEWS = [
  { value: "todo", label: "To send", count: "todo" },
  { value: "followup", label: "Follow up", count: "followup" },
  { value: "sent", label: "Sent", count: "sent" },
  { value: "skipped", label: "Skipped", count: "skipped" },
  { value: "agencies", label: "Not brands", count: "agencies" },
  { value: "results", label: "Results", count: "converted", suffix: " signed up" },
];

// Keyword search surfaces calls from years ago. Past this they are shown as
// old: the brand has usually filled it (the queue drops them at the same age,
// FRESH_CALL_DAYS in instagram-dm-writer.js and OLD_CALL_DAYS in ops_sync.py).
const oldCall = (lead) => Boolean(lead.intent_posted_at)
  && (Date.now() - new Date(lead.intent_posted_at).getTime()) / 86_400_000 > 14;

// Instagram throttles an account that opens too many new conversations in a
// day; well before that, a burst of identical-looking DMs reads as spam.
const DAILY_SOFT_CAP = 40;

// What the "?" beside the title says.
const INSTAGRAM_HELP = [
  ["What this is", "Brands to DM on Instagram. Instagram does not let software start a conversation, so a person sends each one; the message is already written."],
  ["How to send", "Open a brand on the left, read their post, then Copy and open DM. Paste it in the conversation that opens, send, and press Mark sent, next. Keys: c copy and open, s mark sent, j/k move."],
  ["Changing the message", "Edit the text directly, Rewrite for a new draft, or switch language with the In Italiano / In English button."],
  ["The tabs", "To send is the queue. Follow up lists DMs unanswered for three days, with a follow-up written. Sent, Skipped and Not brands (agencies, platforms, creators) hold the rest; Results shows replies and signups."],
  ["Filters", "Found any way, verticals and the order are only for you. The row marked For the whole team changes the queue for everybody."],
  ["Find new brands", "Searches Instagram for brands asking for creators now, instead of at the next scheduled run. Once every half hour; it is the same search as on Email."],
  ["Limits", `Keep to about ${DAILY_SOFT_CAP} new DMs a day from one account. A brand DMed here is never emailed.`],
];

const ago = (iso) => {
  if (!iso) return "";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "1d ago" : `${days}d ago`;
};

const LANGUAGE_LABEL = { en: "English", it: "Italiano" };
const dmLink = (handle) => `https://ig.me/m/${encodeURIComponent(handle)}`;
const nameOf = (lead) => lead.brand_name || lead.ig_full_name || lead.handle;
const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

// Row heights of this page's two lists, for useRowsThatFit.
const ROW_PX = { queue: 52, rows: 54 };

export default function InstagramDmPage() {
  const { theme } = useTheme();
  const wide = useWide();
  const [view, setView] = useState("todo");
  const [data, setData] = useState(null);
  // Counts, settings and countries outlive a tab switch; the list does not.
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState(null);
  const [notice, setNotice] = useState(null);
  const [selected, setSelected] = useState(null);
  const [drafting, setDrafting] = useState(null); // { done, failed } while writing
  const [savingSetting, setSavingSetting] = useState(false);
  // One person's working filter ("today I'm doing beauty"), remembered in this
  // browser. The team settings below decide what is in the queue at all.
  const [verticals, setVerticals] = useState(() => {
    try { return JSON.parse(localStorage.getItem("ig-dm-verticals") || "[]"); } catch { return []; }
  });
  useEffect(() => {
    try { localStorage.setItem("ig-dm-verticals", JSON.stringify(verticals)); } catch { /* private window */ }
  }, [verticals]);
  // How the brands were found, and the order: the same kind of personal
  // choice, so an admin can judge one search path at a time.
  const [paths, setPaths] = useState(() => {
    try { return JSON.parse(localStorage.getItem("ig-dm-paths") || "[]"); } catch { return []; }
  });
  const [sort, setSort] = useState(() => {
    try { return localStorage.getItem("ig-dm-sort") || ""; } catch { return ""; }
  });
  useEffect(() => {
    try {
      localStorage.setItem("ig-dm-paths", JSON.stringify(paths));
      localStorage.setItem("ig-dm-sort", sort);
    } catch { /* private window */ }
  }, [paths, sort]);
  // Paged by the server: the page asks for one page at a time, filtered and
  // sorted in the query, so every brand is reachable however long the queue.
  const [page, setPage] = useState(0);
  const listTop = useRef(null);
  const queueView = view === "todo" || view === "followup";
  // Narrow screens stack the message panel under the list, so the list keeps
  // a short fixed page there instead of filling the window.
  // Measured once the filter bar is there: before it loads the list sits
  // higher than it will, and the page came out a few rows too long.
  const fitted = useRowsThatFit(listTop, queueView ? ROW_PX.queue : ROW_PX.rows, Boolean(meta), `${view}:${wide}`);
  const pageSize = !wide && queueView ? 8 : fitted;
  useEffect(() => { setPage(0); }, [view, verticals, paths, sort, pageSize]);
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);

  // Only the newest request may write. Switching tabs used to paint the "To
  // send" list under "Sent" - with Undo buttons on brands nobody had sent to -
  // until the slower answer arrived.
  const requestRef = useRef(0);

  const load = useCallback(async (quiet = false) => {
    const request = ++requestRef.current;
    if (!quiet) setLoading(true);
    try {
      // Results has its own endpoint; the queue call still refreshes the counts.
      const out = await api.getInstagramDms({
        view: view === "results" ? "todo" : view, limit: view === "results" ? 1 : pageSize,
        offset: view === "results" ? 0 : page * pageSize,
        verticals: verticals.join(","), paths: paths.join(","), sort,
      });
      if (request !== requestRef.current) return;
      setData(out);
      setMeta({ counts: out.counts, settings: out.settings, countries: out.countries || {},
                feedStatus: out.feedStatus, instagramReplies: out.instagramReplies, search: out.search,
                followupDays: out.followupDays,
                verticals: out.verticals || {}, verticalLabels: out.verticalLabels || {},
                paths: out.paths || {}, pathLabels: out.pathLabels || {}, sorts: out.sorts || {} });
      setProblem(null);
    } catch (err) {
      if (request === requestRef.current) setProblem(err?.message || "could not load the queue");
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [view, verticals, paths, sort, page, pageSize]);

  useEffect(() => { setSelected(null); setData(null); load(); }, [load]);

  // While a search runs, look again every 30 seconds so its brands arrive
  // without a reload, and the button comes back when it is done.
  const searching = Boolean(meta?.search?.running);
  useEffect(() => {
    if (!searching) return undefined;
    const timer = setInterval(() => load(true), 30_000);
    return () => clearInterval(timer);
  }, [searching, load]);

  const [finding, setFinding] = useState(false);
  const [findProblem, setFindProblem] = useState(null);
  const findBrands = useCallback(async () => {
    setFinding(true);
    setFindProblem(null);
    try {
      await api.findInstagramBrands();
    } catch (err) {
      setFindProblem(err?.message || "could not start the search");
    } finally {
      setFinding(false);
      load(true);
    }
  }, [load]);

  const leads = useMemo(() => data?.leads || [], [data]);
  const counts = meta?.counts || {};
  const current = leads.find((l) => l.handle === selected) || leads[0] || null;

  // Merge one changed lead into the list, or drop it when it has left this view.
  const leadsRef = useRef([]);
  useEffect(() => { leadsRef.current = leads; }, [leads]);

  const settle = useCallback((updated, stillHere) => {
    if (!stillHere) {
      // Move to the next brand, so marking sent is also "next".
      const list = leadsRef.current;
      const index = list.findIndex((l) => l.handle === updated.handle);
      const next = index >= 0 ? list[index + 1] || list[index - 1] : null;
      setSelected(next ? next.handle : null);
    }
    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        leads: stillHere
          ? prev.leads.map((l) => (l.handle === updated.handle ? { ...l, ...updated } : l))
          : prev.leads.filter((l) => l.handle !== updated.handle),
      };
    });
    load(true);
  }, [load]);

  // Messages are written without anybody asking: a brand in the queue with no
  // message is a brand nobody can send to. Ten at a time (one serverless call),
  // until the list on screen is covered - the brands on this page, named, so a
  // filtered or later page gets its messages rather than the top of the queue.
  const draftMissing = useCallback(async (followUp = false) => {
    let done = 0;
    let failed = 0;
    const mode = followUp ? "followup" : "todo";
    setDrafting({ done, failed });
    try {
      if (!followUp) {
        // Agencies first: a message written for one is money spent on nobody.
        const verdict = await api.classifyInstagramLeads().catch(() => null);
        if (verdict?.agencies) await load(true);
      }
      const tried = new Set();
      for (let round = 0; round < 10 && viewRef.current === mode; round++) {
        const handles = leadsRef.current
          .filter((l) => !(followUp ? l.dm_followup_text : l.dm_text) && !tried.has(l.handle))
          .map((l) => l.handle).slice(0, 10);
        if (!handles.length) break;
        handles.forEach((h) => tried.add(h));
        const out = await api.draftInstagramDms({ handles, followUp });
        done += out.drafted?.length || 0;
        failed += out.failed?.length || 0;
        for (const d of out.drafted || []) settle(d, true);
        setDrafting({ done, failed });
        if (!out.drafted?.length) {
          if (out.failed?.length) {
            setNotice({ tone: "danger",
                        text: `Could not write a message for @${out.failed[0].handle}: ${out.failed[0].error}` });
          }
          break;
        }
      }
    } catch (err) {
      setNotice({ tone: "danger", text: err?.message || "could not write messages" });
    } finally {
      setDrafting(null);
    }
  }, [settle, load]);

  const missing = view === "todo" ? leads.filter((l) => !l.dm_text).length
    : view === "followup" ? leads.filter((l) => !l.dm_followup_text).length : 0;
  const startedFor = useRef(null);
  useEffect(() => {
    // Once per shape of the queue, and only when something is missing, so a
    // brand whose message keeps failing does not loop.
    if (!data || !["todo", "followup"].includes(view) || !missing || drafting) return;
    const key = `${view}:${page}:${pageSize}:${paths}:${verticals}:${sort}:${counts.todo}:${counts.followup}`
      + `:${counts.nonShopify}:${JSON.stringify(meta?.settings)}`;
    if (startedFor.current === key) return;
    startedFor.current = key;
    draftMissing(view === "followup");
  }, [data, view, missing, drafting, page, pageSize, paths, verticals, sort,
      counts.todo, counts.followup, counts.nonShopify, meta?.settings, draftMissing]);

  // Admin choices for the whole team: which brands are in the queue at all.
  async function saveSetting(key, value) {
    setSavingSetting(true);
    try {
      await api.setProspectingSetting(key, value);
      await load(true);
    } catch (err) {
      setNotice({ tone: "danger", text: err?.message || "could not save the setting" });
    } finally {
      setSavingSetting(false);
    }
  }

  // The open brand's two main buttons, for the keyboard.
  const panelActions = useRef({});

  // Outside a text box: j / k or the arrows move through the list, c copies
  // and opens the conversation, s marks it sent and moves on.
  useEffect(() => {
    const onKey = (e) => {
      if (["TEXTAREA", "INPUT"].includes(document.activeElement?.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "c" && panelActions.current.copy) { e.preventDefault(); panelActions.current.copy(); return; }
      if (e.key === "s" && panelActions.current.sent) { e.preventDefault(); panelActions.current.sent(); return; }
      if (!["ArrowDown", "ArrowUp", "j", "k"].includes(e.key) || !leads.length) return;
      e.preventDefault();
      const index = Math.max(0, leads.findIndex((l) => l.handle === current?.handle));
      const step = e.key === "ArrowDown" || e.key === "j" ? 1 : -1;
      setSelected(leads[Math.min(leads.length - 1, Math.max(0, index + step))].handle);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [leads, current]);

  const includeNonShopify = meta?.settings?.dm_include_non_shopify === true;
  const chosenCountries = meta?.settings?.dm_countries || [];
  const verticalLabels = meta?.verticalLabels || {};
  const verticalName = (code) => (code === "NONE" ? "Not classified" : verticalLabels[code] || code);
  const pathName = (code) => meta?.pathLabels?.[code] || code;
  // The pager is the list's own footer, under the brands it pages - not a
  // full-width bar under the message panel.
  const pager = data && <ListPager theme={theme} page={page} pageSize={pageSize} total={data.total}
                                   onPage={setPage} />;
  const filtered = verticals.length > 0 || paths.length > 0;

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 22, color: theme.text }}>Instagram DMs</h1>
        <HelpTip title="Writing to brands on Instagram">
          <HelpList items={INSTAGRAM_HELP} />
        </HelpTip>
        <span style={{ color: theme.textMuted, fontSize: 13 }}>
          Copy the message, send it in the conversation that opens, mark it sent.
          Brands marked sent stay out of the email sequence.
        </span>
      </div>

      {problem && (
        <Card style={{ padding: 16, marginBottom: 0 }}>
          <div style={{ color: theme.textMuted, fontSize: 13 }}>
            <strong style={{ color: theme.text }}>Not set up yet.</strong> {problem}
          </div>
        </Card>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {VIEWS.map((v) => (
          <Btn key={v.value} size="sm" variant={view === v.value ? "solid" : "secondary"}
               onClick={() => { if (v.value !== view) { setView(v.value); setNotice(null); } }}>
            {v.label}{meta && (v.value !== "results" || counts.converted) ? ` ${counts[v.count] ?? 0}${v.suffix || ""}` : ""}
          </Btn>
        ))}
        {meta ? (
          <>
            <Stat theme={theme} label="sent today" value={counts.sentToday}
                  warn={counts.sentToday >= DAILY_SOFT_CAP} />
            <Stat theme={theme} label="replied" value={counts.replied} />
          </>
        ) : (
          <Skeleton style={{ height: 14, width: 150, marginLeft: 6 }} />
        )}
        <div style={{ flex: 1 }} />
        {drafting && (
          <span style={{ fontSize: 12, color: theme.textMid }}>
            Writing messages… {drafting.done} done{drafting.failed ? `, ${drafting.failed} failed` : ""}
          </span>
        )}
        {filtered && data && view !== "results" && (
          <span style={{ fontSize: 12, color: theme.textMuted }}>{data.total} shown</span>
        )}
        {meta && view !== "results" && (
          <>
            <MultiPicker theme={theme} allLabel="Found any way" noun="paths"
                         title="Only show brands found this way (just for you)"
                         options={countedOptions(meta.paths, paths, pathName)}
                         chosen={paths} onChange={setPaths}
                         short={(o) => o.label} />
            <MultiPicker theme={theme} allLabel="All verticals" noun="verticals"
                         title="Only show these verticals (just for you)"
                         options={countedOptions(meta.verticals, verticals, verticalName)}
                         chosen={verticals} onChange={setVerticals}
                         short={(o) => o.label.split(" & ")[0]} />
            <SortPicker theme={theme} value={sort} onChange={setSort}
                        options={[{ value: "", label: view === "todo" ? "Best chance first" : "Default order" },
                                  ...Object.entries(meta.sorts || {})
                                    .filter(([k]) => !(view === "todo" && k === "score"))
                                    .map(([value, label]) => ({ value, label }))]} />
          </>
        )}
      </div>

      {meta && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
                      paddingTop: 10, borderTop: `1px solid ${theme.border}` }}>
          <span style={{ fontSize: 12, color: theme.textMuted }}>For the whole team:</span>
          <MultiPicker theme={theme} allLabel="All countries" noun="countries"
                       title="Which countries' brands are in the queue, for everyone"
                       options={countedOptions(meta.countries, chosenCountries, countryName)}
                       chosen={chosenCountries} disabled={savingSetting}
                       onChange={(codes) => saveSetting("dm_countries", codes)}
                       short={(o) => (o.code === "UNKNOWN" ? "Unknown" : o.code)} />
          <MultiPicker theme={theme} allLabel="Generic Instagram searches" noun="verticals searched"
                       title="Which verticals the morning Instagram searches look for"
                       emptyMeansAll={false}
                       options={Object.entries(verticalLabels).map(([code, label]) => ({ code, label }))}
                       chosen={meta.settings?.search_verticals || []} disabled={savingSetting}
                       onChange={(codes) => saveSetting("search_verticals", codes)}
                       short={(o) => `Search ${o.label.split(" & ")[0].toLowerCase()}`} />
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12,
                          color: theme.textMid, cursor: savingSetting ? "wait" : "pointer" }}
                 title="Brands whose store is not on Shopify are never emailed. This decides whether they are offered here, for everyone.">
            <input type="checkbox" checked={includeNonShopify} disabled={savingSetting}
                   onChange={(e) => saveSetting("dm_include_non_shopify", e.target.checked)} style={{ margin: 0 }} />
            Include brands not on Shopify{counts.nonShopify ? ` (${counts.nonShopify})` : ""}
          </label>
          <FindBrands theme={theme} search={meta.search} busy={finding} problem={findProblem} onFind={findBrands} />
        </div>
      )}

      <FeedBanner status={meta?.feedStatus} theme={theme} />
      {counts.sentToday >= DAILY_SOFT_CAP && view === "todo" && (
        <div style={{ fontSize: 12.5, color: theme.warning }}>
          {counts.sentToday} sent today from this account. Instagram limits how many new
          conversations one account opens in a day; past about {DAILY_SOFT_CAP}, spread the rest over tomorrow.
        </div>
      )}

      {notice && (
        <div style={{ fontSize: 13, color: notice.tone === "danger" ? theme.danger : theme.textMid }}>
          {notice.text}
        </div>
      )}

      <div ref={listTop} />
      {view === "results" ? (
        <ResultsView theme={theme} />
      ) : loading && !data ? (
        <LoadingShape view={view} wide={wide} theme={theme} />
      ) : !leads.length ? (
        <Card style={{ padding: 16, marginBottom: 0 }}>
          <div style={{ color: theme.textMuted, fontSize: 13 }}>{emptyText(view)}</div>
        </Card>
      ) : view === "todo" || view === "followup" ? (
        <div style={{
          display: "grid", gap: 12, alignItems: "start",
          gridTemplateColumns: wide ? "minmax(300px, 380px) minmax(0, 1fr)" : "minmax(0, 1fr)",
        }}>
          <QueueList leads={leads} current={current} onSelect={setSelected} theme={theme}
                     drafting={Boolean(drafting)} footer={pager} />
          {current && (
            <DmPanel key={`${view}:${current.handle}`} lead={current} maxChars={data?.maxChars || 520}
                     followUp={view === "followup"} actionsRef={panelActions}
                     drafting={Boolean(drafting) && !(view === "followup" ? current.dm_followup_text : current.dm_text)}
                     onSettled={settle} onNotice={setNotice} sticky={wide} />
          )}
        </div>
      ) : (
        <Card style={{ padding: 0, marginBottom: 0 }}>
          {view === "agencies" ? leads.map((lead, i) => (
            <NotBrandRow key={lead.handle} lead={lead} last={i === leads.length - 1}
                         onSettled={settle} onNotice={setNotice} />
          )) : leads.map((lead, i) => (
            <SentRow key={lead.handle} lead={lead} last={i === leads.length - 1}
                     canReply={meta?.instagramReplies === true}
                     onSettled={settle} onNotice={setNotice} />
          ))}
          {pager}
        </Card>
      )}
    </div>
  );
}

// The page's own shape while it loads, so nothing jumps when it arrives.
function LoadingShape({ view, wide, theme }) {
  const rows = Array.from({ length: 8 });
  const listRow = (i) => (
    <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 12px",
                          borderTop: i ? `1px solid ${theme.border}` : "none" }}>
      <Skeleton style={{ width: 7, height: 7, borderRadius: 99 }} />
      <div style={{ flex: 1 }}>
        <Skeleton style={{ display: "block", height: 12, width: "55%" }} />
        <Skeleton style={{ display: "block", height: 10, width: "35%", marginTop: 6 }} />
      </div>
      <Skeleton style={{ height: 16, width: 34, borderRadius: 99 }} />
    </div>
  );
  if (!["todo", "followup"].includes(view)) {
    return <Card style={{ padding: 0, marginBottom: 0 }}>{rows.slice(0, 5).map((_, i) => listRow(i))}</Card>;
  }
  return (
    <div style={{ display: "grid", gap: 12, alignItems: "start",
                  gridTemplateColumns: wide ? "minmax(300px, 380px) minmax(0, 1fr)" : "minmax(0, 1fr)" }}>
      <Card style={{ padding: 0, marginBottom: 0 }}>{rows.map((_, i) => listRow(i))}</Card>
      <Card style={{ padding: 18, marginBottom: 0 }}>
        <Skeleton style={{ display: "block", height: 16, width: "30%" }} />
        <Skeleton style={{ display: "block", height: 11, width: "45%", marginTop: 8 }} />
        <Skeleton style={{ height: 44, marginTop: 16 }} />
        <Skeleton style={{ height: 220, marginTop: 12, borderRadius: 10 }} />
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <Skeleton style={{ height: 30, width: 150, borderRadius: 99 }} />
          <Skeleton style={{ height: 30, width: 130, borderRadius: 99 }} />
        </div>
      </Card>
    </div>
  );
}

// Short vertical names for the list, where the code is all a row carries.
const VERTICAL_SHORT = {
  BEAUTY_SKINCARE: "Beauty", FASHION_ACCESSORIES: "Fashion", HEALTH_WELLNESS: "Wellness",
  FITNESS_SPORTS: "Fitness", FOOD_BEVERAGE: "Food & drink", HOME_LIVING: "Home",
  BABY_PARENTING: "Baby", PETS: "Pets", TRAVEL: "Travel", TECHNOLOGY: "Tech",
};
const verticalShort = (code) => VERTICAL_SHORT[code] || code;

const COUNTRY_NAMES = (() => {
  try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; }
})();
const countryName = (code) => (code === "UNKNOWN" ? "Unknown country"
  : (COUNTRY_NAMES?.of(code) || code));

// The logged-in Instagram read feeds the queue. When it stops - an expired
// session, most often - the queue quietly stops growing, so it is said here.
function FeedBanner({ status, theme }) {
  if (!status) return null;
  const last = status.last_scraped_at ? new Date(status.last_scraped_at) : null;
  // `stale` is worked out by the server: three days with no read.
  if (!status.last_error && !status.stale) return null;
  return (
    <Card style={{ padding: "10px 14px", marginBottom: 0, borderColor: theme.warning }}>
      <div style={{ fontSize: 12.5, color: theme.text }}>
        <strong style={{ color: theme.warning }}>Instagram search is paused.</strong>{" "}
        {status.last_error || `No read since ${last ? last.toLocaleDateString() : "it was set up"}.`}{" "}
        <span style={{ color: theme.textMuted }}>
          Fix: on the Mac, in linkable-prospector, run <code>uv run prospector feed-login</code>.
          Paid hashtag search covers for it meanwhile.
        </span>
      </div>
    </Card>
  );
}

function Funnel({ theme, f }) {
  const cell = (label, value, sub) => (
    <div style={{ minWidth: 120 }}>
      <div style={{ fontSize: 12, color: theme.textMuted }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: theme.text }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: theme.textMuted }}>{sub}</div>}
    </div>
  );
  return (
    <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
      {cell("DMs sent", f.sent)}
      {cell("Followed up", f.followedUp)}
      {cell("Replied", f.replied, `${f.replyRate}% of sent`)}
      {cell("Signed up", f.converted, `${f.conversionRate}% of sent`)}
    </div>
  );
}

// What the DMs did: the funnel, and where it works best.
function ResultsView({ theme }) {
  const [data, setData] = useState(null);
  const [problem, setProblem] = useState(null);
  useEffect(() => {
    api.getInstagramResults().then(setData).catch((err) => setProblem(err?.message || "could not load results"));
  }, []);
  if (problem) return <Card style={{ padding: 16, marginBottom: 0 }}><span style={{ fontSize: 13, color: theme.danger }}>{problem}</span></Card>;
  if (!data) return <Card style={{ padding: 18, marginBottom: 0 }}><Skeleton style={{ display: "block", height: 60 }} /></Card>;
  if (!data.total.sent) {
    return (
      <Card style={{ padding: 16, marginBottom: 0 }}>
        <div style={{ fontSize: 13, color: theme.textMuted }}>
          No DMs sent yet. Replies and signups show here as they happen; a signup is matched to a DMed
          brand by its store address or email.
        </div>
      </Card>
    );
  }
  const table = (title, rows) => (
    <Card style={{ padding: 0, marginBottom: 0 }}>
      <div style={{ padding: "10px 14px", fontSize: 13, fontWeight: 600, color: theme.text,
                    borderBottom: `1px solid ${theme.border}` }}>{title}</div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead>
          <tr style={{ color: theme.textMuted }}>
            {["", "Sent", "Replied", "Reply rate", "Signed up"].map((h, i) => (
              <th key={h || i} style={{ textAlign: i ? "right" : "left", padding: "6px 14px", fontWeight: 500 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} style={{ borderTop: `1px solid ${theme.border}`, color: theme.text }}>
              <td style={{ padding: "6px 14px" }}>{r.label}</td>
              <td style={{ padding: "6px 14px", textAlign: "right" }}>{r.sent}</td>
              <td style={{ padding: "6px 14px", textAlign: "right" }}>{r.replied}</td>
              <td style={{ padding: "6px 14px", textAlign: "right" }}>{r.replyRate}%</td>
              <td style={{ padding: "6px 14px", textAlign: "right" }}>{r.converted}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card style={{ padding: 18, marginBottom: 0 }}>
        <Funnel theme={theme} f={data.total} />
        {data.converted.length > 0 && (
          <div style={{ marginTop: 12, fontSize: 12.5, color: theme.textMid }}>
            Signed up after a DM: {data.converted.map((c) => `@${c.handle}`).join(", ")}
          </div>
        )}
      </Card>
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))" }}>
        {table("By message variant", data.byVariant)}
        {data.byScore && table("By conversion score", data.byScore)}
        {table("By vertical", data.byVertical)}
        {table("By country", data.byCountry)}
        {table("By week sent", data.byWeek)}
      </div>
    </div>
  );
}

function emptyText(view) {
  if (view === "sent") return "Nothing sent yet.";
  if (view === "followup") return "No follow-ups due. A DM unanswered for three days shows up here.";
  if (view === "agencies") return "Nothing taken out. Agencies, platforms, events and creators land here.";
  if (view === "skipped") return "Nothing skipped.";
  return "No brands waiting. New ones arrive every morning from the Instagram searches.";
}

function QueueList({ leads, current, onSelect, theme, drafting, footer }) {
  const activeRef = useRef(null);
  useEffect(() => { activeRef.current?.scrollIntoView({ block: "nearest" }); }, [current?.handle]);

  return (
    <Card style={{ padding: 0, marginBottom: 0, overflow: "hidden" }}>
      <div>
        {leads.map((lead, i) => {
          const active = lead.handle === current?.handle;
          const ready = Boolean(lead.dm_text);
          return (
            <button
              key={lead.handle}
              ref={active ? activeRef : null}
              type="button"
              onClick={() => onSelect(lead.handle)}
              aria-current={active ? "true" : undefined}
              style={{
                display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left",
                padding: "9px 12px", border: "none", font: "inherit", cursor: "pointer",
                borderTop: i ? `1px solid ${theme.border}` : "none",
                background: active ? theme.accentLight : "transparent",
                boxShadow: active ? `inset 3px 0 0 ${theme.accent}` : "none",
              }}
            >
              <span
                title={ready ? "Message ready" : drafting ? "Writing…" : "No message yet"}
                style={{
                  width: 7, height: 7, borderRadius: 99, flexShrink: 0,
                  background: ready ? theme.success : theme.border,
                }}
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: theme.text,
                               overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {nameOf(lead)}
                </span>
                <span style={{ display: "block", fontSize: 11.5, color: theme.textMuted,
                               overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  @{lead.handle}
                  {lead.country ? ` · ${lead.country}` : ""}
                  {lead.ig_followers ? ` · ${compact(lead.ig_followers)}` : ""}
                  {lead.vertical_effective ? ` · ${verticalShort(lead.vertical_effective)}` : ""}
                  {lead.intent_posted_at ? ` · posted ${ago(lead.intent_posted_at)}` : ""}
                  {lead.dm_sent_at && !lead.intent_posted_at ? ` · sent ${ago(lead.dm_sent_at)}` : ""}
                </span>
              </span>
              <span style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                {lead.intent_signal === "open_call" && (oldCall(lead)
                  ? <Tag title="Asked for creators over 90 days ago; probably filled">Old call</Tag>
                  : <Tag tone="success" title="Posted asking for creators">Call</Tag>)}
                {lead.status === "not_shopify" && <Tag tone="warning" title="Store is not on Shopify">No Shopify</Tag>}
                {lead.email_queued && <Tag tone="warning" title="Goes to the email sequence on the next run">Email</Tag>}
              </span>
            </button>
          );
        })}
      </div>
      {footer}
    </Card>
  );
}

function DmPanel({ lead, maxChars, drafting, onSettled, onNotice, sticky, followUp = false, actionsRef }) {
  const { theme } = useTheme();
  // The same panel writes the first DM and, three days later, the follow-up.
  const saved = (followUp ? lead.dm_followup_text : lead.dm_text) || "";
  const [text, setText] = useState(saved);
  const [busy, setBusy] = useState(null);
  const [copied, setCopied] = useState(false);
  const [showPost, setShowPost] = useState(false);

  // A redraft replaces the text; typing in the box does not come back here.
  useEffect(() => { setText(saved); }, [saved]);

  const name = nameOf(lead);
  const language = lead.dm_language || lead.default_language || "en";
  const other = language === "it" ? "en" : "it";
  const dirty = text.trim() !== saved.trim();
  const editAction = followUp ? "edit_followup" : "edit";
  const caption = (lead.intent_caption || "").trim();

  async function run(label, fn) {
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      onNotice({ tone: "danger", text: `@${lead.handle}: ${err?.message || "failed"}` });
    } finally {
      setBusy(null);
    }
  }

  const save = () => run("save", async () => {
    if (!dirty) return;
    onSettled(await api.updateInstagramDm(lead.handle, editAction, text), true);
  });

  const draft = (lang) => run(lang ? `draft-${lang}` : "draft", async () => {
    const out = await api.draftInstagramDms({ handles: [lead.handle], language: lang, followUp });
    if (out.failed?.length) throw new Error(out.failed[0].error);
    if (out.drafted?.[0]) onSettled(out.drafted[0], true);
  });

  // Copy first, then open: the conversation opens in another tab and the
  // message is already on the clipboard when it does.
  const copyAndOpen = () => run("copy", async () => {
    if (dirty) onSettled(await api.updateInstagramDm(lead.handle, editAction, text), true);
    await navigator.clipboard.writeText(text.trim());
    setCopied(true);
    window.open(dmLink(lead.handle), "_blank", "noopener");
  });

  const mark = (action) => run(action, async () => {
    if (["sent", "followup_sent"].includes(action) && dirty) {
      await api.updateInstagramDm(lead.handle, editAction, text);
    }
    onSettled(await api.updateInstagramDm(lead.handle, action), false);
  });
  const sentAction = followUp ? "followup_sent" : "sent";

  // For the page's keyboard shortcuts: c and s act on the open brand.
  useEffect(() => {
    if (!actionsRef) return undefined;
    actionsRef.current = {
      copy: () => { if (text.trim() && !busy) copyAndOpen(); },
      sent: () => { if (text.trim() && !busy) mark(sentAction); },
    };
    return () => { actionsRef.current = {}; };
  });

  return (
    <Card style={{ padding: 18, marginBottom: 0, ...(sticky ? { position: "sticky", top: 12 } : {}) }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: theme.text }}>{name}</div>
          <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 2 }}>
            @{lead.handle}
            {lead.country ? ` · ${lead.country}` : ""}
            {lead.ig_category && lead.ig_category !== "None" ? ` · ${lead.ig_category}` : ""}
            {lead.ig_followers ? ` · ${lead.ig_followers.toLocaleString()} followers` : ""}
            {lead.domain ? ` · ${lead.domain}` : ""}
          </div>
          {lead.dm_priority != null && (
            <div style={{ fontSize: 12, color: theme.textMid, marginTop: 4 }}
                 title="Conversion potential, 0-100: market, vertical, what they asked for, store, size, and how fresh the call is">
              <strong style={{ color: theme.text }}>Score {Math.round(lead.dm_priority)}</strong>
              {lead.dm_reasons ? ` · ${lead.dm_reasons}` : ""}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {lead.vertical_effective && <Tag>{verticalShort(lead.vertical_effective)}</Tag>}
          {lead.intent_signal === "open_call" && (oldCall(lead)
            ? <Tag>Asked for creators {ago(lead.intent_posted_at)}</Tag>
            : <Tag tone="success">Asked for creators</Tag>)}
          {lead.status === "not_shopify" && <Tag tone="warning">Not on Shopify</Tag>}
          {lead.tier && <Tag>Tier {lead.tier}</Tag>}
          <Btn size="sm" variant="secondary"
               href={lead.instagram_url || `https://www.instagram.com/${lead.handle}/`} target="_blank">
            Profile
          </Btn>
          <AddToPitchButton lead={lead} />
          {lead.intent_post_url && (
            <Btn size="sm" variant="secondary" href={lead.intent_post_url} target="_blank">Their post</Btn>
          )}
        </div>
      </div>

      {caption && (
        <button
          type="button"
          onClick={() => setShowPost((v) => !v)}
          title={showPost ? "Show less" : "Show the whole post"}
          style={{
            display: "block", width: "100%", textAlign: "left", marginTop: 12, padding: "6px 10px",
            border: "none", borderLeft: `3px solid ${theme.border}`, background: "transparent",
            fontFamily: "inherit", color: theme.textMid, fontSize: 12.5, lineHeight: 1.45, cursor: "pointer",
          }}
        >
          {/* Clamped on an inner block with no padding: clamping the padded
              button let half of the fourth line show through the padding. */}
          <span style={showPost ? { display: "block", whiteSpace: "pre-wrap" } : {
            display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden",
          }}>
            {showPost ? caption : caption.replace(/\s*\n+\s*/g, " · ")}
          </span>
        </button>
      )}

      {followUp && lead.dm_text && (
        <div style={{ marginTop: 12, fontSize: 12, color: theme.textMuted }}>
          First message, sent {ago(lead.dm_sent_at)}, no answer yet:
          <div style={{ marginTop: 4, padding: "6px 10px", borderLeft: `3px solid ${theme.border}`,
                        color: theme.textMid, whiteSpace: "pre-wrap", maxHeight: 90, overflow: "hidden" }}>
            {lead.dm_text}
          </div>
        </div>
      )}

      {lead.email_queued && (
        <div style={{ marginTop: 10, fontSize: 12, color: theme.warning }}>
          Goes to the email sequence on the next run unless it is DMed first.
        </div>
      )}

      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setCopied(false); }}
        onBlur={save}
        rows={Math.min(18, Math.max(followUp ? 5 : 8, text.split("\n").length + 2))}
        placeholder={drafting || busy?.startsWith("draft")
          ? (followUp ? "Writing the follow-up…" : "Writing the message…") : "No message yet."}
        aria-label={`Message to ${name}`}
        style={{
          width: "100%", marginTop: 12, padding: "10px 12px", borderRadius: 10,
          fontFamily: "inherit", fontSize: 13, lineHeight: 1.5,
          border: `1.5px solid ${theme.border}`, background: theme.bg, color: theme.text,
          resize: "vertical", boxSizing: "border-box",
        }}
      />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: theme.textMuted, marginTop: 4 }}>
        <span>
          {saved ? `In ${LANGUAGE_LABEL[language] || language}` : ""}
          {!followUp && lead.dm_variant ? ` · variant ${lead.dm_variant}` : ""}
          {" · keys: c copy and open, s mark sent, j/k move"}
        </span>
        <span style={{ color: text.length > maxChars + 60 ? theme.warning : theme.textMuted }}>
          {text.length} characters
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
        <Btn size="sm" onClick={copyAndOpen} loading={busy === "copy"} disabled={!text.trim() || Boolean(busy)}>
          {copied ? "Copied, open again" : "Copy and open DM"}
        </Btn>
        <Btn size="sm" variant="outline" onClick={() => mark(sentAction)} loading={busy === sentAction}
             disabled={!text.trim() || Boolean(busy)}>
          {followUp ? "Follow-up sent, next" : "Mark sent, next"}
        </Btn>
        <div style={{ flex: 1 }} />
        <Btn size="sm" variant="secondary" onClick={() => draft()} loading={busy === "draft"} disabled={Boolean(busy)}>
          {saved ? "Rewrite" : "Write message"}
        </Btn>
        <Btn size="sm" variant="secondary" onClick={() => draft(other)} loading={busy === `draft-${other}`}
             disabled={Boolean(busy)}>
          In {LANGUAGE_LABEL[other]}
        </Btn>
        {followUp ? (
          <Btn size="sm" variant="secondary" onClick={() => mark("replied")} loading={busy === "replied"}
               disabled={Boolean(busy)}>
            They replied
          </Btn>
        ) : (
          <>
            <Btn size="sm" variant="secondary" onClick={() => mark("not_brand")} loading={busy === "not_brand"}
                 disabled={Boolean(busy)} title="An agency, platform, event or creator: out of the queue, listed under Not brands">
              Not a brand
            </Btn>
            <Btn size="sm" variant="secondary" onClick={() => mark("skip")} loading={busy === "skip"} disabled={Boolean(busy)}>
              Skip
            </Btn>
          </>
        )}
      </div>
    </Card>
  );
}

// An account taken out of the queue as not a brand, and the way back in.
function NotBrandRow({ lead, last, onSettled, onNotice }) {
  const { theme } = useTheme();
  const [busy, setBusy] = useState(false);
  const restore = async () => {
    setBusy(true);
    try {
      onSettled(await api.updateInstagramDm(lead.handle, "brand"), false);
      onNotice({ tone: "info", text: `@${lead.handle} is back in the queue.` });
    } catch (err) {
      onNotice({ tone: "danger", text: `@${lead.handle}: ${err?.message || "failed"}` });
    } finally {
      setBusy(false);
    }
  };
  const about = [lead.ig_category, lead.ig_biography].filter((v) => v && v !== "None").join(" · ");
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "10px 16px", flexWrap: "wrap",
                  borderBottom: last ? "none" : `1px solid ${theme.border}` }}>
      <div style={{ flex: 1, minWidth: 260 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>{nameOf(lead)}</div>
        <div style={{ fontSize: 12, color: theme.textMuted, overflow: "hidden", textOverflow: "ellipsis",
                      whiteSpace: "nowrap", maxWidth: 820 }}>
          @{lead.handle}{about ? ` · ${about.replace(/\s+/g, " ")}` : ""}
        </div>
      </div>
      <Btn size="sm" variant="secondary" href={lead.instagram_url || `https://www.instagram.com/${lead.handle}/`}
           target="_blank">Profile</Btn>
      <Btn size="sm" variant="outline" onClick={restore} loading={busy} disabled={busy}>
        It's a brand
      </Btn>
    </div>
  );
}

function SentRow({ lead, last, onSettled, onNotice, canReply }) {
  const { theme } = useTheme();
  const [busy, setBusy] = useState(null);
  const [answer, setAnswer] = useState("");

  const act = async (action) => {
    setBusy(action);
    try {
      onSettled(await api.updateInstagramDm(lead.handle, action), action === "replied");
    } catch (err) {
      onNotice({ tone: "danger", text: `@${lead.handle}: ${err?.message || "failed"}` });
    } finally {
      setBusy(null);
    }
  };

  // Their reply came through Instagram's API, so the answer can go back the
  // same way - inside the 24 hours Instagram allows.
  const sendAnswer = async () => {
    setBusy("answer");
    try {
      await api.sendInstagramReply(lead.handle, answer);
      setAnswer("");
      onNotice({ tone: "info", text: `Answer sent to @${lead.handle}.` });
    } catch (err) {
      onNotice({ tone: "danger", text: `@${lead.handle}: ${err?.message || "failed"}` });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ padding: "10px 16px", borderBottom: last ? "none" : `1px solid ${theme.border}` }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>{nameOf(lead)}</div>
          <div style={{ fontSize: 12, color: theme.textMuted }}>
            @{lead.handle}
            {lead.dm_sent_at ? ` · sent ${new Date(lead.dm_sent_at).toLocaleString()}` : ""}
            {lead.dm_sent_by ? ` by ${lead.dm_sent_by}` : ""}
            {lead.dm_followup_sent_at ? ` · followed up ${ago(lead.dm_followup_sent_at)}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end" }}>
          {lead.converted_at && <Tag tone="success" title={`Matched by ${lead.converted_match}`}>Signed up</Tag>}
          {lead.dm_state === "replied" && <Tag tone="success">Replied</Tag>}
          {lead.dm_state === "sent" && (
            <Btn size="sm" variant="secondary" onClick={() => act("replied")} loading={busy === "replied"}
                 disabled={Boolean(busy)}>
              They replied
            </Btn>
          )}
          <Btn size="sm" variant="secondary" href={dmLink(lead.handle)} target="_blank">Open DM</Btn>
          <Btn size="sm" variant="secondary" onClick={() => act("reopen")} loading={busy === "reopen"}
               disabled={Boolean(busy)}>
            {lead.dm_state === "skipped" ? "Restore" : "Undo"}
          </Btn>
        </div>
      </div>
      {lead.dm_reply_text && (
        <div style={{ marginTop: 8, padding: "6px 10px", borderLeft: `3px solid ${theme.success}`,
                      fontSize: 12.5, color: theme.textMid, whiteSpace: "pre-wrap" }}>
          {lead.dm_reply_text}
        </div>
      )}
      {canReply && lead.ig_user_id && lead.dm_state === "replied" && (
        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "flex-end" }}>
          <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={2}
                    placeholder="Answer on Instagram…" aria-label={`Answer to ${nameOf(lead)}`}
                    style={{ flex: 1, padding: "8px 10px", borderRadius: 10, fontFamily: "inherit", fontSize: 13,
                             border: `1.5px solid ${theme.border}`, background: theme.bg, color: theme.text,
                             resize: "vertical" }} />
          <Btn size="sm" onClick={sendAnswer} loading={busy === "answer"} disabled={!answer.trim() || Boolean(busy)}>
            Send on Instagram
          </Btn>
        </div>
      )}
    </div>
  );
}
