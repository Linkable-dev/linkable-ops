import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTheme } from "../contexts/ThemeContext";
import { useDbTarget } from "../contexts/DbTargetContext";
import { api } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Btn } from "../components/ui/Button";
import { Skeleton, SkeletonTable } from "../components/ui/Skeleton";

const EXAMPLES = [
  "How many brands signed up each month this year?",
  "Which campaigns got the most accepted creators in the last 90 days?",
  "Top 10 creators by attributed sales, with their brand",
  "Brands whose trial ends in the next 14 days and have no active campaign",
  "GMV per month by currency for the last 12 months",
  "How many sample requests are still pending, per brand?",
];
const HISTORY_KEY = "lk-ask-history";

export default function AskPage() {
  const { theme } = useTheme();
  const { target } = useDbTarget();
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const [history, setHistory] = useState(() => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch { return []; } });
  const inputRef = useRef(null);
  const [params] = useSearchParams();
  const initialQ = params.get("q") || "";

  useEffect(() => { inputRef.current?.focus(); }, []);

  const run = async (q = question) => {
    const text = q.trim();
    if (text.length < 4 || loading) return;
    setQuestion(text); setLoading(true); setError(null); setResult(null); setShowSql(false);
    try {
      const r = await api.askData(text);
      setResult(r);
      const next = [text, ...history.filter((h) => h !== text)].slice(0, 12);
      setHistory(next);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  // Arriving from the command palette with ?q= runs the question straight away.
  const ranInitial = useRef(false);
  useEffect(() => {
    if (initialQ && !ranInitial.current) { ranInitial.current = true; run(initialQ); }
  }, [initialQ]); // eslint-disable-line react-hooks/exhaustive-deps

  const chip = (text, onClick) => (
    <button key={text} onClick={onClick} style={{ border: `1px solid ${theme.border}`, background: theme.surface, color: theme.textMid, borderRadius: 999, padding: "6px 12px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>{text}</button>
  );

  return (
    <div style={{ maxWidth: 1100 }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: theme.text, margin: 0 }}>Ask the data</h1>
        <p style={{ fontSize: 13, color: theme.textMuted, margin: "4px 0 0" }}>
          Ask a question in plain words. Claude writes one read-only SQL query against the {target === "dev" ? "dev" : "production"} database, runs it in a read-only transaction and shows the rows with the SQL.
        </p>
      </div>

      <Card style={{ marginBottom: 12 }}>
        <textarea
          ref={inputRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run(); }}
          placeholder="e.g. Which brands launched a campaign in the last 30 days but have no accepted creator yet?"
          rows={3}
          style={{ width: "100%", boxSizing: "border-box", resize: "vertical", padding: "12px 14px", borderRadius: 10, border: `1.5px solid ${theme.border}`, background: theme.bg, color: theme.text, fontFamily: "inherit", fontSize: 14, lineHeight: 1.5, outline: "none" }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
          <Btn onClick={() => run()} loading={loading} disabled={question.trim().length < 4}>{loading ? "Thinking…" : "Ask"}</Btn>
          <span style={{ fontSize: 12, color: theme.textMuted }}>⌘/Ctrl + Enter to run · read-only, 200 rows max, 10 s timeout</span>
        </div>
      </Card>

      {!result && !loading && !error && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textMuted, marginBottom: 8 }}>Try one of these</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{EXAMPLES.map((q) => chip(q, () => run(q)))}</div>
          {history.length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textMuted, margin: "16px 0 8px" }}>Recent</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{history.map((q) => chip(q, () => run(q)))}</div>
            </>
          )}
        </div>
      )}

      {error && <Card style={{ borderColor: "#FCA5A5", marginBottom: 12 }}><div style={{ fontSize: 13, color: theme.danger }}>{error}</div></Card>}

      {loading && (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "14px 16px", borderBottom: `1px solid ${theme.border}` }}><Skeleton width="70%" height={14} /></div>
          <SkeletonTable rows={5} columns={[{ label: "" }, { label: "", kind: "num" }, { label: "", kind: "num" }, { label: "" }]} headerBackground="transparent" />
        </Card>
      )}

      {result && (
        <>
          <Card style={{ marginBottom: 12 }}>
            {result.summary && <div style={{ fontSize: 15, color: theme.text, lineHeight: 1.55, marginBottom: 8 }}>{result.summary}</div>}
            <div style={{ fontSize: 12, color: theme.textMid, lineHeight: 1.5 }}>{result.explanation}</div>
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 10, flexWrap: "wrap", fontSize: 12, color: theme.textMuted }}>
              <span>{result.rows.length}{result.truncated ? "+" : ""} row{result.rows.length === 1 ? "" : "s"}</span>
              <span>· {result.model} · ${result.cost_usd.toFixed(4)}</span>
              <button onClick={() => setShowSql((v) => !v)} style={{ background: "none", border: "none", color: theme.textMid, cursor: "pointer", fontFamily: "inherit", fontSize: 12, textDecoration: "underline", padding: 0 }}>{showSql ? "Hide SQL" : "Show SQL"}</button>
              {showSql && <button onClick={() => navigator.clipboard?.writeText(result.sql)} style={{ background: "none", border: "none", color: theme.textMid, cursor: "pointer", fontFamily: "inherit", fontSize: 12, textDecoration: "underline", padding: 0 }}>Copy SQL</button>}
            </div>
            {showSql && (
              <pre style={{ marginTop: 10, marginBottom: 0, padding: 12, borderRadius: 10, background: theme.surfaceAlt, color: theme.text, fontSize: 12, lineHeight: 1.5, overflowX: "auto", whiteSpace: "pre-wrap" }}>{result.sql}</pre>
            )}
          </Card>
          <ResultTable result={result} theme={theme} />
        </>
      )}
    </div>
  );
}

function fmt(v) {
  if (v === null || v === undefined) return <span style={{ opacity: 0.5 }}>null</span>;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") return JSON.stringify(v);
  // Dates: date-only values (midnight UTC) show as a date, real timestamps with the time.
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?Z$/.test(v)) return new Date(v).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(v + "T00:00:00Z").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return new Date(v).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) { const n = Number(v); return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 }); }
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return String(v);
}
const isNumeric = (v) => typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v));

function ResultTable({ result, theme }) {
  const { columns, rows, chart } = result;
  if (!rows.length) return <Card><div style={{ fontSize: 13, color: theme.textMuted }}>The query returned no rows.</div></Card>;
  const numericCols = columns.filter((c) => rows.every((r) => r[c] == null || isNumeric(r[c])));
  const labelCol = columns.find((c) => !numericCols.includes(c));
  const valueCol = numericCols.find((c) => c !== labelCol);
  const showChart = chart !== "none" && labelCol && valueCol && rows.length >= 2 && rows.length <= 60;
  const max = showChart ? Math.max(...rows.map((r) => Math.abs(Number(r[valueCol]) || 0)), 1) : 1;
  return (
    <>
      {showChart && (
        <Card style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textMuted, marginBottom: 10 }}>{valueCol} by {labelCol}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {rows.map((r, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
                <div style={{ width: 160, color: theme.textMid, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={String(r[labelCol])}>{fmt(r[labelCol])}</div>
                <div style={{ flex: 1, height: 10, background: theme.surfaceAlt, borderRadius: 6, overflow: "hidden" }}>
                  <div style={{ width: `${(Math.abs(Number(r[valueCol]) || 0) / max) * 100}%`, height: "100%", background: theme.brand, borderRadius: 6 }} />
                </div>
                <div style={{ width: 90, textAlign: "right", color: theme.text, fontVariantNumeric: "tabular-nums" }}>{fmt(r[valueCol])}</div>
              </div>
            ))}
          </div>
        </Card>
      )}
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto", maxHeight: 560 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: theme.surfaceAlt, position: "sticky", top: 0 }}>
                {columns.map((c) => <th key={c} style={{ textAlign: numericCols.includes(c) ? "right" : "left", padding: "10px 14px", fontSize: 11, fontWeight: 600, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "nowrap", borderBottom: `1px solid ${theme.border}` }}>{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${theme.border}` }}>
                  {columns.map((c) => <td key={c} style={{ padding: "9px 14px", color: theme.text, textAlign: numericCols.includes(c) ? "right" : "left", whiteSpace: "nowrap", maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", fontVariantNumeric: "tabular-nums" }} title={typeof r[c] === "string" ? r[c] : undefined}>{fmt(r[c])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
