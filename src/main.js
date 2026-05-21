const { app, BrowserWindow, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");

(function loadLocalEnvFile() {
  const candidates = [
    path.join(__dirname, "..", ".env"),
    path.join(process.cwd(), ".env"),
  ];
  try {
    if (app.isPackaged) {
      candidates.unshift(path.join(process.resourcesPath, ".env"));
    }
  } catch (_) {
    /* ignore */
  }
  for (const envPath of candidates) {
    try {
      if (fs.existsSync(envPath)) {
        dotenv.config({ path: envPath });
        console.log("[MAIN] Loaded environment file:", envPath);
        return;
      }
    } catch (err) {
      console.warn(
        "[MAIN] Failed loading .env:",
        envPath,
        err && err.message ? err.message : err,
      );
    }
  }
})();

const http = require("http");
const https = require("https");
const { registerIpcHandlers, unregisterIpcHandlers } = require("./ipc");
const pythonAPI = require("./services/python/PythonAPI");

let mainWindow;

/** Quit path enters `before-quit` twice: first we prevent quit and teardown Python; second we allow quit. */
let allowQuitAfterPythonBridgeTeardown = false;

const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL || "";
const SHOULD_OPEN_DEVTOOLS =
  process.env.ELECTRON_DEVTOOLS === "1" || process.argv.includes("--devtools");
const STARTUP_TIMEOUT_MS = 60000;
/** Short splash before loading the real renderer (was 3000ms; lower = faster startup). */
const LOADING_DELAY_MS = 500;
const LOADING_ICON_PATH = path.join(__dirname, "assets", "icon.png");
const LOADING_ICON_DATA_URL = fs.existsSync(LOADING_ICON_PATH)
  ? `data:image/png;base64,${fs.readFileSync(LOADING_ICON_PATH, "base64")}`
  : "";
const LOADING_ICON_HTML = LOADING_ICON_DATA_URL
  ? `<div class="icon-wrap"><img src="${LOADING_ICON_DATA_URL}" alt="App icon" /></div>`
  : '<div class="icon-wrap icon-fallback" aria-hidden="true">V</div>';
const LOADING_HTML =
  "data:text/html," +
  encodeURIComponent(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>STARTING...</title>
  <style>
    :root {
      --bg-1: #0b0f17;
      --bg-2: #121a2a;
      --glow-1: rgba(80, 197, 255, 0.35);
      --glow-2: rgba(255, 180, 90, 0.3);
      --accent-1: #8cf3ff;
      --accent-2: #ffd29c;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Bahnschrift", "Trebuchet MS", "Segoe UI", sans-serif;
      background:
        radial-gradient(900px 420px at 8% 12%, rgba(255,255,255,0.07), transparent 60%),
        radial-gradient(700px 380px at 92% 18%, var(--glow-1), transparent 65%),
        radial-gradient(620px 420px at 16% 88%, var(--glow-2), transparent 70%),
        linear-gradient(135deg, var(--bg-1), var(--bg-2));
      color: #eef6ff;
      display: grid;
      place-items: center;
      height: 100vh;
      overflow: hidden;
    }
    body::before,
    body::after {
      content: "";
      position: fixed;
      width: 380px;
      height: 380px;
      border-radius: 50%;
      filter: blur(60px);
      opacity: 0.45;
      z-index: 0;
    }
    body::before { background: #4cb3ff; top: -160px; left: -120px; }
    body::after { background: #ffb46e; bottom: -180px; right: -120px; }
    .wrap {
      position: relative;
      z-index: 1;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 18px;
      padding: 48px 64px 44px;
      border-radius: 28px;
      background: rgba(14, 20, 32, 0.78);
      border: 1px solid rgba(255,255,255,0.08);
      box-shadow: 0 25px 70px rgba(0,0,0,0.55);
      backdrop-filter: blur(14px);
      min-width: 320px;
    }
    .icon-wrap {
      width: 86px;
      height: 86px;
      border-radius: 24px;
      background: linear-gradient(150deg, rgba(140,243,255,0.2), rgba(255,210,156,0.2));
      display: grid;
      place-items: center;
      border: 1px solid rgba(255,255,255,0.16);
      box-shadow: 0 14px 30px rgba(0,0,0,0.35);
    }
    .icon-wrap img { width: 68%; height: 68%; object-fit: contain; }
    .icon-fallback { font-size: 34px; font-weight: 700; letter-spacing: 2px; }
    .title {
      font-size: 42px;
      font-weight: 600;
      letter-spacing: 6px;
      text-transform: uppercase;
      margin: 0;
      background: linear-gradient(90deg, var(--accent-1), var(--accent-2));
      -webkit-background-clip: text;
      color: transparent;
      text-shadow: 0 6px 18px rgba(140,243,255,0.2);
    }
    .subtitle {
      font-size: 12px;
      letter-spacing: 3px;
      text-transform: uppercase;
      opacity: 0.65;
    }
    .progress {
      position: relative;
      width: 220px;
      height: 6px;
      border-radius: 999px;
      background: rgba(255,255,255,0.12);
      overflow: hidden;
    }
    .progress::after {
      content: "";
      position: absolute;
      width: 45%;
      height: 100%;
      left: -45%;
      top: 0;
      background: linear-gradient(90deg, transparent, var(--accent-1), var(--accent-2), transparent);
      animation: slide 1.4s ease-in-out infinite;
    }
    @keyframes slide {
      0% { transform: translateX(0); }
      100% { transform: translateX(320px); }
    }
  </style>
</head>
<body>
  <div class="wrap">
    ${LOADING_ICON_HTML}
    <h1 class="title">STARTING...</h1>
    <div class="subtitle">Preparing workspace</div>
    <div class="progress"></div>
  </div>
</body>
</html>`);

function isDevelopment() {
  return process.env.NODE_ENV === "development" || !app.isPackaged;
}

function buildErrorPage(message) {
  return (
    "data:text/html," +
    encodeURIComponent(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Startup error</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #120f10; color: #f5f5f5; display: flex; align-items: center; justify-content: center; height: 100vh; }
    .wrap { max-width: 520px; padding: 24px; text-align: center; }
    p { opacity: 0.85; }
    code { background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h2>Application startup error</h2>
    <p>${message}</p>
  </div>
</body>
</html>`)
  );
}

function waitForFile(
  filePath,
  timeoutMs = STARTUP_TIMEOUT_MS,
  intervalMs = 250,
) {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (fs.existsSync(filePath)) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, intervalMs);
  });
}

function isDevServerAvailable(url, timeoutMs = 300) {
  return new Promise((resolve) => {
    if (!url) {
      resolve(false);
      return;
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      resolve(false);
      return;
    }

    const client = parsed.protocol === "https:" ? https : http;
    const request = client.request(
      {
        method: "GET",
        host: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname || "/",
        timeout: timeoutMs,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode >= 200 && response.statusCode < 500);
      },
    );

    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });

    request.on("error", () => resolve(false));
    request.end();
  });
}

async function loadDevRenderer(window) {
  const distIndex = path.join(__dirname, "../dist/index.html");
  const devServerReady = await isDevServerAvailable(DEV_SERVER_URL);

  if (devServerReady) {
    await window.loadURL(DEV_SERVER_URL);
    if (SHOULD_OPEN_DEVTOOLS) {
      window.webContents.openDevTools();
    }
    return;
  }

  if (!fs.existsSync(distIndex)) {
    const found = await waitForFile(distIndex);
    if (!found) {
      await window.loadURL(
        buildErrorPage(
          "Renderer build did not appear in time. Run the webpack watcher and try again.",
        ),
      );
      return;
    }
  }

  await window.loadFile(distIndex);
  if (SHOULD_OPEN_DEVTOOLS) {
    window.webContents.openDevTools();
  }
}

async function loadProdRenderer(window) {
  const unpackedIndex = path.join(process.resourcesPath, "dist", "index.html");
  const asarIndex = path.join(__dirname, "../dist/index.html");

  if (process.env.VALTECH_DEBUG_MAIN === "1") {
    console.log("[MAIN] NODE_ENV=production. Checking for index files:");
    console.log("[MAIN] unpackedIndex =", unpackedIndex);
    console.log("[MAIN] asarIndex =", asarIndex);
    try {
      console.log(
        "[MAIN] resourcesPath listing:",
        fs.readdirSync(process.resourcesPath),
      );
    } catch (e) {
      console.warn("[MAIN] cannot read resourcesPath:", e && e.message);
    }
  }

  if (fs.existsSync(unpackedIndex)) {
    await window.loadFile(unpackedIndex);
    return;
  }

  if (fs.existsSync(asarIndex)) {
    await window.loadFile(asarIndex);
    return;
  }

  console.error(
    "[MAIN] ERROR: index.html not found in either resources/dist or app.asar",
  );
  await window.loadURL(
    buildErrorPage("index.html not found. Please reinstall the application."),
  );
}

function createWindow() {
  const devMode = isDevelopment();
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      devTools: true,
      contextIsolation: true,
      enableRemoteModule: false,
      preload: path.join(__dirname, "preload.js"),
    },
    icon: path.join(__dirname, "../assets/icon.png"),
    backgroundColor: "#0b0f17",
    show: false,
  });

  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      console.error(
        "[MAIN] Renderer did-fail-load:",
        errorCode,
        errorDescription,
        validatedURL,
      );
    },
  );

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("[MAIN] Renderer process gone:", details);
  });

  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error("[MAIN] Preload error:", preloadPath, error);
  });

  mainWindow.webContents.once("did-finish-load", () => {
    mainWindow.show();
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        return;
      }
      if (devMode) {
        loadDevRenderer(mainWindow).catch((error) => {
          console.error("[MAIN] Dev renderer load failed:", error);
        });
      } else {
        loadProdRenderer(mainWindow).catch((error) => {
          console.error("[MAIN] Prod renderer load failed:", error);
        });
      }
    }, LOADING_DELAY_MS);
  });
  mainWindow.loadURL(LOADING_HTML);

  let isQuitting = false;

  mainWindow.on("close", async (event) => {
    if (isQuitting) return;

    event.preventDefault();

    const result = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons: ["Cancel", "Quit"],
      defaultId: 1,
      cancelId: 0,
      title: "Confirm Exit",
      message: "Any ongoing processes will be cancelled.",
      detail: "Are you sure you want to quit?",
    });

    if (result.response === 1) {
      isQuitting = true;
      mainWindow.close(); // triggers close again, now allowed
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Electron app event handlers
app.whenReady().then(async () => {
  // Keep Electron session cookies across restarts until their configured expiry.
  // Logout from the renderer still clears cookies via IPC.

  // Register IPC handlers BEFORE creating window to avoid race conditions
  registerIpcHandlers();
  createWindow();
});

async function teardownPythonBridge() {
  try {
    await pythonAPI.closeWorker();
  } catch (error) {
    console.error("[MAIN] Error closing Python worker / Taqeem browser:", error);
  }
}

app.on("before-quit", (event) => {
  if (allowQuitAfterPythonBridgeTeardown) {
    allowQuitAfterPythonBridgeTeardown = false;
    return;
  }

  event.preventDefault();

  teardownPythonBridge().finally(() => {
    allowQuitAfterPythonBridgeTeardown = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  // Unregister IPC handlers to prevent memory leaks
  unregisterIpcHandlers();

  // On macOS, keep app running even when all windows are closed (Taqeem Chrome stays until user quits).
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  // On macOS, re-create window when dock icon is clicked
  if (BrowserWindow.getAllWindows().length === 0) {
    // Ensure handlers are registered before creating window
    registerIpcHandlers();
    createWindow();
  }
});

// Security: Prevent new window creation
app.on("web-contents-created", (event, contents) => {
  contents.on("new-window", (event, navigationUrl) => {
    event.preventDefault();
  });
});
