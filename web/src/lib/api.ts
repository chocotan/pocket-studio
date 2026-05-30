export interface ClientConfig {
  server_url: string;
  local_mode: boolean;
}

export const DEFAULT_SERVER_URL = "http://127.0.0.1:18080";

export function apiURL(path: string): string {
  return `${serverBaseURL()}${path}`;
}

export function websocketURL(path: string, params?: URLSearchParams): string {
  const base = new URL(serverBaseURL() || window.location.origin);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = joinPath(base.pathname, path);
  base.search = params ? params.toString() : "";
  base.hash = "";
  return base.toString();
}

export async function postJSON<T>(url: string, body: any): Promise<T> {
  const res = await fetch(apiURL(url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Request failed with status ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(apiURL(url));
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Request failed with status ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function loadClientConfig(): Promise<ClientConfig> {
  const urlConfig = configFromURL();
  if (urlConfig) {
    applyClientConfig(urlConfig);
    return urlConfig;
  }
  try {
    const cfg = await getJSON<ClientConfig>("/api/config");
    applyClientConfig(cfg);
    return cfg;
  } catch (err) {
    const cfg = configFromStorage();
    applyClientConfig(cfg);
    return cfg;
  }
}

export async function saveClientConfig(cfg: ClientConfig): Promise<ClientConfig> {
  const normalized = normalizeConfig(cfg);
  const saved = await postJSON<ClientConfig>("/api/config", normalized);
  applyClientConfig(saved);
  return saved;
}

export function applyClientConfig(cfg: ClientConfig) {
  window.localStorage.setItem("pocket-studio-config", JSON.stringify(normalizeConfig(cfg)));
}

export function serverBaseURL(): string {
  const cfg = configFromStorage();
  return cfg.server_url;
}

function configFromStorage(): ClientConfig {
  const raw = window.localStorage.getItem("pocket-studio-config");
  if (raw) {
    try {
      return normalizeConfig(JSON.parse(raw));
    } catch {}
  }
  return {
    server_url: defaultServerURL(),
    local_mode: true,
  };
}

function configFromURL(): ClientConfig | null {
  const params = new URLSearchParams(window.location.search);
  const serverURL = params.get("server_url");
  if (!serverURL) return null;
  return normalizeConfig({
    server_url: serverURL,
    local_mode: false,
  });
}

function normalizeConfig(cfg: Partial<ClientConfig>): ClientConfig {
  const serverURL = (cfg.server_url || defaultServerURL()).trim().replace(/\/+$/, "");
  return {
    server_url: serverURL || defaultServerURL(),
    local_mode: Boolean(cfg.local_mode),
  };
}

function defaultServerURL(): string {
  if (window.location.host) {
    return window.location.origin;
  }
  return DEFAULT_SERVER_URL;
}

function joinPath(basePath: string, path: string): string {
  const base = basePath.replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
