import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from pipeline import detect, load_models
from arduino import (
    abrir_cancela,
    arduino_conectado,
    conectar_arduino,
    fechar_arduino,
    listar_portas_arduino,
    status_arduino,
)

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent

MODEL_PLATES = os.getenv(
    "MODEL_PLATES",
    str(BASE_DIR / ".." / "back2" / "deteccao-placas-veiculares-main" / "models" / "best.pt"),
)
DETECT_CONF = float(os.getenv("DETECT_CONF", "0.25"))
DETECT_IMGSZ = int(os.getenv("DETECT_IMGSZ", "640"))
PORT = int(os.getenv("PORT", "8000"))
ARDUINO_PORT = os.getenv("ARDUINO_PORT", "").strip()
ARDUINO_BAUD = int(os.getenv("ARDUINO_BAUD", "9600"))
GATE_OPEN_SECONDS = float(os.getenv("GATE_OPEN_SECONDS", "5"))

app = FastAPI(title="GateVision API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ArduinoConnectPayload(BaseModel):
    port: str
    baud: int = ARDUINO_BAUD


@app.on_event("startup")
def startup():
    print(f"Carregando modelo de placas : {MODEL_PLATES}")
    print(f"Conf YOLO                   : {DETECT_CONF}")
    print(f"imgsz                       : {DETECT_IMGSZ}")
    load_models(MODEL_PLATES, conf=DETECT_CONF, imgsz=DETECT_IMGSZ)
    print("Modelos carregados com sucesso.")

    if ARDUINO_PORT:
        conectar_arduino(ARDUINO_PORT, ARDUINO_BAUD)
    else:
        print("Arduino sem porta predefinida. Aguardando selecao pela interface.")


@app.on_event("shutdown")
def shutdown():
    fechar_arduino()


@app.get("/")
def health():
    return {
        "status": "ok",
        "service": "GateVision API",
        "arduino": arduino_conectado(),
        "arduino_status": status_arduino(),
    }


@app.get("/api/arduino")
def get_arduino_state():
    return {
        "ok": True,
        "ports": listar_portas_arduino(),
        "arduino": status_arduino(),
    }


@app.post("/api/arduino/connect")
def connect_arduino(payload: ArduinoConnectPayload):
    port = payload.port.strip()
    if not port:
        raise HTTPException(status_code=400, detail="Informe a porta serial do Arduino.")

    connected = conectar_arduino(port, payload.baud)
    if not connected:
        raise HTTPException(status_code=400, detail=f"Nao foi possivel conectar ao Arduino em {port}.")

    return {
        "ok": True,
        "ports": listar_portas_arduino(),
        "arduino": status_arduino(),
    }


@app.post("/api/arduino/disconnect")
def disconnect_arduino():
    fechar_arduino()
    return {
        "ok": True,
        "ports": listar_portas_arduino(),
        "arduino": status_arduino(),
    }


@app.post("/api/detect")
async def detect_plate(file: UploadFile = File(...)):
    image_bytes = await file.read()
    result = detect(image_bytes, debug=False)

    placa = result.get("placa")
    confianca = result.get("confianca", 0)

    if placa:
        print(f"[GateVision] Placa detectada : {placa}  (confianca YOLO: {confianca:.2%})")
    else:
        print("[GateVision] Nenhuma placa detectada na imagem.")

    return {"placa": placa, "confianca": confianca}


@app.post("/api/open-gate")
async def open_gate():
    connected = arduino_conectado()
    if not connected:
        raise HTTPException(status_code=409, detail="Arduino nao conectado. Selecione a porta USB e conecte antes de abrir o portao.")

    abrir_cancela(GATE_OPEN_SECONDS)
    print("[GateVision] Abertura manual solicitada.")
    return {"ok": True, "arduino": status_arduino()}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host="0.0.0.0", port=PORT, reload=True)
