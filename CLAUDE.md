# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Gate Vision is a vehicle access control platform for condominiums and parking lots. It combines a Python FastAPI backend (YOLO + EasyOCR license plate detection, Arduino barrier control) with a React frontend (admin dashboard, real-time monitoring, resident/vehicle management backed by Supabase).

## Commands

### Start Everything (Development)
```bash
npm install
npm run dev
```
`scripts/dev.mjs` creates a Python venv under `backend/.venv`, installs pip deps, then starts both the FastAPI server (port 8000) and Vite dev server (port 4173) concurrently.

### Frontend Only
```bash
npm run dev:front   # http://127.0.0.1:4173
npm run build
npm run preview
```

### Backend Only (Windows)
```bash
cd backend
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
python server.py
```

### Run Detection Tests
```bash
cd backend
python test_placas.py [--model path/to/model.pt] [--conf 0.10] [--debug]
```
Reads test images from `../Placas Teste/placas/` and compares against `../Placas Teste/gabarito/`.

## Architecture

### Request Flow
1. Frontend uploads an image to `POST /api/detect` on the FastAPI server.
2. `backend/pipeline.py` applies CLAHE contrast enhancement, runs YOLO inference on the full image, crops detected plate regions, then passes each crop through 4 EasyOCR preprocessing variants (mercosul_ink morphological, color, CLAHE, binary).
3. Results are scored; a candidate exits early if it exceeds a confidence threshold (180 pts). OCR errors specific to Brazilian Mercosul plates are corrected (e.g., `0↔O`, `I↔1`).
4. The frontend checks the returned plate against the Supabase `veiculos`/`vinculos`/`autorizacoes_temporarias` tables to decide allow/deny.
5. On approval, `POST /api/open-gate` sends bytes `b"A"` (open) then `b"F"` (close) to the Arduino via `backend/arduino.py`.

### Backend (`backend/`)
| File | Responsibility |
|---|---|
| `server.py` | FastAPI app, endpoints (`GET /`, `POST /api/detect`, `POST /api/open-gate`), startup/shutdown lifecycle |
| `pipeline.py` | Model loading, full detection pipeline: YOLO + multi-variant EasyOCR + scoring |
| `arduino.py` | Serial connection to Arduino; degrades gracefully to simulation mode when hardware is absent |

### Frontend (`front/Projeto-GateVision-main/src/`)
| File/Dir | Responsibility |
|---|---|
| `App.jsx` | Root: session, view routing (dashboard/monitor/cadastro/cameras/autorizacoes/logs), theme toggle, backend URL config |
| `components/MonitorView.jsx` | Real-time webcam or file-upload plate detection; uses a 2-of-4-frame voting mechanism before confirming a read |
| `components/DashboardView.jsx` | Access metrics and charts (Chart.js) |
| `components/ResidentsView.jsx` | CRUD for residents and their vehicles |
| `lib/config.js` | Supabase client init; backend URL resolution: `?backend=` query param → localStorage → `window.GATEVISION_BACKEND_URL` → `http://localhost:8000` |
| `lib/api.js` | All backend HTTP calls and Supabase database operations |
| `lib/utils.js` | Formatting helpers (CPF, plates, dates), session management, role-based nav |

### Configuration

**`backend/.env`** (create from defaults in `server.py`):
```
MODEL_PLATES=../back2/deteccao-placas-veiculares-main/models/best.pt
DETECT_CONF=0.25
DETECT_IMGSZ=640
PORT=8000
ARDUINO_PORT=COM5
ARDUINO_BAUD=9600
GATE_OPEN_SECONDS=5
```

**Frontend** (`lib/config.js`): requires `SUPABASE_URL` and `SUPABASE_KEY` set in that file.

### Key Constraints
- The YOLO `.pt` model file is gitignored; it lives at `back2/deteccao-placas-veiculares-main/models/best.pt` and must be obtained separately.
- The Supabase schema (tables: `usuarios_sistema`, `pessoas`, `veiculos`, `vinculos`, `cameras`, `autorizacoes_temporarias`, `logs_acesso`) must be provisioned externally.
- Arduino is optional — `arduino.py` falls back to simulation mode automatically when the port is unavailable or `pyserial` is not installed.
- The OCR pipeline is specifically tuned for Brazilian Mercosul plates (diagonal watermarks, specific character confusion patterns).
