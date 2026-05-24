import { useEffect, useState } from "react";
import Modal from "./Modal";
import { deleteCamera, fetchCameras, saveCamera, updateCamera } from "../lib/api";

function CameraForm({ initialData, loading, onSubmit, onClose }) {
  const [form, setForm] = useState({ nome: "", localizacao: "", tipo_camera_id: "1" });

  useEffect(() => {
    setForm({
      nome: initialData?.nome || "",
      localizacao: initialData?.localizacao || "",
      tipo_camera_id: initialData?.tipo_camera_id || "1"
    });
  }, [initialData]);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  return (
    <form className="form-grid" onSubmit={(event) => { event.preventDefault(); onSubmit(form); }}>
      <div><label className="login-sub">Nome da Câmera</label><input required className="input" placeholder="Ex: CAM-PORT-01" value={form.nome} onChange={(event) => update("nome", event.target.value)} /></div>
      <div><label className="login-sub">Localização</label><input required className="input" placeholder="Ex: Portaria Principal" value={form.localizacao} onChange={(event) => update("localizacao", event.target.value)} /></div>
      <div>
        <label className="login-sub">Tipo</label>
        <select className="input" value={form.tipo_camera_id} onChange={(event) => update("tipo_camera_id", event.target.value)}>
          <option value="1">Entrada</option>
          <option value="2">Saída</option>
          <option value="3">Garagem</option>
          <option value="4">Estacionamento</option>
        </select>
      </div>
      <div className="form-actions modal-actions">
        <button className="btn primary" type="submit" disabled={loading}>{loading ? "Salvando..." : "Salvar Câmera"}</button>
        <button className="btn" onClick={onClose} type="button">Cancelar</button>
      </div>
    </form>
  );
}

export default function CamerasView({ onToast }) {
  const [cameras, setCameras] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingCamera, setEditingCamera] = useState(null);

  async function loadCameras() {
    setLoading(true);
    try {
      setCameras(await fetchCameras());
    } catch (error) {
      onToast(`Erro ao carregar câmeras: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCameras();
  }, []);

  async function handleSave(form) {
    setSaving(true);
    try {
      if (editingCamera) {
        await updateCamera(editingCamera.id, form);
        onToast("Câmera atualizada com sucesso!", "ok");
      } else {
        await saveCamera(form);
        onToast("Câmera salva com sucesso!", "ok");
      }
      setOpen(false);
      setEditingCamera(null);
      await loadCameras();
    } catch (error) {
      onToast(`Erro ao salvar câmera: ${error.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(cameraId) {
    if (!window.confirm("Deseja remover esta câmera?")) return;
    try {
      await deleteCamera(cameraId);
      onToast("Câmera removida.", "ok");
      await loadCameras();
    } catch (error) {
      onToast(`Erro ao remover câmera: ${error.message}`);
    }
  }

  function handleOpenCreate() {
    setEditingCamera(null);
    setOpen(true);
  }

  function handleOpenEdit(camera) {
    setEditingCamera(camera);
    setOpen(true);
  }

  function handleCloseModal() {
    setOpen(false);
    setEditingCamera(null);
  }

  return (
    <div className="page-stack">
      <div className="panel-header">
        <div>
          <div className="eyebrow">Infraestrutura</div>
          <h2 className="section-title">Câmeras do sistema</h2>
          <p className="section-sub">Cadastre os pontos de captura e organize os equipamentos de entrada, saída e garagem.</p>
        </div>
        <div className="panel-actions">
          <button className="btn primary" onClick={handleOpenCreate} type="button">Cadastrar câmera</button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">Câmeras Cadastradas</div>
        <div className="card-body table-wrap">
          {loading ? <div className="empty">Carregando...</div> : null}
          {!loading && cameras.length ? (
            <table>
              <thead>
                <tr><th>Nome</th><th>Localização</th><th>Tipo</th><th>Ações</th></tr>
              </thead>
              <tbody>
                {cameras.map((camera) => (
                  <tr key={camera.id}>
                    <td>{camera.nome}</td>
                    <td>{camera.localizacao}</td>
                    <td>{camera.tipo}</td>
                    <td>
                      <div className="actions">
                        <button className="btn" onClick={() => handleOpenEdit(camera)} type="button">Editar</button>
                        <button className="btn err" onClick={() => handleDelete(camera.id)} type="button">Remover</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {!loading && !cameras.length ? <div className="empty">Nenhuma câmera cadastrada.</div> : null}
        </div>
      </div>

      <Modal open={open} title={editingCamera ? "Editar Câmera" : "Nova Câmera"} onClose={handleCloseModal}>
        <CameraForm initialData={editingCamera} loading={saving} onSubmit={handleSave} onClose={handleCloseModal} />
      </Modal>
    </div>
  );
}
