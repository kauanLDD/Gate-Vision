export function formatCPF(value) {
  const digits = (value || "").replace(/\D/g, "").slice(0, 11);
  return digits
    .replace(/^(\d{3})(\d)/, "$1.$2")
    .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1-$2");
}

export function onlyPlate(value) {
  return (value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 7);
}

export function isAllowedStatus(status) {
  return (status || "").toLowerCase().includes("liberado")
    || (status || "").toLowerCase().includes("autorizado");
}

export function logStatus(log) {
  if (log.autorizado === true) return { label: "Liberado", ok: true };
  if (log.autorizado === false) return { label: "Negado", ok: false };
  const text = log.status || log.motivo || "-";
  return { label: text, ok: isAllowedStatus(text) };
}

export function formatDateTime(raw) {
  if (!raw) return "-";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleString("pt-BR", { hour12: false });
}

export function getFilterDateISO(days) {
  if (days === "all") return null;
  const number = Number(days);
  if (!number) return null;
  const date = new Date();
  date.setDate(date.getDate() - number);
  return date.toISOString();
}

export function defaultDatetime(offsetHours = 0) {
  const date = new Date();
  date.setHours(date.getHours() + offsetHours);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function groupLogsByDay(logs, days) {
  const dayMap = {};
  const labels = [];
  const allowedData = [];
  const deniedData = [];
  const totalDays = days === "all" ? 7 : Number(days);
  const safeDays = Number.isFinite(totalDays) && totalDays > 0 ? totalDays : 7;
  const now = new Date();

  for (let index = safeDays - 1; index >= 0; index -= 1) {
    const date = new Date(now.getTime() - index * 24 * 60 * 60 * 1000);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    dayMap[key] = { allowed: 0, denied: 0 };
    labels.push(`${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}`);
  }

  logs.forEach((log) => {
    const raw = log.registrado_em || "";
    if (!raw) return;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return;
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    if (!dayMap[key]) return;
    const { ok } = logStatus(log);
    if (ok) dayMap[key].allowed += 1;
    else dayMap[key].denied += 1;
  });

  Object.keys(dayMap).forEach((key) => {
    allowedData.push(dayMap[key].allowed);
    deniedData.push(dayMap[key].denied);
  });

  return { labels, allowedData, deniedData };
}

export function getSession() {
  try {
    return JSON.parse(localStorage.getItem("gv_session"));
  } catch {
    return null;
  }
}

export function setSession(user) {
  localStorage.setItem("gv_session", JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem("gv_session");
}

export function navItemsByRole(role) {
  if (role === "admin") {
    return [
      { id: "dashboard", label: "Visão Geral" },
      { id: "porteiros", label: "Porteiros" },
      { id: "monitor", label: "Monitor de Placas" },
      { id: "cadastro", label: "Clientes" },
      { id: "cameras", label: "Câmeras" },
      { id: "autorizacoes", label: "Autorizações Temporárias" },
      { id: "logs", label: "Histórico de Acessos" }
    ];
  }

  return [
    { id: "monitor", label: "Monitor de Placas" },
    { id: "residentes", label: "Cadastro (somente leitura)" },
    { id: "logs", label: "Histórico de Acessos" }
  ];
}

export function buildStatusIllustration(type) {
  if (type === "liberado") {
    return `data:image/svg+xml;utf8,${encodeURIComponent(`
      <svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 400'>
        <defs><linearGradient id='g' x1='0' x2='1' y1='0' y2='1'><stop offset='0%' stop-color='#14532d'/><stop offset='100%' stop-color='#22c55e'/></linearGradient></defs>
        <rect width='800' height='400' fill='url(#g)'/>
        <circle cx='140' cy='200' r='74' fill='rgba(255,255,255,0.15)'/>
        <path d='M105 200l28 28 60-70' stroke='white' stroke-width='18' fill='none' stroke-linecap='round' stroke-linejoin='round'/>
        <text x='250' y='180' font-family='Arial, sans-serif' font-size='44' fill='white' font-weight='700'>ACESSO LIBERADO</text>
        <text x='250' y='225' font-family='Arial, sans-serif' font-size='26' fill='rgba(255,255,255,0.92)'>Morador identificado no cadastro</text>

      </svg>
    `)}`;
  }

  return `data:image/svg+xml;utf8,${encodeURIComponent(`
    <svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 400'>
      <defs><linearGradient id='g2' x1='0' x2='1' y1='0' y2='1'><stop offset='0%' stop-color='#7f1d1d'/><stop offset='100%' stop-color='#ef4444'/></linearGradient></defs>
      <rect width='800' height='400' fill='url(#g2)'/>
      <circle cx='140' cy='200' r='74' fill='rgba(255,255,255,0.15)'/>
      <path d='M100 160l80 80M180 160l-80 80' stroke='white' stroke-width='16' stroke-linecap='round'/>
      <text x='250' y='180' font-family='Arial, sans-serif' font-size='44' fill='white' font-weight='700'>ACESSO NEGADO</text>
      <text x='250' y='225' font-family='Arial, sans-serif' font-size='26' fill='rgba(255,255,255,0.92)'>Placa não encontrada no cadastro</text>
    </svg>
  `)}`;
}
