// ═══════════════════════════════════════════════════════════════
//  VisionGate — Supabase integration
// ═══════════════════════════════════════════════════════════════

const { createClient } = supabase
const db = createClient(
  'https://blulbaobttmwewxvttql.supabase.co',
  'sb_publishable_RAYD5x0h3bSgkdToX39u8Q_JFYQkZyi'
)

// ── Resolução da URL do backend ────────────────────────────────
// Prioridade: ?backend= na URL → localStorage → config.js → fallback local
// Para uso no deploy: abrir a página com ?backend=https://SEU-TUNNEL.trycloudflare.com
const _BACKEND_STORAGE_KEY = "gv_backend_url"
const BACKEND_URL = (function () {
  const params = new URLSearchParams(window.location.search)
  const fromQuery = params.get("backend")
  if (fromQuery) {
    const clean = fromQuery.replace(/\/$/, "")
    localStorage.setItem(_BACKEND_STORAGE_KEY, clean)
    return clean
  }
  const fromStorage = localStorage.getItem(_BACKEND_STORAGE_KEY)
  if (fromStorage) return fromStorage.replace(/\/$/, "")
  if (window.GATEVISION_BACKEND_URL) return String(window.GATEVISION_BACKEND_URL).replace(/\/$/, "")
  return "http://localhost:8000"
})()
const SESSION_KEY = "gv_session"
const ESTAB_ID    = 1   // estabelecimento padrão

const APP = {
  currentUser:         null,
  currentView:         "dashboard",
  lastDetection:       null,
  lastDecision:        null,
  charts:              { timeline: null, distribution: null },
  dashboardFilterDays: 7,
  _dashboardCache:     null,
  webcamStream:        null
}

// ── Utilidades ────────────────────────────────────────────────

function formatCPF(v) {
  const d = (v || "").replace(/\D/g, "").slice(0, 11)
  return d
    .replace(/^(\d{3})(\d)/, "$1.$2")
    .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1-$2")
}

function onlyPlate(v) {
  return (v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 7)
}

function isAllowedStatus(s) {
  return (s || "").toLowerCase().includes("liberado") ||
         (s || "").toLowerCase().includes("autorizado")
}

function logStatus(l) {
  if (l.autorizado === true)  return { label: "Liberado", ok: true  }
  if (l.autorizado === false) return { label: "Negado",   ok: false }
  const txt = l.status || l.motivo || "-"
  return { label: txt, ok: isAllowedStatus(txt) }
}

function formatDateTime(raw) {
  if (!raw) return "-"
  const d = new Date(raw)
  return isNaN(d.getTime()) ? raw : d.toLocaleString("pt-BR", { hour12: false })
}

function getFilterDateISO(days) {
  if (days === "all") return null
  const n = Number(days)
  if (!n) return null
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString()
}

function defaultDatetime(offsetHours = 0) {
  const d = new Date()
  d.setHours(d.getHours() + offsetHours)
  return d.toISOString().slice(0, 16)
}

function showToast(msg, type = "err") {
  const el = document.createElement("div")
  el.className = type === "ok" ? "chip ok" : "error"
  el.style.cssText =
    "position:fixed;bottom:24px;right:24px;z-index:9999;" +
    "padding:12px 20px;border-radius:8px;max-width:420px;" +
    "font-size:14px;box-shadow:0 4px 16px rgba(0,0,0,.25);"
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 5000)
}

function groupLogsByDay(logs, days) {
  const dayMap      = {}
  const labels      = []
  const allowedData = []
  const deniedData  = []
  const totalDays   = days === "all" ? 7 : Number(days)
  const safeDays    = Number.isFinite(totalDays) && totalDays > 0 ? totalDays : 7
  const now         = new Date()

  for (let i = safeDays - 1; i >= 0; i--) {
    const d   = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`
    dayMap[key] = { allowed: 0, denied: 0 }
    labels.push(`${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}`)
  }

  logs.forEach(l => {
    const raw = l.registrado_em || ""   // campo correto em vw_ultimos_acessos
    if (!raw) return
    const dt = new Date(raw)
    if (isNaN(dt.getTime())) return
    const key = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`
    if (!dayMap[key]) return
    const { ok } = logStatus(l)
    if (ok) dayMap[key].allowed += 1
    else    dayMap[key].denied  += 1
  })

  Object.keys(dayMap).forEach(k => {
    allowedData.push(dayMap[k].allowed)
    deniedData.push(dayMap[k].denied)
  })

  return { labels, allowedData, deniedData }
}

// ── Sessão (localStorage) ─────────────────────────────────────

function getSession()  { try { return JSON.parse(localStorage.getItem(SESSION_KEY)) } catch { return null } }
function setSession(u) { localStorage.setItem(SESSION_KEY, JSON.stringify(u)) }
function clearSession(){ localStorage.removeItem(SESSION_KEY) }

// ── Autenticação ──────────────────────────────────────────────

async function login() {
  const loginInput = document.getElementById("loginUsuario").value.trim()
  const passInput  = document.getElementById("loginSenha").value.trim()
  const errorEl    = document.getElementById("loginError")
  const btn        = document.getElementById("btnLogin")

  if (!loginInput || !passInput) {
    errorEl.textContent = "Preencha usuario e senha."
    errorEl.classList.remove("hidden")
    return
  }

  btn.disabled    = true
  btn.textContent = "Entrando..."

  try {
    const { data, error } = await db
      .from("usuarios_sistema")
      .select("*, pessoas(nome), perfis_acesso(descricao)")
      .eq("login", loginInput)
      .eq("senha_hash", passInput)
      .eq("ativo", true)
      .maybeSingle()

    if (error) throw error

    if (!data) {
      errorEl.textContent = "Usuário ou senha inválidos."
      errorEl.classList.remove("hidden")
      return
    }

    errorEl.classList.add("hidden")
    APP.currentUser = {
      id:       data.id,
      username: data.login,
      nome:     data.pessoas?.nome || data.login,
      role:     data.perfis_acesso?.descricao || "porteiro"
    }
    setSession(APP.currentUser)
    await showApp()

  } catch (e) {
    errorEl.textContent = "Erro ao conectar. Verifique sua conexão."
    errorEl.classList.remove("hidden")
    console.error("login error:", e)
  } finally {
    btn.disabled    = false
    btn.textContent = "Entrar"
  }
}

function logout() {
  APP.currentUser = null
  clearSession()
  document.getElementById("appScreen").classList.add("hidden")
  document.getElementById("loginScreen").classList.remove("hidden")
  document.getElementById("loginSenha").value = ""
}

async function showApp() {
  document.getElementById("loginScreen").classList.add("hidden")
  document.getElementById("appScreen").classList.remove("hidden")
  document.getElementById("userName").textContent = APP.currentUser.nome
  document.getElementById("userRole").textContent = APP.currentUser.role
  APP.currentView = APP.currentUser.role === "admin" ? "dashboard" : "monitor"
  renderNav()
  await renderView()
}

// ── Navegação ─────────────────────────────────────────────────

function navItemsByRole(role) {
  if (role === "admin") {
    return [
      { id: "dashboard",    label: "Visao Geral"                  },
      { id: "monitor",      label: "Monitor de Placas"            },
      { id: "cadastro",     label: "Cadastro de Clientes e Placas" },
      { id: "cameras",      label: "Cameras"                      },
      { id: "autorizacoes", label: "Autorizacoes Temporarias"     },
      { id: "logs",         label: "Historico de Acessos"         }
    ]
  }
  return [
    { id: "monitor",    label: "Monitor de Placas"          },
    { id: "residentes", label: "Cadastro (somente leitura)" },
    { id: "logs",       label: "Historico de Acessos"       }
  ]
}

function renderNav() {
  const menu  = document.getElementById("navMenu")
  const items = navItemsByRole(APP.currentUser.role)
  menu.innerHTML = items.map(i =>
    `<button class="nav-btn ${APP.currentView === i.id ? "active" : ""}" data-view="${i.id}">${i.label}</button>`
  ).join("")
  menu.querySelectorAll(".nav-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      APP.currentView = btn.dataset.view
      renderNav()
      await renderView()
    })
  })
}

// ── Monitor de Placas ─────────────────────────────────────────

async function detectPlate(placa) {
  const clean = onlyPlate(placa)
  APP.lastDetection = null
  APP.lastDecision  = null

  try {
    const { data, error } = await db
      .from("vw_placas_autorizadas")
      .select("*")
      .eq("placa", clean)
      .maybeSingle()

    if (error) throw error

    if (data) {
      APP.lastDetection = {
        placa:  clean,
        status: "autorizado",
        morador: {
          nome:        data.proprietario || "Morador",
          cpf:         "",
          apartamento: data.unidade || "-",   // campo correto da view
          torre:       data.bloco   || "-"    // campo correto da view
        }
      }
    } else {
      APP.lastDetection = { placa: clean, status: "nao-cadastrado", morador: null }
    }
  } catch (e) {
    showToast("Erro ao verificar placa: " + e.message)
    console.error("detectPlate:", e)
    APP.lastDetection = { placa: clean, status: "nao-cadastrado", morador: null }
  }

  await renderView()
}

async function detectPlateFromImage(file) {
  APP.lastDetection = null
  APP.lastDecision  = null

  try {
    const form = new FormData()
    form.append("file", file)

    const res  = await fetch(`${BACKEND_URL}/api/detect`, { method: "POST", body: form })
    if (!res.ok) throw new Error(`Servidor retornou ${res.status}`)

    const json = await res.json()

    if (!json.placa) {
      showToast("Nenhuma placa detectada na imagem.")
      APP.lastDetection = { placa: "---", status: "nao-detectado", morador: null }
      await renderView()
      return
    }

    const clean = onlyPlate(json.placa)
    const detectInput = document.getElementById("detectInput")
    if (detectInput) detectInput.value = clean

    await detectPlate(clean)
  } catch (e) {
    showToast("Erro ao processar imagem: " + e.message)
    console.error("detectPlateFromImage:", e)
    await renderView()
  }
}

// ── Webcam ─────────────────────────────────────────────────────

function _webcamShowVideo() {
  const video       = document.getElementById("webcamVideo")
  const previewWrap = document.getElementById("imgPreviewWrap")
  const placeholder = document.getElementById("cameraPlaceholder")
  if (video)       { video.style.display       = "block" }
  if (previewWrap) { previewWrap.style.display  = "none"  }
  if (placeholder) { placeholder.style.display  = "none"  }
}

function _webcamShowPlaceholder() {
  const video       = document.getElementById("webcamVideo")
  const previewWrap = document.getElementById("imgPreviewWrap")
  const placeholder = document.getElementById("cameraPlaceholder")
  if (video)       { video.style.display       = "none"  }
  if (previewWrap) { previewWrap.style.display  = "none"  }
  if (placeholder) { placeholder.style.display  = ""      }
}

async function startWebcam() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast("Seu navegador nao suporta acesso a webcam.")
    return
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true })
    APP.webcamStream = stream

    const video = document.getElementById("webcamVideo")
    if (!video) return
    video.srcObject = stream

    _webcamShowVideo()

    const btnStart  = document.getElementById("btnStartWebcam")
    const btnDetect = document.getElementById("btnDetectWebcam")
    const btnStop   = document.getElementById("btnStopWebcam")
    if (btnStart)  { btnStart.disabled = true }
    if (btnDetect) { btnDetect.disabled = false }
    if (btnStop)   { btnStop.style.display = "" }
  } catch (err) {
    const msg = err.name === "NotAllowedError"
      ? "Permissao de camera negada. Permita o acesso no navegador."
      : err.name === "NotFoundError"
        ? "Nenhuma camera encontrada no dispositivo."
        : "Erro ao acessar a webcam: " + err.message
    showToast(msg)
  }
}

function stopWebcam() {
  if (APP.webcamStream) {
    APP.webcamStream.getTracks().forEach(t => t.stop())
    APP.webcamStream = null
  }
  const video = document.getElementById("webcamVideo")
  if (video) { video.srcObject = null }

  _webcamShowPlaceholder()

  const btnStart  = document.getElementById("btnStartWebcam")
  const btnDetect = document.getElementById("btnDetectWebcam")
  const btnStop   = document.getElementById("btnStopWebcam")
  if (btnStart)  { btnStart.disabled = false }
  if (btnDetect) { btnDetect.disabled = true }
  if (btnStop)   { btnStop.style.display = "none" }
}

async function captureAndDetectWebcam() {
  const video = document.getElementById("webcamVideo")
  if (!video || !APP.webcamStream) {
    showToast("Webcam nao esta ativa.")
    return
  }
  const canvas  = document.createElement("canvas")
  canvas.width  = video.videoWidth  || 640
  canvas.height = video.videoHeight || 480
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height)

  canvas.toBlob(async blob => {
    if (!blob) { showToast("Erro ao capturar frame da webcam."); return }
    const file = new File([blob], "webcam_frame.jpg", { type: "image/jpeg" })

    const preview     = document.getElementById("imgPreview")
    const previewWrap = document.getElementById("imgPreviewWrap")
    const webcamVideo = document.getElementById("webcamVideo")
    if (preview && previewWrap) {
      preview.src = URL.createObjectURL(file)
      previewWrap.style.display = "block"
    }
    if (webcamVideo) { webcamVideo.style.display = "none" }

    stopWebcam()

    const btnDetect = document.getElementById("btnDetectWebcam")
    if (btnDetect) { btnDetect.disabled = true; btnDetect.textContent = "Detectando..." }

    await detectPlateFromImage(file)
  }, "image/jpeg", 0.92)
}

async function openGateManual() {
  if (!APP.lastDetection) return
  const placa = APP.lastDetection.placa

  try {
    const { error } = await db.rpc("registrar_acesso", {
      p_placa:      placa,
      p_camera_id:  1,
      p_confianca:  100,
      p_imagem_url: null,
      p_tempo_ms:   null
    })
    if (error) throw error

    APP.lastDecision = "liberado"
    showToast("Portao aberto pelo porteiro.", "ok")
  } catch (e) {
    showToast("Erro ao registrar abertura: " + e.message)
    console.error("openGateManual:", e)
  }

  try {
    await fetch(`${BACKEND_URL}/api/open-gate`, { method: "POST" })
  } catch (e) {
    console.warn("open-gate: backend indisponivel ou Arduino nao conectado.", e)
  }

  await renderView()
}

async function denyAccess() {
  if (!APP.lastDetection) return
  const d = APP.lastDetection

  try {
    const { error } = await db.from("acessos").insert({
      placa_detectada: d.placa,
      camera_id:       1,
      autorizado:      false,
      motivo_bloqueio: "Negado pelo porteiro",
      confianca:       100
    })
    if (error) throw error

    APP.lastDecision = "negado"
    showToast("Acesso negado registrado.", "ok")
  } catch (e) {
    showToast("Erro ao registrar negacao: " + e.message)
    console.error("denyAccess:", e)
  }

  await renderView()
}

// ── Dashboard ─────────────────────────────────────────────────

async function renderDashboard() {
  const minDate = getFilterDateISO(APP.dashboardFilterDays)

  let logsQuery = db.from("vw_ultimos_acessos").select("*")
  if (minDate) logsQuery = logsQuery.gte("registrado_em", minDate)

  const [logsRes, countRes] = await Promise.all([
    logsQuery,
    db.from("pessoas").select("*", { count: "exact", head: true })
  ])

  if (logsRes.error)  { showToast("Erro ao carregar acessos."); console.error(logsRes.error)  }
  if (countRes.error) { showToast("Erro ao contar clientes.");  console.error(countRes.error) }

  const logs          = logsRes.data || []
  const totalClientes = countRes.count || 0
  const liberados     = logs.filter(l => logStatus(l).ok).length
  const negados       = logs.filter(l => !logStatus(l).ok).length
  const total         = liberados + negados
  const percent       = total ? Math.round((liberados / total) * 100) : 0
  const latest        = logs.slice(0, 5)

  APP._dashboardCache = { logs, liberados, negados }

  return `
    <div class="page-stack">
      <div class="hero-card">
        <div class="hero-grid">
          <div>
            <div class="eyebrow">Visao operacional</div>
            <h2 class="section-title">Acesso monitorado com leitura de placa em tempo real</h2>
            <p class="section-sub">Resumo do fluxo da portaria, desempenho de liberações e acompanhamento das últimas ocorrências registradas pelo sistema.</p>
            <div class="hero-meta">
              <span class="chip ok">${liberados} liberados</span>
              <span class="chip warn">${negados} negados</span>
              <span class="chip">${totalClientes} clientes cadastrados</span>
            </div>
          </div>
          <div class="hero-note">
            <div>
              <div class="eyebrow">Taxa de aprovacao</div>
              <strong>${percent}%</strong>
            </div>
            <p class="section-sub">Base calculada sobre ${total} acessos avaliados no periodo filtrado.</p>
          </div>
        </div>
      </div>

      <div class="dashboard-toolbar">
        <div>
          <label class="login-sub">Periodo dos Relatórios</label>
          <select id="dashboardFilter" class="input">
            <option value="7"   ${String(APP.dashboardFilterDays) === "7"   ? "selected" : ""}>Ultimos 7 dias</option>
            <option value="15"  ${String(APP.dashboardFilterDays) === "15"  ? "selected" : ""}>Ultimos 15 dias</option>
            <option value="30"  ${String(APP.dashboardFilterDays) === "30"  ? "selected" : ""}>Ultimos 30 dias</option>
            <option value="all" ${String(APP.dashboardFilterDays) === "all" ? "selected" : ""}>Todos os registros</option>
          </select>
        </div>
      </div>

      <div class="grid-3">
        <div class="kpi"><div class="kpi-label">Clientes cadastrados</div><div class="kpi-val">${totalClientes}</div><div class="kpi-sub">Base ativa monitorada</div></div>
        <div class="kpi"><div class="kpi-label">Acessos permitidos</div><div class="kpi-val">${liberados}</div><div class="kpi-sub">${percent}% de aprovacao</div></div>
        <div class="kpi"><div class="kpi-label">Acessos negados</div><div class="kpi-val">${negados}</div><div class="kpi-sub">${total} analisados</div></div>
      </div>

      <div class="chart-grid">
        <div class="chart-card">
          <div class="chart-title">Historico de acessos por dia</div>
          <div class="chart-canvas-wrap"><canvas id="chartTimeline"></canvas></div>
        </div>
        <div class="chart-card">
          <div class="chart-title">Distribuicao de acessos</div>
          <div class="chart-canvas-wrap"><canvas id="chartDistribution"></canvas></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">Ultimos acessos registrados</div>
        <div class="card-body">
          ${latest.length ? `
            <div class="last-access-list">
              ${latest.map(item => {
                const { label, ok } = logStatus(item)
                const nome = item.proprietario || "-"
                return `
                  <div class="last-access-item">
                    <div class="last-access-main">${item.placa_detectada} - ${nome}</div>
                    <div class="last-access-status ${ok ? "ok" : "err"}">${label}</div>
                    <div class="last-access-meta">${formatDateTime(item.registrado_em)} - ${item.camera || "-"}</div>
                  </div>`
              }).join("")}
            </div>
          ` : `<div class="empty">Sem registros para o periodo selecionado.</div>`}
        </div>
      </div>
    </div>`
}

function drawDashboardCharts() {
  if (APP.currentView !== "dashboard") return
  const tlCanvas   = document.getElementById("chartTimeline")
  const distCanvas = document.getElementById("chartDistribution")
  if (!tlCanvas || !distCanvas || typeof Chart === "undefined") return
  if (!APP._dashboardCache) return

  const { logs, liberados, negados } = APP._dashboardCache
  const grouped = groupLogsByDay(logs, APP.dashboardFilterDays)

  if (APP.charts.timeline)     APP.charts.timeline.destroy()
  if (APP.charts.distribution) APP.charts.distribution.destroy()

  APP.charts.timeline = new Chart(tlCanvas, {
    type: "line",
    data: {
      labels: grouped.labels,
      datasets: [
        { label: "Permitidos", data: grouped.allowedData, borderColor: "#1f8b56", backgroundColor: "rgba(31,139,86,0.15)", tension: 0.3, fill: true },
        { label: "Negados",    data: grouped.deniedData,  borderColor: "#c33a2f", backgroundColor: "rgba(195,58,47,0.12)",  tension: 0.3, fill: true }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "top",
          labels: { color: "#dce7dc" }
        }
      },
      scales: {
        x: {
          ticks: { color: "#8fa291" },
          grid: { color: "rgba(255,255,255,0.06)" }
        },
        y: {
          beginAtZero: true,
          ticks: { precision: 0, color: "#8fa291" },
          grid: { color: "rgba(255,255,255,0.06)" }
        }
      }
    }
  })

  APP.charts.distribution = new Chart(distCanvas, {
    type: "doughnut",
    data: {
      labels: ["Permitidos", "Negados"],
      datasets: [{ data: [liberados, negados], backgroundColor: ["#1f8b56", "#c33a2f"], borderWidth: 0 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "bottom",
          labels: { color: "#dce7dc" }
        }
      }
    }
  })
}

// ── Cadastro de Clientes ──────────────────────────────────────

async function fetchResidents() {
  try {
    const [pessoasRes, veiculosRes, vinculosRes] = await Promise.all([
      db.from("pessoas").select("id, nome, cpf"),
      db.from("veiculos").select("id, placa, modelo, pessoa_id"),
      db.from("vinculos").select("pessoa_id, unidades(identificacao, blocos(nome))")
    ])

    if (pessoasRes.error)  throw pessoasRes.error
    if (veiculosRes.error) throw veiculosRes.error
    if (vinculosRes.error) throw vinculosRes.error

    return (pessoasRes.data || []).map(p => {
      const veiculo = (veiculosRes.data || []).find(v => v.pessoa_id === p.id)
      const vinculo = (vinculosRes.data || []).find(v => v.pessoa_id === p.id)
      const unidade = vinculo?.unidades
      const bloco   = unidade?.blocos
      return {
        id:          p.id,
        nome:        p.nome,
        cpf:         p.cpf,
        apartamento: unidade?.identificacao || "-",
        torre:       bloco?.nome            || "-",
        placa:       veiculo?.placa         || "-",
        veiculo:     veiculo?.modelo        || "-"
      }
    })
  } catch (e) {
    showToast("Erro ao carregar clientes: " + e.message)
    console.error("fetchResidents:", e)
    return []
  }
}

async function saveResident(novo) {
  try {
    // 1. Verifica duplicatas
    const [cpfRes, placaRes] = await Promise.all([
      db.from("pessoas").select("id").eq("cpf", novo.cpf).maybeSingle(),
      db.from("veiculos").select("id").eq("placa", novo.placa).maybeSingle()
    ])
    if (cpfRes.error)  throw cpfRes.error
    if (placaRes.error) throw placaRes.error
    if (cpfRes.data)   { showToast("CPF já cadastrado.");   return false }
    if (placaRes.data) { showToast("Placa já cadastrada."); return false }

    // 2. Busca ou cria bloco filtrado pelo estabelecimento
    let { data: bloco, error: blocoErr } = await db.from("blocos").select("id")
      .ilike("nome", novo.torre)
      .eq("estabelecimento_id", ESTAB_ID)
      .maybeSingle()
    if (blocoErr) throw blocoErr

    if (!bloco) {
      const res = await db.from("blocos")
        .insert({ nome: novo.torre, estabelecimento_id: ESTAB_ID })
        .select("id").single()
      if (res.error) throw res.error
      bloco = res.data
    }

    // 3. Busca ou cria unidade
    let { data: unidade, error: unidErr } = await db.from("unidades").select("id")
      .eq("identificacao", novo.apartamento)
      .eq("bloco_id", bloco.id)
      .maybeSingle()
    if (unidErr) throw unidErr

    if (!unidade) {
      const res = await db.from("unidades")
        .insert({ identificacao: novo.apartamento, bloco_id: bloco.id })
        .select("id").single()
      if (res.error) throw res.error
      unidade = res.data
    }

    // 4. Cria pessoa
    const pessoaRes = await db.from("pessoas")
      .insert({ nome: novo.nome, cpf: novo.cpf })
      .select("id").single()
    if (pessoaRes.error) throw pessoaRes.error
    const pessoaId = pessoaRes.data.id

    // 5. Vínculo pessoa <-> unidade (tipo_vinculo_id=1 = morador)
    const vinRes = await db.from("vinculos").insert({
      pessoa_id:       pessoaId,
      unidade_id:      unidade.id,
      tipo_vinculo_id: 1
    })
    if (vinRes.error) throw vinRes.error

    // 6. Cria veículo (tipo_veiculo_id=1 = carro)
    const veiRes = await db.from("veiculos").insert({
      placa:           novo.placa,
      modelo:          novo.veiculo || null,
      pessoa_id:       pessoaId,
      tipo_veiculo_id: 1
    })
    if (veiRes.error) throw veiRes.error

    showToast("Cadastro salvo com sucesso!", "ok")
    return true
  } catch (e) {
    showToast("Erro ao salvar cadastro: " + e.message)
    console.error("saveResident:", e)
    return false
  }
}

async function deleteResident(pessoaId) {
  try {
    const [vinRes, veiRes] = await Promise.all([
      db.from("vinculos").delete().eq("pessoa_id", pessoaId),
      db.from("veiculos").delete().eq("pessoa_id", pessoaId)
    ])
    if (vinRes.error) throw vinRes.error
    if (veiRes.error) throw veiRes.error

    const pRes = await db.from("pessoas").delete().eq("id", pessoaId)
    if (pRes.error) throw pRes.error

    showToast("Cadastro removido.", "ok")
    return true
  } catch (e) {
    showToast("Erro ao remover cadastro: " + e.message)
    console.error("deleteResident:", e)
    return false
  }
}

async function renderCadastroAdmin() {
  const residents = await fetchResidents()
  return `
    <div class="page-stack">
      <div class="panel-header">
        <div>
          <div class="eyebrow">Cadastro residencial</div>
          <h2 class="section-title">Gestao de moradores e veiculos</h2>
          <p class="section-sub">Cadastre moradores, associe placas e mantenha a base de acesso sempre atualizada.</p>
        </div>
        <div class="panel-actions">
          <button id="btnOpenResidentModal" class="btn primary">Cadastrar placa e morador</button>
        </div>
      </div>
      <div class="card">
        <div class="card-head">Clientes Cadastrados</div>
        <div class="card-body table-wrap">
          ${renderResidentsTable(residents, true)}
        </div>
      </div>
    </div>`
}

function renderResidentsTable(residents, allowDelete) {
  if (!residents.length) return `<div class="empty">Nenhum cliente cadastrado.</div>`
  return `
    <table>
      <thead>
        <tr>
          <th>Nome</th><th>CPF</th><th>Apto</th><th>Torre</th><th>Placa</th><th>Veiculo</th><th>Vaga</th>
          ${allowDelete ? "<th>Acoes</th>" : ""}
        </tr>
      </thead>
      <tbody>
        ${residents.map(r => `
          <tr>
            <td>${r.nome}</td>
            <td class="mono">${formatCPF(r.cpf)}</td>
            <td>${r.apartamento}</td>
            <td>${r.torre}</td>
            <td class="mono">${r.placa}</td>
            <td>${r.veiculo || "-"}</td>
            <td>-</td>
            ${allowDelete ? `<td><button class="btn" data-del="${r.id}">Excluir</button></td>` : ""}
          </tr>`).join("")}
      </tbody>
    </table>`
}

async function renderResidentsReadOnly() {
  const residents = await fetchResidents()
  return `
    <div class="page-stack">
      <div class="panel-header">
        <div>
          <div class="eyebrow">Consulta</div>
          <h2 class="section-title">Base de clientes</h2>
          <p class="section-sub">Visualização em modo leitura para conferência rápida dos moradores e placas vinculadas.</p>
        </div>
      </div>
      <div class="card">
        <div class="card-head">Cadastro de Clientes (Leitura)</div>
        <div class="card-body table-wrap">
          ${renderResidentsTable(residents, false)}
        </div>
      </div>
    </div>`
}

// ── Histórico de Acessos ──────────────────────────────────────

async function renderLogs() {
  try {
    const { data, error } = await db
      .from("vw_ultimos_acessos")
      .select("*")
      .limit(200)

    if (error) throw error

    const logs = data || []
    return `
      <div class="page-stack">
        <div class="panel-header">
          <div>
            <div class="eyebrow">Rastreabilidade</div>
            <h2 class="section-title">Historico de acessos</h2>
            <p class="section-sub">Até 200 registros recentes para auditoria da entrada, identificação da câmera e decisão tomada.</p>
          </div>
        </div>
        <div class="card">
          <div class="card-head">Historico de acessos</div>
          <div class="card-body table-wrap">
            ${logs.length ? `
              <table>
                <thead>
                  <tr><th>Data/Hora</th><th>Placa</th><th>Morador</th><th>Camera</th><th>Status</th></tr>
                </thead>
                <tbody>
                  ${logs.map(l => {
                    const { label, ok } = logStatus(l)
                    const nome = l.proprietario || "-"
                    return `
                      <tr>
                        <td>${formatDateTime(l.registrado_em)}</td>
                        <td class="mono">${l.placa_detectada}</td>
                        <td>${nome}</td>
                        <td>${l.camera || "-"}</td>
                        <td class="${ok ? "table-status-ok" : "table-status-err"}">${label}</td>
                      </tr>`
                  }).join("")}
                </tbody>
              </table>
            ` : `<div class="empty">Sem registros de acesso no momento.</div>`}
          </div>
        </div>
      </div>`
  } catch (e) {
    showToast("Erro ao carregar historico: " + e.message)
    console.error("renderLogs:", e)
    return `<div class="card"><div class="card-body"><div class="empty">Erro ao carregar historico.</div></div></div>`
  }
}

// ── Monitor Porteiro ──────────────────────────────────────────

function renderMonitorPorteiro() {
  const d        = APP.lastDetection
  const decision = APP.lastDecision

  const statusChip = !d
    ? `<span class="chip warn">Aguardando identificacao</span>`
    : decision === "liberado"
      ? `<span class="chip ok">Acesso liberado pelo porteiro</span>`
      : decision === "negado"
        ? `<span class="chip err">Acesso negado pelo porteiro</span>`
        : d.status === "autorizado"
          ? `<span class="chip warn">Placa cadastrada (aguardando acao)</span>`
          : `<span class="chip warn">Placa nao cadastrada (aguardando acao)</span>`

  const imgLiberado = "data:image/svg+xml;utf8," + encodeURIComponent(`
    <svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 400'>
      <defs><linearGradient id='g' x1='0' x2='1' y1='0' y2='1'><stop offset='0%' stop-color='#14532d'/><stop offset='100%' stop-color='#22c55e'/></linearGradient></defs>
      <rect width='800' height='400' fill='url(#g)'/>
      <circle cx='140' cy='200' r='74' fill='rgba(255,255,255,0.15)'/>
      <path d='M105 200l28 28 60-70' stroke='white' stroke-width='18' fill='none' stroke-linecap='round' stroke-linejoin='round'/>
      <text x='250' y='180' font-family='Arial, sans-serif' font-size='44' fill='white' font-weight='700'>ACESSO LIBERADO</text>
      <text x='250' y='225' font-family='Arial, sans-serif' font-size='26' fill='rgba(255,255,255,0.92)'>Morador identificado no cadastro</text>
    </svg>`)
  const imgNegado = "data:image/svg+xml;utf8," + encodeURIComponent(`
    <svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 400'>
      <defs><linearGradient id='g2' x1='0' x2='1' y1='0' y2='1'><stop offset='0%' stop-color='#7f1d1d'/><stop offset='100%' stop-color='#ef4444'/></linearGradient></defs>
      <rect width='800' height='400' fill='url(#g2)'/>
      <circle cx='140' cy='200' r='74' fill='rgba(255,255,255,0.15)'/>
      <path d='M100 160l80 80M180 160l-80 80' stroke='white' stroke-width='16' stroke-linecap='round'/>
      <text x='250' y='180' font-family='Arial, sans-serif' font-size='44' fill='white' font-weight='700'>ACESSO NEGADO</text>
      <text x='250' y='225' font-family='Arial, sans-serif' font-size='26' fill='rgba(255,255,255,0.92)'>Placa nao encontrada no cadastro</text>
    </svg>`)

  const statusImage = !d
    ? `<div class="status-empty">Aguardando leitura da placa...</div>`
    : decision === "liberado"
      ? `<img class="status-image" src="${imgLiberado}" alt="Status de acesso liberado">`
      : decision === "negado"
        ? `<img class="status-image" src="${imgNegado}" alt="Status de acesso negado">`
        : `<div class="status-empty">Placa identificada. Escolha liberar ou negar acesso.</div>`

  return `
    <div class="page-stack">
      <div class="hero-card">
        <div class="hero-grid">
          <div>
            <div class="eyebrow">Monitor de leitura</div>
            <h2 class="section-title">Triagem de veículos na entrada principal</h2>
            <p class="section-sub">Envie imagem, use a webcam ou digite a placa manualmente para validar a autorização e decidir a abertura do portão.</p>
            <div class="hero-meta">
              ${statusChip}
            </div>
          </div>
          <div class="hero-note">
            <div>
              <div class="eyebrow">Ultima placa</div>
              <strong class="mono">${d ? d.placa : "---"}</strong>
            </div>
            <p class="section-sub">${d && d.morador ? d.morador.nome : "Aguardando identificação para exibir dados do morador."}</p>
          </div>
        </div>
      </div>

      <div class="monitor-layout">
        <div class="monitor-tools">
          <div class="card">
            <div class="card-head">Captura e leitura</div>
            <div class="card-body">
              <div class="camera" id="cameraPreview">
                <div id="imgPreviewWrap" style="display:none;width:100%;height:100%;overflow:hidden;">
                  <img id="imgPreview" style="width:100%;height:100%;object-fit:contain;" />
                </div>
                <video id="webcamVideo" class="webcam-video" style="display:none;" autoplay playsinline muted></video>
                <div id="cameraPlaceholder">
                  Envie uma foto, use a webcam<br>ou digite a placa manualmente
                </div>
              </div>
              <div class="monitor-toolbar" style="margin-top:12px;">
                <input id="detectInput" class="input mono" placeholder="Ex: BRA2E24" maxlength="7">
                <button id="btnDetect" class="btn primary">Identificar placa</button>
              </div>
              <div class="monitor-toolbar" style="margin-top:10px;">
                <input type="file" id="imageInput" accept="image/*" style="display:none;">
                <button id="btnUpload" class="btn">Enviar foto</button>
                <button id="btnDetectImage" class="btn primary" disabled>Detectar na foto</button>
              </div>
              <div class="monitor-toolbar" style="margin-top:10px;">
                <button id="btnStartWebcam" class="btn">Usar webcam</button>
                <button id="btnDetectWebcam" class="btn primary" disabled>Detectar pela webcam</button>
                <button id="btnStopWebcam" class="btn err" style="display:none;">Parar webcam</button>
              </div>
            </div>
          </div>

          <div class="monitor-banner">
            <strong>Fluxo recomendado</strong>
            <p class="section-sub">Primeiro capture a placa. Depois confira o morador identificado e finalize com liberação ou negação para registrar o evento no histórico.</p>
          </div>
        </div>

        <div class="monitor-result">
          <div class="card">
            <div class="card-head">Resultado da leitura</div>
            <div class="card-body">
              <div class="status-image-wrap">${statusImage}</div>
              <div style="margin-bottom:12px;">${statusChip}</div>
              <div class="status-box">
                <div class="row"><span>Placa</span><strong class="mono">${d ? d.placa : "---"}</strong></div>
                <div class="row"><span>Morador</span><strong>${d && d.morador ? d.morador.nome : "-"}</strong></div>
                <div class="row"><span>CPF</span><strong>${d && d.morador ? formatCPF(d.morador.cpf) : "-"}</strong></div>
                <div class="row"><span>Apartamento</span><strong>${d && d.morador ? `${d.morador.apartamento} - Torre ${d.morador.torre}` : "-"}</strong></div>
              </div>
              <div class="actions" style="margin-top:12px;">
                <button id="btnOpenGate" class="btn ok" ${d && !decision ? "" : "disabled"}>Abrir portao</button>
                <button id="btnDeny" class="btn err" ${d && !decision ? "" : "disabled"}>Negar acesso</button>
              </div>
            </div>
          </div>

          <div class="split-card">
            <div class="metric-mini">
              <span>Status atual</span>
              <strong>${decision ? decision.toUpperCase() : "EM ANALISE"}</strong>
            </div>
            <div class="metric-mini">
              <span>Origem</span>
              <strong>${d ? "PLACA DETECTADA" : "AGUARDANDO"}</strong>
            </div>
          </div>
        </div>
      </div>
    </div>`
}

// ── Câmeras ───────────────────────────────────────────────────

async function fetchCameras() {
  try {
    const { data, error } = await db
      .from("cameras")
      .select("id, nome, localizacao, tipos_camera(descricao)")
      .eq("estabelecimento_id", ESTAB_ID)
      .eq("ativo", true)
    if (error) throw error
    return (data || []).map(c => ({
      id:          c.id,
      nome:        c.nome,
      localizacao: c.localizacao || "-",
      tipo:        c.tipos_camera?.descricao || "-"
    }))
  } catch (e) {
    showToast("Erro ao carregar cameras: " + e.message)
    console.error("fetchCameras:", e)
    return []
  }
}

async function saveCamara(novo) {
  try {
    const { error } = await db.from("cameras").insert({
      nome:               novo.nome,
      localizacao:        novo.localizacao,
      tipo_camera_id:     parseInt(novo.tipo_camera_id),
      estabelecimento_id: ESTAB_ID
    })
    if (error) throw error
    showToast("Camera salva com sucesso!", "ok")
    return true
  } catch (e) {
    showToast("Erro ao salvar camera: " + e.message)
    console.error("saveCamara:", e)
    return false
  }
}

async function deleteCamara(id) {
  try {
    const { error } = await db.from("cameras").update({ ativo: false }).eq("id", id)
    if (error) throw error
    showToast("Camera removida.", "ok")
    return true
  } catch (e) {
    showToast("Erro ao remover camera: " + e.message)
    console.error("deleteCamara:", e)
    return false
  }
}

async function renderCameras() {
  const cameras = await fetchCameras()
  return `
    <div class="page-stack">
      <div class="panel-header">
        <div>
          <div class="eyebrow">Infraestrutura</div>
          <h2 class="section-title">Cameras do sistema</h2>
          <p class="section-sub">Cadastre os pontos de captura e organize os equipamentos de entrada, saída e garagem.</p>
        </div>
        <div class="panel-actions">
          <button id="btnOpenCameraModal" class="btn primary">Cadastrar camera</button>
        </div>
      </div>
      <div class="card">
        <div class="card-head">Cameras Cadastradas</div>
        <div class="card-body table-wrap">
          ${cameras.length ? `
            <table>
              <thead>
                <tr><th>Nome</th><th>Localizacao</th><th>Tipo</th><th>Acoes</th></tr>
              </thead>
              <tbody>
                ${cameras.map(c => `
                  <tr>
                    <td>${c.nome}</td>
                    <td>${c.localizacao}</td>
                    <td>${c.tipo}</td>
                    <td><button class="btn" data-del-cam="${c.id}">Remover</button></td>
                  </tr>`).join("")}
              </tbody>
            </table>
          ` : `<div class="empty">Nenhuma camera cadastrada.</div>`}
        </div>
      </div>
    </div>`
}

// ── Autorizações Temporárias ──────────────────────────────────

async function fetchAutorizacoes() {
  try {
    const { data, error } = await db
      .from("autorizacoes_temporarias")
      .select("id, placa, nome_autorizado, motivo, data_inicio, data_fim")
      .eq("estabelecimento_id", ESTAB_ID)
      .eq("ativo", true)
      .gte("data_fim", new Date().toISOString())
      .order("data_fim", { ascending: true })
    if (error) throw error
    return data || []
  } catch (e) {
    showToast("Erro ao carregar autorizacoes: " + e.message)
    console.error("fetchAutorizacoes:", e)
    return []
  }
}

async function saveAutorizacao(novo) {
  try {
    const { error } = await db.from("autorizacoes_temporarias").insert({
      placa:              novo.placa,
      nome_autorizado:    novo.nome_autorizado,
      motivo:             novo.motivo || null,
      data_inicio:        novo.data_inicio,
      data_fim:           novo.data_fim,
      estabelecimento_id: ESTAB_ID
    })
    if (error) throw error
    showToast("Autorizacao criada com sucesso!", "ok")
    return true
  } catch (e) {
    showToast("Erro ao criar autorizacao: " + e.message)
    console.error("saveAutorizacao:", e)
    return false
  }
}

async function deleteAutorizacao(id) {
  try {
    const { error } = await db.from("autorizacoes_temporarias")
      .update({ ativo: false })
      .eq("id", id)
    if (error) throw error
    showToast("Autorizacao cancelada.", "ok")
    return true
  } catch (e) {
    showToast("Erro ao cancelar autorizacao: " + e.message)
    console.error("deleteAutorizacao:", e)
    return false
  }
}

async function renderAutorizacoes() {
  const lista = await fetchAutorizacoes()
  return `
    <div class="page-stack">
      <div class="panel-header">
        <div>
          <div class="eyebrow">Permissoes temporarias</div>
          <h2 class="section-title">Liberacoes para visitantes</h2>
          <p class="section-sub">Cadastre acessos com validade limitada para prestadores, entregas e visitantes fora da base principal.</p>
        </div>
        <div class="panel-actions">
          <button id="btnOpenAutorizacaoModal" class="btn primary">Criar autorizacao</button>
        </div>
      </div>
      <div class="card">
        <div class="card-head">Autorizacoes Ativas</div>
        <div class="card-body table-wrap">
          ${lista.length ? `
            <table>
              <thead>
                <tr><th>Placa</th><th>Visitante</th><th>Motivo</th><th>Inicio</th><th>Validade</th><th>Acoes</th></tr>
              </thead>
              <tbody>
                ${lista.map(a => `
                  <tr>
                    <td class="mono">${a.placa}</td>
                    <td>${a.nome_autorizado}</td>
                    <td>${a.motivo || "-"}</td>
                    <td>${formatDateTime(a.data_inicio)}</td>
                    <td>${formatDateTime(a.data_fim)}</td>
                    <td><button class="btn err" data-del-auth="${a.id}">Cancelar</button></td>
                  </tr>`).join("")}
              </tbody>
            </table>
          ` : `<div class="empty">Nenhuma autorizacao ativa no momento.</div>`}
        </div>
      </div>
    </div>`
}

// ── renderView ────────────────────────────────────────────────

function renderResidentForm() {
  return `
    <form id="residentForm" class="form-grid">
      <div><label class="login-sub">Nome completo</label><input required id="fNome" class="input" /></div>
      <div><label class="login-sub">CPF</label><input required id="fCpf" class="input" maxlength="14" /></div>
      <div><label class="login-sub">Apartamento</label><input required id="fApto" class="input" /></div>
      <div><label class="login-sub">Torre</label><input required id="fTorre" class="input" /></div>
      <div><label class="login-sub">Placa</label><input required id="fPlaca" class="input mono" maxlength="7" /></div>
      <div><label class="login-sub">Veiculo</label><input id="fVeiculo" class="input" /></div>
      <div><label class="login-sub">Vaga</label><input id="fVaga" class="input" /></div>
      <div class="form-actions modal-actions">
        <button class="btn primary" type="submit">Salvar Cadastro</button>
        <button class="btn" type="button" data-close-modal>Cancelar</button>
      </div>
    </form>`
}

function renderCameraForm() {
  return `
    <form id="cameraForm" class="form-grid">
      <div><label class="login-sub">Nome da Camera</label><input required id="camNome" class="input" placeholder="Ex: CAM-PORT-01" /></div>
      <div><label class="login-sub">Localizacao</label><input required id="camLocal" class="input" placeholder="Ex: Portaria Principal" /></div>
      <div>
        <label class="login-sub">Tipo</label>
        <select required id="camTipo" class="input">
          <option value="1">Entrada</option>
          <option value="2">Saida</option>
          <option value="3">Garagem</option>
          <option value="4">Estacionamento</option>
        </select>
      </div>
      <div class="form-actions modal-actions">
        <button class="btn primary" type="submit">Salvar Camera</button>
        <button class="btn" type="button" data-close-modal>Cancelar</button>
      </div>
    </form>`
}

function renderAutorizacaoForm() {
  return `
    <form id="autorizacaoForm" class="form-grid">
      <div><label class="login-sub">Placa</label><input required id="atPlaca" class="input mono" maxlength="7" placeholder="Ex: TMP1A23" /></div>
      <div><label class="login-sub">Nome do Visitante</label><input required id="atNome" class="input" placeholder="Ex: Pedro Encanador" /></div>
      <div><label class="login-sub">Motivo</label><input id="atMotivo" class="input" placeholder="Ex: manutencao, visita, entrega" /></div>
      <div></div>
      <div><label class="login-sub">Inicio</label><input required id="atInicio" type="datetime-local" class="input" value="${defaultDatetime()}" /></div>
      <div><label class="login-sub">Fim</label><input required id="atFim" type="datetime-local" class="input" value="${defaultDatetime(24)}" /></div>
      <div class="form-actions modal-actions">
        <button class="btn primary" type="submit">Criar Autorizacao</button>
        <button class="btn" type="button" data-close-modal>Cancelar</button>
      </div>
    </form>`
}

function openModal(title, content) {
  const modal = document.getElementById("appModal")
  const titleEl = document.getElementById("appModalTitle")
  const bodyEl = document.getElementById("appModalBody")
  if (!modal || !titleEl || !bodyEl) return
  titleEl.textContent = title
  bodyEl.innerHTML = content
  modal.classList.remove("hidden")
  document.body.classList.add("modal-open")
}

function closeModal() {
  const modal = document.getElementById("appModal")
  const bodyEl = document.getElementById("appModalBody")
  if (!modal || !bodyEl) return
  modal.classList.add("hidden")
  bodyEl.innerHTML = ""
  document.body.classList.remove("modal-open")
}

function bindModalShell() {
  const modal = document.getElementById("appModal")
  if (!modal || modal.dataset.bound === "true") return
  modal.dataset.bound = "true"

  modal.addEventListener("click", (e) => {
    if (e.target === modal || e.target.closest("[data-close-modal]")) closeModal()
  })

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal()
  })
}

async function renderView() {
  const titleMap = {
    dashboard:    "Visao Geral",
    cadastro:     "Cadastro de Clientes e Placas",
    cameras:      "Cameras",
    autorizacoes: "Autorizacoes Temporarias",
    monitor:      "Monitor de Placas",
    residentes:   "Cadastro de Clientes",
    logs:         "Historico de Acessos"
  }
  document.getElementById("viewTitle").textContent = titleMap[APP.currentView] || "Painel"

  // Libera a câmera se o usuário sair da tela de monitor
  if (APP.webcamStream && APP.currentView !== "monitor") {
    APP.webcamStream.getTracks().forEach(t => t.stop())
    APP.webcamStream = null
  }

  const vc = document.getElementById("viewContainer")

  if (APP.currentView !== "monitor") {
    vc.innerHTML = '<div class="empty">Carregando...</div>'
  }

  let html = ""
  if      (APP.currentView === "dashboard")    html = await renderDashboard()
  else if (APP.currentView === "cadastro")     html = await renderCadastroAdmin()
  else if (APP.currentView === "cameras")      html = await renderCameras()
  else if (APP.currentView === "autorizacoes") html = await renderAutorizacoes()
  else if (APP.currentView === "monitor")      html = renderMonitorPorteiro()
  else if (APP.currentView === "residentes")   html = await renderResidentsReadOnly()
  else if (APP.currentView === "logs")         html = await renderLogs()

  vc.innerHTML = html
  bindViewActions()
  if (APP.currentView === "dashboard") drawDashboardCharts()
}

// ── bindViewActions ───────────────────────────────────────────

function bindViewActions() {
  const btnOpenResidentModal = document.getElementById("btnOpenResidentModal")
  if (btnOpenResidentModal) {
    btnOpenResidentModal.addEventListener("click", () => {
      openModal("Novo Cliente / Veiculo", renderResidentForm())
      bindResidentModalForm()
    })
  }

  const btnOpenCameraModal = document.getElementById("btnOpenCameraModal")
  if (btnOpenCameraModal) {
    btnOpenCameraModal.addEventListener("click", () => {
      openModal("Nova Camera", renderCameraForm())
      bindCameraModalForm()
    })
  }

  const btnOpenAutorizacaoModal = document.getElementById("btnOpenAutorizacaoModal")
  if (btnOpenAutorizacaoModal) {
    btnOpenAutorizacaoModal.addEventListener("click", () => {
      openModal("Nova Autorizacao Temporaria", renderAutorizacaoForm())
      bindAutorizacaoModalForm()
    })
  }

  document.querySelectorAll("[data-del]").forEach(btn => {
    if (btn.dataset.bound === "true") return
    btn.dataset.bound = "true"
    btn.addEventListener("click", async () => {
      if (!confirm("Deseja remover este cadastro?")) return
      const ok = await deleteResident(btn.dataset.del)
      if (ok) await renderView()
    })
  })

  document.querySelectorAll("[data-del-cam]").forEach(btn => {
    if (btn.dataset.bound === "true") return
    btn.dataset.bound = "true"
    btn.addEventListener("click", async () => {
      if (!confirm("Deseja remover esta camera?")) return
      const ok = await deleteCamara(btn.dataset.delCam)
      if (ok) await renderView()
    })
  })

  document.querySelectorAll("[data-del-auth]").forEach(btn => {
    if (btn.dataset.bound === "true") return
    btn.dataset.bound = "true"
    btn.addEventListener("click", async () => {
      if (!confirm("Deseja cancelar esta autorizacao?")) return
      const ok = await deleteAutorizacao(btn.dataset.delAuth)
      if (ok) await renderView()
    })
  })

  // ── Formulário de cadastro de moradores
  const residentForm = document.getElementById("residentForm")
  if (residentForm) {
    const cpfInput   = document.getElementById("fCpf")
    const placaInput = document.getElementById("fPlaca")

    cpfInput.addEventListener("input",   () => cpfInput.value   = formatCPF(cpfInput.value))
    placaInput.addEventListener("input", () => placaInput.value = onlyPlate(placaInput.value))

    residentForm.addEventListener("submit", async (e) => {
      e.preventDefault()
      const btn = residentForm.querySelector("[type=submit]")
      btn.disabled    = true
      btn.textContent = "Salvando..."

      const novo = {
        nome:        document.getElementById("fNome").value.trim(),
        cpf:         document.getElementById("fCpf").value.replace(/\D/g, ""),
        apartamento: document.getElementById("fApto").value.trim(),
        torre:       document.getElementById("fTorre").value.trim().toUpperCase(),
        placa:       onlyPlate(document.getElementById("fPlaca").value),
        veiculo:     document.getElementById("fVeiculo").value.trim()
      }

      if (novo.cpf.length !== 11) {
        showToast("CPF deve ter 11 digitos.")
        btn.disabled = false; btn.textContent = "Salvar Cadastro"
        return
      }
      if (novo.placa.length < 7) {
        showToast("Placa invalida (minimo 7 caracteres).")
        btn.disabled = false; btn.textContent = "Salvar Cadastro"
        return
      }

      const ok = await saveResident(novo)
      if (ok) { residentForm.reset(); await renderView() }
      else    { btn.disabled = false; btn.textContent = "Salvar Cadastro" }
    })

    document.querySelectorAll("[data-del]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Deseja remover este cadastro?")) return
        const ok = await deleteResident(btn.dataset.del)
        if (ok) await renderView()
      })
    })
  }

  // ── Formulário de câmeras
  const cameraForm = document.getElementById("cameraForm")
  if (cameraForm) {
    cameraForm.addEventListener("submit", async (e) => {
      e.preventDefault()
      const btn = cameraForm.querySelector("[type=submit]")
      btn.disabled    = true
      btn.textContent = "Salvando..."

      const novo = {
        nome:           document.getElementById("camNome").value.trim(),
        localizacao:    document.getElementById("camLocal").value.trim(),
        tipo_camera_id: document.getElementById("camTipo").value
      }

      const ok = await saveCamara(novo)
      if (ok) { cameraForm.reset(); await renderView() }
      else    { btn.disabled = false; btn.textContent = "Salvar Camera" }
    })

    document.querySelectorAll("[data-del-cam]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Deseja remover esta camera?")) return
        const ok = await deleteCamara(btn.dataset.delCam)
        if (ok) await renderView()
      })
    })
  }

  // ── Formulário de autorizações temporárias
  const autorizacaoForm = document.getElementById("autorizacaoForm")
  if (autorizacaoForm) {
    const atPlacaInput = document.getElementById("atPlaca")
    atPlacaInput.addEventListener("input", () => atPlacaInput.value = onlyPlate(atPlacaInput.value))

    autorizacaoForm.addEventListener("submit", async (e) => {
      e.preventDefault()
      const btn = autorizacaoForm.querySelector("[type=submit]")
      btn.disabled    = true
      btn.textContent = "Criando..."

      const placa  = onlyPlate(document.getElementById("atPlaca").value)
      const inicio = document.getElementById("atInicio").value
      const fim    = document.getElementById("atFim").value

      if (placa.length < 7) {
        showToast("Placa invalida (minimo 7 caracteres).")
        btn.disabled = false; btn.textContent = "Criar Autorizacao"
        return
      }
      if (new Date(fim) <= new Date(inicio)) {
        showToast("A data de fim deve ser posterior ao inicio.")
        btn.disabled = false; btn.textContent = "Criar Autorizacao"
        return
      }

      const novo = {
        placa,
        nome_autorizado: document.getElementById("atNome").value.trim(),
        motivo:          document.getElementById("atMotivo").value.trim(),
        data_inicio:     new Date(inicio).toISOString(),
        data_fim:        new Date(fim).toISOString()
      }

      const ok = await saveAutorizacao(novo)
      if (ok) { autorizacaoForm.reset(); await renderView() }
      else    { btn.disabled = false; btn.textContent = "Criar Autorizacao" }
    })

    document.querySelectorAll("[data-del-auth]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Deseja cancelar esta autorizacao?")) return
        const ok = await deleteAutorizacao(btn.dataset.delAuth)
        if (ok) await renderView()
      })
    })
  }

  // ── Monitor: detectar placa (manual)
  const detectBtn   = document.getElementById("btnDetect")
  const detectInput = document.getElementById("detectInput")
  if (detectBtn && detectInput) {
    detectInput.addEventListener("input", () => detectInput.value = onlyPlate(detectInput.value))

    const doDetect = async () => {
      const p = onlyPlate(detectInput.value)
      if (!p) { showToast("Digite uma placa para identificar."); return }
      detectBtn.disabled    = true
      detectBtn.textContent = "Verificando..."
      await detectPlate(p)
    }

    detectBtn.addEventListener("click", doDetect)
    detectInput.addEventListener("keydown", e => { if (e.key === "Enter") doDetect() })
  }

  // ── Monitor: upload de imagem para deteccao via backend
  const imageInput     = document.getElementById("imageInput")
  const btnUpload      = document.getElementById("btnUpload")
  const btnDetectImage = document.getElementById("btnDetectImage")
  if (imageInput && btnUpload && btnDetectImage) {
    btnUpload.addEventListener("click", () => imageInput.click())

    imageInput.addEventListener("change", () => {
      const file = imageInput.files[0]
      if (!file) return
      btnDetectImage.disabled = false

      const preview     = document.getElementById("imgPreview")
      const previewWrap = document.getElementById("imgPreviewWrap")
      const placeholder = document.getElementById("cameraPlaceholder")
      if (preview && previewWrap && placeholder) {
        preview.src = URL.createObjectURL(file)
        previewWrap.style.display = "block"
        placeholder.style.display = "none"
      }
    })

    btnDetectImage.addEventListener("click", async () => {
      const file = imageInput.files[0]
      if (!file) { showToast("Selecione uma imagem primeiro."); return }
      btnDetectImage.disabled    = true
      btnDetectImage.textContent = "Detectando..."
      await detectPlateFromImage(file)
    })
  }

  // ── Monitor: webcam
  const btnStartWebcam  = document.getElementById("btnStartWebcam")
  const btnDetectWebcam = document.getElementById("btnDetectWebcam")
  const btnStopWebcam   = document.getElementById("btnStopWebcam")
  if (btnStartWebcam)  { btnStartWebcam.addEventListener("click",  () => startWebcam()) }
  if (btnDetectWebcam) { btnDetectWebcam.addEventListener("click", () => captureAndDetectWebcam()) }
  if (btnStopWebcam)   { btnStopWebcam.addEventListener("click",   () => stopWebcam()) }

  // ── Monitor: abrir/negar portao
  const btnOpen = document.getElementById("btnOpenGate")
  if (btnOpen) btnOpen.addEventListener("click", openGateManual)

  const btnDenyEl = document.getElementById("btnDeny")
  if (btnDenyEl) btnDenyEl.addEventListener("click", denyAccess)

  // ── Dashboard: filtro de período
  const selectFilter = document.getElementById("dashboardFilter")
  if (selectFilter) {
    selectFilter.addEventListener("change", () => {
      APP.dashboardFilterDays = selectFilter.value
      renderView()
    })
  }
}

// ── Configuração de backend em tempo real ─────────────────────

function bindResidentModalForm() {
  const residentForm = document.getElementById("residentForm")
  if (!residentForm || residentForm.dataset.modalBound === "true") return
  residentForm.dataset.modalBound = "true"

  const cpfInput   = document.getElementById("fCpf")
  const placaInput = document.getElementById("fPlaca")

  cpfInput.addEventListener("input",   () => cpfInput.value   = formatCPF(cpfInput.value))
  placaInput.addEventListener("input", () => placaInput.value = onlyPlate(placaInput.value))

  residentForm.addEventListener("submit", async (e) => {
    e.preventDefault()
    const btn = residentForm.querySelector("[type=submit]")
    btn.disabled    = true
    btn.textContent = "Salvando..."

    const novo = {
      nome:        document.getElementById("fNome").value.trim(),
      cpf:         document.getElementById("fCpf").value.replace(/\D/g, ""),
      apartamento: document.getElementById("fApto").value.trim(),
      torre:       document.getElementById("fTorre").value.trim().toUpperCase(),
      placa:       onlyPlate(document.getElementById("fPlaca").value),
      veiculo:     document.getElementById("fVeiculo").value.trim()
    }

    if (novo.cpf.length !== 11) {
      showToast("CPF deve ter 11 digitos.")
      btn.disabled = false
      btn.textContent = "Salvar Cadastro"
      return
    }
    if (novo.placa.length < 7) {
      showToast("Placa invalida (minimo 7 caracteres).")
      btn.disabled = false
      btn.textContent = "Salvar Cadastro"
      return
    }

    const ok = await saveResident(novo)
    if (ok) {
      closeModal()
      await renderView()
    } else {
      btn.disabled = false
      btn.textContent = "Salvar Cadastro"
    }
  })
}

function bindCameraModalForm() {
  const cameraForm = document.getElementById("cameraForm")
  if (!cameraForm || cameraForm.dataset.modalBound === "true") return
  cameraForm.dataset.modalBound = "true"

  cameraForm.addEventListener("submit", async (e) => {
    e.preventDefault()
    const btn = cameraForm.querySelector("[type=submit]")
    btn.disabled    = true
    btn.textContent = "Salvando..."

    const novo = {
      nome:           document.getElementById("camNome").value.trim(),
      localizacao:    document.getElementById("camLocal").value.trim(),
      tipo_camera_id: document.getElementById("camTipo").value
    }

    const ok = await saveCamara(novo)
    if (ok) {
      closeModal()
      await renderView()
    } else {
      btn.disabled = false
      btn.textContent = "Salvar Camera"
    }
  })
}

function bindAutorizacaoModalForm() {
  const autorizacaoForm = document.getElementById("autorizacaoForm")
  if (!autorizacaoForm || autorizacaoForm.dataset.modalBound === "true") return
  autorizacaoForm.dataset.modalBound = "true"

  const atPlacaInput = document.getElementById("atPlaca")
  atPlacaInput.addEventListener("input", () => atPlacaInput.value = onlyPlate(atPlacaInput.value))

  autorizacaoForm.addEventListener("submit", async (e) => {
    e.preventDefault()
    const btn = autorizacaoForm.querySelector("[type=submit]")
    btn.disabled    = true
    btn.textContent = "Criando..."

    const placa  = onlyPlate(document.getElementById("atPlaca").value)
    const inicio = document.getElementById("atInicio").value
    const fim    = document.getElementById("atFim").value

    if (placa.length < 7) {
      showToast("Placa invalida (minimo 7 caracteres).")
      btn.disabled = false
      btn.textContent = "Criar Autorizacao"
      return
    }
    if (new Date(fim) <= new Date(inicio)) {
      showToast("A data de fim deve ser posterior ao inicio.")
      btn.disabled = false
      btn.textContent = "Criar Autorizacao"
      return
    }

    const novo = {
      placa,
      nome_autorizado: document.getElementById("atNome").value.trim(),
      motivo:          document.getElementById("atMotivo").value.trim(),
      data_inicio:     new Date(inicio).toISOString(),
      data_fim:        new Date(fim).toISOString()
    }

    const ok = await saveAutorizacao(novo)
    if (ok) {
      closeModal()
      await renderView()
    } else {
      btn.disabled = false
      btn.textContent = "Criar Autorizacao"
    }
  })
}

function _updateBackendChip() {
  const chip = document.getElementById("backendChip")
  if (!chip) return
  const isLocal = BACKEND_URL.includes("localhost")
  chip.textContent = isLocal ? "API: local" : "API: " + BACKEND_URL.replace(/^https?:\/\//, "")
  chip.style.background = isLocal ? "rgba(230,168,0,0.18)" : "rgba(31,139,86,0.18)"
  chip.style.color       = isLocal ? "#a07800"              : "#1f8b56"
  chip.style.border      = isLocal ? "1px solid #e6a800"   : "1px solid #1f8b56"
}

function _promptChangeBackend() {
  const current = localStorage.getItem(_BACKEND_STORAGE_KEY) || BACKEND_URL
  const input = prompt(
    "Cole a URL do Cloudflare Tunnel (ex: https://abc-123.trycloudflare.com)\nDeixe vazio para usar localhost:",
    current.includes("localhost") ? "" : current
  )
  if (input === null) return
  const url = (input || "").trim().replace(/\/$/, "")
  if (url) {
    localStorage.setItem(_BACKEND_STORAGE_KEY, url)
  } else {
    localStorage.removeItem(_BACKEND_STORAGE_KEY)
  }
  window.location.reload()
}

// ── Bootstrap ─────────────────────────────────────────────────

async function bootstrap() {
  bindModalShell()
  document.getElementById("btnLogin").addEventListener("click", login)
  document.getElementById("loginSenha").addEventListener("keydown", e => {
    if (e.key === "Enter") login()
  })
  document.getElementById("btnLogout").addEventListener("click", logout)

  const backendChip = document.getElementById("backendChip")
  if (backendChip) {
    _updateBackendChip()
    backendChip.addEventListener("click", _promptChangeBackend)
  }

  const session = getSession()
  if (session) {
    APP.currentUser = session
    await showApp()
  }
}

bootstrap()
