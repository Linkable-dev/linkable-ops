import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../contexts/AuthContext";
import { useTheme } from "../../contexts/ThemeContext";
import logo from "../../assets/logo-dark.svg";

export default function AcceptInvitePage() {
  const { theme } = useTheme();
  const { token } = useParams();
  const navigate = useNavigate();
  const { signUp } = useAuth();

  const [invitation, setInvitation] = useState(null);
  const [validating, setValidating] = useState(true);
  const [tokenError, setTokenError] = useState("");

  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    async function validate() {
      const { data, error: fetchErr } = await supabase
        .from("team_invitations")
        .select("*")
        .eq("token", token)
        .is("accepted_at", null)
        .gt("expires_at", new Date().toISOString())
        .single();

      if (fetchErr || !data) {
        setTokenError(
          "This invitation is invalid or has expired. Please ask your team admin for a new invite."
        );
      } else {
        setInvitation(data);
      }
      setValidating(false);
    }
    validate();
  }, [token]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await signUp(invitation.email, password, fullName);
      navigate("/");
    } catch (err) {
      setError(err.message || "Sign-up failed");
    } finally {
      setSubmitting(false);
    }
  }

  const styles = {
    wrapper: {
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: theme.bg,
      padding: 24,
    },
    card: {
      width: "100%",
      maxWidth: 420,
      background: theme.surface,
      borderRadius: 10,
      boxShadow: theme.shadowMd,
      padding: 40,
    },
    logo: {
      display: "block",
      margin: "0 auto 24px",
      height: 36,
    },
    title: {
      margin: 0,
      fontSize: 22,
      fontWeight: 700,
      color: theme.text,
      textAlign: "center",
    },
    subtitle: {
      margin: "6px 0 28px",
      fontSize: 14,
      color: theme.textMuted,
      textAlign: "center",
    },
    label: {
      display: "block",
      fontSize: 13,
      fontWeight: 600,
      color: theme.textMid,
      marginBottom: 4,
    },
    input: {
      width: "100%",
      padding: "10px 12px",
      fontSize: 14,
      border: `1px solid ${theme.border}`,
      borderRadius: 10,
      outline: "none",
      boxSizing: "border-box",
      marginBottom: 16,
    },
    inputReadonly: {
      width: "100%",
      padding: "10px 12px",
      fontSize: 14,
      border: `1px solid ${theme.border}`,
      borderRadius: 10,
      outline: "none",
      boxSizing: "border-box",
      marginBottom: 16,
      background: theme.surfaceAlt,
      color: theme.textMid,
    },
    primaryBtn: {
      width: "100%",
      padding: "10px 0",
      fontSize: 14,
      fontWeight: 600,
      color: theme.bg,
      background: theme.accent,
      border: "none",
      borderRadius: 10,
      cursor: "pointer",
    },
    error: {
      background: "#FEE2E2",
      color: "#B91C1C",
      fontSize: 13,
      padding: "10px 12px",
      borderRadius: 10,
      marginBottom: 16,
    },
    spinner: {
      textAlign: "center",
      color: theme.textMuted,
      fontSize: 14,
      padding: "60px 0",
    },
  };

  if (validating) {
    return (
      <div style={styles.wrapper}>
        <div style={styles.card}>
          <div style={styles.spinner}>Validating invitation...</div>
        </div>
      </div>
    );
  }

  if (tokenError) {
    return (
      <div style={styles.wrapper}>
        <div style={styles.card}>
          <img src={logo} alt="Linkable" style={styles.logo} />
          <h1 style={styles.title}>Invalid Invitation</h1>
          <p
            style={{
              ...styles.subtitle,
              marginBottom: 0,
              color: "#B91C1C",
            }}
          >
            {tokenError}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.wrapper}>
      <div style={styles.card}>
        <img src={logo} alt="Linkable" style={styles.logo} />
        <h1 style={styles.title}>Join Your Team</h1>
        <p style={styles.subtitle}>Complete your account to get started</p>

        {error && <div style={styles.error}>{error}</div>}

        <form onSubmit={handleSubmit}>
          <label style={styles.label}>Email</label>
          <input
            type="email"
            value={invitation.email}
            readOnly
            style={styles.inputReadonly}
          />

          <label style={styles.label}>Full Name</label>
          <input
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            style={styles.input}
            placeholder="Your full name"
          />

          <label style={styles.label}>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            style={styles.input}
            placeholder="Create a password"
          />

          <button type="submit" disabled={submitting} style={styles.primaryBtn}>
            {submitting ? "Creating account..." : "Join Team"}
          </button>
        </form>
      </div>
    </div>
  );
}
