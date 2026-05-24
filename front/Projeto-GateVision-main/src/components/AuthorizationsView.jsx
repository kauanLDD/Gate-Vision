import { useEffect, useState } from "react";
import Modal from "./Modal";
import { deleteAuthorization, fetchAuthorizations, saveAuthorization, updateAuthorization } from "../lib/api";
import { defaultDatetime, formatDateTime, onlyPlate } from "../lib/utils";

function AuthorizationForm({ initialData, loading, onSubmit, onClose }) {
  const [form, setForm] = useState({
    placa: "",
    nome_autorizado: "",
    motivo: "",
    data_inicio: defaultDatetime(),
    data_fim: defaultDatetime(24)
  });

  useEffect(() => {
    setForm({
      placa: initialData?.placa || "",
      nome_autorizado: initialData?.nome_autorizado || "",
      motivo: initialData?.motivo || "",
      data_inicio: initialData?.data_inicio ? new Date(initialData.data_inicio).toISOString().slice(0, 16) : defaultDatetime(),
      data_fim: initialData?.data_fim ? new Date(initialData.data_fim).toISOString().slice(0, 16) : defaultDatetime(24)
    });
  }, [initialData]);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  return (
    <form className="form-grid" onSubmit={(event) => { event.preventDefault(); onSubmit(form); }}>
      <div><label className="login-sub">Placa</label><input required className="input mono" maxLength={7} placeholder="Ex: TMP1A23" value={form.placa} onChange={(event) => update("placa", onlyPlate(event.target.value))} /></div>
      <div><label className="login-sub">Nome do Visitante</label><input required className="input" placeholder="Ex: Pedro Encanador" value={form.nome_autorizado} onChange={(event) => update("nome_autorizado", event.target.value)} /></div>
      <div><label className="login-sub">Motivo</label><input className="input" placeholder="Ex: manutenção, visita, entrega" value={form.motivo} onChange={(event) => update("motivo", event.target.value)} /></div>
      <div />
      <div><label className="login-sub">Inicio</label><input required type="datetime-local" className="input" value={form.data_inicio} onChange={(event) => update("data_inicio", event.target.value)} /></div>
      <div><label className="login-sub">Fim</label><input required type="datetime-local" className="input" value={form.data_fim} onChange={(event) => update("data_fim", event.target.value)} /></div>
      <div className="form-actions modal-actions">
        <button className="btn primary" type="submit" disabled={loading}>{loading ? "Criando..." : "Criar Autorização"}</button>
        <button className="btn" onClick={onClose} type="button">Cancelar</button>
      </div>
    </form>
  );
}

export default function AuthorizationsView({ onToast }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingAuthorization, setEditingAuthorization] = useState(null);

  async function loadAuthorizations() {
    setLoading(true);
    try {
      setItems(await fetchAuthorizations());
    } catch (error) {
      onToast(`Erro ao carregar autorizações: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAuthorizations();
  }, []);

  async function handleSave(form) {
    if (onlyPlate(form.placa).length < 7) {
      onToast("Placa inválida (mínimo 7 caracteres).");
      return;
    }
    if (new Date(form.data_fim) <= new Date(form.data_inicio)) {
      onToast("A data de fim deve ser posterior ao início.");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        ...form,
        placa: onlyPlate(form.placa),
        data_inicio: new Date(form.data_inicio).toISOString(),
        data_fim: new Date(form.data_fim).toISOString()
      };

      if (editingAuthorization) {
        await updateAuthorization(editingAuthorization.id, payload);
        onToast("Autorização atualizada com sucesso!", "ok");
      } else {
        await saveAuthorization(payload);
        onToast("Autorização criada com sucesso!", "ok");
      }
      setOpen(false);
      setEditingAuthorization(null);
      await loadAuthorizations();
    } catch (error) {
      onToast(`Erro ao criar autorização: ${error.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    if (!window.confirm("Deseja cancelar esta autorização?")) return;
    try {
      await deleteAuthorization(id);
      onToast("Autorização cancelada.", "ok");
      await loadAuthorizations();
    } catch (error) {
      onToast(`Erro ao cancelar autorizacao: ${error.message}`);
    }
  }

  function handleOpenCreate() {
    setEditingAuthorization(null);
    setOpen(true);
  }

  function handleOpenEdit(item) {
    setEditingAuthorization(item);
    setOpen(true);
  }

  function handleCloseModal() {
    setOpen(false);
    setEditingAuthorization(null);
  }

  return (
    <div className="page-stack">
      <div className="panel-header">
        <div>
          <div className="eyebrow">Permissões temporárias</div>
          <h2 className="section-title">Liberações para visitantes</h2>
          <p className="section-sub">Cadastre acessos com validade limitada para prestadores, entregas e visitantes fora da base principal.</p>
        </div>
        <div className="panel-actions">
          <button className="btn primary" onClick={handleOpenCreate} type="button">Criar autorização</button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">Autorizações Ativas</div>
        <div className="card-body table-wrap">
          {loading ? <div className="empty">Carregando...</div> : null}
          {!loading && items.length ? (
            <table>
              <thead>
                <tr><th>Placa</th><th>Visitante</th><th>Motivo</th><th>Início</th><th>Validade</th><th>Ações</th></tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td className="mono">{item.placa}</td>
                    <td>{item.nome_autorizado}</td>
                    <td>{item.motivo || "-"}</td>
                    <td>{formatDateTime(item.data_inicio)}</td>
                    <td>{formatDateTime(item.data_fim)}</td>
                    <td>
                      <div className="actions">
                        <button className="btn" onClick={() => handleOpenEdit(item)} type="button">Editar</button>
                        <button className="btn err" onClick={() => handleDelete(item.id)} type="button">Cancelar</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {!loading && !items.length ? <div className="empty">Nenhuma autorização ativa no momento.</div> : null}
        </div>
      </div>

      <Modal open={open} title={editingAuthorization ? "Editar Autorização Temporária" : "Nova Autorização Temporária"} onClose={handleCloseModal}>
        <AuthorizationForm initialData={editingAuthorization} loading={saving} onSubmit={handleSave} onClose={handleCloseModal} />
      </Modal>
    </div>
  );
}
