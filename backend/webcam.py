import argparse
import os
import re
import signal
import sys
import time
from collections import deque
from pathlib import Path

from dotenv import load_dotenv

try:
    from supabase import create_client
except ImportError:
    create_client = None

from arduino import conectar_arduino, fechar_arduino, abrir_cancela

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent

DEFAULT_MODEL = str(
    BASE_DIR / ".." / "back2" / "deteccao-placas-veiculares-main" / "models" / "best.pt"
)

SUPABASE_URL = os.getenv(
    "SUPABASE_URL",
    "https://blulbaobttmwewxvttql.supabase.co",
)
SUPABASE_KEY = os.getenv(
    "SUPABASE_KEY",
    "sb_publishable_RAYD5x0h3bSgkdToX39u8Q_JFYQkZyi",
)
SUPABASE_AUTH_VIEW = os.getenv("SUPABASE_AUTH_VIEW", "vw_placas_autorizadas")
SUPABASE_PLATE_COLUMN = os.getenv("SUPABASE_PLATE_COLUMN", "placa")
CAMERA_ID = int(os.getenv("GATEVISION_CAMERA_ID", "1"))
GATE_OPEN_SECONDS = float(os.getenv("GATE_OPEN_SECONDS", "5"))

supabase = None


def criar_cliente_supabase():
    if create_client is None:
        print("Pacote supabase nao instalado. A autorizacao ficara indisponivel.")
        return None

    try:
        return create_client(SUPABASE_URL, SUPABASE_KEY)
    except Exception as exc:
        print(f"Erro ao criar cliente Supabase: {exc}")
        return None


def normalizar_placa(placa: str | None) -> str | None:
    if not placa:
        return None

    placa = re.sub(r"[^A-Z0-9]", "", str(placa).upper())
    return placa[:7] or None


def placa_autorizada(placa: str | None) -> bool:
    placa = normalizar_placa(placa)
    if not placa or supabase is None:
        return False

    try:
        response = (
            supabase.table(SUPABASE_AUTH_VIEW)
            .select("*")
            .eq(SUPABASE_PLATE_COLUMN, placa)
            .limit(1)
            .execute()
        )
        return bool(response.data)
    except Exception as exc:
        print(f"Erro ao consultar placa autorizada no Supabase: {exc}")
        return False


def _confidence_percent(conf_yolo: float) -> float:
    conf = float(conf_yolo or 0)
    return round(conf * 100, 2) if conf <= 1 else round(conf, 2)


def registrar_acesso(placa: str, autorizado: bool, conf_yolo: float):
    if supabase is None:
        print("Cliente Supabase indisponivel. Acesso nao registrado.")
        return

    try:
        if autorizado:
            supabase.rpc(
                "registrar_acesso",
                {
                    "p_placa": placa,
                    "p_camera_id": CAMERA_ID,
                    "p_confianca": _confidence_percent(conf_yolo),
                    "p_imagem_url": None,
                    "p_tempo_ms": None,
                },
            ).execute()
        else:
            supabase.table("acessos").insert(
                {
                    "placa_detectada": placa,
                    "camera_id": CAMERA_ID,
                    "autorizado": False,
                    "motivo_bloqueio": "Placa nao autorizada",
                    "confianca": _confidence_percent(conf_yolo),
                }
            ).execute()
    except Exception as exc:
        print(f"Erro ao registrar acesso no Supabase: {exc}")


def _on_plate_confirmed(placa: str, conf_yolo: float):
    global GATE_OPEN_SECONDS

    placa = normalizar_placa(placa)
    if not placa:
        print("Leitura de placa invalida.")
        return

    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] PLACA CONFIRMADA: {placa}  (confianca YOLO: {conf_yolo:.0%})")

    autorizado = placa_autorizada(placa)
    registrar_acesso(placa, autorizado, conf_yolo)

    if autorizado:
        abrir_cancela(GATE_OPEN_SECONDS)
    else:
        print(f"Acesso negado para a placa {placa}.")


def run(camera, model_path: str, conf: float, imgsz: int,
        sample_every: int, confirm_frames: int, cooldown: float,
        show: bool):

    import cv2
    from pipeline import load_models, detect

    print("Carregando modelos (pode demorar na primeira execucao)...")
    load_models(model_path, conf=conf, imgsz=imgsz)
    print(f"Modelos carregados. Abrindo camera: {camera}")

    if isinstance(camera, int) and os.name == "nt":
        cap = cv2.VideoCapture(camera, cv2.CAP_DSHOW)
    else:
        cap = cv2.VideoCapture(camera)
    if not cap.isOpened():
        print(f"Erro: nao foi possivel abrir a camera '{camera}'.", file=sys.stderr)
        sys.exit(1)

    # Informações da câmera
    width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps    = cap.get(cv2.CAP_PROP_FPS) or 30
    print(f"Camera: {width}x{height} @ {fps:.0f}fps")
    print(f"Processando 1 a cada {sample_every} frames | "
          f"Confirmacao: {confirm_frames} frames consecutivos | "
          f"Cooldown: {cooldown}s")
    print("Pressione Ctrl+C para encerrar.\n")

    recent_plates: deque[str | None] = deque(maxlen=confirm_frames)
    last_confirmed: str | None = None
    last_confirmed_time: float = 0.0
    frame_count = 0
    last_display_plate = ""

    # Permite encerrar com Ctrl+C limpo
    running = [True]
    def _sigint(sig, frame):
        running[0] = False
    signal.signal(signal.SIGINT, _sigint)

    while running[0]:
        ret, frame = cap.read()
        if not ret:
            print("Aviso: falha ao capturar frame. Tentando novamente...")
            time.sleep(0.1)
            continue

        frame_count += 1

        # Processar apenas 1 a cada sample_every frames
        if frame_count % sample_every != 0:
            if show:
                _draw_overlay(frame, last_display_plate)
                cv2.imshow("GateVision", frame)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
            continue

        # Codifica o frame como JPEG e envia ao pipeline
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
        if not ok:
            continue

        result = detect(buf.tobytes())
        placa = normalizar_placa(result.get("placa"))
        conf_yolo = float(result.get("confianca", 0.0))

        recent_plates.append(placa)

        # Verificar se a fila está cheia e toda leitura é a mesma placa válida
        if (len(recent_plates) == confirm_frames
                and len(set(recent_plates)) == 1
                and recent_plates[0] is not None):

            confirmed = recent_plates[0]
            now = time.time()

            # Cooldown: mesma placa não dispara duas vezes em menos de X segundos
            same_plate_cooldown = (confirmed == last_confirmed
                                   and (now - last_confirmed_time) < cooldown)

            if not same_plate_cooldown:
                _on_plate_confirmed(confirmed, conf_yolo)
                last_confirmed      = confirmed
                last_confirmed_time = now
                last_display_plate  = confirmed
                recent_plates.clear()

        if show:
            _draw_overlay(frame, last_display_plate)
            cv2.imshow("GateVision", frame)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break

    cap.release()
    if show:
        cv2.destroyAllWindows()
    print("\nEncerrado.")


def _draw_overlay(frame, placa: str):
    """Desenha a última placa confirmada sobre o frame (apenas para --show)."""
    import cv2
    h, w = frame.shape[:2]
    label = f"Placa: {placa}" if placa else "Aguardando..."
    cv2.rectangle(frame, (0, h - 50), (w, h), (0, 0, 0), -1)
    cv2.putText(frame, label, (10, h - 15),
                cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 0), 2, cv2.LINE_AA)


def main():
    global supabase, GATE_OPEN_SECONDS

    parser = argparse.ArgumentParser(
        description="Leitura continua de placas via webcam ou camera IP."
    )
    parser.add_argument(
        "--camera", default=0,
        help="Indice da webcam (0, 1...) ou URL RTSP. Padrao: 0"
    )
    parser.add_argument(
        "--model",
        default=os.getenv("MODEL_PLATES", DEFAULT_MODEL),
        help="Caminho para o .pt do detector YOLO de placas"
    )
    parser.add_argument("--conf",   type=float, default=0.25,
                        help="Limiar de confianca YOLO (padrao: 0.25)")
    parser.add_argument("--imgsz",  type=int,   default=640,
                        help="Tamanho de entrada do YOLO (padrao: 640)")
    parser.add_argument("--sample-every", type=int, default=5,
                        help="Processar 1 a cada N frames (padrao: 5)")
    parser.add_argument("--confirm", type=int, default=2,
                        help="Frames consecutivos para confirmar placa (padrao: 2)")
    parser.add_argument("--cooldown", type=float, default=10.0,
                        help="Segundos entre disparos da mesma placa (padrao: 10)")
    parser.add_argument("--show", action="store_true",
                        help="Exibir janela com preview da camera")
    parser.add_argument("--arduino-port", default=os.getenv("ARDUINO_PORT", "COM5"),
                        help="Porta serial do Arduino (padrao: COM5)")
    parser.add_argument("--baud", type=int,
                        default=int(os.getenv("ARDUINO_BAUD", "9600")),
                        help="Baud rate da serial do Arduino (padrao: 9600)")
    parser.add_argument("--gate-open-seconds", type=float,
                        default=GATE_OPEN_SECONDS,
                        help="Tempo em segundos para manter o portao aberto")
    args = parser.parse_args()

    supabase = criar_cliente_supabase()
    GATE_OPEN_SECONDS = args.gate_open_seconds

    # Converter --camera para int se for número
    camera = args.camera
    try:
        camera = int(camera)
    except (ValueError, TypeError):
        pass  # É uma URL RTSP, manter como string

    model_path = Path(args.model)
    if not model_path.exists():
        print(f"Erro: modelo nao encontrado: {model_path}", file=sys.stderr)
        print("Informe o caminho com --model ou via variavel MODEL_PLATES.",
              file=sys.stderr)
        sys.exit(1)

    conectar_arduino(args.arduino_port, args.baud)

    try:
        run(
            camera=camera,
            model_path=str(model_path),
            conf=args.conf,
            imgsz=args.imgsz,
            sample_every=args.sample_every,
            confirm_frames=args.confirm,
            cooldown=args.cooldown,
            show=args.show,
        )
    finally:
        fechar_arduino()


if __name__ == "__main__":
    main()
