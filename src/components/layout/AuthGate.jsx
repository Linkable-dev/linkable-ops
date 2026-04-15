import { Outlet } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { useTheme } from "../../contexts/ThemeContext";
import LoginPage from "../../pages/LoginPage";

export default function AuthGate() {
  const { admin, loading, accessDenied } = useAuth();
  const { theme } = useTheme();

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: theme.bg }}>
      <div style={{ width: 24, height: 24, border: `2.5px solid ${theme.border}`, borderTopColor: theme.text, borderRadius: "50%", animation: "spin 0.6s linear infinite" }} />
    </div>
  );

  if (accessDenied) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: theme.bg, color: theme.text, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}>
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

  if (!admin) return <LoginPage />;

  return <Outlet />;
}
