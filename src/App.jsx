import { Outlet } from "react-router-dom";
import Sidebar from "./components/layout/Sidebar";
import Header from "./components/layout/Header";
import { useTheme } from "./contexts/ThemeContext";
import { BrandDrawerProvider } from "./contexts/BrandDrawerContext";
import CommandPalette from "./components/CommandPalette";

export default function App() {
  const { theme, sidebarOpen } = useTheme();
  const sidebarW = sidebarOpen ? 240 : 64; // keep in sync with Sidebar W

  return (
    <BrandDrawerProvider>
    <CommandPalette />
    <div style={{
      display: "flex", minHeight: "100vh", background: theme.bg,
      fontFamily: "inherit",
      color: theme.text, transition: "background 0.2s, color 0.2s",
    }}>
      <Sidebar />
      <div style={{ flex: 1, marginLeft: sidebarW, display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden", transition: "margin-left 0.2s ease" }}>
        <Header />
        <main style={{ flex: 1, width: "100%", padding: "24px 32px 64px", overflowY: "auto" }}>
          {/* Pages fill the width and sit centred; the cap only kicks in on very wide monitors. */}
          <div style={{ width: "100%", maxWidth: 1680, margin: "0 auto" }}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
    </BrandDrawerProvider>
  );
}
