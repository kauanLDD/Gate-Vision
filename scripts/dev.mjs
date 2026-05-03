import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const backendDir = path.join(rootDir, "backend");
const backendPython = path.join(backendDir, ".venv", "Scripts", "python.exe");
const frontendPort = 4173;
const frontendUrl = `http://127.0.0.1:${frontendPort}`;
const shouldOpenBrowser = !process.argv.includes("--no-open");

let backendProcess = null;
let frontendProcess = null;
let shuttingDown = false;

function log(msg) {
  console.log(`[dev] ${msg}`);
}

function openBrowser(url) {
  spawn("cmd", ["/c", "start", "", url], {
    detached: true,
    stdio: "ignore"
  }).unref();
}

function runSetup(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: backendDir,
    stdio: "inherit",
    ...options
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Comando falhou: ${command} ${args.join(" ")}`);
  }
}

function killProcessTree(processRef) {
  return new Promise((resolve) => {
    if (!processRef?.pid) {
      resolve();
      return;
    }

    const killer = spawn("taskkill", ["/pid", String(processRef.pid), "/t", "/f"], {
      stdio: "ignore"
    });

    killer.on("exit", () => resolve());
    killer.on("error", () => resolve());
  });
}

function watchProcess(name, processRef) {
  processRef.on("error", (error) => {
    if (shuttingDown) return;
    console.error(`[dev] ${name} falhou ao iniciar: ${error.message}`);
    void shutdown(`${name} error`);
  });

  processRef.on("exit", (code, signal) => {
    if (shuttingDown) return;
    const reason = signal ? `sinal ${signal}` : `codigo ${code}`;
    log(`${name} finalizou com ${reason}.`);
    void shutdown(`${name} exit`);
  });
}

function startBackend() {
  if (!fs.existsSync(backendPython)) {
    log("criando ambiente virtual do backend...");
    runSetup("python", ["-m", "venv", ".venv"]);
  }

  const dotenvCheck = spawnSync(backendPython, ["-c", "import dotenv"], {
    cwd: backendDir,
    stdio: "ignore"
  });

  if (dotenvCheck.status !== 0) {
    log("instalando dependencias do backend...");
    runSetup(backendPython, ["-m", "pip", "install", "-r", "requirements.txt"]);
  }

  backendProcess = spawn(backendPython, ["server.py"], {
    cwd: backendDir,
    stdio: "inherit"
  });
  watchProcess("backend", backendProcess);
}

function startFrontend() {
  const command = process.platform === "win32" ? "cmd" : "npm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm", "run", "dev:front", "--", "--host", "127.0.0.1", "--port", String(frontendPort)]
    : ["run", "dev:front", "--", "--host", "127.0.0.1", "--port", String(frontendPort)];

  frontendProcess = spawn(command, args, {
    cwd: rootDir,
    stdio: "inherit"
  });
  watchProcess("frontend", frontendProcess);
}

async function shutdown(signal = "encerramento") {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`recebido ${signal}, finalizando processos...`);

  await Promise.all([
    killProcessTree(frontendProcess),
    killProcessTree(backendProcess)
  ]);

  process.exit(0);
}

process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

log("iniciando backend FastAPI...");
startBackend();
log(`iniciando frontend React em ${frontendUrl}...`);
startFrontend();

if (shouldOpenBrowser) {
  setTimeout(() => {
    log("abrindo navegador...");
    openBrowser(frontendUrl);
  }, 2500);
}
