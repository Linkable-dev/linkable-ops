import { useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useTheme } from "../contexts/ThemeContext";
import { supabase } from "../lib/supabase";
import logoDark from "../assets/logo-dark.svg";
import logoWhite from "../assets/logo-white.svg";

export default function LoginPage() {
  const { login } = useAuth();
  const { theme, mode } = useTheme();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [loading, setLoading] = useState(false);
  const [forgotMode, setForgotMode] = useState(false);

  const logo = mode === "dark" ? logoWhite : logoDark;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setLoading(true);
    try { await login(email, password); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  const handleForgot = async (e) => {
    e.preventDefault();
    if (!email) { setError("Enter your email first"); return; }
    setError(null);
    setLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/setup-password`,
      });
      if (error) throw error;
      setSuccess("Password reset link sent! Check your email.");
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  const inputStyle = {
    width: "100%", boxSizing: "border-box", background: theme.bg,
    border: `1.5px solid ${theme.border}`, borderRadius: 8, color: theme.text,
    fontFamily: "inherit", fontSize: 14, padding: "11px 14px",
    outline: "none", transition: "border-color 0.2s",
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
            {forgotMode ? "Reset your password" : "Sign in to your admin panel"}
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

        {success && (
          <div style={{
            padding: "10px 14px", borderRadius: 8, marginBottom: 16,
            background: mode === "dark" ? "#052e16" : "#F0FDF4",
            border: `1px solid ${mode === "dark" ? "#14532d" : "#BBF7D0"}`,
            fontSize: 13, color: "#22C55E",
          }}>{success}</div>
        )}

        <form onSubmit={forgotMode ? handleForgot : handleSubmit}>
          <div style={{
            background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 10,
            padding: 24, boxShadow: theme.shadowMd,
          }}>
            <div style={{ marginBottom: forgotMode ? 20 : 16 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: theme.textMid, display: "block", marginBottom: 6 }}>Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required style={inputStyle} />
            </div>
            {!forgotMode && (
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: theme.textMid, display: "block", marginBottom: 6 }}>Password</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password" required style={inputStyle} />
              </div>
            )}
            {!forgotMode && (
              <div style={{ textAlign: "right", marginBottom: 16 }}>
                <button type="button" onClick={() => { setForgotMode(true); setError(null); setSuccess(null); }} style={{
                  background: "none", border: "none", color: theme.textMuted, fontSize: 12,
                  cursor: "pointer", fontFamily: "inherit", textDecoration: "underline",
                }}>Forgot password?</button>
              </div>
            )}
            <button type="submit" disabled={loading} style={{
              width: "100%", padding: "11px 0", borderRadius: 8, border: "none",
              background: theme.accent, color: mode === "dark" ? "#0A0A0A" : "#fff",
              fontSize: 14, fontWeight: 600, cursor: loading ? "not-allowed" : "pointer",
              fontFamily: "inherit", opacity: loading ? 0.7 : 1,
            }}>
              {loading ? "..." : forgotMode ? "Send Reset Link" : "Sign In"}
            </button>
            {forgotMode && (
              <button type="button" onClick={() => { setForgotMode(false); setError(null); setSuccess(null); }} style={{
                width: "100%", padding: "9px 0", marginTop: 8, borderRadius: 8, border: `1px solid ${theme.border}`,
                background: "transparent", color: theme.textMid,
                fontSize: 13, cursor: "pointer", fontFamily: "inherit",
              }}>Back to Sign In</button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
