"""
pipeline.py — detecção de placa (YOLO) + OCR (EasyOCR) com suporte a debug.

Fluxo padrão (modo rápido):
  1. CLAHE na imagem inteira.
  2. YOLO sem TTA (augment=False) — inferência mais rápida.
  3. OCR com a variante "mercosul_ink" primeiro (fecha falhas diagonais).
  4. Se não encontrar placa válida → variantes "color" e "clahe".
  5. Se ainda não encontrar → "binary" (último fallback local).
  6. Se ainda nada → YOLO com TTA + confiança reduzida e repete OCR.

Parâmetros controláveis por env var / load_models():
  DETECT_CONF   — limiar de confiança YOLO (padrão: 0.25)
  DETECT_IMGSZ  — tamanho de entrada YOLO (padrão: 640)
"""

import re
import time
import cv2
import numpy as np
from pathlib import Path
from ultralytics import YOLO

_model_plates = None
_ocr_reader = None
_detect_conf = 0.25
_detect_imgsz = 640

_OCR_IGNORE = {"BRASIL", "BR", "MERCOSUL", "BRAZIL", "MERC", "OSUL", "OSUR", "ERCO"}

# Score mínimo para aceitar resultado e encerrar cedo o OCR
_EARLY_STOP_SCORE = 180

# Confiança mínima para aceitar parada antecipada após a 2ª variante.
# Abaixo deste limiar, o pipeline continua até a 3ª variante (clahe) antes
# de parar — garantindo uma segunda chance de leitura mais limpa.
_EARLY_STOP_MIN_CONF = 0.80


# ── Inicialização ──────────────────────────────────────────────

def load_models(plates_path: str, chars_path: str = None,
                conf: float = 0.25, imgsz: int = 640):
    """Carrega modelo YOLO de placas e leitor EasyOCR.

    chars_path é aceito por compatibilidade mas ignorado.
    """
    global _model_plates, _ocr_reader, _detect_conf, _detect_imgsz
    import easyocr

    model_file = Path(plates_path)
    if not model_file.exists():
        raise FileNotFoundError(
            f"Modelo YOLO nao encontrado: {plates_path}\n"
            "Defina MODEL_PLATES ou passe --model com o caminho correto do .pt"
        )

    _model_plates = YOLO(str(model_file))
    _ocr_reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    _detect_conf = conf
    _detect_imgsz = imgsz


# ── Pré-processamento da imagem inteira (antes do YOLO) ────────

def _enhance_full_image(img: np.ndarray) -> np.ndarray:
    """Equalização adaptativa de contraste (CLAHE) no canal L do espaço LAB."""
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    l = clahe.apply(l)
    return cv2.cvtColor(cv2.merge([l, a, b]), cv2.COLOR_LAB2BGR)


# ── Nitidez (unsharp mask) ─────────────────────────────────────

def _sharpen(img: np.ndarray, amount: float = 1.5) -> np.ndarray:
    """Unsharp mask: subtrai versão borrada para realçar bordas dos caracteres."""
    blurred = cv2.GaussianBlur(img, (0, 0), sigmaX=1.5)
    return cv2.addWeighted(img, 1.0 + amount, blurred, -amount, 0)


# ── Crop com margem ────────────────────────────────────────────

def _safe_crop(img: np.ndarray, x1: int, y1: int, x2: int, y2: int,
               margin: float = 0.08) -> np.ndarray:
    h, w = img.shape[:2]
    mw = int((x2 - x1) * margin)
    mh = int((y2 - y1) * margin)
    x1 = max(0, x1 - mw)
    y1 = max(0, y1 - mh)
    x2 = min(w, x2 + mw)
    y2 = min(h, y2 + mh)
    return img[y1:y2, x1:x2]


# ── ROI da linha de caracteres ─────────────────────────────────

def _crop_char_row(crop: np.ndarray) -> np.ndarray:
    """Recorta a faixa que contém os 7 caracteres, descartando o cabeçalho
    BRASIL (azul, ~30 % do topo) e a borda inferior (~10 %).

    Em placas inclinadas ou muito variadas o crop completo é mantido como
    fallback nas variantes color/clahe/binary — aqui apenas as variantes
    ink usam o recorte.
    """
    h = crop.shape[0]
    # O cabeçalho azul "BRASIL" ocupa aproximadamente os primeiros 30 % da altura.
    # A linha de caracteres vai até cerca de 90 % da altura total.
    top    = int(h * 0.28)
    bottom = int(h * 0.92)
    return crop[top:bottom, :]


# ── Variante mercosul_ink ──────────────────────────────────────

def _make_mercosul_ink(crop: np.ndarray) -> np.ndarray:
    """Gera imagem limpa para OCR em placas Mercosul com marcas diagonais.

    Problema: as placas Mercosul têm "MERCOSUL" impresso em branco na
    diagonal repetidas vezes sobre o fundo branco dos caracteres. Isso cria
    lacunas brancas dentro das letras/números pretos, fragmentando os
    glifos para o OCR.

    Solução:
      1. Recorta só a linha de caracteres (sem faixa BRASIL).
      2. Normaliza para largura fixa de 600 px — garante que as operações
         morfológicas usem kernels de tamanho consistente independentemente
         da resolução da câmera.
      3. Converte para cinza e aplica CLAHE leve.
      4. Limiariza com Otsu: pixels escuros → máscara dos caracteres.
      5. Fechamento morfológico (MORPH_CLOSE) preenche as lacunas
         diagonais sem engrossar demais os traços.
      6. Remove componentes de ruído muito pequenos.
      7. Escala 3× para o EasyOCR e retorna imagem limpa.
    """
    roi = _crop_char_row(crop)

    # Normaliza para largura padrão; as operações morfológicas ficam
    # independentes da resolução original da câmera.
    TARGET_W = 600
    h_roi, w_roi = roi.shape[:2]
    scale = TARGET_W / max(w_roi, 1)
    norm_h = max(1, int(h_roi * scale))
    norm = cv2.resize(roi, (TARGET_W, norm_h), interpolation=cv2.INTER_AREA)

    gray = cv2.cvtColor(norm, cv2.COLOR_BGR2GRAY)

    # CLAHE leve para normalizar contraste sem ampliar ruído
    clahe = cv2.createCLAHE(clipLimit=1.5, tileGridSize=(8, 8))
    gray = clahe.apply(gray)

    # Sharpening: realça bordas dos caracteres antes da binarização
    gray = _sharpen(gray, amount=1.5)

    # Blur suave para fundir pequenas variações causadas pelas marcas
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)

    # Threshold Otsu: pixels escuros são os caracteres
    _, mask = cv2.threshold(blurred, 0, 255,
                            cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Fechamento morfológico: preenche lacunas internas.
    # Na imagem normalizada a 600px de largura os caracteres têm ~50-80px
    # de altura e as marcas diagonais ~2-5px de espessura → kernel (7,5).
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 5))
    closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

    # Remove componentes muito pequenos (ruído residual das marcas diagonais)
    n_labels, labels, stats, _ = cv2.connectedComponentsWithStats(closed,
                                                                    connectivity=8)
    min_area = int(norm.shape[0] * norm.shape[1] * 0.0008)
    clean = np.zeros_like(closed)
    for i in range(1, n_labels):
        if stats[i, cv2.CC_STAT_AREA] >= min_area:
            clean[labels == i] = 255

    # Escala 3× para o EasyOCR ter pixels suficientes
    up = cv2.resize(clean, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)

    # Retorna imagem com fundo branco e tinta preta para o EasyOCR
    result = np.full((*up.shape, 1), 255, dtype=np.uint8).squeeze()
    result[up > 127] = 0
    return result


# ── Variantes padrão de pré-processamento do crop ──────────────

def _make_variants(crop: np.ndarray) -> dict[str, np.ndarray]:
    # Correção 1: remove faixa BRASIL antes de qualquer OCR
    roi = _crop_char_row(crop)
    color_up = cv2.resize(roi, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    # Sharpening: realça bordas; gray/clahe/binary derivam daqui e herdam o efeito
    color_up = _sharpen(color_up, amount=1.2)
    gray = cv2.cvtColor(color_up, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    clahe_img = clahe.apply(gray)
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    # Correção 2: threshold adaptativo funciona melhor com iluminação não-uniforme
    binary = cv2.adaptiveThreshold(
        blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV, 31, 10,
    )
    return {"color": color_up, "clahe": clahe_img, "binary": binary}


# ── OCR com detalhe ────────────────────────────────────────────

def _run_ocr(img_variant: np.ndarray) -> list[tuple[str, float]]:
    results = _ocr_reader.readtext(img_variant, detail=1, paragraph=False,
                                   allowlist="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
    out = []
    for (_, text, conf) in results:
        clean = re.sub(r"[^A-Z0-9]", "", text.upper())
        if clean and clean not in _OCR_IGNORE:
            out.append((clean, float(conf)))
    return out


# ── Extração e pontuação de candidatos Mercosul ───────────────

# Confusões: dígito lido pelo OCR onde deveria ser letra
_DIGIT_TO_LETTER = {
    "0": "O",
    "1": "I",
    "4": "A",
    "8": "B",
    "7": "T",
    "6": "G",   # 6 confundido com G
    "2": "Z",   # 2 confundido com Z
    "5": "S",   # 5 confundido com S
}

# Confusões: letra lida pelo OCR onde deveria ser dígito
_LETTER_TO_DIGIT = {
    "O": "0",
    "I": "1",
    "A": "4",
    "B": "8",
    "T": "7",
    "L": "1",
    "G": "6",   # G confundido com 6
    "Z": "2",   # Z confundido com 2
    "S": "5",   # S confundido com 5
}

_MERCOSUL_RE = re.compile(r"^[A-Z]{3}[0-9][A-Z][0-9]{2}$")
_OLD_RE      = re.compile(r"^[A-Z]{3}[0-9]{4}$")


def _correct_mercosul(text: str) -> str:
    chars = list(text)
    for i in range(min(7, len(chars))):
        if i < 3 or i == 4:
            # Posições de letra: corrigir dígito → letra
            if chars[i] in _DIGIT_TO_LETTER:
                chars[i] = _DIGIT_TO_LETTER[chars[i]]
        else:
            # Posições de dígito: corrigir letra → dígito
            if chars[i] in _LETTER_TO_DIGIT:
                chars[i] = _LETTER_TO_DIGIT[chars[i]]
    return "".join(chars[:7])


def _confidence_for_corrected(original: str, corrected: str, raw_conf: float) -> float:
    """Ajusta a confiança quando a correção Mercosul produz um formato válido.

    O EasyOCR reporta a confiança do texto bruto (p.ex. "AQN8408"), não do
    texto corrigido ("AQN8A08"). A correção é determinística e orientada pelo
    formato da placa, por isso a confiança final deve ser maior do que a do
    segmento mal-lido — especialmente quando poucos caracteres precisaram de
    correção.
    """
    if not _MERCOSUL_RE.match(corrected):
        return raw_conf
    n_fixed = sum(a != b for a, b in zip(original, corrected))
    # Base 0.88 para 0 correções; −0.10 por cada correção necessária.
    # O resultado é limitado superiormente a 0.92 e nunca cai abaixo de raw_conf.
    base = 0.88 - n_fixed * 0.10
    return max(raw_conf, min(base, 0.92))


def _score(text: str) -> int:
    s = 0
    if len(text) == 7:
        s += 20
    if _MERCOSUL_RE.match(text):
        s += 200
    elif _OLD_RE.match(text):
        s += 100
    if len(text) >= 3 and len(set(text[:3])) == 1:
        s -= 30
    return s


def _extract_candidates(ocr_hits: list[tuple[str, float]]) -> list[tuple[str, int, float]]:
    """Retorna lista de (texto, score, confianca_ocr) ordenada por score desc.

    confianca_ocr é a confiança EasyOCR que sustentou o candidato vencedor:
    - via hit direto: confiança do segmento reconhecido
    - via janela de caracteres: média das confianças dos 7 caracteres da janela
    """
    if not ocr_hits:
        return []

    candidates: dict[str, int] = {}
    ocr_confs: dict[str, float] = {}

    for text, conf in ocr_hits:
        if 4 <= len(text) <= 10:
            corrected = _correct_mercosul(text)
            adj_conf = _confidence_for_corrected(text, corrected, conf)
            sc = _score(corrected) + int(conf * 60)
            if corrected not in candidates or sc > candidates[corrected]:
                candidates[corrected] = sc
                ocr_confs[corrected] = adj_conf

    # Correção 3: janela deslizante apenas dentro de cada segmento OCR,
    # sem cruzar fronteiras entre palavras distintas.
    for text, conf in ocr_hits:
        for start in range(len(text) - 6):
            window = text[start:start + 7]
            corrected = _correct_mercosul(window)
            adj_conf = _confidence_for_corrected(window, corrected, conf)
            sc = _score(corrected) + int(conf * 30)
            if corrected not in candidates or sc > candidates[corrected]:
                candidates[corrected] = sc
                ocr_confs[corrected] = adj_conf

    return sorted(
        [(text, score, round(ocr_confs.get(text, 0.0), 4))
         for text, score in candidates.items()],
        key=lambda x: x[1], reverse=True,
    )


# ── OCR com parada antecipada (variante a variante) ────────────

def _ocr_crop_fast(crop: np.ndarray, debug_variants: dict | None = None
                   ) -> tuple[list[tuple[str, float]], bool]:
    """Roda OCR variante a variante; para assim que encontrar placa válida.

    Ordem:
      1. mercosul_ink  — ROI dos caracteres com fechamento morfológico.
         Resolve as lacunas das marcas diagonais Mercosul.
      2. color         — crop completo colorido escalado 3×.
      3. clahe         — crop completo com equalização adaptativa.
      4. binary        — binarização Otsu (último fallback).

    Retorna (all_hits, found_early).
    """
    # Correção 4: variantes construídas sob demanda; standard_variants só é
    # criado quando a primeira variante padrão (color) for necessária.
    order = ["mercosul_ink", "color", "clahe", "binary"]
    standard_variants: dict[str, np.ndarray] | None = None
    all_hits: list[tuple[str, float]] = []
    found_early = False

    for idx, vname in enumerate(order):
        if vname == "mercosul_ink":
            variant = _make_mercosul_ink(crop)
        else:
            if standard_variants is None:
                standard_variants = _make_variants(crop)
            variant = standard_variants[vname]

        hits = _run_ocr(variant)
        all_hits.extend(hits)

        if debug_variants is not None:
            debug_variants[vname] = {"img": variant, "hits": hits}

        # Parada antecipada: requer score >= _EARLY_STOP_SCORE E
        #   (a) ao menos 3 variantes já rodaram (idx >= 2), OU
        #   (b) a confiança do melhor candidato já é alta (>= _EARLY_STOP_MIN_CONF).
        # Isso garante que leituras corrigidas com confiança borderline (~0.78)
        # rodem a variante clahe antes de encerrar, aumentando a chance de um
        # leitura mais limpa e com confiança mais alta.
        if idx >= 1:
            candidates = _extract_candidates(all_hits)
            if candidates and candidates[0][1] >= _EARLY_STOP_SCORE:
                top_conf = candidates[0][2]
                if idx >= 2 or top_conf >= _EARLY_STOP_MIN_CONF:
                    found_early = True
                    if debug_variants is not None:
                        sv = standard_variants or {}
                        for remaining in order:
                            if remaining not in debug_variants:
                                debug_variants[remaining] = {
                                    "img": sv.get(remaining),
                                    "hits": [],
                                    "skipped": True,
                                }
                    break

    return all_hits, found_early


# ── Inferência YOLO ────────────────────────────────────────────

def _run_yolo_fast(img: np.ndarray) -> list[tuple]:
    """Inferência rápida: sem TTA, confiança padrão."""
    results = _model_plates(img, conf=_detect_conf, imgsz=_detect_imgsz,
                             augment=False, verbose=False)
    return [(r, box) for r in results for box in r.boxes]


def _run_yolo_robust(img: np.ndarray) -> list[tuple]:
    """Inferência robusta: com TTA e confiança reduzida — usada como fallback."""
    results = _model_plates(img, conf=_detect_conf, imgsz=_detect_imgsz,
                             augment=True, verbose=False)
    detections = [(r, box) for r in results for box in r.boxes]

    if not detections:
        fallback_conf = max(0.04, _detect_conf / 3)
        results = _model_plates(img, conf=fallback_conf, imgsz=_detect_imgsz,
                                 augment=True, verbose=False)
        detections = [(r, box) for r in results for box in r.boxes]

    return detections


# ── Processar um conjunto de detecções YOLO → melhor placa ─────

def _process_detections(detections: list[tuple], img: np.ndarray,
                         debug_info: dict | None, timings: dict | None
                         ) -> dict:
    """Itera pelas detecções YOLO, roda OCR e devolve resultado da melhor placa.

    Retorna dict com:
      placa          — texto detectado ou None
      confianca_yolo — confiança da caixa YOLO
      confianca_ocr  — confiança EasyOCR do melhor candidato (0-1)
      score_ocr      — pontuação heurística (formato + contribuição OCR)
      candidatos     — top 3 candidatos como lista de dicts serializáveis
    """
    best_plate = None
    best_conf_yolo = 0.0
    best_ocr_conf = 0.0
    best_score = 0
    best_candidates_json: list[dict] = []

    sorted_dets = sorted(detections, key=lambda x: float(x[1].conf[0]), reverse=True)

    for r, box in sorted_dets:
        x1, y1, x2, y2 = map(int, box.xyxy[0])
        plate_conf = float(box.conf[0])
        crop = _safe_crop(img, x1, y1, x2, y2)

        variant_debug: dict | None = {} if debug_info is not None else None
        t_ocr = time.perf_counter()
        all_hits, early = _ocr_crop_fast(crop, variant_debug)
        if timings is not None:
            timings.setdefault("ocr_ms", []).append(
                round((time.perf_counter() - t_ocr) * 1000, 1))

        candidates = _extract_candidates(all_hits)
        top_text     = candidates[0][0] if candidates else None
        top_score    = candidates[0][1] if candidates else -999
        top_ocr_conf = candidates[0][2] if candidates else 0.0

        if debug_info is not None:
            debug_info["detections"].append({
                "box": (x1, y1, x2, y2),
                "yolo_conf": plate_conf,
                "crop": crop.copy(),
                "variants": variant_debug,
                "all_hits": all_hits,
                "candidates": candidates,
                "early_stop": early,
            })

        if top_text and top_score > _score(best_plate or ""):
            best_plate = top_text
            best_conf_yolo = plate_conf
            best_ocr_conf = top_ocr_conf
            best_score = top_score
            best_candidates_json = [
                {"placa": t, "score": s, "confianca_ocr": c}
                for t, s, c in candidates[:3]
            ]

        if best_plate and _score(best_plate) >= _EARLY_STOP_SCORE:
            break

    return {
        "placa": best_plate,
        "confianca_yolo": round(best_conf_yolo, 4),
        "confianca_ocr": round(best_ocr_conf, 4),
        "score_ocr": best_score,
        "candidatos": best_candidates_json,
    }


# ── Detecção principal ─────────────────────────────────────────

def detect(image_bytes: bytes, debug: bool = False) -> dict:
    """Pipeline completo: pré-processamento → YOLO (rápido) → OCR Mercosul.

    Retorna:
      placa          — texto da placa ou None
      confianca      — alias de confianca_yolo (compatibilidade com versão anterior)
      confianca_yolo — confiança da caixa YOLO (0-1)
      confianca_ocr  — confiança EasyOCR do melhor candidato (0-1)
      score_ocr      — pontuação heurística usada para ranquear (formato + OCR)
      candidatos     — top 3 candidatos como lista de dicts {placa, score, confianca_ocr}
      debug          — dados de diagnóstico quando debug=True, senão None
    """
    if _model_plates is None or _ocr_reader is None:
        raise RuntimeError("Modelos nao carregados. Chame load_models() primeiro.")

    t_total = time.perf_counter()
    timings: dict = {}

    t0 = time.perf_counter()
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    timings["decode_ms"] = round((time.perf_counter() - t0) * 1000, 1)

    if img is None:
        return {
            "placa": None, "confianca": 0,
            "confianca_yolo": 0, "confianca_ocr": 0,
            "score_ocr": 0, "candidatos": [], "debug": None,
        }

    t0 = time.perf_counter()
    enhanced = _enhance_full_image(img)
    timings["clahe_ms"] = round((time.perf_counter() - t0) * 1000, 1)

    debug_info = {"detections": [], "yolo_passes": 1, "timings": timings} if debug else None

    # ── Passagem rápida: YOLO sem TTA ─────────────────────────
    t0 = time.perf_counter()
    detections = _run_yolo_fast(enhanced)
    timings["yolo_fast_ms"] = round((time.perf_counter() - t0) * 1000, 1)

    best_plate: str | None = None
    best_conf = 0.0
    best_ocr_conf = 0.0
    best_score = 0
    best_candidates: list[dict] = []

    if detections:
        det = _process_detections(detections, img, debug_info, timings)
        best_plate     = det["placa"]
        best_conf      = det["confianca_yolo"]
        best_ocr_conf  = det["confianca_ocr"]
        best_score     = det["score_ocr"]
        best_candidates = det["candidatos"]

    # ── Fallback: YOLO com TTA quando placa não encontrada ────
    if not best_plate:
        if debug_info is not None:
            debug_info["yolo_passes"] = 2

        t0 = time.perf_counter()
        detections_robust = _run_yolo_robust(enhanced)
        timings["yolo_robust_ms"] = round((time.perf_counter() - t0) * 1000, 1)

        if detections_robust:
            det = _process_detections(detections_robust, img, debug_info, timings)
            best_plate      = det["placa"]
            best_conf       = det["confianca_yolo"]
            best_ocr_conf   = det["confianca_ocr"]
            best_score      = det["score_ocr"]
            best_candidates = det["candidatos"]

    timings["total_ms"] = round((time.perf_counter() - t_total) * 1000, 1)

    return {
        "placa":          best_plate,
        "confianca":      round(best_conf, 4),
        "confianca_yolo": round(best_conf, 4),
        "confianca_ocr":  round(best_ocr_conf, 4),
        "score_ocr":      best_score,
        "candidatos":     best_candidates,
        "debug":          debug_info,
    }
