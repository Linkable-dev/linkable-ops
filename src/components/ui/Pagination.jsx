import { useTheme } from "../../contexts/ThemeContext";

export function Pagination({ page, pageSize, total, onPageChange, onPageSizeChange }) {
  const { theme } = useTheme();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = Math.min((page - 1) * pageSize + 1, total);
  const to = Math.min(page * pageSize, total);

  const btnStyle = (disabled) => ({
    padding: "6px 12px", borderRadius: 6, border: `1px solid ${theme.border}`,
    background: disabled ? "transparent" : theme.surface, color: disabled ? theme.textMuted : theme.text,
    fontSize: 13, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1, transition: "all 0.1s",
  });

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 0", flexWrap: "wrap", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: theme.textMuted }}>
        <span>Showing {from}-{to} of {total}</span>
        <select value={pageSize} onChange={e => onPageSizeChange(Number(e.target.value))}
          style={{ padding: "4px 28px 4px 8px", borderRadius: 6, border: `1px solid ${theme.border}`, background: theme.bg, fontSize: 12, color: theme.text }}>
          {[25, 50, 100].map(n => <option key={n} value={n}>{n} / page</option>)}
        </select>
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        <button style={btnStyle(page <= 1)} disabled={page <= 1} onClick={() => onPageChange(1)}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 3L6 8l5 5"/><line x1="5" y1="3" x2="5" y2="13"/></svg>
        </button>
        <button style={btnStyle(page <= 1)} disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10 3L5 8l5 5"/></svg>
        </button>
        <span style={{ padding: "6px 12px", fontSize: 13, color: theme.text, fontWeight: 500 }}>
          {page} / {totalPages}
        </span>
        <button style={btnStyle(page >= totalPages)} disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 3l5 5-5 5"/></svg>
        </button>
        <button style={btnStyle(page >= totalPages)} disabled={page >= totalPages} onClick={() => onPageChange(totalPages)}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 3l5 5-5 5"/><line x1="11" y1="3" x2="11" y2="13"/></svg>
        </button>
      </div>
    </div>
  );
}
