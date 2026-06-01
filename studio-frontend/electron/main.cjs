const { app, BrowserWindow, Menu, dialog, protocol, net: electronNet, ipcMain } = require("electron");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const MODULES = new Set(["ui", "server", "daemon"]);

protocol.registerSchemesAsPrivileged([
  {
    scheme: "pocket-studio",
    privileges: {
      standard: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

let mainWindow;
const children = [];
const daemonRuntime = {
  enabled: false,
  env: {},
  workspace: "",
  currentKey: "",
  child: null,
};
const appRuntime = {
  localServerURL: "",
};

function log(...args) {
  const line = `[pocket-studio] ${args.map((arg) => {
    if (typeof arg === "string") return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }).join(" ")}`;
  console.log(line);
  try {
    if (app.isReady()) {
      fs.mkdirSync(configDir(), { recursive: true });
      fs.appendFileSync(path.join(configDir(), "app.log"), `${new Date().toISOString()} ${line}\n`);
    }
  } catch {
    // Logging must never block startup.
  }
}

function resourcePath(...parts) {
  const base = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..", "..", "dist", "electron-resources");
  return path.join(base, ...parts);
}

function bundledBinary(name) {
  const extension = process.platform === "win32" ? ".exe" : "";
  return resourcePath("bin", `${name}${extension}`);
}

function appEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  if (process.platform === "darwin") {
    const shellPath = env.SHELL || "/bin/zsh";
    try {
      const shellPATH = execFileSync(shellPath, ["-lic", "printf %s \"$PATH\""], {
        env,
        encoding: "utf8",
        timeout: 3000,
      }).trim();
      if (shellPATH) {
        env.PATH = shellPATH;
      }
    } catch {
      // macOS GUI apps start with a sparse launchd environment; the static fallback below is still useful.
    }
    const pathParts = [
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/local/sbin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      env.PATH || "",
    ].filter(Boolean);
    env.PATH = Array.from(new Set(pathParts.flatMap((value) => value.split(":")).filter(Boolean))).join(":");
  }
  return env;
}

function configDir() {
  return path.join(app.getPath("appData"), "pocket-studio");
}

function parseArgs(argv) {
  const modules = [];
  const options = {};
  for (const arg of argv) {
    if (MODULES.has(arg)) {
      modules.push(arg);
      continue;
    }
    if (!arg.startsWith("--")) continue;
    const raw = arg.slice(2);
    const index = raw.indexOf("=");
    if (index === -1) {
      options[raw] = "true";
    } else {
      options[raw.slice(0, index)] = raw.slice(index + 1);
    }
  }
  if (modules.length === 0) {
    modules.push("ui", "server", "daemon");
  }
  return { modules: new Set(modules), options };
}

function normalizeHTTPAddress(value) {
  if (!value) return "";
  if (/^https?:\/\//.test(value)) return value.replace(/\/+$/, "");
  return `http://${value}`.replace(/\/+$/, "");
}

function daemonWebSocketURL(serverURL) {
  if (!serverURL) {
    return "ws://127.0.0.1:18080/ws/daemon";
  }
  const raw = /^wss?:\/\//.test(serverURL) ? serverURL.replace(/\/+$/, "") : normalizeHTTPAddress(serverURL);
  const base = new URL(raw);
  if (base.protocol === "https:") {
    base.protocol = "wss:";
  } else if (base.protocol === "http:") {
    base.protocol = "ws:";
  } else if (base.protocol !== "ws:" && base.protocol !== "wss:") {
    throw new Error(`unsupported daemon server URL: ${serverURL}`);
  }
  const pathname = base.pathname.replace(/\/+$/, "");
  base.pathname = pathname.endsWith("/ws/daemon") ? pathname : `${pathname}/ws/daemon`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

function portFromServerPortOption(value) {
  if (!value || value === "0") return 0;
  if (value.includes(":")) {
    const part = value.split(":").pop();
    return Number(part || 0);
  }
  return Number(value);
}

function serverListenAddr(options) {
  const raw = options["server.addr"] || "0";
  if (raw.includes(":")) {
    return raw;
  }
  const port = portFromServerPortOption(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --server.addr: ${raw}`);
  }
  return `127.0.0.1:${port}`;
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

function waitForHTTP(serverURL) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const check = () => {
      const req = http.get(`${serverURL}/api/state`, (res) => {
        res.resume();
        if (res.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      });
      req.setTimeout(500, () => {
        req.destroy();
        retry();
      });
      req.on("error", retry);
    };
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error(`server did not become ready: ${serverURL}`));
        return;
      }
      setTimeout(check, 150);
    };
    check();
  });
}

function registerAppProtocol() {
  const rootDir = path.resolve(resourcePath("ui", "dist"));
  const indexFile = path.join(rootDir, "index.html");
  protocol.handle("pocket-studio", (request) => {
    const requestURL = new URL(request.url);
    let pathname = decodeURIComponent(requestURL.pathname || "/");
    if (pathname === "/studio") {
      pathname = "/";
    } else if (pathname.startsWith("/studio/")) {
      pathname = pathname.slice("/studio".length) || "/";
    }
    const requestedPath = path.resolve(rootDir, `.${pathname}`);
    let filePath = requestedPath;

    if (!requestedPath.startsWith(`${rootDir}${path.sep}`) && requestedPath !== rootDir) {
      return new Response("Forbidden", { status: 403 });
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
    if (!fs.existsSync(filePath)) {
      filePath = path.extname(pathname) ? "" : indexFile;
    }
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return new Response("Not found", { status: 404 });
    }
    return electronNet.fetch(`file://${filePath}`);
  });
  log("app protocol", rootDir);
}

function registerDaemonIPC() {
  ipcMain.handle("daemon:sync-config", (_event, cfg) => {
    if (!cfg || typeof cfg !== "object") return { ok: false };
    const serverURL = typeof cfg.server_url === "string" ? cfg.server_url : "";
    const token = typeof cfg.token === "string" ? cfg.token : "";
    if (!serverURL) return { ok: false };
    restartDaemon(serverURL, token);
    return { ok: true };
  });
  ipcMain.handle("app:local-mode", () => {
    if (!appRuntime.localServerURL) {
      return { ok: false, error: "local server is not running" };
    }
    restartDaemon(appRuntime.localServerURL, "");
    return { ok: true, server_url: appRuntime.localServerURL };
  });
}

function spawnManaged(command, args, env) {
  log("spawn", command, args.join(" "));
  const child = spawn(command, args, {
    env: appEnvironment(env),
    stdio: "inherit",
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    const index = children.indexOf(child);
    if (index !== -1) children.splice(index, 1);
    if (daemonRuntime.child === child) {
      daemonRuntime.child = null;
    }
    if (code !== 0 && signal !== "SIGTERM") {
      console.error(`${path.basename(command)} exited`, { code, signal });
    }
  });
  return child;
}

function daemonArgsFor(serverURL, token, workspace) {
  const args = ["-daemon.server.url", daemonWebSocketURL(serverURL)];
  if (token) {
    args.push("-daemon.server.token", token);
  }
  if (workspace) {
    args.push("-daemon.workspace", workspace);
  }
  return args;
}

function restartDaemon(serverURL, token) {
  if (!daemonRuntime.enabled) return;
  const args = daemonArgsFor(serverURL, token, daemonRuntime.workspace);
  const key = args.join("\x00");
  if (key === daemonRuntime.currentKey && daemonRuntime.child && !daemonRuntime.child.killed) {
    return;
  }
  daemonRuntime.currentKey = key;
  if (daemonRuntime.child && !daemonRuntime.child.killed) {
    log("restart daemon");
    daemonRuntime.child.kill();
  }
  daemonRuntime.child = spawnManaged(bundledBinary("pocket-studio-daemon"), args, daemonRuntime.env);
}

function daemonConfigFromURL(rawURL) {
  let parsed;
  try {
    parsed = new URL(rawURL);
  } catch {
    return null;
  }
  const serverURL = parsed.searchParams.get("server_url");
  const token = parsed.searchParams.get("token") || "";
  if (!serverURL) return null;
  return { serverURL, token };
}

function syncDaemonFromWindowURL(rawURL) {
  const cfg = daemonConfigFromURL(rawURL);
  if (!cfg) return;
  try {
    restartDaemon(cfg.serverURL, cfg.token);
  } catch (error) {
    log("daemon restart failed", error instanceof Error ? error.message : String(error));
  }
}

async function startModules() {
  fs.mkdirSync(configDir(), { recursive: true });
  const { modules, options } = parseArgs(process.argv.slice(1));
  log("modules", Array.from(modules).join(",") || "(none)");
  const env = {};
  const explicitUIServerURL = normalizeHTTPAddress(options["ui.server.url"] || "");
  let uiServerURL = explicitUIServerURL;
  let uiServerURLSource = explicitUIServerURL ? "explicit" : "";
  let daemonServerURL = options["daemon.server.url"] || "";
  let serverReadyPromise = null;

  if (modules.has("server")) {
    let addr = serverListenAddr(options);
    if (addr.endsWith(":0")) {
      const port = await reservePort();
      addr = `127.0.0.1:${port}`;
    }
    const port = addr.split(":").pop();
    const localServerURL = `http://127.0.0.1:${port}`;
    appRuntime.localServerURL = localServerURL;
    log("server listen", localServerURL);
    spawnManaged(bundledBinary("pocket-studio-server"), ["-server.addr", addr], env);
    serverReadyPromise = waitForHTTP(localServerURL)
      .then(() => {
        log("server ready", localServerURL);
        return true;
      })
      .catch((error) => {
        log("server readiness failed", error instanceof Error ? error.message : String(error));
        return false;
      });
    if (!uiServerURL) {
      uiServerURL = localServerURL;
      uiServerURLSource = "runtime";
    }
    if (!daemonServerURL) daemonServerURL = localServerURL;
  }

  if (modules.has("ui")) {
    if (!uiServerURL) {
      uiServerURL = "http://127.0.0.1:18080";
      uiServerURLSource = "default";
    }
    log("ui server", uiServerURL || "(not configured)");
  }

  if (modules.has("daemon")) {
    if (!daemonServerURL) {
      daemonServerURL = uiServerURL || "http://127.0.0.1:18080";
    }
    log("daemon server", daemonServerURL || "(not configured)");
    daemonRuntime.enabled = true;
    daemonRuntime.env = env;
    daemonRuntime.workspace = options["daemon.workspace"] || "";
    const token = options["daemon.server.token"] || options["token"] || "";
    const startDaemon = () => restartDaemon(daemonServerURL, token);
    if (serverReadyPromise) {
      serverReadyPromise.then((ready) => {
        if (ready) startDaemon();
      });
    } else {
      startDaemon();
    }
  }

  return { modules, uiServerURL, uiServerURLSource };
}

async function createWindow(serverURL, serverURLSource) {
  const target = new URL("pocket-studio://app/studio/");
  if (serverURL && serverURLSource) {
    target.searchParams.set("server_url", serverURL);
    target.searchParams.set("server_url_source", serverURLSource);
  }
  log("open window", target.toString());
  mainWindow = new BrowserWindow({
    show: true,
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: "Pocket Studio",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  mainWindow.once("ready-to-show", () => {
    log("window ready to show");
    mainWindow.show();
    mainWindow.focus();
  });
  mainWindow.webContents.on("did-finish-load", () => {
    log("window loaded", mainWindow.webContents.getURL());
    syncDaemonFromWindowURL(mainWindow.webContents.getURL());
    mainWindow.show();
    mainWindow.focus();
  });
  mainWindow.webContents.on("did-navigate", (_event, url) => {
    syncDaemonFromWindowURL(url);
  });
  mainWindow.webContents.on("did-navigate-in-page", (_event, url) => {
    syncDaemonFromWindowURL(url);
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    log("window load failed", { code, description, url });
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    log("renderer gone", details);
  });
  await mainWindow.loadURL(target.toString());
}

function stopChildren() {
  for (const child of children) {
    if (child && !child.killed) child.kill();
  }
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  log("ready", { packaged: app.isPackaged, resources: process.resourcesPath });
  registerAppProtocol();
  registerDaemonIPC();
  const { modules, uiServerURL, uiServerURLSource } = await startModules();
  if (modules.has("ui")) {
    await createWindow(uiServerURL, uiServerURLSource);
  }
}).catch((error) => {
  dialog.showErrorBox("Pocket Studio failed to start", error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on("window-all-closed", () => {
  stopChildren();
  app.quit();
});

app.on("before-quit", stopChildren);
