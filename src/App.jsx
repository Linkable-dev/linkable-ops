import { Outlet } from "react-router-dom";
import Sidebar from "./components/layout/Sidebar";
import Header from "./components/layout/Header";
import { useTheme } from "./contexts/ThemeContext";

export default function App() {
  const { theme, sidebarOpen } = useTheme();
  const sidebarW = sidebarOpen ? 240 : 68;

  return (
    <div style={{
      display: "flex", minHeight: "100vh", background: theme.bg,
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
      color: theme.text, transition: "background 0.2s, color 0.2s",
    }}>
      <Sidebar />
      <div style={{ flex: 1, marginLeft: sidebarW, display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden", transition: "margin-left 0.2s ease" }}>
        <Header />
        <main style={{ flex: 1, width: "100%", padding: "24px 32px 64px", overflowY: "auto" }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
