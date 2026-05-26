import { useRef, useState } from "react";
import CameraPanel from "./CameraPanel";

const MAX_PANELS = 4;

export default function MonitorView({ backendUrl, onToast }) {
  const [panels, setPanels] = useState([{ id: 1, name: "Câmera 1" }]);
  const [addingName, setAddingName] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const addInputRef = useRef(null);
  const nextIdRef = useRef(2);

  function openAddForm() {
    setAddingName("");
    setShowAddForm(true);
    setTimeout(() => addInputRef.current?.focus(), 50);
  }

  function confirmAddPanel() {
    const name = addingName.trim() || `Câmera ${panels.length + 1}`;
    setPanels((prev) => [...prev, { id: nextIdRef.current, name }]);
    nextIdRef.current += 1;
    setAddingName("");
    setShowAddForm(false);
  }

  function cancelAddPanel() {
    setAddingName("");
    setShowAddForm(false);
  }

  function removePanel(id) {
    if (panels.length === 1) {
      onToast("É necessário manter pelo menos um painel ativo.", "err");
      return;
    }
    setPanels((prev) => prev.filter((p) => p.id !== id));
  }

  return (
    <div className="page-stack">
      <div className="hero-card">
        <div className="hero-grid">
          <div>
            <div className="eyebrow">Monitor de acesso</div>
            <h2 className="section-title">Câmeras ativas</h2>
            <p className="section-sub">
              {panels.length === 1
                ? "1 painel de monitoramento ativo."
                : `${panels.length} painéis de monitoramento ativos.`}{" "}
              Cada painel opera de forma independente com seu próprio fluxo de detecção.
            </p>
          </div>

          <div className="hero-note">
            {!showAddForm ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {panels.length < MAX_PANELS && (
                  <button className="btn ok" type="button" onClick={openAddForm}>
                    + Adicionar câmera
                  </button>
                )}
                {panels.length >= MAX_PANELS && (
                  <span className="section-sub" style={{ fontSize: 12 }}>
                    Limite de {MAX_PANELS} painéis atingido.
                  </span>
                )}
                <span className="section-sub" style={{ fontSize: 12 }}>
                  Para remover um painel, clique em ✕ no cabeçalho dele.
                </span>
              </div>
            ) : (
              <div className="monitor-add-form">
                <span className="section-sub" style={{ fontSize: 13, marginBottom: 6, display: "block" }}>
                  Nome do novo painel:
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    ref={addInputRef}
                    className="input"
                    value={addingName}
                    onChange={(e) => setAddingName(e.target.value)}
                    placeholder={`Câmera ${panels.length + 1}`}
                    maxLength={32}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") confirmAddPanel();
                      if (e.key === "Escape") cancelAddPanel();
                    }}
                  />
                  <button className="btn ok" type="button" onClick={confirmAddPanel}>
                    OK
                  </button>
                  <button className="btn" type="button" onClick={cancelAddPanel}>
                    ✕
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="multi-monitor-grid" data-count={panels.length}>
        {panels.map((panel) => (
          <CameraPanel
            key={panel.id}
            panelName={panel.name}
            backendUrl={backendUrl}
            onToast={onToast}
            onRemove={() => removePanel(panel.id)}
          />
        ))}
      </div>
    </div>
  );
}
