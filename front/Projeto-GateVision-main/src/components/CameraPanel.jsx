import { useEffect, useRef, useState } from "react";
import {
  detectPlateFromBackend,
  lookupAuthorizedPlate,
  registerAccessDenied,
  registerAccessOpen,
  triggerGate
} from "../lib/api";
import { buildStatusIllustration, formatCPF, onlyPlate } from "../lib/utils";

const VOTE_WINDOW = 4;
const CONFIRM_VOTES = 1;
const OCR_MIN_CONF = 0.72;

function statusChip(detection, decision) {
  if (!detection) return <span className="chip warn">Aguardando identificação</span>;
  if (decision === "liberado") return <span className="chip ok">Acesso liberado</span>;
  if (decision === "negado") return <span className="chip err">Acesso negado</span>;
  if (detection.status === "autorizado") return <span className="chip warn">Placa cadastrada (aguardando ação)</span>;
  return <span className="chip warn">Placa não cadastrada (aguardando ação)</span>;
}

function statusImage(detection, decision) {
  if (!detection) return <div className="status-empty">Aguardando leitura da placa...</div>;
  if (decision === "liberado") return <img className="status-image" src={buildStatusIllustration("liberado")} alt="Acesso liberado" />;
  if (decision === "negado") return <img className="status-image" src={buildStatusIllustration("negado")} alt="Acesso negado" />;
  return <div className="status-empty">Placa identificada. Escolha liberar ou negar acesso.</div>;
}

export default function CameraPanel({ panelName, backendUrl, onToast, onRemove }) {
  const [detection, setDetection] = useState(null);
  const [decision, setDecision] = useState(null);
  const [manualPlate, setManualPlate] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [webcamActive, setWebcamActive] = useState(false);
  const [processingLabel, setProcessingLabel] = useState("");
  const [cameraDevices, setCameraDevices] = useState([]);
  const [selectedCameraId, setSelectedCameraId] = useState("");

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const detectInFlightRef = useRef(false);
  const ocrInFlightRef = useRef(false);
  const lastProcessedPlateRef = useRef(null);
  const lastFrameSampleRef = useRef(null);
  const stableFrameCountRef = useRef(0);
  const resetTimerRef = useRef(null);
  const plateVoteBufferRef = useRef([]);
  const autoStartAttemptedRef = useRef(false);
  // FIX 1: guard against setState after unmount (panel removal)
  const mountedRef = useRef(true);
  // FIX 5: prevent concurrent startWebcam calls (auto-start + button click race)
  const startingWebcamRef = useRef(false);

  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    if (videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [webcamActive]);

  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return undefined;
    void loadCameraDevices();
    const handleDeviceChange = () => void loadCameraDevices();
    navigator.mediaDevices.addEventListener?.("devicechange", handleDeviceChange);
    return () => navigator.mediaDevices.removeEventListener?.("devicechange", handleDeviceChange);
  }, []);

  useEffect(() => {
    if (webcamActive || streamRef.current || autoStartAttemptedRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia) return;
    if (cameraDevices.length === 0 && selectedCameraId) return;
    autoStartAttemptedRef.current = true;
    void startWebcam(selectedCameraId);
  }, [cameraDevices.length, selectedCameraId, webcamActive]);

  useEffect(() => () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    stopWebcam();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  async function loadCameraDevices(preferredId = null) {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices
        .filter((d) => d.kind === "videoinput")
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
      if (!mountedRef.current) return cameras;
      setCameraDevices(cameras);
      setSelectedCameraId((current) => {
        if (preferredId && cameras.some((c) => c.id === preferredId)) return preferredId;
        if (current && cameras.some((c) => c.id === current)) return current;
        return cameras[0]?.id || "";
      });
      return cameras;
    } catch (error) {
      console.warn("Falha ao listar câmeras:", error);
      return [];
    }
  }

  function resetProcessedPlate() {
    lastProcessedPlateRef.current = null;
  }

  function resetVoteBuffer() {
    plateVoteBufferRef.current = [];
  }

  function addVote(placa) {
    const buffer = plateVoteBufferRef.current;
    const lastPlate = buffer.length > 0 ? buffer[buffer.length - 1] : null;
    if (lastPlate !== null && lastPlate !== placa) {
      plateVoteBufferRef.current = [placa];
    } else {
      plateVoteBufferRef.current = [...buffer, placa].slice(-VOTE_WINDOW);
    }
    return plateVoteBufferRef.current.filter((p) => p === placa).length;
  }

  function clearMonitorState() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setDetection(null);
    setDecision(null);
    setManualPlate("");
    setPreviewUrl("");
    // FIX 3: use streamRef (always current) instead of webcamActive state (stale closure)
    setProcessingLabel(streamRef.current ? "Aguardando nova placa..." : "");
    resetProcessedPlate();
    resetStabilityTracking();
    resetVoteBuffer();
  }

  function scheduleMonitorReset() {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => {
      if (!mountedRef.current) return; // FIX 1
      clearMonitorState();
      resetTimerRef.current = null;
    }, 20000);
  }

  function resetStabilityTracking() {
    lastFrameSampleRef.current = null;
    stableFrameCountRef.current = 0;
    plateVoteBufferRef.current = [];
  }

  function isCurrentFrameStable() {
    if (!videoRef.current) return false;
    if (videoRef.current.readyState < 2) return false;

    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = 32;
    sampleCanvas.height = 18;
    const context = sampleCanvas.getContext("2d", { willReadFrequently: true });
    if (!context) return false;

    context.drawImage(videoRef.current, 0, 0, 32, 18);
    const imageData = context.getImageData(0, 0, 32, 18).data;
    const currentSample = new Uint8Array(32 * 18);

    for (let src = 0, dst = 0; src < imageData.length; src += 4, dst += 1) {
      currentSample[dst] = Math.round(
        imageData[src] * 0.299 + imageData[src + 1] * 0.587 + imageData[src + 2] * 0.114
      );
    }

    const previousSample = lastFrameSampleRef.current;
    lastFrameSampleRef.current = currentSample;

    if (!previousSample || previousSample.length !== currentSample.length) {
      stableFrameCountRef.current = 0;
      return false;
    }

    let totalDiff = 0;
    for (let i = 0; i < currentSample.length; i += 1) {
      totalDiff += Math.abs(currentSample[i] - previousSample[i]);
    }

    if (totalDiff / currentSample.length < 18) {
      stableFrameCountRef.current += 1;
    } else {
      stableFrameCountRef.current = 0;
    }

    return stableFrameCountRef.current >= 1;
  }

  async function openGate(detected, autoTriggered = false, ocrConf = null) {
    if (!detected) return;
    await registerAccessOpen(detected.placa, ocrConf);
    if (!mountedRef.current) return; // FIX 1
    setDecision("liberado");
    scheduleMonitorReset();
    onToast(
      autoTriggered ? "Placa autorizada. Portão aberto automaticamente." : "Portão aberto pelo porteiro.",
      "ok"
    );
    try {
      await triggerGate(backendUrl);
    } catch (error) {
      console.warn("open-gate indisponível:", error);
    }
  }

  async function processPlate(plate, autoOpen = true, ocrConf = null) {
    const clean = onlyPlate(plate);
    if (clean.length < 7 || detectInFlightRef.current) return;
    if (lastProcessedPlateRef.current === clean && detection?.placa === clean) return;

    detectInFlightRef.current = true;
    lastProcessedPlateRef.current = clean;
    if (mountedRef.current) {
      setDecision(null);
      setProcessingLabel("Validando...");
    }

    try {
      const nextDetection = await lookupAuthorizedPlate(clean);
      if (!mountedRef.current) return; // FIX 1
      setDetection(nextDetection);
      if (autoOpen && nextDetection.status === "autorizado") {
        await openGate(nextDetection, true, ocrConf);
      }
    } catch (error) {
      if (!mountedRef.current) return; // FIX 1
      setDetection({ placa: clean, status: "nao-cadastrado", morador: null });
      onToast(`Erro ao verificar placa: ${error.message}`);
    } finally {
      detectInFlightRef.current = false;
      if (mountedRef.current) setProcessingLabel(""); // FIX 1
    }
  }

  async function processImage(file, fromWebcam = false) {
    if (ocrInFlightRef.current) return;
    ocrInFlightRef.current = true;
    if (!fromWebcam && mountedRef.current) {
      setDetection(null);
      setDecision(null);
    }
    if (mountedRef.current) setProcessingLabel("Detectando...");

    try {
      const result = await detectPlateFromBackend(backendUrl, file);

      if (!result.placa) {
        if (!fromWebcam && mountedRef.current) {
          setDetection({ placa: "---", status: "nao-detectado", morador: null });
          onToast("Nenhuma placa detectada na imagem.");
        }
        return;
      }

      const clean = onlyPlate(result.placa);
      const ocrConf = result.confianca_ocr ?? 0;

      if (fromWebcam) {
        if (ocrConf > 0 && ocrConf < OCR_MIN_CONF) {
          if (mountedRef.current) setProcessingLabel("Aguardando leitura mais clara...");
          return;
        }
        const votes = addVote(clean);
        if (votes < CONFIRM_VOTES) {
          if (mountedRef.current) setProcessingLabel(`Confirmando placa ${clean} (${votes}/${CONFIRM_VOTES})`);
          return;
        }
        resetVoteBuffer();
        if (mountedRef.current) setManualPlate(clean);
        await processPlate(clean, true, ocrConf);
      } else {
        if (mountedRef.current) setManualPlate(clean);
        await processPlate(clean, true);
      }
    } catch (error) {
      if (!fromWebcam && mountedRef.current) onToast(`Erro ao processar imagem: ${error.message}`);
    } finally {
      ocrInFlightRef.current = false;
      if (!mountedRef.current) return; // FIX 1
      if (!fromWebcam) {
        setProcessingLabel("");
      } else if (!detectInFlightRef.current && streamRef.current) {
        // FIX 4: use streamRef (always current) instead of webcamActive state (stale closure)
        setProcessingLabel("Aguardando nova placa...");
      }
    }
  }

  async function startWebcam(cameraId = selectedCameraId) {
    // FIX 5: prevent concurrent startWebcam calls
    if (startingWebcamRef.current || streamRef.current) return;
    startingWebcamRef.current = true;

    if (!navigator.mediaDevices?.getUserMedia) {
      startingWebcamRef.current = false;
      onToast("Seu navegador não suporta acesso à webcam.");
      return;
    }

    try {
      let stream = null;
      let selectedCameraUnavailable = false;

      if (cameraId) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cameraId } } });
        } catch (error) {
          if (error.name === "OverconstrainedError" || error.name === "NotReadableError") {
            selectedCameraUnavailable = true;
          } else {
            throw error;
          }
        }
      }

      if (!stream && cameraId) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { ideal: cameraId } } });
        } catch (error) {
          if (error.name !== "OverconstrainedError" && error.name !== "NotReadableError") throw error;
        }
      }

      if (!stream) {
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
      }

      if (!mountedRef.current) { // FIX 1: panel was removed while awaiting getUserMedia
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      const activeTrack = stream.getVideoTracks()[0];
      const activeCameraId = activeTrack?.getSettings?.().deviceId || cameraId || "";

      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = stream;
      setWebcamActive(true);
      setPreviewUrl("");
      setProcessingLabel("Aguardando a placa e a câmera estabilizarem...");
      resetStabilityTracking();
      if (activeCameraId) setSelectedCameraId(activeCameraId);
      await loadCameraDevices(activeCameraId);

      if (videoRef.current) videoRef.current.srcObject = stream;

      if (selectedCameraUnavailable && activeCameraId && cameraId && activeCameraId !== cameraId) {
        onToast("A câmera USB selecionada não abriu. O navegador usou outra câmera disponível.");
      }

      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = window.setInterval(() => {
        if (!detectInFlightRef.current && !ocrInFlightRef.current) {
          if (isCurrentFrameStable()) void captureAndDetect(true);
        }
      }, 350);
    } catch (error) {
      autoStartAttemptedRef.current = false;
      if (mountedRef.current) { // FIX 1
        setProcessingLabel("");
        const message =
          error.name === "NotAllowedError" ? "Permissão de câmera negada. Permita o acesso no navegador."
          : error.name === "NotFoundError" ? "Nenhuma câmera encontrada no dispositivo."
          : error.name === "OverconstrainedError" ? "A câmera selecionada não está disponível no momento."
          : `Erro ao acessar a webcam: ${error.message}`;
        onToast(message);
      }
    } finally {
      startingWebcamRef.current = false; // FIX 5
    }
  }

  function stopWebcam() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    if (videoRef.current) videoRef.current.srcObject = null;
    resetStabilityTracking();
    // FIX 1 + FIX 2: guard unmount; always clear label (no stale-closure conditional)
    if (!mountedRef.current) return;
    setProcessingLabel("");
    setWebcamActive(false);
  }

  async function captureAndDetect(silent = false) {
    if (!videoRef.current || !streamRef.current) {
      if (!silent) onToast("Webcam não está ativa.");
      return;
    }
    if (detectInFlightRef.current || ocrInFlightRef.current) return;

    const canvas = document.createElement("canvas");
    canvas.width = videoRef.current.videoWidth || 640;
    canvas.height = videoRef.current.videoHeight || 480;
    canvas.getContext("2d").drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) { onToast("Erro ao capturar frame da webcam."); return; }

    await processImage(new File([blob], "webcam_frame.jpg", { type: "image/jpeg" }), true);
  }

  async function handleManualOpen() {
    if (!detection) return;
    try { await openGate(detection, false); }
    catch (error) { onToast(`Erro ao registrar abertura: ${error.message}`); }
  }

  async function handleDeny() {
    if (!detection) return;
    try {
      await registerAccessDenied(detection.placa);
      if (!mountedRef.current) return; // FIX 1
      setDecision("negado");
      scheduleMonitorReset();
      onToast("Acesso negado registrado.", "ok");
    } catch (error) {
      onToast(`Erro ao registrar negação: ${error.message}`);
    }
  }

  async function handleManualInputChange(event) {
    const clean = onlyPlate(event.target.value);
    setManualPlate(clean);
    if (clean.length < 7) { resetProcessedPlate(); return; }
    await processPlate(clean, true);
  }

  async function handleFileChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    // FIX 6: reset input so the same file can be selected again
    event.target.value = "";
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
    await processImage(file, false);
  }

  async function handleCameraChange(event) {
    const nextCameraId = event.target.value;
    setSelectedCameraId(nextCameraId);
    if (!webcamActive) return;
    stopWebcam();
    await startWebcam(nextCameraId);
  }

  const currentChip = statusChip(detection, decision);
  const currentImage = statusImage(detection, decision);

  return (
    <div className="camera-panel">
      <div className="camera-panel-header">
        <div className="camera-panel-title">
          <span className="eyebrow" style={{ marginBottom: 0 }}>Câmera</span>
          <strong className="camera-panel-name">{panelName}</strong>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="camera-panel-chip">{currentChip}</div>
          <button className="camera-panel-remove" onClick={onRemove} type="button" title="Remover painel">
            ✕
          </button>
        </div>
      </div>

      <div className="camera-panel-body">
        <div className="card">
          <div className="card-head">Captura e leitura</div>
          <div className="card-body">
            <div className="camera">
              {previewUrl && !webcamActive ? (
                <div style={{ width: "100%", height: "100%", overflow: "hidden" }}>
                  <img src={previewUrl} style={{ width: "100%", height: "100%", objectFit: "contain" }} alt="Preview" />
                </div>
              ) : null}
              <video
                ref={videoRef}
                className="webcam-video"
                style={{ display: webcamActive ? "block" : "none" }}
                autoPlay
                playsInline
                muted
              />
              {!previewUrl && !webcamActive ? (
                <div>Envie uma foto, use a webcam<br />ou digite a placa manualmente</div>
              ) : null}
            </div>

            <div className="monitor-toolbar" style={{ marginTop: 12 }}>
              <input
                className="input mono"
                value={manualPlate}
                onChange={handleManualInputChange}
                placeholder="Ex: BRA2E24"
                maxLength={7}
              />
              <label className="btn" style={{ cursor: "pointer" }}>
                Enviar foto
                <input type="file" accept="image/*" style={{ display: "none" }} onChange={handleFileChange} />
              </label>
            </div>

            <div className="monitor-toolbar" style={{ marginTop: 10 }}>
              <select
                className="input"
                value={selectedCameraId}
                onChange={handleCameraChange}
                disabled={!cameraDevices.length}
              >
                <option value="">
                  {cameraDevices.length ? "Selecione uma câmera" : "Nenhuma câmera encontrada"}
                </option>
                {cameraDevices.map((cam) => (
                  <option key={cam.id} value={cam.id}>{cam.label}</option>
                ))}
              </select>
              {webcamActive ? (
                <button className="btn err" type="button" onClick={stopWebcam}>Parar</button>
              ) : (
                <button className="btn ok" type="button" onClick={() => startWebcam()}>Iniciar webcam</button>
              )}
            </div>

            {processingLabel ? (
              <div className="empty" style={{ marginTop: 12 }}>{processingLabel}</div>
            ) : null}
          </div>
        </div>

        <div className="card">
          <div className="card-head">Resultado</div>
          <div className="card-body">
            <div className="status-image-wrap">{currentImage}</div>
            <div style={{ marginBottom: 10 }}>{currentChip}</div>
            <div className="status-box">
              <div className="row">
                <span>Placa</span>
                <strong className="mono">{detection ? detection.placa : "---"}</strong>
              </div>
              <div className="row">
                <span>Morador</span>
                <strong>{detection?.morador ? detection.morador.nome : "-"}</strong>
              </div>
              <div className="row">
                <span>CPF</span>
                <strong>{detection?.morador ? formatCPF(detection.morador.cpf) : "-"}</strong>
              </div>
              <div className="row">
                <span>Apartamento</span>
                <strong>
                  {detection?.morador
                    ? `${detection.morador.apartamento} - Torre ${detection.morador.torre}`
                    : "-"}
                </strong>
              </div>
            </div>
            <div className="actions" style={{ marginTop: 12 }}>
              <button
                className="btn ok"
                onClick={handleManualOpen}
                type="button"
                disabled={!detection || !!decision}
              >
                Abrir portão
              </button>
              <button
                className="btn err"
                onClick={handleDeny}
                type="button"
                disabled={!detection || !!decision}
              >
                Negar acesso
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
