import { useEffect } from "react";
import { useTheme } from "../../contexts/ThemeContext";

export function Modal({ open, onClose, title, width = 520, children }) {
  const { theme } = useTheme();

  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  if (!open) return null;

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: "rgba(0,0,0,0.4)", backdropFilter: "blur(2px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 24,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: theme.surface, borderRadius: 12, width: "100%", maxWidth: width,
        maxHeight: "85vh", overflow: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
        border: `1px solid ${theme.border}`,
      }}>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "16px 20px", borderBottom: `1px solid ${theme.border}`,
          position: "sticky", top: 0, background: theme.surface, zIndex: 1, borderRadius: "12px 12px 0 0",
        }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: theme.text }}>{title}</div>
          <button onClick={onClose} style={{
            background: "none", border: "none", cursor: "pointer", color: theme.textMuted,
            fontSize: 20, lineHeight: 1, padding: "0 4px", display: "flex",
          }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
          </button>
        </div>
        <div style={{ padding: 20 }}>
          {children}
        </div>
      </div>
    </div>
  );
}
