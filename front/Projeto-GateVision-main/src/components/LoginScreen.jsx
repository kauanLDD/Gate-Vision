import { useState } from "react";

export default function LoginScreen({ theme, onThemeToggle, onLogin }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!login.trim() || !password.trim()) {
      setError("Preencha usuario e senha.");
      return;
    }

    setLoading(true);
    setError("");
    try {
      await onLogin(login.trim(), password.trim());
    } catch (submitError) {
      setError(submitError.message || "Erro ao conectar. Verifique sua conexao.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="login-shell">
      <button
        className="theme-toggle login-theme-toggle"
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
      <form className="login-card" onSubmit={handleSubmit}>
        <div>
          <div className="eyebrow">Controle inteligente de acesso</div>
          <h1 className="logo-title">Vision<em>Gate</em></h1>
          <p className="login-sub">Sistema de acesso por leitura de placa</p>
        </div>
        {error ? <div className="error">{error}</div> : null}
        <div>
          <label htmlFor="loginUsuario" className="login-sub">Usuario</label>
          <input id="loginUsuario" className="input" value={login} onChange={(event) => setLogin(event.target.value)} placeholder="Digite o usuario" />
        </div>
        <div>
          <label htmlFor="loginSenha" className="login-sub">Senha</label>
          <input id="loginSenha" type="password" className="input" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Digite a senha" />
        </div>
        <button className="btn primary" type="submit" disabled={loading}>
          {loading ? "Entrando..." : "Entrar"}
        </button>
      </form>
    </section>
  );
}
