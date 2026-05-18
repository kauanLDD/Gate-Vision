import { useEffect, useRef, useState } from "react";
import Chart from "chart.js/auto";
import { fetchDashboardData } from "../lib/api";
import { formatDateTime, groupLogsByDay, logStatus } from "../lib/utils";

function DashboardCharts({ logs, liberados, negados, filterDays }) {
  const timelineRef = useRef(null);
  const distributionRef = useRef(null);
  const timelineChartRef = useRef(null);
  const distributionChartRef = useRef(null);

  useEffect(() => {
    const grouped = groupLogsByDay(logs, filterDays);

    if (timelineChartRef.current) timelineChartRef.current.destroy();
    if (distributionChartRef.current) distributionChartRef.current.destroy();

    timelineChartRef.current = new Chart(timelineRef.current, {
      type: "line",
      data: {
        labels: grouped.labels,
        datasets: [
          { label: "Permitidos", data: grouped.allowedData, borderColor: "#1f8b56", backgroundColor: "rgba(31,139,86,0.15)", tension: 0.3, fill: true },
          { label: "Negados", data: grouped.deniedData, borderColor: "#c33a2f", backgroundColor: "rgba(195,58,47,0.12)", tension: 0.3, fill: true }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "top", labels: { color: "#dce7dc" } } },
        scales: {
          x: { ticks: { color: "#8fa291" }, grid: { color: "rgba(255,255,255,0.06)" } },
          y: { beginAtZero: true, ticks: { precision: 0, color: "#8fa291" }, grid: { color: "rgba(255,255,255,0.06)" } }
        }
      }
    });

    distributionChartRef.current = new Chart(distributionRef.current, {
      type: "doughnut",
      data: {
        labels: ["Permitidos", "Negados"],
        datasets: [{ data: [liberados, negados], backgroundColor: ["#1f8b56", "#c33a2f"], borderWidth: 0 }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom", labels: { color: "#dce7dc" } } }
      }
    });

    return () => {
      if (timelineChartRef.current) timelineChartRef.current.destroy();
      if (distributionChartRef.current) distributionChartRef.current.destroy();
    };
  }, [logs, liberados, negados, filterDays]);

  return (
    <div className="chart-grid">
      <div className="chart-card">
        <div className="chart-title">Historico de acessos por dia</div>
        <div className="chart-canvas-wrap"><canvas ref={timelineRef} /></div>
      </div>
      <div className="chart-card">
        <div className="chart-title">Distribuicao de acessos</div>
        <div className="chart-canvas-wrap"><canvas ref={distributionRef} /></div>
      </div>
    </div>
  );
}

export default function DashboardView({ filterDays, onFilterChange, onError }) {
  const [state, setState] = useState({ loading: true, data: null });

  useEffect(() => {
    let alive = true;
    setState({ loading: true, data: null });

    fetchDashboardData(filterDays)
      .then((data) => {
        if (alive) setState({ loading: false, data });
      })
      .catch((error) => {
        onError(`Erro ao carregar dashboard: ${error.message}`);
        if (alive) setState({ loading: false, data: { logs: [], totalClientes: 0, liberados: 0, negados: 0, total: 0, latest: [] } });
      });

    return () => { alive = false; };
  }, [filterDays]);

  if (state.loading || !state.data) {
    return <div className="empty">Carregando...</div>;
  }

  const {
    logs,
    totalClientes,
    liberados,
    negados,
    total,
    latest
  } = state.data;
  const percent = total ? Math.round((liberados / total) * 100) : 0;

  return (
    <div className="page-stack">
      <div className="hero-card">
        <div className="hero-grid">
          <div>
            <div className="eyebrow">Visao operacional</div>
            <h2 className="section-title">Acesso monitorado com leitura de placa em tempo real</h2>
            <p className="section-sub">Resumo do fluxo da portaria, desempenho de liberacoes e acompanhamento das ultimas ocorrencias registradas pelo sistema.</p>
            <div className="hero-meta">
              <span className="chip ok">{liberados} liberados</span>
              <span className="chip warn">{negados} negados</span>
              <span className="chip">{totalClientes} clientes cadastrados</span>
            </div>
          </div>
        </div>
      </div>

      <div className="dashboard-toolbar">
        <div>
          <label className="login-sub" htmlFor="dashboardFilter">Periodo dos graficos</label>
          <select id="dashboardFilter" className="input" value={String(filterDays)} onChange={(event) => onFilterChange(event.target.value)}>
            <option value="7">Ultimos 7 dias</option>
            <option value="15">Ultimos 15 dias</option>
            <option value="30">Ultimos 30 dias</option>
            <option value="all">Todos os registros</option>
          </select>
        </div>
      </div>

      <div className="grid-3">
        <div className="kpi"><div className="kpi-label">Clientes cadastrados</div><div className="kpi-val">{totalClientes}</div><div className="kpi-sub">Base ativa monitorada</div></div>
        <div className="kpi"><div className="kpi-label">Acessos permitidos</div><div className="kpi-val">{liberados}</div><div className="kpi-sub">{percent}% de aprovacao</div></div>
        <div className="kpi"><div className="kpi-label">Acessos negados</div><div className="kpi-val">{negados}</div><div className="kpi-sub">{total} analisados</div></div>
      </div>

      <DashboardCharts logs={logs} liberados={liberados} negados={negados} filterDays={filterDays} />

      <div className="card">
        <div className="card-head">Ultimos acessos registrados</div>
        <div className="card-body">
          {latest.length ? (
            <div className="last-access-list">
              {latest.map((item, index) => {
                const { label, ok } = logStatus(item);
                const nome = item.proprietario || "-";
                return (
                  <div className="last-access-item" key={`${item.registrado_em}-${index}`}>
                    <div className="last-access-main">{item.placa_detectada} - {nome}</div>
                    <div className={`last-access-status ${ok ? "ok" : "err"}`}>{label}</div>
                    <div className="last-access-meta">{formatDateTime(item.registrado_em)} - {item.camera || "-"}</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty">Sem registros para o periodo selecionado.</div>
          )}
        </div>
      </div>
    </div>
  );
}
