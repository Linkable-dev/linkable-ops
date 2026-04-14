import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import { KBProvider } from "./contexts/KBContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import ProtectedRoute from "./components/layout/ProtectedRoute";
import App from "./App";
import LoginPage from "./pages/auth/LoginPage";
import AcceptInvitePage from "./pages/auth/AcceptInvitePage";
import OnboardingPage from "./pages/ops/OnboardingPage";
import BuildListPage from "./pages/ops/BuildListPage";
import BuildOfferPage from "./pages/ops/BuildOfferPage";
import CampaignPage from "./pages/ops/CampaignPage";
import ContentPage from "./pages/ops/ContentPage";
import LeadsPage from "./pages/ops/LeadsPage";
import PerformancePage from "./pages/ops/PerformancePage";
import ContactsPage from "./pages/crm/ContactsPage";
import PipelinePage from "./pages/crm/PipelinePage";
import ScraperPage from "./pages/crm/ScraperPage";
import OutreachPage from "./pages/crm/OutreachPage";
import SettingsPage from "./pages/settings/SettingsPage";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/invite/:token" element={<AcceptInvitePage />} />
          <Route element={<ProtectedRoute />}>
            <Route element={<KBProvider><App /></KBProvider>}>
              <Route path="/" element={<Navigate to="/ops/onboarding" replace />} />
              <Route path="/ops/onboarding" element={<OnboardingPage />} />
              <Route path="/ops/build-list" element={<BuildListPage />} />
              <Route path="/ops/build-offer" element={<BuildOfferPage />} />
              <Route path="/ops/campaign" element={<CampaignPage />} />
              <Route path="/ops/content" element={<ContentPage />} />
              <Route path="/ops/leads" element={<LeadsPage />} />
              <Route path="/ops/performance" element={<PerformancePage />} />
              <Route path="/crm/contacts" element={<ContactsPage />} />
              <Route path="/crm/pipeline" element={<PipelinePage />} />
              <Route path="/crm/scraper" element={<ScraperPage />} />
              <Route path="/crm/outreach" element={<OutreachPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>
);
