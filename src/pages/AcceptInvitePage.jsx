import { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useTheme } from "../contexts/ThemeContext";
import { supabase } from "../lib/supabase";
import logoDark from "../assets/logo-dark.svg";
import logoWhite from "../assets/logo-white.svg";

export default function AcceptInvitePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { theme, mode } = useTheme();
  const token = searchParams.get("token");

  const [checking, setChecking] = useState(true);
  const [invite, setInvite] = useState(null);
  const [tokenError, setTokenError] = useState(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const logo = mode === "dark" ? logoWhite : logoDark;

  // Validate token on mount
  useEffect(() => {
    if (!token) { setTokenError("Missing invite token"); setChecking(false); return; }
    fetch(`/api/auth/invite/${token}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || "Invalid invite");
        setInvite(data);
      })
      .catch((err) => setTokenError(err.message))
      .finally(() => setChecking(false));
  }, [token]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (password.length < 6) { setError("Password must be at least 6 characters"); return; }
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/accept-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // Sign in with the new credentials
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: invite.email,
        password,
      });
      if (signInError) throw signInError;
      navigate("/");
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  const inputStyle = {
    width: "100%", boxSizing: "border-box", background: theme.bg,
    border: `1.5px solid ${theme.border}`, borderRadius: 8, color: theme.text,
    fontFamily: "inherit", fontSize: 14, padding: "11px 14px",
    outline: "none", transition: "border-color 0.2s",
  };

  if (checking) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: theme.bg }}>
      <div style={{ width: 24, height: 24, border: `2.5px solid ${theme.border}`, borderTopColor: theme.text, borderRadius: "50%", animation: "spin 0.6s linear infinite" }} />
    </div>
  );

  if (tokenError) return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh",
      background: theme.bg, color: theme.text, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    }}>
      <div style={{ textAlign: "center", maxWidth: 360, padding: 24 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Invalid or Expired Invite</div>
        <p style={{ color: theme.textMuted, fontSize: 13, margin: 0, marginBottom: 16 }}>{tokenError}. Ask an admin to send you a new invite.</p>
        <button onClick={() => navigate("/")} style={{
          padding: "8px 20px", borderRadius: 8, border: `1px solid ${theme.border}`,
          background: "transparent", color: theme.text, fontSize: 13, cursor: "pointer", fontFamily: "inherit",
        }}>Go to Sign In</button>
      </div>
    </div>
  );

  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh",
      background: theme.bg, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
      color: theme.text,
    }}>
      <div style={{ width: "100%", maxWidth: 380, padding: 24 }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 8 }}>
            <img src={logo} alt="Linkable" style={{ height: 18 }} />
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: theme.textMuted, background: theme.accentLight, padding: "2px 6px", borderRadius: 4 }}>OPS</span>
          </div>
          <p style={{ fontSize: 14, fontWeight: 600, color: theme.text, margin: "12px 0 4px" }}>
            Welcome{invite?.name ? `, ${invite.name}` : ""}!
          </p>
          <p style={{ fontSize: 13, color: theme.textMuted, margin: 0 }}>
            Set a password to access <strong>{invite?.email}</strong>
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
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" required minLength={6} autoFocus style={inputStyle} />
            </div>
            <button type="submit" disabled={loading} style={{
              width: "100%", padding: "11px 0", borderRadius: 8, border: "none",
              background: theme.accent, color: mode === "dark" ? "#0A0A0A" : "#fff",
              fontSize: 14, fontWeight: 600, cursor: loading ? "not-allowed" : "pointer",
              fontFamily: "inherit", opacity: loading ? 0.7 : 1,
            }}>
              {loading ? "Setting up..." : "Set Password & Enter"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
