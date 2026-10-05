import { useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useTheme } from "../../contexts/ThemeContext";
import { PITCH_TABS } from "./pitchLabels";

// The Pitch section: its tab strip over whichever tab is open. The strip
// lives in the route, as GTM's does, so a tab added later cannot forget it.
export function PitchSection() {
  const { theme: t } = useTheme();
  const { pathname } = useLocation();
  return (
    <div>
      <div style={{ display: "flex", gap: 2, borderBottom: `1px solid ${t.border}`, marginBottom: 20 }}>
        {PITCH_TABS.map((tab) => {
          const active = tab.match(pathname);
          return (
            <Link key={tab.to} to={tab.to} style={{
              padding: "10px 14px", fontSize: 13, textDecoration: "none",
              color: active ? t.text : t.textMuted, fontWeight: active ? 600 : 400,
              borderBottom: `2px solid ${active ? t.text : "transparent"}`, marginBottom: -1,
            }}>
              {tab.label}
            </Link>
          );
        })}
      </div>
      <Outlet />
    </div>
  );
}

// A brand's logo on white (logos are drawn for white), or its initial.
export function Logo({ src, name, size = 32 }) {
  const { theme: t } = useTheme();
  const [broken, setBroken] = useState(false);
  const box = { width: size, height: size, borderRadius: size / 2, border: `1px solid ${t.border}`, background: "#fff", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", fontSize: 11, fontWeight: 600, color: "#50576B" };
  if (!src || broken) return <div style={box}>{(name || "?").trim().charAt(0).toUpperCase()}</div>;
  return <div style={box}><img src={src} alt="" onError={() => setBroken(true)} style={{ width: "100%", height: "100%", objectFit: "contain", padding: 3, boxSizing: "border-box" }} /></div>;
}

// A creator's picture, filling the circle, or their initial.
export function Avatar({ src, name, size = 32 }) {
  const { theme: t } = useTheme();
  const [broken, setBroken] = useState(false);
  const box = { width: size, height: size, borderRadius: size / 2, background: t.surfaceAlt, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", fontSize: 12, fontWeight: 600, color: t.textMid };
  if (!src || broken) return <div style={box}>{(name || "?").trim().charAt(0).toUpperCase()}</div>;
  return <div style={box}><img src={src} alt="" onError={() => setBroken(true)} style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>;
}

// Picture, a bold first line and a muted second, truncating together.
export function Who({ picture, title, sub, subHref }) {
  const { theme: t } = useTheme();
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
      {picture}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
        {sub && (subHref
          ? <a href={subHref} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} style={{ fontSize: 12, color: t.textMuted, textDecoration: "none", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</a>
          : <div style={{ fontSize: 12, color: t.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</div>)}
      </div>
    </div>
  );
}

// One number with its name and, under it, what it is out of.
export function StatTile({ label, value, sub, strong }) {
  const { theme: t } = useTheme();
  return (
    <div style={{
      background: strong ? t.surfaceAlt : t.surface, border: `1px solid ${t.border}`, borderRadius: t.radiusSm,
      padding: "14px 16px", minWidth: 0,
    }}>
      <div style={{ fontSize: 12, color: t.textMuted, fontWeight: 500, marginBottom: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: t.text, lineHeight: 1.1, letterSpacing: -0.4 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: t.textMuted, marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

// An error or a notice above a list, with a way to dismiss it.
export function Banner({ tone = "notice", children, onDismiss }) {
  const { theme: t } = useTheme();
  const colors = tone === "error"
    ? { background: t.mode === "dark" ? "#3B1515" : "#FEF2F2", color: t.danger }
    : tone === "warning"
      ? { background: t.mode === "dark" ? "#3A2A0F" : "#FFFBEB", color: t.warning }
      : { background: t.surfaceAlt, color: t.textMid };
  return (
    <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 8, fontSize: 13, display: "flex", justifyContent: "space-between", gap: 12, ...colors }}>
      <span>{children}</span>
      {onDismiss && <button onClick={onDismiss} style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer", fontFamily: "inherit", fontSize: 12, padding: 0 }}>Dismiss</button>}
    </div>
  );
}
