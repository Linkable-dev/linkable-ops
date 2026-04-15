import { useState } from "react";
import { useParams } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useTheme } from "../contexts/ThemeContext";
import logoDark from "../assets/logo-dark.svg";
import logoWhite from "../assets/logo-white.svg";

export default function InvitePage() {
  const { inviteToken } = useParams();
  const { acceptInvite } = useAuth();
  const { theme, mode } = useTheme();
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const logo = mode === "dark" ? logoWhite : logoDark;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try { await acceptInvite(inviteToken, password); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  const inputStyle = {
    width: "100%", boxSizing: "border-box", background: theme.bg,
    border: `1.5px solid ${theme.border}`, borderRadius: 8, color: theme.text,
    fontFamily: "inherit", fontSize: 14, padding: "11px 14px", outline: "none",
  };

  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh",
      background: theme.bg, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
      color: theme.text,
    }}>
      <div style={{ width: "100%", maxWidth: 380, padding: 24 }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 8 }}>
            <img src={logo} alt="Linkable" style={{ height: 18 }} />
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: theme.textMuted, background: theme.accentLight, padding: "2px 6px", borderRadius: 4 }}>OPS</span>
          </div>
          <p style={{ fontSize: 13, color: theme.textMuted, margin: 0, marginTop: 8 }}>
            You've been invited. Choose a password to join.
          </p>
        </div>

        {error && (
          <div style={{
            padding: "10px 14px", borderRadius: 8, marginBottom: 16,
            background: mode === "dark" ? "#3B1111" : "#FEF2F2",
            border: `1px solid ${mode === "dark" ? "#5C1D1D" : "#FECACA"}`,
            fontSize: 13, color: "#EF4444",
          }}>{error}</div>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{
            background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 10,
            padding: 24, boxShadow: theme.shadowMd,
          }}>
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: theme.textMid, display: "block", marginBottom: 6 }}>Choose a Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" required minLength={6} style={inputStyle} />
            </div>
            <button type="submit" disabled={loading} style={{
              width: "100%", padding: "11px 0", borderRadius: 8, border: "none",
              background: theme.accent, color: mode === "dark" ? "#0A0A0A" : "#fff",
              fontSize: 14, fontWeight: 600, cursor: loading ? "not-allowed" : "pointer",
              fontFamily: "inherit", opacity: loading ? 0.7 : 1,
            }}>
              {loading ? "..." : "Join & Sign In"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
