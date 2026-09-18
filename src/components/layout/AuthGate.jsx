import { Outlet } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { useTheme } from "../../contexts/ThemeContext";
import LoginPage from "../../pages/LoginPage";
import { FullPageLoader } from "../ui/BrandLoader";

export default function AuthGate() {
  const { admin, loading, accessDenied, authError, retryAuth } = useAuth();
  const { theme } = useTheme();

  if (loading) return <FullPageLoader />;

  if (accessDenied) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: theme.bg, color: theme.text, fontFamily: "inherit" }}>
      <div style={{ textAlign: "center", maxWidth: 360 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Access Denied</div>
        <p style={{ color: theme.textMuted, fontSize: 13, margin: 0, marginBottom: 16 }}>Your account doesn't have access to this admin panel. Ask an existing admin to invite you.</p>
        <button onClick={() => window.location.reload()} style={{
          padding: "8px 16px", borderRadius: 8, border: `1px solid ${theme.border}`,
          background: "transparent", color: theme.text, fontSize: 13, cursor: "pointer", fontFamily: "inherit",
        }}>Try Again</button>
      </div>
    </div>
  );

  // Distinct from Access Denied: the sign-in itself is fine, but checking
  // whether that account is an admin failed on the server (a 500, a
  // timeout) rather than answering no. Falling through to the login screen
  // here — the old behavior — told a signed-in person to log in again,
  // which is not what happened and not something logging in again fixes.
  if (authError) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: theme.bg, color: theme.text, fontFamily: "inherit" }}>
      <div style={{ textAlign: "center", maxWidth: 420 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Couldn't check your access</div>
        <p style={{ color: theme.textMuted, fontSize: 13, margin: 0, marginBottom: 10 }}>
          You're signed in, but the server hit a problem confirming admin access — this isn't your
          password or account.
        </p>
        <p style={{ color: theme.textMuted, fontSize: 12, fontFamily: "monospace", margin: 0, marginBottom: 16, wordBreak: "break-word" }}>
          {authError}
        </p>
        <button onClick={retryAuth} style={{
          padding: "8px 16px", borderRadius: 8, border: `1px solid ${theme.border}`,
          background: "transparent", color: theme.text, fontSize: 13, cursor: "pointer", fontFamily: "inherit",
        }}>Try Again</button>
      </div>
    </div>
  );

  if (!admin) return <LoginPage />;

  return <Outlet />;
}
