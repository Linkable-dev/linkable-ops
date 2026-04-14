import { createContext, useContext, useState, useEffect } from "react";

const ThemeContext = createContext(null);

const LIGHT = {
  mode: "light",
  bg: "#FAFAFA",
  surface: "#FFFFFF",
  surfaceAlt: "#F5F5F5",
  border: "#E5E5E5",
  text: "#0A0A0A",
  textMid: "#525252",
  textMuted: "#A3A3A3",
  accent: "#0A0A0A",
  accentLight: "#F5F5F5",
  shadow: "0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.03)",
  shadowMd: "0 4px 12px rgba(0,0,0,0.06)",
  sidebarBg: "#FFFFFF",
  sidebarBorder: "#E5E5E5",
};

const DARK = {
  mode: "dark",
  bg: "#0A0A0A",
  surface: "#171717",
  surfaceAlt: "#262626",
  border: "#333333",
  text: "#FAFAFA",
  textMid: "#A3A3A3",
  textMuted: "#737373",
  accent: "#FAFAFA",
  accentLight: "#262626",
  shadow: "0 1px 3px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2)",
  shadowMd: "0 4px 12px rgba(0,0,0,0.4)",
  sidebarBg: "#171717",
  sidebarBorder: "#333333",
};

export function ThemeProvider({ children }) {
  const [mode, setMode] = useState(() => {
    const saved = localStorage.getItem("linkable-theme");
    if (saved) return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    const saved = localStorage.getItem("linkable-sidebar");
    return saved !== "collapsed";
  });

  const theme = mode === "dark" ? DARK : LIGHT;

  const toggleTheme = () => {
    const next = mode === "dark" ? "light" : "dark";
    setMode(next);
    localStorage.setItem("linkable-theme", next);
  };

  const toggleSidebar = () => {
    const next = !sidebarOpen;
    setSidebarOpen(next);
    localStorage.setItem("linkable-sidebar", next ? "open" : "collapsed");
  };

  useEffect(() => {
    document.documentElement.style.colorScheme = mode;
    document.body.style.background = theme.bg;
    document.body.style.color = theme.text;
  }, [mode, theme]);

  return (
    <ThemeContext.Provider value={{ theme, mode, toggleTheme, sidebarOpen, toggleSidebar }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
