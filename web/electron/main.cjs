const { app, BrowserWindow, Menu, dialog, protocol, net: electronNet } = require("electron");
const { spawn } = require("node:child_process");
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

function configDir() {
  return path.join(app.getPath("appData"), "pocket-studio");
}

function clientConfigPath() {
  return path.join(configDir(), "client.json");
}

function daemonConfigPath() {
  return path.join(configDir(), "daemon.json");
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

function readClientConfig() {
  const defaults = { server_url: "http://127.0.0.1:18080" };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(clientConfigPath(), "utf8")) };
  } catch {
    return defaults;
  }
}

function writeClientConfig(config) {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(clientConfigPath(), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

function ensureDaemonConfig() {
  if (fs.existsSync(daemonConfigPath())) return;
  fs.mkdirSync(configDir(), { recursive: true });
  const home = app.getPath("home");
  const workspace = path.join(home, "Agent");
  fs.mkdirSync(workspace, { recursive: true });
  const config = {
    device: { id: "dev_local", name: "" },
    server: { url: "ws://127.0.0.1:18080/ws/daemon" },
    claude: { command: "claude", args: ["--output-format", "stream-json", "--verbose"] },
    acpx: {
      enabled: true,
      command: "acpx",
      agent: "claude",
      session_name: "agentbridge",
      ttl_seconds: 300,
      args: ["--format", "json", "--approve-all"],
    },
    workspaces: [{ id: "agent-root", name: "Agent", path: workspace }],
  };
  fs.writeFileSync(daemonConfigPath(), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

function normalizeHTTPAddress(value) {
  if (!value) return "";
  if (/^https?:\/\//.test(value)) return value.replace(/\/+$/, "");
  return `http://${value}`.replace(/\/+$/, "");
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
  const raw = options["server.port"] || "0";
  const port = portFromServerPortOption(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --server.port: ${raw}`);
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
  const rootDir = path.resolve(resourcePath("web", "dist"));
  const indexFile = path.join(rootDir, "index.html");
  protocol.handle("pocket-studio", (request) => {
    const requestURL = new URL(request.url);
    const pathname = decodeURIComponent(requestURL.pathname || "/");
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

function spawnManaged(command, args, env) {
  log("spawn", command, args.join(" "));
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM") {
      console.error(`${path.basename(command)} exited`, { code, signal });
    }
  });
  return child;
}

async function startModules() {
  fs.mkdirSync(configDir(), { recursive: true });
  ensureDaemonConfig();
  const { modules, options } = parseArgs(process.argv.slice(1));
  log("modules", Array.from(modules).join(",") || "(none)");
  const env = { POCKET_STUDIO_CONFIG_DIR: configDir() };
  let config = readClientConfig();
  let uiServerURL = normalizeHTTPAddress(options["ui.server.addr"] || "");
  let daemonServerURL = normalizeHTTPAddress(options["daemon.server.addr"] || "");
  let serverReadyPromise = null;

  if (modules.has("server")) {
    let addr = serverListenAddr(options);
    if (addr.endsWith(":0")) {
      const port = await reservePort();
      addr = `127.0.0.1:${port}`;
    }
    const port = addr.split(":").pop();
    const localServerURL = `http://127.0.0.1:${port}`;
    log("server listen", localServerURL);
    config = { ...config, server_url: localServerURL };
    writeClientConfig(config);
    spawnManaged(resourcePath("bin", "pocket-studio-server"), ["-addr", addr], env);
    serverReadyPromise = waitForHTTP(localServerURL)
      .then(() => {
        log("server ready", localServerURL);
        return true;
      })
      .catch((error) => {
        log("server readiness failed", error instanceof Error ? error.message : String(error));
        return false;
      });
    if (!uiServerURL) uiServerURL = localServerURL;
    if (!daemonServerURL) daemonServerURL = localServerURL;
  }

  if (modules.has("ui")) {
    if (!uiServerURL) {
      uiServerURL = normalizeHTTPAddress(config.server_url);
    }
    log("ui server", uiServerURL || "(not configured)");
    config = { ...config, server_url: uiServerURL };
    writeClientConfig(config);
  }

  if (modules.has("daemon")) {
    if (!daemonServerURL) {
      daemonServerURL = uiServerURL || normalizeHTTPAddress(config.server_url);
    }
    log("daemon server", daemonServerURL || "(not configured)");
    const daemonConfig = { ...config, server_url: daemonServerURL };
    writeClientConfig(daemonConfig);
    const startDaemon = () => spawnManaged(
      resourcePath("bin", "pocket-studio-daemon"),
      ["-config", daemonConfigPath(), "-client-config", clientConfigPath()],
      env,
    );
    if (serverReadyPromise) {
      serverReadyPromise.then((ready) => {
        if (ready) startDaemon();
      });
    } else {
      startDaemon();
    }
  }

  return { modules, uiServerURL };
}

async function createWindow(serverURL) {
  const target = new URL("pocket-studio://app/");
  if (serverURL) target.searchParams.set("server_url", serverURL);
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
    },
  });
  mainWindow.once("ready-to-show", () => {
    log("window ready to show");
    mainWindow.show();
    mainWindow.focus();
  });
  mainWindow.webContents.on("did-finish-load", () => {
    log("window loaded", mainWindow.webContents.getURL());
    mainWindow.show();
    mainWindow.focus();
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
  const { modules, uiServerURL } = await startModules();
  if (modules.has("ui")) {
    await createWindow(uiServerURL);
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
