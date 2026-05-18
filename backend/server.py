import os
from pathlib import Path

from dotenv import load_dotenv
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from pipeline import load_models, detect
from arduino import conectar_arduino, fechar_arduino, abrir_cancela, arduino_conectado

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent

MODEL_PLATES = os.getenv(
    "MODEL_PLATES",
    str(BASE_DIR / ".." / "back2" / "deteccao-placas-veiculares-main" / "models" / "best.pt")
)
DETECT_CONF      = float(os.getenv("DETECT_CONF",       "0.25"))
DETECT_IMGSZ     = int(os.getenv("DETECT_IMGSZ",       "640"))
PORT             = int(os.getenv("PORT",                "8000"))
ARDUINO_PORT     = os.getenv("ARDUINO_PORT",            "COM5")
ARDUINO_BAUD     = int(os.getenv("ARDUINO_BAUD",        "9600"))
GATE_OPEN_SECONDS = float(os.getenv("GATE_OPEN_SECONDS", "5"))

@asynccontextmanager
async def lifespan(app: FastAPI):
    print(f"Carregando modelo de placas : {MODEL_PLATES}")
    print(f"Conf YOLO                   : {DETECT_CONF}")
    print(f"imgsz                       : {DETECT_IMGSZ}")
    load_models(MODEL_PLATES, conf=DETECT_CONF, imgsz=DETECT_IMGSZ)
    print("Modelos carregados com sucesso.")
    conectar_arduino(ARDUINO_PORT, ARDUINO_BAUD)
    yield
    fechar_arduino()


app = FastAPI(title="GateVision API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def health():
    return {
        "status": "ok",
        "service": "GateVision API",
        "arduino": arduino_conectado(),
    }


@app.post("/api/detect")
async def detect_plate(file: UploadFile = File(...)):
    image_bytes = await file.read()
    result = detect(image_bytes, debug=False)

    placa         = result.get("placa")
    confianca     = result.get("confianca", 0)
    confianca_ocr = result.get("confianca_ocr", 0)

    if placa:
        print(
            f"[GateVision] Placa detectada : {placa}"
            f"  (YOLO: {confianca:.2%}  OCR: {confianca_ocr:.2%})"
        )
    else:
        print("[GateVision] Nenhuma placa detectada na imagem.")

    return {
        "placa":          placa,
        "confianca":      confianca,
        "confianca_yolo": result.get("confianca_yolo", confianca),
        "confianca_ocr":  confianca_ocr,
        "score_ocr":      result.get("score_ocr", 0),
        "candidatos":     result.get("candidatos", []),
    }


@app.post("/api/open-gate")
async def open_gate():
    """Aciona o Arduino para abrir a cancela/portão."""
    abrir_cancela(GATE_OPEN_SECONDS)
    connected = arduino_conectado()
    print(f"[GateVision] Abertura manual solicitada. Arduino conectado: {connected}")
    return {"ok": True, "arduino": connected}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=PORT, reload=True)
