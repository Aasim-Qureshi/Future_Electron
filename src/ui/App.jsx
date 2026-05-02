import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import "./index.css";
import i18n from "./i18n";
import Layout from "./components/Layout";
import { SessionProvider, useSession } from "./context/SessionContext";
import { SystemControlProvider } from "./context/SystemControlContext";
import { NavStatusProvider } from "./context/NavStatusContext";
import { ElrajhiUploadProvider } from "./context/ElrajhiUploadContext";
import ElRajhiUploadReport from "./screens/ElRajhiUploadReport";
import SubmitReportsQuickly from "./screens/SubmitReportsQuickly";
import SettingsDashboard from "./screens/SettingsDashboard";
import { RamProvider } from "./context/RAMContext";
import { ValueNavProvider } from "./context/ValueNavContext";
import { useValueNav } from "./context/ValueNavContext";
import { NotificationProvider } from "./context/NotificationContext";
import {
  AUTH_EXPIRED_EVENT,
  installAuthExpiryInterceptor,
} from "./utils/authInterceptor";
import { LocalAppLoginGate } from "./components/LocalAppLoginGate";
import navigation from "./constants/navigation";

const DEFAULT_VIEW = navigation.DEFAULT_HOME_VIEW;

const AppContent = () => {
  const [currentView, setCurrentView] = useState(DEFAULT_VIEW);
  const { logout } = useSession();
  const { syncNavForView, setActiveTab, resetNavigation } = useValueNav();

  useEffect(() => {
    setActiveTab(null);
    resetNavigation();
    setCurrentView(DEFAULT_VIEW);
  }, [resetNavigation, setActiveTab]);

  const handleViewChange = (nextView) => {
    if (!nextView) {
      setCurrentView(DEFAULT_VIEW);
      return;
    }
    if (syncNavForView) {
      syncNavForView(nextView);
    }
    setCurrentView(nextView);
  };

  useEffect(() => {
    try {
      const hash = currentView ? `#/${currentView}` : `#/${DEFAULT_VIEW}`;
      window.history.replaceState(null, "", hash);
    } catch (err) {
      // ignore
    }
  }, [currentView]);

  useEffect(() => {
    const cleanupInterceptor = installAuthExpiryInterceptor();
    const handleAuthExpired = () => {
      logout();
      resetNavigation();
      setActiveTab(null);
      setCurrentView(DEFAULT_VIEW);
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
    return () => {
      window.removeEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
      if (typeof cleanupInterceptor === "function") {
        cleanupInterceptor();
      }
    };
  }, [logout, resetNavigation, setActiveTab]);

  const renderCurrentView = () => {
    switch (currentView) {
      case "system-settings":
        return <SettingsDashboard onViewChange={handleViewChange} />;
      case "upload-report-elrajhi":
        return <ElRajhiUploadReport onViewChange={handleViewChange} />;
      case "submit-reports-quickly":
      default:
        return <SubmitReportsQuickly onViewChange={handleViewChange} />;
    }
  };

  return (
    <Layout currentView={currentView} onViewChange={handleViewChange}>
      {renderCurrentView()}
    </Layout>
  );
};

const App = () => {
  return (
    <I18nextProvider i18n={i18n}>
      <SessionProvider>
        <LocalAppLoginGate>
          <SystemControlProvider>
            <NavStatusProvider>
              <RamProvider>
                <ElrajhiUploadProvider>
                  <NotificationProvider>
                    <ValueNavProvider>
                      <AppContent />
                    </ValueNavProvider>
                  </NotificationProvider>
                </ElrajhiUploadProvider>
              </RamProvider>
            </NavStatusProvider>
          </SystemControlProvider>
        </LocalAppLoginGate>
      </SessionProvider>
    </I18nextProvider>
  );
};

const container = document.getElementById("root");
const root = createRoot(container);
root.render(<App />);

export default App;
