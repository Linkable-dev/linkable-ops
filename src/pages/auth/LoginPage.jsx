import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { useTheme } from "../../contexts/ThemeContext";
import logoDark from "../../assets/logo-dark.svg";
import logoWhite from "../../assets/logo-white.svg";

export default function LoginPage() {
  const { user, signIn, signInWithGoogle } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (user) navigate("/", { replace: true });
  }, [user, navigate]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await signIn(email, password);
      navigate("/");
    } catch (err) {
      setError(err.message || "Sign-in failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleGoogle() {
    setError("");
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(err.message || "Google sign-in failed");
    }
  }

  const { theme, mode } = useTheme();
  const logo = mode === "dark" ? logoWhite : logoDark;

  const styles = {
    wrapper: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: theme.bg, padding: 24, transition: "background 0.2s" },
    card: { width: "100%", maxWidth: 420, background: theme.surface, borderRadius: 10, boxShadow: theme.shadowMd, padding: 40 },
    logo: { display: "block", margin: "0 auto 24px", height: 20 },
    title: { margin: 0, fontSize: 22, fontWeight: 700, color: theme.text, textAlign: "center" },
    subtitle: { margin: "6px 0 28px", fontSize: 14, color: theme.textMuted, textAlign: "center" },
    label: { display: "block", fontSize: 13, fontWeight: 600, color: theme.textMid, marginBottom: 4 },
    input: { width: "100%", padding: "10px 12px", fontSize: 14, border: `1px solid ${theme.border}`, borderRadius: 10, outline: "none", boxSizing: "border-box", marginBottom: 16, background: theme.surface, color: theme.text },
    primaryBtn: { width: "100%", padding: "10px 0", fontSize: 14, fontWeight: 600, color: theme.bg, background: theme.accent, border: "none", borderRadius: 10, cursor: "pointer" },
    divider: { display: "flex", alignItems: "center", margin: "20px 0", gap: 12 },
    dividerLine: { flex: 1, height: 1, background: theme.border },
    dividerText: { fontSize: 12, color: theme.textMuted },
    googleBtn: { width: "100%", padding: "10px 0", fontSize: 14, fontWeight: 600, color: theme.text, background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 },
    googleIcon: { fontWeight: 700, fontSize: 16, color: "#4285F4" },
    error: { background: "#FEE2E2", color: "#B91C1C", fontSize: 13, padding: "10px 12px", borderRadius: 10, marginBottom: 16 },
    footer: { marginTop: 24, fontSize: 13, color: theme.textMuted, textAlign: "center" },
    link: { color: theme.accent, textDecoration: "none", fontWeight: 600 },
  };

  if (user) return null;

  return (
    <div style={styles.wrapper}>
      <div style={styles.card}>
        <img src={logo} alt="Linkable" style={styles.logo} />
        <h1 style={styles.title}>Linkable Ops</h1>
        <p style={styles.subtitle}>Sign in to your workspace</p>

        {error && <div style={styles.error}>{error}</div>}

        <form onSubmit={handleSubmit}>
          <label style={styles.label}>Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={styles.input}
            placeholder="you@company.com"
          />

          <label style={styles.label}>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={styles.input}
            placeholder="Enter your password"
          />

          <button type="submit" disabled={submitting} style={styles.primaryBtn}>
            {submitting ? "Signing in..." : "Sign In"}
          </button>
        </form>

        <div style={styles.divider}>
          <div style={styles.dividerLine} />
          <span style={styles.dividerText}>or</span>
          <div style={styles.dividerLine} />
        </div>

        <button onClick={handleGoogle} style={styles.googleBtn}>
          <span style={styles.googleIcon}>G</span>
          Sign in with Google
        </button>

        <p style={styles.footer}>
          Have an invite?{" "}
          <Link to="/invite/initial-setup-token" style={styles.link}>
            Accept invitation
          </Link>
        </p>
      </div>
    </div>
  );
}
