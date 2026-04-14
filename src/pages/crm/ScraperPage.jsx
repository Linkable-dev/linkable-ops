import { useState, useEffect, useRef, useCallback } from "react";
import { Btn } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { Tag } from "../../components/ui/Tag";
import { TabBar } from "../../components/ui/TabBar";
import { Label, SectionTitle, Row, Col } from "../../components/ui/Label";
import { ProgressBar } from "../../components/ui/ProgressBar";
import { Pagination } from "../../components/ui/Pagination";
import { useAuth } from "../../contexts/AuthContext";
import { callClaude } from "../../lib/claude";
import { api } from "../../lib/api";
import { supabase } from "../../lib/supabase";
import { useTheme } from "../../contexts/ThemeContext";

export default function ScraperPage() {
  const { theme } = useTheme();
  const COLOR = theme.accent;
  const { profile } = useAuth();
  const teamId = profile?.team_id;

  // Search intent
  const [searchIntent, setSearchIntent] = useState("Shopify beauty and wellness brands in the US and UK with around $50k monthly revenue");
  const [generatingQueries, setGeneratingQueries] = useState(false);

  // Manual domains
  const [domainInput, setDomainInput] = useState("");
  const [mode, setMode] = useState("discover");

  // Email enrichment
  const [enrichingDomains, setEnrichingDomains] = useState(new Set());
  const [status, setStatus] = useState({ status: "idle", processed: 0, total: 0, qualified: 0, results: [] });
  const [error, setError] = useState("");
  const pollRef = useRef(null);

  // Persisted results — server-side paginated
  const [dbResults, setDbResults] = useState([]);
  const [tab, setTab] = useState("pending");
  const [loadingDb, setLoadingDb] = useState(true);

  // Pagination
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [totalCount, setTotalCount] = useState(0);
  const [tabCounts, setTabCounts] = useState({ pending: 0, added: 0, passed: 0 });

  const thStyle = { textAlign: "left", padding: "10px 12px", fontWeight: 600, color: theme.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: `2px solid ${theme.border}`, whiteSpace: "nowrap" };
  const tdStyle = { padding: "10px 12px", color: theme.text, borderBottom: `1px solid ${theme.border}`, fontSize: 13, whiteSpace: "nowrap" };

  // Reset page when tab changes
  useEffect(() => { setPage(1); }, [tab, pageSize]);

  const loadDbResults = useCallback(async () => {
    if (!teamId) return;
    setLoadingDb(true);

    // Fetch counts for all tabs + paginated data for current tab in parallel
    const baseMatch = { team_id: teamId, qualified: true };
    const [pRes, aRes, passRes, pageRes] = await Promise.all([
      supabase.from("scraper_results").select("*", { count: "exact", head: true }).match({ ...baseMatch, lead_status: "pending" }),
      supabase.from("scraper_results").select("*", { count: "exact", head: true }).match({ ...baseMatch, lead_status: "added" }),
      supabase.from("scraper_results").select("*", { count: "exact", head: true }).match({ ...baseMatch, lead_status: "passed" }),
      supabase.from("scraper_results").select("*", { count: "exact" })
        .match({ ...baseMatch, lead_status: tab })
        .order("beauty_score", { ascending: false })
        .range((page - 1) * pageSize, page * pageSize - 1),
    ]);

    setTabCounts({ pending: pRes.count || 0, added: aRes.count || 0, passed: passRes.count || 0 });
    setDbResults(pageRes.data || []);
    setTotalCount(pageRes.count || 0);
    setLoadingDb(false);
  }, [teamId, tab, page, pageSize]);

  useEffect(() => { loadDbResults(); }, [loadDbResults]);

  // Poll while running — also refresh DB results every 5 polls to show new finds
  const pollCountRef = useRef(0);
  useEffect(() => {
    if (status.status === "running" || status.status === "discovering") {
      pollCountRef.current = 0;
      pollRef.current = setInterval(async () => {
        try {
          const data = await api("/scraper/status");
          setStatus(data);
          pollCountRef.current++;
          // Refresh DB results every 5 polls (10s) to show newly scraped leads
          if (pollCountRef.current % 5 === 0) loadDbResults();
          if (data.status === "complete" || data.status === "stopped" || data.status === "idle") {
            clearInterval(pollRef.current);
            loadDbResults();
            // Email enrichment happens after scrape — refresh again after delays to catch them
            setTimeout(() => loadDbResults(), 10000);
            setTimeout(() => loadDbResults(), 30000);
            setTimeout(() => loadDbResults(), 60000);
          }
        } catch {}
      }, 2000);
      return () => clearInterval(pollRef.current);
    }
  }, [status.status, loadDbResults]);

  // AI generates search queries from natural language
  async function handleGenerateAndSearch() {
    if (!searchIntent.trim()) { setError("Describe what you're looking for"); return; }
    setError("");
    setGeneratingQueries(true);

    try {
      const result = await callClaude(
        `You generate web search queries to discover ecommerce brand websites. Rules:
- Return ONLY a JSON array of 12 search query strings. No markdown, no code fences, no explanation.
- DO NOT use "site:" operators. Just use natural search terms.
- Each query should target DIFFERENT niches, sub-categories, or angles to maximize unique brand discovery.
- Include brand names, product categories, geography terms, and indie/DTC/small business indicators.
- Mix specific queries ("vegan Korean skincare brand UK") with broader ones ("best indie beauty brands 2025").
- Some queries should target listicles, roundups, and "brands to watch" articles which link to many stores.`,
        `Find brands matching: ${searchIntent}`,
        () => {}, 600
      );

      let queries;
      try {
        queries = JSON.parse(result.replace(/```json|```/g, "").trim());
      } catch {
        // Try extracting array from response
        const match = result.match(/\[[\s\S]*\]/);
        queries = match ? JSON.parse(match[0]) : null;
      }

      if (!Array.isArray(queries) || !queries.length) {
        setError("Couldn't generate search queries. Try rephrasing.");
        setGeneratingQueries(false);
        return;
      }

      // Send queries to the server for discovery
      const data = await api("/scraper/start", { method: "POST", body: { discover: true, queries } });
      if (data.message) {
        setError(data.message);
        setGeneratingQueries(false);
        return;
      }
      setStatus(prev => ({ ...prev, status: data.status || "discovering", total: data.total || 0 }));
    } catch (err) {
      setError(err.message);
    }
    setGeneratingQueries(false);
  }

  async function handleStartManual(useSeeds = false) {
    setError("");
    try {
      const body = {};
      if (useSeeds) body.useSeeds = true;
      else {
        const domains = domainInput.split(/[\n,]+/).map(d => d.trim()).filter(Boolean);
        if (!domains.length) { setError("Enter at least one domain"); return; }
        body.domains = domains;
      }
      const data = await api("/scraper/start", { method: "POST", body });
      if (data.message) { setError(data.message + " — try searching for new brands instead."); return; }
      setStatus(prev => ({ ...prev, status: data.status || "running", total: data.total || 0 }));
    } catch (err) { setError(err.message); }
  }

  async function handleStop() {
    try { await api("/scraper/stop", { method: "POST" }); setStatus(prev => ({ ...prev, status: "stopping" })); }
    catch (err) { setError(err.message); }
  }

  async function handleFindEmail(result) {
    setEnrichingDomains(prev => new Set([...prev, result.domain]));
    try {
      const data = await api("/scraper/enrich-email", { method: "POST", body: { domain: result.domain } });
      const bestEmail = data.best || `hello@${result.domain}`;
      // Update local state
      setDbResults(prev => prev.map(r => r.id === result.id ? { ...r, contact_email: bestEmail, found_emails: data.found || [] } : r));
      // Persist to DB
      if (result.id) {
        await supabase.from("scraper_results").update({ contact_email: bestEmail }).eq("id", result.id).catch(() => {});
      }
    } catch {
      // Fallback to common pattern
      setDbResults(prev => prev.map(r => r.id === result.id ? { ...r, contact_email: `hello@${result.domain}` } : r));
    }
    setEnrichingDomains(prev => { const n = new Set(prev); n.delete(result.domain); return n; });
  }

  async function handleAddToCRM(result) {
    if (!teamId) return;
    // Optimistic: remove from current page
    setDbResults(prev => prev.filter(r => r.id !== result.id));
    setTotalCount(prev => prev - 1);
    setTabCounts(prev => ({ ...prev, pending: prev.pending - 1, added: prev.added + 1 }));

    const { data: existing } = await supabase.from("contacts").select("id").eq("team_id", teamId).eq("domain", result.domain).maybeSingle();
    if (!existing) {
      const { data: contact, error: err } = await supabase.from("contacts").insert({
        team_id: teamId, name: result.store_name || "", company: result.store_name || "",
        domain: result.domain, email: result.contact_email || "", stage: "Lead",
        estimated_revenue: result.estimated_revenue, product_count: result.product_count,
        category: (result.matched_keywords || []).slice(0, 3).join(", "),
        country: result.country || "", source: "scraper", beauty_score: result.beauty_score, aov: result.aov,
      }).select().single();
      if (!err && contact) {
        await supabase.from("activities").insert({ contact_id: contact.id, team_id: teamId, type: "imported", description: "Imported from Shopify scraper" });
        await supabase.from("deals").insert({ contact_id: contact.id, team_id: teamId, value: 0, stage: "Lead" });
      }
    }
    if (result.id) await supabase.from("scraper_results").update({ lead_status: "added", imported_to_crm: true }).eq("id", result.id);
  }

  async function handlePass(result) {
    // Optimistic: remove from current page
    setDbResults(prev => prev.filter(r => r.id !== result.id));
    setTotalCount(prev => prev - 1);
    setTabCounts(prev => ({ ...prev, pending: prev.pending - 1, passed: prev.passed + 1 }));
    if (result.id) await supabase.from("scraper_results").update({ lead_status: "passed" }).eq("id", result.id);
  }

  async function handleUnpass(result) {
    // Optimistic: remove from current page
    setDbResults(prev => prev.filter(r => r.id !== result.id));
    setTotalCount(prev => prev - 1);
    setTabCounts(prev => ({ ...prev, passed: prev.passed - 1, pending: prev.pending + 1 }));
    if (result.id) await supabase.from("scraper_results").update({ lead_status: "pending" }).eq("id", result.id);
  }

  const isRunning = status.status === "running" || status.status === "discovering";
  const pct = status.total > 0 ? Math.round((status.processed / status.total) * 100) : 0;
  const totalDbCount = tabCounts.pending + tabCounts.added + tabCounts.passed;

  function renderTable(results, showActions) {
    if (!results.length) return (
      <div style={{ textAlign: "center", color: theme.textMuted, padding: 32, fontSize: 14 }}>
        {tab === "pending" ? "No pending leads. Search for brands above." : tab === "added" ? "No leads added to CRM yet." : "No passed leads."}
      </div>
    );
    return (
      <div style={{ overflowY: "auto", maxHeight: "60vh" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <colgroup>
            <col />
            <col />
            <col />
            <col />
            <col />
            <col />
            <col />
          </colgroup>
          <thead style={{ position: "sticky", top: 0, zIndex: 1, background: theme.surface }}><tr>
            <th style={thStyle}>Brand</th><th style={thStyle}>Country</th><th style={thStyle}>Est. Revenue</th>
            <th style={thStyle}>Products</th><th style={thStyle}>Beauty Score</th><th style={thStyle}>Contact</th><th style={thStyle}>Actions</th>
          </tr></thead>
          <tbody>
            {results.map(r => {
              const keywords = (r.matched_keywords || []);
              const sc = (r.beauty_score || 0) >= 0.7 ? "#10B981" : (r.beauty_score || 0) >= 0.4 ? "#F59E0B" : "#EF4444";
              return (
                <tr key={r.id}>
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 600, fontSize: 14, color: theme.text }}>{r.store_name || r.domain}</div>
                    <a href={`https://${r.domain}`} target="_blank" rel="noopener noreferrer" style={{ color: theme.textMuted, fontSize: 12, textDecoration: "none" }}>{r.domain}</a>
                  </td>
                  <td style={tdStyle}>{r.country || "-"}</td>
                  <td style={tdStyle}>${(r.estimated_revenue || 0).toLocaleString()}</td>
                  <td style={tdStyle}>{r.product_count || "-"}</td>
                  <td style={{ ...tdStyle, whiteSpace: "normal", minWidth: 120 }}>
                    <Tag color={sc}>{((r.beauty_score || 0) * 100).toFixed(0)}%</Tag>
                    {keywords.length > 0 && <div style={{ marginTop: 4, fontSize: 11, color: theme.textMuted, lineHeight: 1.5 }}>{keywords.slice(0, 4).join(", ")}</div>}
                  </td>
                  <td style={tdStyle}>
                    {r.contact_email ? (
                      <a href={`mailto:${r.contact_email}`} style={{ color: theme.text, fontSize: 12, wordBreak: "break-all" }}>{r.contact_email}</a>
                    ) : enrichingDomains.has(r.domain) ? (
                      <span style={{ fontSize: 12, color: theme.textMuted }}>Finding...</span>
                    ) : (
                      <Btn size="sm" variant="outline" onClick={() => handleFindEmail(r)}>Find</Btn>
                    )}
                  </td>
                  <td style={tdStyle}>
                    {showActions === "pending" && <div style={{ display: "flex", gap: 6, whiteSpace: "nowrap" }}><Btn size="sm" onClick={() => handleAddToCRM(r)}>Add</Btn><Btn size="sm" variant="outline" color="#EF4444" onClick={() => handlePass(r)}>Pass</Btn></div>}
                    {showActions === "added" && <Tag color="#10B981">In CRM</Tag>}
                    {showActions === "passed" && <Btn size="sm" variant="outline" onClick={() => handleUnpass(r)}>Restore</Btn>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div>
      {/* Search Controls */}
      <Card>
        <SectionTitle>Find Shopify Brands</SectionTitle>

        <TabBar tabs={[["discover", "AI Search"], ["manual", "Manual Domains"]]} active={mode} onSelect={setMode} />

        {mode === "discover" && !isRunning && (
          <>
            <Label>Describe what you're looking for</Label>
            <Input
              multiline rows={2}
              value={searchIntent}
              onChange={e => setSearchIntent(e.target.value)}
              placeholder="e.g. Clean beauty brands in the UK doing $30-80k/mo, focused on skincare and wellness"
            />
            <div style={{ display: "flex", gap: 10, marginTop: 14, alignItems: "center" }}>
              <Btn onClick={handleGenerateAndSearch} disabled={generatingQueries || !searchIntent.trim()}>
                {generatingQueries ? "Generating searches..." : "Search for Brands"}
              </Btn>
            </div>
          </>
        )}

        {mode === "manual" && !isRunning && (
          <>
            <Label>Domains (one per line or comma-separated)</Label>
            <Input multiline rows={3} value={domainInput} onChange={e => setDomainInput(e.target.value)} placeholder={"example.com\nanother-store.com"} />
            <div style={{ marginTop: 14 }}>
              <Btn onClick={() => handleStartManual(false)}>Scrape Domains</Btn>
            </div>
          </>
        )}

        {isRunning && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div>
                <span style={{ fontWeight: 600, fontSize: 14, color: theme.text }}>
                  {status.status === "discovering" ? "Discovering domains..." : "Scraping..."}
                </span>
                <span style={{ color: theme.textMuted, fontSize: 13, marginLeft: 12 }}>
                  {status.processed}/{status.total} &middot; {status.qualified} qualified
                </span>
              </div>
              <Btn size="sm" color="#EF4444" onClick={handleStop}>Stop</Btn>
            </div>
            <ProgressBar pct={pct} />
          </div>
        )}

        {error && <div style={{ color: "#EF4444", fontSize: 13, marginTop: 10 }}>{error}</div>}
      </Card>

      {/* Persisted Results */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <SectionTitle>Scraped Leads ({totalDbCount} total)</SectionTitle>
          <div style={{ display: "flex", gap: 8, fontSize: 12 }}>
            <Tag color={theme.text}>{tabCounts.pending} pending</Tag>
            <Tag color="#10B981">{tabCounts.added} in CRM</Tag>
            <Tag color="#EF4444">{tabCounts.passed} passed</Tag>
          </div>
        </div>
        <TabBar tabs={[["pending", `Pending (${tabCounts.pending})`], ["added", `In CRM (${tabCounts.added})`], ["passed", `Passed (${tabCounts.passed})`]]} active={tab} onSelect={setTab} />
        {loadingDb ? <div style={{ textAlign: "center", color: theme.textMuted, padding: 32 }}>Loading...</div> : renderTable(dbResults, tab)}

        {/* Pagination */}
        {!loadingDb && totalCount > 0 && (
          <Pagination
            page={page} pageSize={pageSize} total={totalCount}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        )}
      </Card>
    </div>
  );
}
