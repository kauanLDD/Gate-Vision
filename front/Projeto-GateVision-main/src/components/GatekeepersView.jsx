import { useEffect, useMemo, useState } from "react";
import Modal from "./Modal";
import { fetchGatekeepers, saveGatekeeper, setGatekeeperActive, updateGatekeeper } from "../lib/api";
import { formatCPF } from "../lib/utils";

const EMPTY_FORM = {
  nome: "",
  cpf: "",
  login: "",
  senha: "",
  confirmarSenha: "",
  ativo: true
};

function GatekeeperForm({ initialData, loading, onSubmit, onClose }) {
  const isEditing = Boolean(initialData);
  const [form, setForm] = useState(EMPTY_FORM);

  useEffect(() => {
    setForm({
      nome: initialData?.nome || "",
      cpf: initialData?.cpf ? formatCPF(initialData.cpf) : "",
      login: initialData?.login || "",
      senha: "",
      confirmarSenha: "",
      ativo: initialData?.ativo ?? true
    });
  }, [initialData]);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  return (
    <form className="form-grid" onSubmit={(event) => { event.preventDefault(); onSubmit(form); }}>
      <div>
        <label className="login-sub">Nome completo</label>
        <input required className="input" value={form.nome} onChange={(event) => update("nome", event.target.value)} />
      </div>
      <div>
        <label className="login-sub">CPF</label>
        <input required className="input" maxLength={14} value={form.cpf} onChange={(event) => update("cpf", formatCPF(event.target.value))} />
      </div>
      <div>
        <label className="login-sub">Login</label>
        <input required className="input" minLength={3} value={form.login} onChange={(event) => update("login", event.target.value)} />
      </div>
      {isEditing ? (
        <div>
          <label className="login-sub">Status</label>
          <select className="input" value={String(form.ativo)} onChange={(event) => update("ativo", event.target.value === "true")}>
            <option value="true">Ativo</option>
            <option value="false">Inativo</option>
          </select>
        </div>
      ) : <div />}
      <div>
        <label className="login-sub">{isEditing ? "Nova senha" : "Senha"}</label>
        <input
          className="input"
          minLength={4}
          required={!isEditing}
          type="password"
          value={form.senha}
          onChange={(event) => update("senha", event.target.value)}
        />
      </div>
      <div>
        <label className="login-sub">Confirmar senha</label>
        <input
          className="input"
          minLength={4}
          required={!isEditing || Boolean(form.senha)}
          type="password"
          value={form.confirmarSenha}
          onChange={(event) => update("confirmarSenha", event.target.value)}
        />
      </div>
      <div className="form-actions modal-actions">
        <button className="btn primary" type="submit" disabled={loading}>{loading ? "Salvando..." : "Salvar login"}</button>
        <button className="btn" onClick={onClose} type="button">Cancelar</button>
      </div>
    </form>
  );
}

function GatekeepersTable({ gatekeepers, loading, onEdit, onToggleActive }) {
  if (loading) return <div className="empty">Carregando...</div>;
  if (!gatekeepers.length) return <div className="empty">Nenhum porteiro cadastrado.</div>;

  return (
    <table>
      <thead>
        <tr>
          <th>Nome</th>
          <th>CPF</th>
          <th>Login</th>
          <th>Status</th>
          <th>Ações</th>
        </tr>
      </thead>
      <tbody>
        {gatekeepers.map((gatekeeper) => (
          <tr key={gatekeeper.id}>
            <td>{gatekeeper.nome}</td>
            <td className="mono">{formatCPF(gatekeeper.cpf)}</td>
            <td className="mono">{gatekeeper.login}</td>
            <td><span className={`chip ${gatekeeper.ativo ? "ok" : "err"}`}>{gatekeeper.ativo ? "Ativo" : "Inativo"}</span></td>
            <td>
              <div className="actions">
                <button className="btn" onClick={() => onEdit(gatekeeper)} type="button">Editar</button>
                <button className={gatekeeper.ativo ? "btn err" : "btn ok"} onClick={() => onToggleActive(gatekeeper)} type="button">
                  {gatekeeper.ativo ? "Desativar" : "Ativar"}
                </button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function GatekeepersView({ onToast }) {
  const [gatekeepers, setGatekeepers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [editingGatekeeper, setEditingGatekeeper] = useState(null);

  const stats = useMemo(() => {
    const active = gatekeepers.filter((item) => item.ativo).length;
    return {
      total: gatekeepers.length,
      active,
      inactive: gatekeepers.length - active
    };
  }, [gatekeepers]);

  async function loadGatekeepers() {
    setLoading(true);
    try {
      setGatekeepers(await fetchGatekeepers());
    } catch (error) {
      onToast(`Erro ao carregar porteiros: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadGatekeepers();
  }, []);

  async function handleSave(form) {
    const cpf = form.cpf.replace(/\D/g, "");
    const senha = form.senha.trim();

    if (cpf.length !== 11) {
      onToast("CPF deve ter 11 dígitos.");
      return;
    }
    if (form.login.trim().length < 3) {
      onToast("Login deve ter pelo menos 3 caracteres.");
      return;
    }
    if (!editingGatekeeper && senha.length < 4) {
      onToast("Senha deve ter pelo menos 4 caracteres.");
      return;
    }
    if (senha && senha !== form.confirmarSenha.trim()) {
      onToast("As senhas nao conferem.");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        nome: form.nome,
        cpf,
        login: form.login,
        senha,
        ativo: form.ativo
      };

      if (editingGatekeeper) {
        await updateGatekeeper(editingGatekeeper.id, editingGatekeeper.pessoa_id, payload);
        onToast("Login do porteiro atualizado com sucesso!", "ok");
      } else {
        await saveGatekeeper(payload);
        onToast("Login do porteiro criado com sucesso!", "ok");
      }

      setOpen(false);
      setEditingGatekeeper(null);
      await loadGatekeepers();
    } catch (error) {
      onToast(`Erro ao salvar porteiro: ${error.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(gatekeeper) {
    const nextActive = !gatekeeper.ativo;
    const action = nextActive ? "ativar" : "desativar";
    if (!window.confirm(`Deseja ${action} este login de porteiro?`)) return;

    try {
      await setGatekeeperActive(gatekeeper.id, nextActive);
      onToast(`Login ${nextActive ? "ativado" : "desativado"} com sucesso.`, "ok");
      await loadGatekeepers();
    } catch (error) {
      onToast(`Erro ao atualizar status: ${error.message}`);
    }
  }

  function handleOpenCreate() {
    setEditingGatekeeper(null);
    setOpen(true);
  }

  function handleOpenEdit(gatekeeper) {
    setEditingGatekeeper(gatekeeper);
    setOpen(true);
  }

  function handleCloseModal() {
    setOpen(false);
    setEditingGatekeeper(null);
  }

  return (
    <div className="page-stack">
      <div className="panel-header">
        <div>
          <div className="eyebrow">Administração</div>
          <h2 className="section-title">Logins de porteiros</h2>
          <p className="section-sub">Crie e mantenha os acessos de quem opera o monitoramento da portaria.</p>
        </div>
        <div className="panel-actions">
          <button className="btn primary" onClick={handleOpenCreate} type="button">Criar login de porteiro</button>
        </div>
      </div>

      <div className="grid-3">
        <div className="kpi">
          <div className="kpi-label">Total</div>
          <div className="kpi-val">{stats.total}</div>
          <div className="kpi-sub">Logins cadastrados</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Ativos</div>
          <div className="kpi-val">{stats.active}</div>
          <div className="kpi-sub">Acesso liberado ao fluxo operacional</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Inativos</div>
          <div className="kpi-val">{stats.inactive}</div>
          <div className="kpi-sub">Sem acesso ao sistema</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">Porteiros cadastrados</div>
        <div className="card-body table-wrap">
          <GatekeepersTable
            gatekeepers={gatekeepers}
            loading={loading}
            onEdit={handleOpenEdit}
            onToggleActive={handleToggleActive}
          />
        </div>
      </div>

      <Modal open={open} title={editingGatekeeper ? "Editar login de porteiro" : "Novo login de porteiro"} onClose={handleCloseModal}>
        <GatekeeperForm initialData={editingGatekeeper} loading={saving} onSubmit={handleSave} onClose={handleCloseModal} />
      </Modal>
    </div>
  );
}
