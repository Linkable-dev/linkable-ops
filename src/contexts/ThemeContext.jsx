import { createContext, useContext, useState, useEffect } from "react";

const ThemeContext = createContext(null);

// Palette taken from linkable.link: near-black ink, cool greys, soft borders,
// the green status dot, pill controls and layered shadows.
const LIGHT = {
  mode: "light",
  bg: "#F8FAFC",
  surface: "#FFFFFF",
  surfaceAlt: "#F1F3F6",
  border: "#E5EAF0",
  text: "#121419",
  textMid: "#50576B",
  textMuted: "#838B9E",
  accent: "#232323",
  accentLight: "#F1F2F4",
  brand: "#3CBA8C",
  danger: "#DC2626",
  radius: 14,
  radiusSm: 10,
  shadow: "0 1px 2px rgba(18,20,25,0.04), 0 2px 6px -1px rgba(18,20,25,0.04)",
  shadowMd: "0 0.5px 2px rgba(0,0,0,0.11), 0 2.3px 6px -0.8px rgba(0,0,0,0.02), 0 10px 26px -1.25px rgba(0,0,0,0.04)",
  sidebarBg: "#FFFFFF",
  sidebarBorder: "#E5EAF0",
};

const DARK = {
  mode: "dark",
  bg: "#0F1115",
  surface: "#171A1F",
  surfaceAlt: "#20242B",
  border: "#2A2F38",
  text: "#F5F7FA",
  textMid: "#A9B0BF",
  textMuted: "#6F778A",
  accent: "#F5F7FA",
  accentLight: "#20242B",
  brand: "#3CBA8C",
  danger: "#F87171",
  radius: 14,
  radiusSm: 10,
  shadow: "0 1px 3px rgba(0,0,0,0.35), 0 1px 2px rgba(0,0,0,0.25)",
  shadowMd: "0 8px 24px rgba(0,0,0,0.45)",
  sidebarBg: "#171A1F",
  sidebarBorder: "#2A2F38",
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
    const root = document.documentElement.style;
    root.setProperty("--lk-focus", theme.accent);
    root.setProperty("--lk-focus-ring", mode === "dark" ? "rgba(245,247,250,0.16)" : "rgba(35,35,35,0.12)");
    root.setProperty("--lk-scrollbar", mode === "dark" ? "#3A404B" : "#D9DFE8");
    root.setProperty("--lk-hover", mode === "dark" ? "rgba(255,255,255,0.05)" : "rgba(35,35,35,0.04)");
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
