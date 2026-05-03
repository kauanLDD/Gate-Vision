# Gate Vision

Gate Vision é uma plataforma completa de controle de acesso veicular que combina:
- uma API em Python com FastAPI para detecção de placas e integração com Arduino,
- um pipeline de visão computacional com YOLO + OCR para leitura de placas Mercosul,
- uma interface administrativa em React para monitoramento, cadastro de moradores, câmeras e autorizações temporárias,
- persistência de dados via Supabase.

## Visão geral do sistema

O projeto foi pensado para uso em condomínios, portarias ou estacionamentos que precisam:
- detectar placas de veículos automaticamente,
- autorizar entradas de forma automática ou manual,
- registrar acessos e negar veículos não cadastrados,
- integrar com hardware Arduino para abrir/fechar cancelas.

## Estrutura do repositório

- `package.json` - scripts do projeto e dependências do frontend.
- `vite.config.js` - configuração do Vite para iniciar o frontend React.
- `scripts/dev.mjs` - script de desenvolvimento que inicializa backend Python e frontend React juntos.
- `backend/` - código backend FastAPI e integração com Arduino.
- `front/Projeto-GateVision-main/` - código frontend React.
- `back2/deteccao-placas-veiculares-main/` - modelo YOLO e recursos de detecção de placas.

---

## Backend

### `backend/server.py`

Este arquivo define a API principal e os pontos de entrada:

- `startup()`
  - carrega o modelo de detecção YOLO e inicializa a conexão com o Arduino.

- `shutdown()`
  - fecha a conexão com o Arduino ao encerrar o serviço.

- `health()` (`GET /`)
  - retorna status de saúde do serviço e estado de conexão com o Arduino.

- `detect_plate()` (`POST /api/detect`)
  - recebe uma imagem como upload e retorna:
    - `placa` detectada,
    - `confianca` da detecção,
    - logs de erro no servidor quando não há placa.

- `open_gate()` (`POST /api/open-gate`)
  - aciona o Arduino para abrir a cancela/portão por um tempo configurável.

Configurações em `server.py`:
- `MODEL_PLATES` - caminho do modelo YOLO (`best.pt`).
- `DETECT_CONF` - limiar de confiança do YOLO.
- `DETECT_IMGSZ` - dimensão de entrada do YOLO.
- `PORT` - porta HTTP para FastAPI.
- `ARDUINO_PORT` - porta serial do Arduino.
- `ARDUINO_BAUD` - velocidade da serial do Arduino.
- `GATE_OPEN_SECONDS` - tempo que o portão permanece aberto.

### `backend/pipeline.py`

Este módulo implementa o pipeline de detecção de placas e OCR.

Principais funções exportadas:
- `load_models(plates_path, chars_path=None, conf=0.25, imgsz=640)`
  - carrega o modelo YOLO e inicializa leitor EasyOCR.

- `detect(image_bytes, debug=False)`
  - pipeline completo que retorna:
    - `placa`: placa extraída ou `None`,
    - `confianca`: confiança YOLO,
    - `debug`: dados opcionais de detecção.

Componentes do pipeline:
- `_enhance_full_image(img)`
  - aplica CLAHE no espaço LAB para melhorar contraste.

- `_safe_crop(img, x1, y1, x2, y2, margin=0.08)`
  - recorta região detectada adicionando margem segura.

- `_crop_char_row(crop)`
  - isola a linha de texto da placa, removendo cabeçalho e borda.

- `_make_mercosul_ink(crop)`
  - processa placas Mercosul com marcas diagonais usando morfologia.

- `_make_variants(crop)`
  - gera variantes `color`, `clahe` e `binary` para o OCR.

- `_run_ocr(img_variant)`
  - executa EasyOCR com allowlist de caracteres `A-Z0-9`.

- `_correct_mercosul(text)`
  - corrige confusões comuns entre letras e dígitos em placas Mercosul.

- `_score(text)`
  - pontua candidatos de placa com base em formato Mercosul/antigo.

- `_extract_candidates(ocr_hits)`
  - monta candidatos a placa e seleciona o melhor resultado.

- `_ocr_crop_fast(crop, debug_variants=None)`
  - executa OCR em variantes ordenadas de imagem e faz parada antecipada.

- `_run_yolo_fast(img)`
  - inferência rápida YOLO sem TTA.

- `_run_yolo_robust(img)`
  - inferência robusta com TTA e fallback de confiança.

- `_process_detections(detections, img, debug_info, timings)`
  - roda OCR nas detecções YOLO e escolhe a melhor placa.

A lógica principal de `detect()` é:
1. decodificar bytes em imagem;
2. realçar imagem com CLAHE;
3. rodar YOLO rápido;
4. extrair placas via OCR;
5. se não houver resultado, executar YOLO robusto com TTA;
6. retornar placa e confiança.

### `backend/arduino.py`

Gerencia a camada de hardware do Arduino para abrir e fechar o portão.

Funções expostas:
- `arduino_conectado()` - indica se há conexão ativa.
- `conectar_arduino(porta, baud)` - tenta abrir a porta serial.
- `fechar_arduino()` - encerra a conexão serial.
- `enviar_arduino(comando)` - envia bytes para o Arduino.
- `abrir_cancela(tempo_aberta)`
  - dispara abertura (`b"A"`) e depois fechamento (`b"F"`) após `tempo_aberta`.

O módulo suporta modo de simulação quando a biblioteca `pyserial` não está disponível ou a conexão falha.

---

## Frontend

A interface é construída em React e reside em `front/Projeto-GateVision-main`.

### `src/App.jsx`

Responsabilidades principais:
- controle de sessão e login do usuário;
- definição da visualização atual (`dashboard`, `monitor`, `cadastro`, etc.);
- gestão da URL do backend via localStorage ou parâmetro `backend` na URL;
- renderização condicional das views com base no perfil do usuário;
- exibição de toasts de sucesso/erro.

### `src/lib/config.js`

- cria cliente Supabase com `SUPABASE_URL` e `SUPABASE_KEY`.
- define `resolveBackendUrl()` para descobrir a URL do backend em:
  - query string `backend`,
  - `localStorage`,
  - variável global `window.GATEVISION_BACKEND_URL`,
  - fallback `http://localhost:8000`.

### `src/lib/utils.js`

Funções utilitárias de uso compartilhado:
- `formatCPF(value)`;
- `onlyPlate(value)`;
- `isAllowedStatus(status)`;
- `logStatus(log)`;
- `formatDateTime(raw)`;
- `getFilterDateISO(days)`;
- `defaultDatetime(offsetHours)`;
- `groupLogsByDay(logs, days)`;
- gerenciamento de sessão local:
  - `getSession()`, `setSession(user)`, `clearSession()`;
- `navItemsByRole(role)` para menu por perfil;
- `buildStatusIllustration(type)` para imagens de status.

### `src/lib/api.js`

Esse módulo concentra todas as chamadas de dados e integrações com Supabase e backend.

Operações de autenticação e cadastro:
- `loginUser(login, password)` - valida credenciais na tabela `usuarios_sistema`.
- `fetchResidents()` - retorna lista de moradores, veículos e unidades.
- `saveResident(payload)` - cria pessoa, veículo, bloco, unidade e vínculo.
- `deleteResident(personId)` - remove vínculos, veículo e pessoa.
- `updateResident(personId, payload)` - atualiza registros existentes.

Operações de painel administrativo:
- `fetchDashboardData(filterDays)` - busca logs de acesso e agrega métricas.
- `fetchLogs()` - retorna histórico de acessos.
- `fetchCameras()`, `saveCamera(payload)`, `deleteCamera(cameraId)`, `updateCamera(cameraId, payload)`.
- `fetchAuthorizations()`, `saveAuthorization(payload)`, `updateAuthorization(id, payload)`, `deleteAuthorization(id)`.

Operações de detecção e controle:
- `detectPlateFromBackend(backendUrl, file)` - envia imagem ao backend FastAPI para OCR de placas.
- `lookupAuthorizedPlate(plate)` - checa placas autorizadas e autorizações temporárias.
- `registerAccessOpen(plate)` - grava acesso liberado.
- `registerAccessDenied(plate)` - grava acesso negado.
- `triggerGate(backendUrl)` - chama `POST /api/open-gate` para acionar hardware.

### Principais views do frontend

- `LoginScreen.jsx`
  - autenticação do usuário e validação de formulário.

- `DashboardView.jsx`
  - resumo de acessos, visitantes liberados/negados, total de moradores e gráficos.

- `MonitorView.jsx`
  - monitor de leitura de placas em tempo real;
  - suporta webcam local e captura de imagem;
  - exibe estado de placa detectada, status de liberação e preview da câmera;
  - permite liberar automaticamente placas autorizadas e abrir o portão.

- `ResidentsView.jsx`
  - gerenciamento de moradores e veículos;
  - cadastro, edição e exclusão de registros.

- `CamerasView.jsx`
  - gerenciamento de câmeras ativas no sistema.

- `AuthorizationsView.jsx`
  - criação e manutenção de autorizações temporárias de entrada.

- `LogsView.jsx`
  - histórico de acessos, negativos e positivos.

- `AppShell.jsx`
  - layout principal, navegação e cabeçalho do sistema.

- `ToastViewport.jsx`
  - exibição de mensagens de feedback no frontend.

---

## Arquitetura de funcionamento

1. Usuário faz login no frontend React.
2. Frontend exibe páginas com base no perfil (`admin` ou `porteiro`).
3. No monitor de placas, o sistema captura imagem de webcam ou arquivo.
4. A imagem é enviada a `backend/server.py` em `/api/detect`.
5. O backend processa via `backend/pipeline.py`:
   - realça contraste,
   - detecta região da placa com YOLO,
   - faz OCR em variantes de imagem,
   - corrige confusões de Mercosul,
   - escolhe a melhor placa.
6. O frontend consulta a base Supabase para verificar autorização.
7. Se autorizado, o backend recebe comando de abrir o portão.
8. `backend/arduino.py` envia comandos seriais ao Arduino para abrir e fechar.

---

## Dependências principais

### Backend
- Python 3.x
- FastAPI
- Uvicorn
- ultralytics
- easyocr
- opencv-python
- python-dotenv
- pyserial

### Frontend
- React 19
- Vite
- @supabase/supabase-js
- chart.js

---

## Como rodar o projeto

### 1. Instalar dependências do frontend

```bash
npm install
```

### 2. Iniciar ambiente de desenvolvimento

```bash
npm run dev
```

Isso executa `scripts/dev.mjs`, que:
- cria um ambiente virtual Python em `backend/.venv` se necessário;
- instala dependências Python do backend;
- inicia o backend FastAPI;
- inicia o frontend Vite;
- abre o navegador em `http://127.0.0.1:4173`.

### 3. Alternativas

- Frontend apenas:
  - `npm run dev:front`
- Build de produção frontend:
  - `npm run build`
- Preview do build:
  - `npm run preview`

### 4. Rodar backend isolado

No diretório `backend`:

```bash
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
python server.py
```

---

## Variáveis de ambiente

O backend respeita as seguintes variáveis:

- `MODEL_PLATES` - caminho do arquivo `.pt` do modelo YOLO.
- `DETECT_CONF` - confiança inicial do detector YOLO.
- `DETECT_IMGSZ` - tamanho de imagem para o YOLO.
- `PORT` - porta HTTP do backend.
- `ARDUINO_PORT` - porta serial do Arduino.
- `ARDUINO_BAUD` - baudrate serial.
- `GATE_OPEN_SECONDS` - tempo de abertura do portão.

---

## Observações importantes

- O projeto inclui `back2/deteccao-placas-veiculares-main/models/best.pt` como modelo de detecção.
- `backend/pipeline.py` fornece suporte específico para placas Mercosul e placas antigas.
- O controle de portão usa comandos seriais `b"A"` e `b"F"`.
- O frontend depende de tabelas e visões Supabase como `usuarios_sistema`, `pessoas`, `veiculos`, `vinculos`, `cameras`, `autorizacoes_temporarias`, `vw_ultimos_acessos` e `vw_placas_autorizadas`.

---

## Funcionalidades disponíveis

### Funcionalidades do sistema completo
- autenticação de usuários;
- dashboard com métricas de acesso;
- monitor de placas com webcam e captura de imagens;
- detecção automática de placa via backend;
- lookup de autorização em base de dados;
- abertura de portão via Arduino;
- cadastro completo de moradores e veículos;
- gerenciamento de câmeras;
- autorizações temporárias para visitantes;
- histórico de acessos liberados ou negados.

### Diferenciais técnicos
- pipeline de OCR com:
  - CLAHE,
  - detecção YOLO rápida e robusta com TTA,
  - variantes de pré-processamento de imagens,
  - correção automática de caracteres Mercosul.
- fallback de hardware para modo de simulação em caso de Arduino offline.
- backend e frontend desacoplados com comunicação via HTTP.

## Para desenvolvedores

### Estrutura de pastas
- `backend/` - serviço de API, detecção e controle de hardware.
- `front/Projeto-GateVision-main/` - aplicação React.
- `back2/` - repositório de modelos e recursos de detecção de placas.
- `scripts/` - utilitários de desenvolvimento.

### Pontos de extensão
- configurar `supabase` e tabelas para correspondência de schema;
- ajustar `MODEL_PLATES` para outro modelo YOLO personalizado;
- adaptar `ARDUINO_PORT` e `ARDUINO_BAUD` para diferentes placas;
- adicionar endpoint de debug no backend para retorno de imagens/frames.

---

## Conclusão

Este projeto é uma solução robusta para controle de acesso veicular com visão computacional e integração de hardware. A documentação acima cobre as funções principais, a arquitetura de execução, os arquivos críticos e os modos de operação disponíveis.
