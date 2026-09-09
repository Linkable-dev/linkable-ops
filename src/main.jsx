import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider } from "./contexts/ThemeContext";
import { AuthProvider } from "./contexts/AuthContext";
import { DbTargetProvider } from "./contexts/DbTargetContext";
import AuthGate from "./components/layout/AuthGate";
import App from "./App";
import { BrandLoader } from "./components/ui/BrandLoader";
import "./index.css";

// Every page is code split: the login screen no longer pays for the charting
// library or the long campaign and table pages. Chunks are fetched on first
// visit and cached by the browser after that.
const HomePage = lazy(() => import("./pages/HomePage"));
const AlertsPage = lazy(() => import("./pages/AlertsPage"));
const AskPage = lazy(() => import("./pages/AskPage"));
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const CampaignsOpsPage = lazy(() => import("./pages/CampaignsOpsPage"));
const TablePage = lazy(() => import("./pages/TablePage"));
const TableAnalyticsPage = lazy(() => import("./pages/TableAnalyticsPage"));
const TeamPage = lazy(() => import("./pages/TeamPage"));
const SetupPasswordPage = lazy(() => import("./pages/SetupPasswordPage"));
const AcceptInvitePage = lazy(() => import("./pages/AcceptInvitePage"));
const AiTestLabPage = lazy(() => import("./pages/AiTestLabPage"));
const AiInboxPage = lazy(() => import("./pages/AiInboxPage"));
const AiCampaignsPage = lazy(() => import("./pages/AiCampaignsPage"));
const AiCampaignDetailPage = lazy(() => import("./pages/AiCampaignDetailPage"));
const UsersPage = lazy(() => import("./pages/UsersPage"));
const TrialsPage = lazy(() => import("./pages/TrialsPage"));
const HealthPage = lazy(() => import("./pages/HealthPage"));
const BlogPage = lazy(() => import("./pages/blog/BlogPage"));
const BlogEditorPage = lazy(() => import("./pages/blog/BlogEditorPage"));

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <DbTargetProvider>
          <AuthProvider>
            <Suspense fallback={<div style={{ display: "flex", justifyContent: "center", paddingTop: "18vh" }}><BrandLoader /></div>}>
              <Routes>
                <Route path="/setup-password" element={<SetupPasswordPage />} />
                <Route path="/accept-invite" element={<AcceptInvitePage />} />
                <Route element={<AuthGate />}>
                  <Route element={<App />}>
                    <Route path="/" element={<HomePage />} />
                    <Route path="/alerts" element={<AlertsPage />} />
                    <Route path="/health" element={<HealthPage />} />
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
            </Suspense>
          </AuthProvider>
        </DbTargetProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>
);
