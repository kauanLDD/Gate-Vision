import { navItemsByRole } from "../lib/utils";

export default function AppShell({
  currentUser,
  currentView,
  onViewChange,
  onLogout,
  backendLabel,
  onBackendClick,
  theme,
  onThemeToggle,
  children
}) {
  const items = navItemsByRole(currentUser.role);
  const titleMap = {
    dashboard: "Visao Geral",
    cadastro: "Cadastro de Clientes e Placas",
    cameras: "Cameras",
    autorizacoes: "Autorizacoes Temporarias",
    monitor: "Monitor de Placas",
    residentes: "Cadastro de Clientes",
    logs: "Historico de Acessos"
  };

  return (
    <section className="app">
      <aside className="side">
        <div className="brand">
          <svg viewBox="0 0 195 52" xmlns="http://www.w3.org/2000/svg">
            <g transform="translate(0, 2)">
              <path d="M24 4 C12 4, 4 13, 4 24 C4 35, 12 44, 24 44" stroke="#1a7a1a" strokeWidth="4.5" fill="none" strokeLinecap="round" />
              <path d="M24 9 C15 9, 9 16, 9 24 C9 32, 15 39, 24 39" stroke="#e6a800" strokeWidth="4" fill="none" strokeLinecap="round" />
              <circle cx="24" cy="24" r="9" fill="#1a3a8a" />
              <circle cx="24" cy="24" r="4" fill="#2a5ce6" />
              <circle cx="21.5" cy="21.5" r="2" fill="white" opacity="0.5" />
              <polygon points="33,24 46,18 46,30" fill="#e6a800" opacity="0.9" />
            </g>
            <text x="58" y="34" fontSize="22" fontFamily="Arial, sans-serif" fontWeight="800" letterSpacing="-0.5">
              <tspan fill="#1a7a1a">Vision</tspan><tspan fill="#1a2a5e">Gate</tspan>
            </text>
          </svg>
          <p className="brand-copy">Painel operacional para leitura de placas, autorizacao de entrada e historico de acessos em tempo real.</p>
        </div>

        <div className="nav">
          {items.map((item) => (
            <button
              key={item.id}
              className={`nav-btn ${currentView === item.id ? "active" : ""}`}
              onClick={() => onViewChange(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="user-box">
          <div className="user-name">{currentUser.nome}</div>
          <div className="user-role">{currentUser.role}</div>
          <button className="btn" onClick={onLogout} type="button">Sair</button>
        </div>
      </aside>

      <main className="main">
        <header className="top">
          <div className="top-title">
            <strong>{titleMap[currentView] || "Painel"}</strong>
            <span>Operacao central da portaria</span>
          </div>
          <div className="top-actions">
            <button
              className="theme-toggle"
              onClick={onThemeToggle}
              title={theme === "dark" ? "Ativar modo claro" : "Ativar modo escuro"}
              aria-label={theme === "dark" ? "Ativar modo claro" : "Ativar modo escuro"}
              type="button"
            >
              {theme === "dark" ? (
                <svg className="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="4.4" />
                  <path d="M12 1.6v3M12 19.4v3M1.6 12h3M19.4 12h3M4.7 4.7l2.1 2.1M17.2 17.2l2.1 2.1M19.3 4.7l-2.1 2.1M6.8 17.2l-2.1 2.1" />
                </svg>
              ) : (
                <svg className="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path className="moon-shape" d="M20.8 14.4A8 8 0 0 1 9.6 3.2 8.8 8.8 0 1 0 20.8 14.4Z" />
                </svg>
              )}
            </button>
            <div className="chip ok">Sistema ativo</div>
            <button
              className="chip"
              style={{ cursor: "pointer", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              onClick={onBackendClick}
              title="Clique para alterar o backend"
              type="button"
            >
              {backendLabel}
            </button>
          </div>
        </header>

        <div className="content">
          {children}
        </div>
      </main>
    </section>
  );
}
