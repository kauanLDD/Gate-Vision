import { Suspense, lazy, useEffect, useState } from "react";
import AppShell from "./components/AppShell";
import LoginScreen from "./components/LoginScreen";
import ToastViewport from "./components/ToastViewport";
import { BACKEND_STORAGE_KEY, resolveBackendUrl } from "./lib/config";
import { loginUser } from "./lib/api";
import { clearSession, getSession, setSession } from "./lib/utils";

const DashboardView = lazy(() => import("./components/DashboardView"));
const GatekeepersView = lazy(() => import("./components/GatekeepersView"));
const ResidentsView = lazy(() => import("./components/ResidentsView"));
const CamerasView = lazy(() => import("./components/CamerasView"));
const AuthorizationsView = lazy(() => import("./components/AuthorizationsView"));
const MonitorView = lazy(() => import("./components/MonitorView"));
const LogsView = lazy(() => import("./components/LogsView"));
const THEME_STORAGE_KEY = "gateVisionTheme";

function getInitialTheme() {
  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  if (savedTheme === "light" || savedTheme === "dark") return savedTheme;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function backendLabel(url) {
  const isLocal = url.includes("localhost");
  return isLocal ? "API: local" : `API: ${url.replace(/^https?:\/\//, "")}`;
}

export default function App() {
  const [currentUser, setCurrentUser] = useState(() => getSession());
  const [currentView, setCurrentView] = useState(() => (getSession()?.role === "admin" ? "dashboard" : "monitor"));
  const [dashboardFilterDays, setDashboardFilterDays] = useState("7");
  const [backendUrl, setBackendUrl] = useState(() => resolveBackendUrl());
  const [toasts, setToasts] = useState([]);
  const [theme, setTheme] = useState(() => getInitialTheme());

  useEffect(() => {
    if (!currentUser) return;
    setCurrentView(currentUser.role === "admin" ? "dashboard" : "monitor");
  }, [currentUser]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  function pushToast(message, type = "err") {
    const toast = { id: `${Date.now()}-${Math.random()}`, message, type };
    setToasts((current) => [...current, toast]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== toast.id));
    }, 5000);
  }

  async function handleLogin(login, password) {
    const user = await loginUser(login, password);
    if (!user) throw new Error("Usuário ou senha inválidos.");
    setSession(user);
    setCurrentUser(user);
  }

  function handleLogout() {
    clearSession();
    setCurrentUser(null);
  }

  function handleBackendClick() {
    const current = localStorage.getItem(BACKEND_STORAGE_KEY) || backendUrl;
    const input = window.prompt(
      "Cole a URL do Cloudflare Tunnel (ex: https://abc-123.trycloudflare.com)\nDeixe vazio para usar localhost:",
      current.includes("localhost") ? "" : current
    );
    if (input === null) return;
    const url = (input || "").trim().replace(/\/$/, "");
    if (url) localStorage.setItem(BACKEND_STORAGE_KEY, url);
    else localStorage.removeItem(BACKEND_STORAGE_KEY);
    const nextUrl = resolveBackendUrl();
    setBackendUrl(nextUrl);
    pushToast(`Backend atualizado para ${backendLabel(nextUrl)}.`, "ok");
  }

  function toggleTheme() {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }

  if (!currentUser) {
    return (
      <>
        <LoginScreen theme={theme} onThemeToggle={toggleTheme} onLogin={handleLogin} />
        <ToastViewport toasts={toasts} />
      </>
    );
  }

  let content = null;
  if (currentView === "dashboard") content = <DashboardView filterDays={dashboardFilterDays} onFilterChange={setDashboardFilterDays} onError={pushToast} />;
  else if (currentView === "porteiros" && currentUser.role === "admin") content = <GatekeepersView onToast={pushToast} />;
  else if (currentView === "cadastro") content = <ResidentsView onToast={pushToast} />;
  else if (currentView === "cameras") content = <CamerasView onToast={pushToast} />;
  else if (currentView === "autorizacoes") content = <AuthorizationsView onToast={pushToast} />;
  else if (currentView === "monitor") content = <MonitorView backendUrl={backendUrl} onToast={pushToast} />;
  else if (currentView === "residentes") content = <ResidentsView readOnly onToast={pushToast} />;
  else if (currentView === "logs") content = <LogsView onToast={pushToast} />;

  return (
    <>
      <AppShell
        currentUser={currentUser}
        currentView={currentView}
        onViewChange={setCurrentView}
        onLogout={handleLogout}
        backendLabel={backendLabel(backendUrl)}
        onBackendClick={handleBackendClick}
        theme={theme}
        onThemeToggle={toggleTheme}
      >
        <Suspense fallback={<div className="empty">Carregando...</div>}>
          {content}
        </Suspense>
      </AppShell>
      <ToastViewport toasts={toasts} />
    </>
  );
}
