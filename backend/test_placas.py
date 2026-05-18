"""
test_placas.py — avalia o pipeline em imagens reais com gabaritos conhecidos.

Uso:
    python test_placas.py
    python test_placas.py --model ../back2/deteccao-placas-veiculares-main/models/best.pt
    python test_placas.py --debug          # salva imagens intermediárias em backend/debug/
    python test_placas.py --conf 0.10      # reduz limiar YOLO para detecção mais permissiva

As imagens e gabaritos são lidos automaticamente de:
    ../Placas Teste/placas/   (*.JPG, *.jpg, *.png)
    ../Placas Teste/gabarito/ (*.txt com o texto da placa na linha 1)
"""

import argparse
import os
import re
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_MODEL = str(
    BASE_DIR / ".." / "back2" / "deteccao-placas-veiculares-main" / "models" / "best.pt"
)
PLACAS_DIR  = BASE_DIR / ".." / "Placas Teste" / "placas"
GABARITO_DIR = BASE_DIR / ".." / "Placas Teste" / "gabarito"


# ── Helpers ────────────────────────────────────────────────────

def _normalizar(texto: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (texto or "").upper())


def _char_accuracy(esperado: str, obtido: str) -> float:
    """Fração de caracteres corretos na posição certa (min comprimento)."""
    if not esperado:
        return 0.0
    corretos = sum(a == b for a, b in zip(esperado, obtido or ""))
    return corretos / len(esperado)


def _diff_str(esperado: str, obtido: str) -> str:
    """Mostra diferenças char a char: correto=verde(.), errado=X."""
    if not obtido:
        return "X" * len(esperado)
    result = []
    for i, ch_esp in enumerate(esperado):
        ch_obt = obtido[i] if i < len(obtido) else "_"
        result.append("." if ch_esp == ch_obt else f"[{ch_esp}≠{ch_obt}]")
    if len(obtido) > len(esperado):
        result.append(f"+{obtido[len(esperado):]}")
    return "".join(result)


def _load_pairs() -> list[dict]:
    """Carrega pares (imagem, gabarito) emparelhando pelo nome base (sem extensão)."""
    if not PLACAS_DIR.exists():
        print(f"Erro: pasta de placas nao encontrada: {PLACAS_DIR}", file=sys.stderr)
        sys.exit(1)
    if not GABARITO_DIR.exists():
        print(f"Erro: pasta de gabaritos nao encontrada: {GABARITO_DIR}", file=sys.stderr)
        sys.exit(1)

    img_extensions = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
    pairs = []
    for img_path in sorted(PLACAS_DIR.iterdir()):
        if img_path.suffix.lower() not in img_extensions:
            continue
        stem = img_path.stem
        gabarito_path = GABARITO_DIR / f"{stem}.txt"
        if not gabarito_path.exists():
            print(f"  Aviso: sem gabarito para {img_path.name} — ignorando.")
            continue
        esperado = _normalizar(gabarito_path.read_text(encoding="utf-8").split()[0])
        if not esperado:
            print(f"  Aviso: gabarito vazio para {img_path.name} — ignorando.")
            continue
        pairs.append({"img": img_path, "esperado": esperado})

    return pairs


# ── Main ───────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Avalia o pipeline de deteccao de placas com gabaritos conhecidos."
    )
    parser.add_argument("--model", default=os.getenv("MODEL_PLATES", DEFAULT_MODEL))
    parser.add_argument("--conf",  type=float, default=0.25)
    parser.add_argument("--imgsz", type=int,   default=640)
    parser.add_argument("--debug", action="store_true",
                        help="Salva imagens de debug em backend/debug/")
    args = parser.parse_args()

    model_path = Path(args.model)
    if not model_path.exists():
        print(f"Erro: modelo nao encontrado: {model_path}", file=sys.stderr)
        print("Informe com --model ou via MODEL_PLATES.", file=sys.stderr)
        sys.exit(1)

    print("Carregando modelos (pode demorar na primeira execucao)...")
    from pipeline import load_models, detect  # noqa: importado aqui para não exigir GPU no import

    load_models(str(model_path), conf=args.conf, imgsz=args.imgsz)

    pairs = _load_pairs()
    if not pairs:
        print("Nenhum par imagem/gabarito encontrado.")
        sys.exit(0)

    sep = "─" * 72
    print(f"\n{sep}")
    print(f"  Imagens: {PLACAS_DIR}")
    print(f"  Conf YOLO: {args.conf}  |  imgsz: {args.imgsz}")
    print(sep)

    acertos_exatos = 0
    soma_char_acc  = 0.0
    resultados = []

    for pair in pairs:
        img_bytes = pair["img"].read_bytes()
        resultado = detect(img_bytes, debug=args.debug)

        esperado   = pair["esperado"]
        obtido     = _normalizar(resultado.get("placa") or "")
        exato      = esperado == obtido
        char_acc   = _char_accuracy(esperado, obtido)
        conf_yolo  = resultado.get("confianca_yolo", resultado.get("confianca", 0))
        conf_ocr   = resultado.get("confianca_ocr", 0)
        score_ocr  = resultado.get("score_ocr", 0)
        candidatos = resultado.get("candidatos", [])

        if exato:
            acertos_exatos += 1
        soma_char_acc += char_acc

        status = "OK " if exato else "ERR"
        print(f"\n  [{status}] {pair['img'].name}")
        print(f"       Esperado  : {esperado}")
        print(f"       Obtido    : {obtido or '(nao detectado)'}")
        print(f"       Diff      : {_diff_str(esperado, obtido)}")
        print(f"       Acuracia  : {char_acc:.0%} por caractere")
        print(f"       YOLO conf : {conf_yolo:.2%}  |  OCR conf: {conf_ocr:.2%}  |  score: {score_ocr}")
        if candidatos:
            tops = "  ".join(
                f"{c['placa']}({c.get('confianca_ocr', 0):.0%})"
                for c in candidatos[:3]
            )
            print(f"       Candidatos: {tops}")

        if args.debug:
            debug_info = resultado.get("debug")
            if debug_info:
                from read_plate import _save_debug
                debug_dir = BASE_DIR / "debug"
                _save_debug(debug_info, debug_dir, pair["img"].stem)
                print(f"       Debug salvo em: {debug_dir}/")

        resultados.append({
            "arquivo":   pair["img"].name,
            "esperado":  esperado,
            "obtido":    obtido,
            "exato":     exato,
            "char_acc":  char_acc,
            "conf_yolo": conf_yolo,
            "conf_ocr":  conf_ocr,
        })

    total = len(pairs)
    media_char = soma_char_acc / total if total else 0.0

    print(f"\n{sep}")
    print(f"  RESUMO  ({total} imagens)")
    print(f"  Acertos exatos : {acertos_exatos}/{total}  ({acertos_exatos/total:.0%})")
    print(f"  Acuracia média : {media_char:.1%} por caractere")

    conf_yolo_media = sum(r["conf_yolo"] for r in resultados) / total if total else 0
    conf_ocr_media  = sum(r["conf_ocr"]  for r in resultados) / total if total else 0
    print(f"  Conf YOLO méd. : {conf_yolo_media:.2%}")
    print(f"  Conf OCR  méd. : {conf_ocr_media:.2%}")
    print(sep)

    if acertos_exatos < total:
        print("\n  Dica: use --debug para inspecionar as imagens intermediarias.")
        print(f"  Tambem: python read_plate.py <imagem> --debug --conf {args.conf}")
    print()


if __name__ == "__main__":
    main()
