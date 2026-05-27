import { db, ESTAB_ID } from "./config";
import { formatDateTime, getFilterDateISO, logStatus } from "./utils";

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeLogin(value) {
  return String(value || "").trim().toLowerCase();
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function isMissingColumnError(error, column) {
  const text = `${error?.code || ""} ${error?.message || ""} ${error?.details || ""}`;
  return text.includes("PGRST204") || text.toLowerCase().includes(column.toLowerCase());
}

function mapGatekeeper(row) {
  return {
    id: row.id,
    pessoa_id: row.pessoa_id || null,
    login: row.login,
    ativo: row.ativo !== false,
    nome: row.pessoas?.nome || row.login,
    cpf: row.pessoas?.cpf || "",
    perfil: row.perfis_acesso?.descricao || "porteiro"
  };
}

async function fetchGatekeeperProfileId() {
  const { data, error } = await db
    .from("perfis_acesso")
    .select("id, descricao")
    .order("id", { ascending: true });

  if (error) throw error;

  const profile = (data || []).find((item) => normalizeText(item.descricao).includes("porteiro"));
  if (!profile) throw new Error("Perfil de acesso 'porteiro' nao encontrado.");
  return profile.id;
}

async function insertSystemUserWithProfile(payload, profileId) {
  const candidateColumns = ["perfil_acesso_id", "perfil_id", "perfilacesso_id"];
  let lastError = null;

  for (const column of candidateColumns) {
    const { error } = await db
      .from("usuarios_sistema")
      .insert({ ...payload, [column]: profileId });

    if (!error) return;

    lastError = error;
    if (!isMissingColumnError(error, column)) break;
  }

  throw lastError || new Error("Nao foi possivel criar o usuario do porteiro.");
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
    role: normalizeText(data.perfis_acesso?.descricao).includes("admin") ? "admin" : "porteiro"
  };
}

export async function fetchGatekeepers() {
  const { data, error } = await db
    .from("usuarios_sistema")
    .select("*, pessoas(nome, cpf), perfis_acesso(id, descricao)")
    .order("id", { ascending: false });

  if (error) throw error;

  return (data || [])
    .filter((item) => normalizeText(item.perfis_acesso?.descricao).includes("porteiro"))
    .map(mapGatekeeper);
}

export async function saveGatekeeper(payload) {
  const login = normalizeLogin(payload.login);
  const cpf = onlyDigits(payload.cpf);

  const [loginRes, cpfRes, profileId] = await Promise.all([
    db.from("usuarios_sistema").select("id").eq("login", login).maybeSingle(),
    db.from("pessoas").select("id").eq("cpf", cpf).maybeSingle(),
    fetchGatekeeperProfileId()
  ]);

  if (loginRes.error) throw loginRes.error;
  if (cpfRes.error) throw cpfRes.error;
  if (loginRes.data) throw new Error("Login ja cadastrado.");
  if (cpfRes.data) throw new Error("CPF ja cadastrado.");

  const personRes = await db
    .from("pessoas")
    .insert({ nome: payload.nome.trim(), cpf })
    .select("id")
    .single();

  if (personRes.error) throw personRes.error;

  try {
    await insertSystemUserWithProfile({
      pessoa_id: personRes.data.id,
      estabelecimento_id: ESTAB_ID,
      login,
      senha_hash: payload.senha,
      ativo: true
    }, profileId);
  } catch (error) {
    await db.from("pessoas").delete().eq("id", personRes.data.id);
    throw error;
  }
}

export async function updateGatekeeper(userId, personId, payload) {
  const login = normalizeLogin(payload.login);
  const cpf = onlyDigits(payload.cpf);

  const [loginRes, cpfRes] = await Promise.all([
    db.from("usuarios_sistema").select("id").eq("login", login).neq("id", userId).maybeSingle(),
    personId
      ? db.from("pessoas").select("id").eq("cpf", cpf).neq("id", personId).maybeSingle()
      : db.from("pessoas").select("id").eq("cpf", cpf).maybeSingle()
  ]);

  if (loginRes.error) throw loginRes.error;
  if (cpfRes.error) throw cpfRes.error;
  if (loginRes.data) throw new Error("Login ja cadastrado.");
  if (cpfRes.data) throw new Error("CPF ja cadastrado.");

  let resolvedPersonId = personId;
  const userPatch = {
    login,
    ativo: payload.ativo
  };

  if (payload.senha) userPatch.senha_hash = payload.senha;

  if (resolvedPersonId) {
    const personRes = await db
      .from("pessoas")
      .update({ nome: payload.nome.trim(), cpf })
      .eq("id", resolvedPersonId);
    if (personRes.error) throw personRes.error;
  } else {
    const personRes = await db
      .from("pessoas")
      .insert({ nome: payload.nome.trim(), cpf })
      .select("id")
      .single();
    if (personRes.error) throw personRes.error;
    resolvedPersonId = personRes.data.id;
    userPatch.pessoa_id = resolvedPersonId;
  }

  const userRes = await db.from("usuarios_sistema").update(userPatch).eq("id", userId);
  if (userRes.error) throw userRes.error;
}

export async function setGatekeeperActive(userId, ativo) {
  const { error } = await db.from("usuarios_sistema").update({ ativo }).eq("id", userId);
  if (error) throw error;
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
    db.from("pessoas").select("id, nome, cpf").order("id", { ascending: false }),
    db.from("veiculos").select("id, placa, modelo, pessoa_id"),
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
      veiculo: vehicle?.modelo || "-"
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
    modelo: payload.veiculo || null,
    pessoa_id: personId,
    tipo_veiculo_id: 1
  });
  if (vehicleRes.error) throw vehicleRes.error;
}

export async function deleteResident(personId) {
  const [vinculoRes, vehicleRes, authRes, userRes] = await Promise.all([
    db.from("vinculos").delete().eq("pessoa_id", personId),
    db.from("veiculos").delete().eq("pessoa_id", personId),
    db.from("autorizacoes_temporarias").update({ autorizado_por: null }).eq("autorizado_por", personId),
    db.from("usuarios_sistema").delete().eq("pessoa_id", personId)
  ]);
  if (vinculoRes.error) throw vinculoRes.error;
  if (vehicleRes.error) throw vehicleRes.error;
  if (authRes.error) throw authRes.error;
  if (userRes.error) throw userRes.error;

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
        modelo: payload.veiculo || null,
        tipo_veiculo_id: 1
      })
      .eq("id", currentVehicleRes.data.id);
    if (vehicleRes.error) throw vehicleRes.error;
  } else {
    const vehicleRes = await db.from("veiculos").insert({
      placa: payload.placa,
      modelo: payload.veiculo || null,
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

  const { data, error } = await db
    .from("vw_placas_autorizadas")
    .select("*")
    .eq("placa", plate)
    .maybeSingle();

  if (error) throw error;
  if (data) {
    return {
      placa: plate,
      status: "autorizado",
      morador: {
        nome: data.proprietario || "Morador",
        cpf: "",
        apartamento: data.unidade || "-",
        torre: data.bloco || "-"
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
      }
    };
  }

  return { placa: plate, status: "nao-cadastrado", morador: null };
}

export async function detectPlateFromBackend(backendUrl, file) {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(`${backendUrl}/api/detect`, { method: "POST", body: formData });
  if (!response.ok) throw new Error(`Servidor retornou ${response.status}`);
  return response.json();
}

export async function registerAccessOpen(plate, confiancaOcr = null) {
  const confianca = confiancaOcr !== null ? Math.round(confiancaOcr * 100) : 100;
  const { error } = await db.rpc("registrar_acesso", {
    p_placa: plate,
    p_camera_id: 1,
    p_confianca: confianca,
    p_imagem_url: null,
    p_tempo_ms: null
  });
  if (error) throw error;
}

export async function triggerGate(backendUrl) {
  await fetch(`${backendUrl}/api/open-gate`, { method: "POST" });
}

export async function registerAccessDenied(plate) {
  const { error } = await db.from("acessos").insert({
    placa_detectada: plate,
    camera_id: 1,
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
    tipo: camera.tipos_camera?.descricao || "-"
  }));
}

export async function saveCamera(payload) {
  const { error } = await db.from("cameras").insert({
    nome: payload.nome,
    localizacao: payload.localizacao,
    tipo_camera_id: Number.parseInt(payload.tipo_camera_id, 10),
    estabelecimento_id: ESTAB_ID
  });
  if (error) throw error;
}

export async function deleteCamera(cameraId) {
  const { error } = await db.from("cameras").update({ ativo: false }).eq("id", cameraId);
  if (error) throw error;
}

export async function updateCamera(cameraId, payload) {
  const { error } = await db.from("cameras").update({
    nome: payload.nome,
    localizacao: payload.localizacao,
    tipo_camera_id: Number.parseInt(payload.tipo_camera_id, 10)
  }).eq("id", cameraId);
  if (error) throw error;
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
