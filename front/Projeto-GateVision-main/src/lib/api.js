import { db, ESTAB_ID } from "./config";
import { formatDateTime, getFilterDateISO, logStatus } from "./utils";

const CAMERA_GATE_CONFIG_KEY = "gatevision_camera_gate_config_v1";

function readCameraGateConfig() {
  try {
    const raw = localStorage.getItem(CAMERA_GATE_CONFIG_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeCameraGateConfig(config) {
  localStorage.setItem(CAMERA_GATE_CONFIG_KEY, JSON.stringify(config));
}

function getCameraGateConfig(cameraId) {
  const config = readCameraGateConfig();
  return config[String(cameraId)] || { gate_usb_port: "", gate_baud: 9600 };
}

function setCameraGateConfig(cameraId, payload) {
  const config = readCameraGateConfig();
  config[String(cameraId)] = {
    gate_usb_port: payload.gate_usb_port || "",
    gate_baud: Number.parseInt(payload.gate_baud, 10) || 9600
  };
  writeCameraGateConfig(config);
}

function removeCameraGateConfig(cameraId) {
  const config = readCameraGateConfig();
  delete config[String(cameraId)];
  writeCameraGateConfig(config);
}

export async function loginUser(login, password) {
  const { data, error } = await db
    .from("usuarios_sistema")
    .select("*, pessoas(nome), perfis_acesso(descricao)")
    .eq("login", login)
    .eq("senha_hash", password)
    .eq("ativo", true)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    id: data.id,
    username: data.login,
    nome: data.pessoas?.nome || data.login,
    role: data.perfis_acesso?.descricao || "porteiro"
  };
}

export async function fetchDashboardData(filterDays) {
  const minDate = getFilterDateISO(filterDays);
  let logsQuery = db.from("vw_ultimos_acessos").select("*");
  if (minDate) logsQuery = logsQuery.gte("registrado_em", minDate);

  const [logsRes, countRes] = await Promise.all([
    logsQuery,
    db.from("pessoas").select("*", { count: "exact", head: true })
  ]);

  if (logsRes.error) throw logsRes.error;
  if (countRes.error) throw countRes.error;

  const logs = logsRes.data || [];
  const totalClientes = countRes.count || 0;
  const liberados = logs.filter((item) => logStatus(item).ok).length;
  const negados = logs.filter((item) => !logStatus(item).ok).length;

  return {
    logs,
    totalClientes,
    liberados,
    negados,
    total: liberados + negados,
    latest: logs.slice(0, 5)
  };
}

export async function fetchResidents() {
  const [pessoasRes, veiculosRes, vinculosRes] = await Promise.all([
    db.from("pessoas").select("id, nome, cpf"),
    db.from("veiculos").select("id, placa, modelo, cor, pessoa_id"),
    db.from("vinculos").select("pessoa_id, unidades(identificacao, blocos(nome))")
  ]);

  if (pessoasRes.error) throw pessoasRes.error;
  if (veiculosRes.error) throw veiculosRes.error;
  if (vinculosRes.error) throw vinculosRes.error;

  return (pessoasRes.data || []).map((person) => {
    const vehicle = (veiculosRes.data || []).find((item) => item.pessoa_id === person.id);
    const vinculo = (vinculosRes.data || []).find((item) => item.pessoa_id === person.id);
    const unidade = vinculo?.unidades;
    const bloco = unidade?.blocos;
    return {
      id: person.id,
      nome: person.nome,
      cpf: person.cpf,
      apartamento: unidade?.identificacao || "-",
      torre: bloco?.nome || "-",
      veiculo_id: vehicle?.id || null,
      placa: vehicle?.placa || "-",
      modelo: vehicle?.modelo || "-",
      cor: vehicle?.cor || "-"
    };
  });
}

export async function saveResident(payload) {
  const [cpfRes, placaRes] = await Promise.all([
    db.from("pessoas").select("id").eq("cpf", payload.cpf).maybeSingle(),
    db.from("veiculos").select("id").eq("placa", payload.placa).maybeSingle()
  ]);

  if (cpfRes.error) throw cpfRes.error;
  if (placaRes.error) throw placaRes.error;
  if (cpfRes.data) throw new Error("CPF ja cadastrado.");
  if (placaRes.data) throw new Error("Placa ja cadastrada.");

  let { data: bloco, error: blocoErr } = await db.from("blocos").select("id")
    .ilike("nome", payload.torre)
    .eq("estabelecimento_id", ESTAB_ID)
    .maybeSingle();
  if (blocoErr) throw blocoErr;

  if (!bloco) {
    const createdBlock = await db.from("blocos")
      .insert({ nome: payload.torre, estabelecimento_id: ESTAB_ID })
      .select("id")
      .single();
    if (createdBlock.error) throw createdBlock.error;
    bloco = createdBlock.data;
  }

  let { data: unidade, error: unidadeErr } = await db.from("unidades").select("id")
    .eq("identificacao", payload.apartamento)
    .eq("bloco_id", bloco.id)
    .maybeSingle();
  if (unidadeErr) throw unidadeErr;

  if (!unidade) {
    const createdUnit = await db.from("unidades")
      .insert({ identificacao: payload.apartamento, bloco_id: bloco.id })
      .select("id")
      .single();
    if (createdUnit.error) throw createdUnit.error;
    unidade = createdUnit.data;
  }

  const personRes = await db.from("pessoas")
    .insert({ nome: payload.nome, cpf: payload.cpf })
    .select("id")
    .single();
  if (personRes.error) throw personRes.error;

  const personId = personRes.data.id;
  const vinculoRes = await db.from("vinculos").insert({
    pessoa_id: personId,
    unidade_id: unidade.id,
    tipo_vinculo_id: 1
  });
  if (vinculoRes.error) throw vinculoRes.error;

  const vehicleRes = await db.from("veiculos").insert({
    placa: payload.placa,
    modelo: payload.modelo || null,
    cor: payload.cor || null,
    pessoa_id: personId,
    tipo_veiculo_id: 1
  });
  if (vehicleRes.error) throw vehicleRes.error;
}

export async function deleteResident(personId) {
  const [vinculoRes, vehicleRes] = await Promise.all([
    db.from("vinculos").delete().eq("pessoa_id", personId),
    db.from("veiculos").delete().eq("pessoa_id", personId)
  ]);
  if (vinculoRes.error) throw vinculoRes.error;
  if (vehicleRes.error) throw vehicleRes.error;

  const personRes = await db.from("pessoas").delete().eq("id", personId);
  if (personRes.error) throw personRes.error;
}

export async function updateResident(personId, payload) {
  const [cpfRes, placaRes, currentVehicleRes, currentVinculoRes] = await Promise.all([
    db.from("pessoas").select("id").eq("cpf", payload.cpf).neq("id", personId).maybeSingle(),
    db.from("veiculos").select("id, pessoa_id").eq("placa", payload.placa).neq("pessoa_id", personId).maybeSingle(),
    db.from("veiculos").select("id").eq("pessoa_id", personId).maybeSingle(),
    db.from("vinculos").select("id").eq("pessoa_id", personId).maybeSingle()
  ]);

  if (cpfRes.error) throw cpfRes.error;
  if (placaRes.error) throw placaRes.error;
  if (currentVehicleRes.error) throw currentVehicleRes.error;
  if (currentVinculoRes.error) throw currentVinculoRes.error;
  if (cpfRes.data) throw new Error("CPF ja cadastrado.");
  if (placaRes.data) throw new Error("Placa ja cadastrada.");

  let { data: bloco, error: blocoErr } = await db.from("blocos").select("id")
    .ilike("nome", payload.torre)
    .eq("estabelecimento_id", ESTAB_ID)
    .maybeSingle();
  if (blocoErr) throw blocoErr;

  if (!bloco) {
    const createdBlock = await db.from("blocos")
      .insert({ nome: payload.torre, estabelecimento_id: ESTAB_ID })
      .select("id")
      .single();
    if (createdBlock.error) throw createdBlock.error;
    bloco = createdBlock.data;
  }

  let { data: unidade, error: unidadeErr } = await db.from("unidades").select("id")
    .eq("identificacao", payload.apartamento)
    .eq("bloco_id", bloco.id)
    .maybeSingle();
  if (unidadeErr) throw unidadeErr;

  if (!unidade) {
    const createdUnit = await db.from("unidades")
      .insert({ identificacao: payload.apartamento, bloco_id: bloco.id })
      .select("id")
      .single();
    if (createdUnit.error) throw createdUnit.error;
    unidade = createdUnit.data;
  }

  const personRes = await db.from("pessoas")
    .update({ nome: payload.nome, cpf: payload.cpf })
    .eq("id", personId);
  if (personRes.error) throw personRes.error;

  if (currentVinculoRes.data?.id) {
    const vinculoRes = await db.from("vinculos")
      .update({ unidade_id: unidade.id, tipo_vinculo_id: 1 })
      .eq("id", currentVinculoRes.data.id);
    if (vinculoRes.error) throw vinculoRes.error;
  } else {
    const vinculoRes = await db.from("vinculos").insert({
      pessoa_id: personId,
      unidade_id: unidade.id,
      tipo_vinculo_id: 1
    });
    if (vinculoRes.error) throw vinculoRes.error;
  }

  if (currentVehicleRes.data?.id) {
    const vehicleRes = await db.from("veiculos")
      .update({
        placa: payload.placa,
        modelo: payload.modelo || null,
        cor: payload.cor || null,
        tipo_veiculo_id: 1
      })
      .eq("id", currentVehicleRes.data.id);
    if (vehicleRes.error) throw vehicleRes.error;
  } else {
    const vehicleRes = await db.from("veiculos").insert({
      placa: payload.placa,
      modelo: payload.modelo || null,
      cor: payload.cor || null,
      pessoa_id: personId,
      tipo_veiculo_id: 1
    });
    if (vehicleRes.error) throw vehicleRes.error;
  }
}

export async function fetchLogs() {
  const { data, error } = await db.from("vw_ultimos_acessos").select("*").limit(200);
  if (error) throw error;
  return data || [];
}

export async function lookupAuthorizedPlate(plate) {
  const nowIso = new Date().toISOString();
  const { data: vehicle, error: vehicleError } = await db
    .from("veiculos")
    .select("id, placa, modelo, cor, pessoa_id")
    .eq("placa", plate)
    .maybeSingle();

  if (vehicleError) throw vehicleError;
  if (vehicle?.pessoa_id) {
    const [personRes, vinculoRes] = await Promise.all([
      db.from("pessoas").select("id, nome, cpf").eq("id", vehicle.pessoa_id).maybeSingle(),
      db.from("vinculos").select("pessoa_id, unidades(identificacao, blocos(nome))").eq("pessoa_id", vehicle.pessoa_id).maybeSingle()
    ]);

    if (personRes.error) throw personRes.error;
    if (vinculoRes.error) throw vinculoRes.error;

    const unidade = vinculoRes.data?.unidades;
    const bloco = unidade?.blocos;
    return {
      placa: plate,
      status: "autorizado",
      morador: {
        nome: personRes.data?.nome || "Morador",
        cpf: personRes.data?.cpf || "",
        apartamento: unidade?.identificacao || "-",
        torre: bloco?.nome || "-"
      },
      veiculo: {
        modelo: vehicle.modelo || "-",
        cor: vehicle.cor || "-"
      }
    };
  }

  const { data: temporaryAuthorization, error: temporaryError } = await db
    .from("autorizacoes_temporarias")
    .select("placa, nome_autorizado, data_inicio, data_fim")
    .eq("placa", plate)
    .eq("estabelecimento_id", ESTAB_ID)
    .eq("ativo", true)
    .lte("data_inicio", nowIso)
    .gte("data_fim", nowIso)
    .order("data_fim", { ascending: true })
    .maybeSingle();

  if (temporaryError) throw temporaryError;
  if (temporaryAuthorization) {
    return {
      placa: plate,
      status: "autorizado",
      morador: {
        nome: temporaryAuthorization.nome_autorizado || "Visitante autorizado",
        cpf: "",
        apartamento: "Temporario",
        torre: formatDateTime(temporaryAuthorization.data_fim)
      },
      veiculo: {
        modelo: "-",
        cor: "-"
      }
    };
  }

  return {
    placa: plate,
    status: "nao-cadastrado",
    morador: null,
    veiculo: {
      modelo: "-",
      cor: "-"
    }
  };
}

export async function detectPlateFromBackend(backendUrl, file) {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(`${backendUrl}/api/detect`, { method: "POST", body: formData });
  if (!response.ok) throw new Error(`Servidor retornou ${response.status}`);
  return response.json();
}

async function parseBackendResponse(response) {
  if (response.ok) return response.json();

  let detail = `Servidor retornou ${response.status}`;
  try {
    const payload = await response.json();
    if (payload?.detail) detail = payload.detail;
  } catch {
    // Mantem a mensagem padrao quando nao houver JSON valido.
  }
  throw new Error(detail);
}

export async function fetchArduinoState(backendUrl) {
  const response = await fetch(`${backendUrl}/api/arduino`);
  return parseBackendResponse(response);
}

export async function connectArduinoPort(backendUrl, port, baud = 9600) {
  const response = await fetch(`${backendUrl}/api/arduino/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ port, baud })
  });
  return parseBackendResponse(response);
}

export async function disconnectArduinoPort(backendUrl) {
  const response = await fetch(`${backendUrl}/api/arduino/disconnect`, {
    method: "POST"
  });
  return parseBackendResponse(response);
}

export async function registerAccessOpen(plate, cameraId = 1) {
  const { error } = await db.rpc("registrar_acesso", {
    p_placa: plate,
    p_camera_id: cameraId,
    p_confianca: 100,
    p_imagem_url: null,
    p_tempo_ms: null
  });
  if (error) throw error;
}

export async function triggerGate(backendUrl) {
  const response = await fetch(`${backendUrl}/api/open-gate`, { method: "POST" });
  return parseBackendResponse(response);
}

export async function registerAccessDenied(plate, cameraId = 1) {
  const { error } = await db.from("acessos").insert({
    placa_detectada: plate,
    camera_id: cameraId,
    autorizado: false,
    motivo_bloqueio: "Negado pelo porteiro",
    confianca: 100
  });
  if (error) throw error;
}

export async function fetchCameras() {
  const { data, error } = await db
    .from("cameras")
    .select("id, nome, localizacao, tipo_camera_id, tipos_camera(descricao)")
    .eq("estabelecimento_id", ESTAB_ID)
    .eq("ativo", true);
  if (error) throw error;

  return (data || []).map((camera) => ({
    id: camera.id,
    nome: camera.nome,
    localizacao: camera.localizacao || "-",
    tipo_camera_id: String(camera.tipo_camera_id || 1),
    tipo: camera.tipos_camera?.descricao || "-",
    ...getCameraGateConfig(camera.id)
  }));
}

export async function saveCamera(payload) {
  const { data, error } = await db.from("cameras").insert({
    nome: payload.nome,
    localizacao: payload.localizacao,
    tipo_camera_id: Number.parseInt(payload.tipo_camera_id, 10),
    estabelecimento_id: ESTAB_ID
  }).select("id").single();
  if (error) throw error;
  if (data?.id) setCameraGateConfig(data.id, payload);
  return data;
}

export async function deleteCamera(cameraId) {
  const { error } = await db.from("cameras").update({ ativo: false }).eq("id", cameraId);
  if (error) throw error;
  removeCameraGateConfig(cameraId);
}

export async function updateCamera(cameraId, payload) {
  const { error } = await db.from("cameras").update({
    nome: payload.nome,
    localizacao: payload.localizacao,
    tipo_camera_id: Number.parseInt(payload.tipo_camera_id, 10)
  }).eq("id", cameraId);
  if (error) throw error;
  setCameraGateConfig(cameraId, payload);
}

export async function fetchAuthorizations() {
  const { data, error } = await db
    .from("autorizacoes_temporarias")
    .select("id, placa, nome_autorizado, motivo, data_inicio, data_fim")
    .eq("estabelecimento_id", ESTAB_ID)
    .eq("ativo", true)
    .gte("data_fim", new Date().toISOString())
    .order("data_fim", { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function saveAuthorization(payload) {
  const { error } = await db.from("autorizacoes_temporarias").insert({
    placa: payload.placa,
    nome_autorizado: payload.nome_autorizado,
    motivo: payload.motivo || null,
    data_inicio: payload.data_inicio,
    data_fim: payload.data_fim,
    estabelecimento_id: ESTAB_ID
  });
  if (error) throw error;
}

export async function updateAuthorization(authorizationId, payload) {
  const { error } = await db.from("autorizacoes_temporarias").update({
    placa: payload.placa,
    nome_autorizado: payload.nome_autorizado,
    motivo: payload.motivo || null,
    data_inicio: payload.data_inicio,
    data_fim: payload.data_fim
  }).eq("id", authorizationId);
  if (error) throw error;
}

export async function deleteAuthorization(authorizationId) {
  const { error } = await db.from("autorizacoes_temporarias")
    .update({ ativo: false })
    .eq("id", authorizationId);
  if (error) throw error;
}
