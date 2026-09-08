import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider } from "./contexts/ThemeContext";
import { AuthProvider } from "./contexts/AuthContext";
import { DbTargetProvider } from "./contexts/DbTargetContext";
import AuthGate from "./components/layout/AuthGate";
import App from "./App";
import HomePage from "./pages/HomePage";
import DashboardPage from "./pages/DashboardPage";
import CampaignsOpsPage from "./pages/CampaignsOpsPage";
import TablePage from "./pages/TablePage";
import TableAnalyticsPage from "./pages/TableAnalyticsPage";
import TeamPage from "./pages/TeamPage";
import SetupPasswordPage from "./pages/SetupPasswordPage";
import AcceptInvitePage from "./pages/AcceptInvitePage";
import AiTestLabPage from "./pages/AiTestLabPage";
import AiInboxPage from "./pages/AiInboxPage";
import AiCampaignsPage from "./pages/AiCampaignsPage";
import AiCampaignDetailPage from "./pages/AiCampaignDetailPage";
import UsersPage from "./pages/UsersPage";
import TrialsPage from "./pages/TrialsPage";
import BlogPage from "./pages/blog/BlogPage";
import BlogEditorPage from "./pages/blog/BlogEditorPage";
import AlertsPage from "./pages/AlertsPage";
import AskPage from "./pages/AskPage";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <DbTargetProvider>
          <AuthProvider>
            <Routes>
            <Route path="/setup-password" element={<SetupPasswordPage />} />
            <Route path="/accept-invite" element={<AcceptInvitePage />} />
            <Route element={<AuthGate />}>
              <Route element={<App />}>
                <Route path="/" element={<HomePage />} />
                <Route path="/alerts" element={<AlertsPage />} />
                <Route path="/ask" element={<AskPage />} />
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/ops/campaigns" element={<CampaignsOpsPage />} />
                <Route path="/ai/test-lab" element={<AiTestLabPage />} />
                <Route path="/ai/inbox" element={<AiInboxPage />} />
                <Route path="/ai/campaigns" element={<AiCampaignsPage />} />
                <Route path="/ai/campaigns/:id" element={<AiCampaignDetailPage />} />
                <Route path="/users" element={<UsersPage />} />
                <Route path="/trials" element={<TrialsPage />} />
                <Route path="/tables/:table" element={<TablePage />} />
                <Route path="/tables/:table/analytics" element={<TableAnalyticsPage />} />
                <Route path="/team" element={<TeamPage />} />
                <Route path="/blog" element={<BlogPage />} />
                <Route path="/blog/new" element={<BlogEditorPage />} />
                <Route path="/blog/:id" element={<BlogEditorPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Route>
            </Routes>
          </AuthProvider>
        </DbTargetProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>
);
