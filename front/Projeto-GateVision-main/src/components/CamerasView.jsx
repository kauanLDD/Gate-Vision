import { useEffect, useState } from "react";
import Modal from "./Modal";
import { connectArduinoPort, deleteCamera, disconnectArduinoPort, fetchArduinoState, fetchCameras, saveCamera, updateCamera } from "../lib/api";

function CameraForm({ initialData, loading, onSubmit, onClose, arduinoPorts }) {
  const [form, setForm] = useState({ nome: "", localizacao: "", tipo_camera_id: "1", gate_usb_port: "", gate_baud: "9600" });

  useEffect(() => {
    setForm({
      nome: initialData?.nome || "",
      localizacao: initialData?.localizacao || "",
      tipo_camera_id: initialData?.tipo_camera_id || "1",
      gate_usb_port: initialData?.gate_usb_port || "",
      gate_baud: String(initialData?.gate_baud || 9600)
    });
  }, [initialData]);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  return (
    <form className="form-grid" onSubmit={(event) => { event.preventDefault(); onSubmit(form); }}>
      <div><label className="login-sub">Nome da Camera</label><input required className="input" placeholder="Ex: CAM-PORT-01" value={form.nome} onChange={(event) => update("nome", event.target.value)} /></div>
      <div><label className="login-sub">Localizacao</label><input required className="input" placeholder="Ex: Portaria Principal" value={form.localizacao} onChange={(event) => update("localizacao", event.target.value)} /></div>
      <div>
        <label className="login-sub">Tipo</label>
        <select className="input" value={form.tipo_camera_id} onChange={(event) => update("tipo_camera_id", event.target.value)}>
          <option value="1">Entrada</option>
          <option value="2">Saida</option>
          <option value="3">Garagem</option>
          <option value="4">Estacionamento</option>
        </select>
      </div>
      <div>
        <label className="login-sub">Portao USB (Arduino)</label>
        <select className="input mono" value={form.gate_usb_port} onChange={(event) => update("gate_usb_port", event.target.value)}>
          <option value="">{arduinoPorts.length ? "Selecione a porta do portao" : "Nenhuma porta serial encontrada"}</option>
          {arduinoPorts.map((port) => (
            <option key={port.device} value={port.device}>{`${port.device} - ${port.description}`}</option>
          ))}
        </select>
      </div>
      <div><label className="login-sub">Baud rate do portao</label><input className="input mono" value={form.gate_baud} onChange={(event) => update("gate_baud", event.target.value.replace(/\D/g, "").slice(0, 6) || "9600")} /></div>
      <div className="form-actions modal-actions">
        <button className="btn primary" type="submit" disabled={loading}>{loading ? "Salvando..." : "Salvar Camera"}</button>
        <button className="btn" onClick={onClose} type="button">Cancelar</button>
      </div>
    </form>
  );
}

export default function CamerasView({ backendUrl, onToast }) {
  const [cameras, setCameras] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingCamera, setEditingCamera] = useState(null);
  const [arduinoPorts, setArduinoPorts] = useState([]);
  const [arduinoStatus, setArduinoStatus] = useState({ connected: false, port: "", baud: 9600 });
  const [arduinoBusy, setArduinoBusy] = useState(false);

  async function loadCameras() {
    setLoading(true);
    try {
      setCameras(await fetchCameras());
    } catch (error) {
      onToast(`Erro ao carregar cameras: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCameras();
    void loadArduinoState();
  }, [backendUrl]);

  async function loadArduinoState() {
    try {
      const payload = await fetchArduinoState(backendUrl);
      setArduinoPorts(payload.ports || []);
      setArduinoStatus(payload.arduino || { connected: false, port: "", baud: 9600 });
    } catch (error) {
      onToast(`Erro ao consultar portas USB: ${error.message}`);
    }
  }

  async function handleSave(form) {
      setSaving(true);
      try {
        if (editingCamera) {
          await updateCamera(editingCamera.id, form);
          onToast("Camera atualizada com sucesso!", "ok");
      } else {
        await saveCamera(form);
        onToast("Camera salva com sucesso!", "ok");
      }
      setOpen(false);
      setEditingCamera(null);
      await loadCameras();
    } catch (error) {
      onToast(`Erro ao salvar camera: ${error.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(cameraId) {
    if (!window.confirm("Deseja remover esta camera?")) return;
    try {
      await deleteCamera(cameraId);
      onToast("Camera removida.", "ok");
      await loadCameras();
    } catch (error) {
      onToast(`Erro ao remover camera: ${error.message}`);
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

  async function handleConnectGate(camera) {
    if (!camera.gate_usb_port) {
      onToast("Associe uma porta USB ao portao desta camera antes de conectar.");
      return;
    }

    setArduinoBusy(true);
    try {
      const payload = await connectArduinoPort(backendUrl, camera.gate_usb_port, camera.gate_baud || 9600);
      setArduinoPorts(payload.ports || []);
      setArduinoStatus(payload.arduino);
      onToast(`Portao conectado para ${camera.nome} em ${payload.arduino.port}.`, "ok");
    } catch (error) {
      onToast(error.message);
    } finally {
      setArduinoBusy(false);
    }
  }

  async function handleDisconnectGate() {
    setArduinoBusy(true);
    try {
      const payload = await disconnectArduinoPort(backendUrl);
      setArduinoPorts(payload.ports || []);
      setArduinoStatus(payload.arduino);
      onToast("Portao desconectado.", "ok");
    } catch (error) {
      onToast(error.message);
    } finally {
      setArduinoBusy(false);
    }
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
          <h2 className="section-title">Cameras do sistema</h2>
          <p className="section-sub">Cadastre os pontos de captura e organize os equipamentos de entrada, saida e garagem.</p>
        </div>
        <div className="panel-actions">
          <button className="btn primary" onClick={handleOpenCreate} type="button">Cadastrar camera</button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">Portoes e portas USB</div>
        <div className="card-body">
          <div className="hero-meta" style={{ marginBottom: 12 }}>
            <span className={`chip ${arduinoStatus.connected ? "ok" : "err"}`}>
              {arduinoStatus.connected ? `Arduino conectado em ${arduinoStatus.port}` : "Nenhum portao conectado agora"}
            </span>
          </div>
          <div className="monitor-toolbar">
            <button className="btn" onClick={() => { void loadArduinoState(); }} type="button" disabled={arduinoBusy}>Atualizar portas USB</button>
            <button className="btn err" onClick={() => { void handleDisconnectGate(); }} type="button" disabled={arduinoBusy || !arduinoStatus.connected}>Desconectar portao atual</button>
          </div>
          <div className="status-box" style={{ marginTop: 12 }}>
            <div className="row"><span>Porta atual</span><strong className="mono">{arduinoStatus.port || "-"}</strong></div>
            <div className="row"><span>Baud atual</span><strong>{arduinoStatus.baud || 9600}</strong></div>
            <div className="row"><span>Associacao</span><strong>Configure a USB do Arduino dentro de cada camera abaixo.</strong></div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">Cameras Cadastradas</div>
        <div className="card-body table-wrap">
          {loading ? <div className="empty">Carregando...</div> : null}
          {!loading && cameras.length ? (
            <table>
              <thead>
                <tr><th>Nome</th><th>Localizacao</th><th>Tipo</th><th>Portao USB</th><th>Baud</th><th>Acoes</th></tr>
              </thead>
              <tbody>
                {cameras.map((camera) => (
                  <tr key={camera.id}>
                    <td>{camera.nome}</td>
                    <td>{camera.localizacao}</td>
                    <td>{camera.tipo}</td>
                    <td className="mono">{camera.gate_usb_port || "-"}</td>
                    <td>{camera.gate_baud || 9600}</td>
                    <td>
                      <div className="actions">
                        <button className="btn ok" onClick={() => { void handleConnectGate(camera); }} type="button" disabled={arduinoBusy || !camera.gate_usb_port}>Conectar portao</button>
                        <button className="btn" onClick={() => handleOpenEdit(camera)} type="button">Editar</button>
                        <button className="btn err" onClick={() => handleDelete(camera.id)} type="button">Remover</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {!loading && !cameras.length ? <div className="empty">Nenhuma camera cadastrada.</div> : null}
        </div>
      </div>

      <Modal open={open} title={editingCamera ? "Editar Camera" : "Nova Camera"} onClose={handleCloseModal}>
        <CameraForm initialData={editingCamera} loading={saving} onSubmit={handleSave} onClose={handleCloseModal} arduinoPorts={arduinoPorts} />
      </Modal>
    </div>
  );
}
