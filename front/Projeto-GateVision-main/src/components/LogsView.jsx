import { useEffect, useState } from "react";
import { fetchLogs } from "../lib/api";
import { formatDateTime, logStatus } from "../lib/utils";

export default function LogsView({ onToast }) {
  const [logs, setLogs] = useState(null);

  useEffect(() => {
    let alive = true;
    fetchLogs()
      .then((data) => { if (alive) setLogs(data); })
      .catch((error) => {
        onToast(`Erro ao carregar histórico: ${error.message}`);
        if (alive) setLogs([]);
      });
    return () => { alive = false; };
  }, []);

  return (
    <div className="page-stack">
      <div className="panel-header">
        <div>
          <div className="eyebrow">Rastreabilidade</div>
          <h2 className="section-title">Histórico de acessos</h2>
          <p className="section-sub">Até 200 registros recentes para auditoria da entrada, identificação da câmera e decisão tomada.</p>
        </div>
      </div>

      <div className="card">
        <div className="card-head">Histórico de acessos</div>
        <div className="card-body table-wrap">
          {logs === null ? <div className="empty">Carregando...</div> : null}
          {logs && logs.length ? (
            <table>
              <thead>
                <tr><th>Data/Hora</th><th>Placa</th><th>Morador</th><th>Camera</th><th>Status</th></tr>
              </thead>
              <tbody>
                {logs.map((log, index) => {
                  const { label, ok } = logStatus(log);
                  return (
                    <tr key={`${log.registrado_em}-${index}`}>
                      <td>{formatDateTime(log.registrado_em)}</td>
                      <td className="mono">{log.placa_detectada}</td>
                      <td>{log.proprietario || "-"}</td>
                      <td>{log.camera || "-"}</td>
                      <td className={ok ? "table-status-ok" : "table-status-err"}>{label}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : null}
          {logs && !logs.length ? <div className="empty">Sem registros de acesso no momento.</div> : null}
        </div>
      </div>
    </div>
  );
}
