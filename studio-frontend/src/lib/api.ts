export interface ClientConfig {
  server_url: string;
  local_mode: boolean;
  access_token?: string;
}

export const DEFAULT_SERVER_URL = "http://127.0.0.1:18080";
const LOCAL_CONFIG_KEY = "pocket_studio_client_config";

let activeConfig: ClientConfig = {
  server_url: defaultServerURL(),
  local_mode: true,
};

export function apiURL(path: string): string {
  return `${serverBaseURL()}${path}`;
}

export function websocketURL(path: string, params?: URLSearchParams): string {
  const base = new URL(serverBaseURL() || window.location.origin);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = joinPath(base.pathname, path);
  const wsParams = params ? new URLSearchParams(params) : new URLSearchParams();
  if (activeConfig.access_token) {
    wsParams.set("token", activeConfig.access_token);
  }
  base.search = wsParams.toString();
  base.hash = "";
  return base.toString();
}

export async function postJSON<T>(url: string, body: any): Promise<T> {
  const res = await fetch(apiURL(url), {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Request failed with status ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(apiURL(url), {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Request failed with status ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function loadClientConfig(): Promise<ClientConfig> {
  const storedConfig = loadConfigFromStorage();
  const urlConfig = configPatchFromURL();
  if (urlConfig) {
    if (isAutoServerURLFromAppImage() && storedConfig?.server_url) {
      const cfg = normalizeConfig(storedConfig);
      applyClientConfig(cfg);
      saveConfigToStorage(cfg);
      return cfg;
    }
    const cfg = normalizeConfig({
      ...storedConfig,
      ...(isHTTPPage() ? { server_url: window.location.origin, local_mode: isLocalHost(window.location.hostname) } : {}),
      ...urlConfig,
    });
    applyClientConfig(cfg);
    saveConfigToStorage(cfg);
    return cfg;
  }
  if (storedConfig) {
    const cfg = normalizeConfig({
      ...(isHTTPPage() ? { server_url: window.location.origin, local_mode: isLocalHost(window.location.hostname) } : {}),
      ...storedConfig,
    });
    applyClientConfig(cfg);
    return cfg;
  }
  if (isHTTPPage()) {
    const cfg = normalizeConfig({
      server_url: window.location.origin,
      local_mode: isLocalHost(window.location.hostname),
      access_token: activeConfig.access_token,
    });
    applyClientConfig(cfg);
    return cfg;
  }
  const cfg = normalizeConfig(activeConfig);
  applyClientConfig(cfg);
  return cfg;
}

export async function saveClientConfig(cfg: ClientConfig): Promise<ClientConfig> {
  const normalized = normalizeConfig(cfg);
  saveConfigToStorage(normalized);
  applyClientConfig(normalized);
  return normalized;
}

export function clearClientConfig() {
  clearConfigFromStorage();
  const cfg = normalizeConfig({
    server_url: defaultServerURL(),
    local_mode: true,
    access_token: "",
  });
  applyClientConfig(cfg);
  return cfg;
}

export function applyClientConfig(cfg: ClientConfig) {
  activeConfig = normalizeConfig(cfg);
}

export function serverBaseURL(): string {
  return activeConfig.server_url;
}

export function accessToken(): string {
  return activeConfig.access_token || "";
}

function configPatchFromURL(): Partial<ClientConfig> | null {
  const params = new URLSearchParams(window.location.search);
  const serverURL = params.get("server_url");
  const token = params.get("token");
  if (!serverURL && !token) return null;
  return {
    ...(serverURL ? { server_url: serverURL, local_mode: false } : {}),
    ...(token ? { access_token: token } : {}),
  };
}

function isAutoServerURLFromAppImage(): boolean {
  if (window.location.protocol !== "pocket-studio:") return false;
  const params = new URLSearchParams(window.location.search);
  const source = params.get("server_url_source");
  return source === "runtime" || source === "default";
}

function loadConfigFromStorage(): Partial<ClientConfig> | null {
  if (typeof window === "undefined" || !window.localStorage) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(LOCAL_CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ClientConfig>;
    if (!parsed.server_url && !parsed.access_token) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveConfigToStorage(cfg: ClientConfig) {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(LOCAL_CONFIG_KEY, JSON.stringify(normalizeConfig(cfg)));
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

function clearConfigFromStorage() {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.removeItem(LOCAL_CONFIG_KEY);
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

function normalizeConfig(cfg: Partial<ClientConfig>): ClientConfig {
  const serverURL = (cfg.server_url || defaultServerURL()).trim().replace(/\/+$/, "");
  return {
    server_url: serverURL || defaultServerURL(),
    local_mode: Boolean(cfg.local_mode),
    access_token: (cfg.access_token || "").trim(),
  };
}

function authHeaders(base?: HeadersInit): HeadersInit {
  const headers = new Headers(base);
  if (activeConfig.access_token) {
    headers.set("Authorization", `Bearer ${activeConfig.access_token}`);
  }
  return headers;
}

function defaultServerURL(): string {
  if (isHTTPPage()) {
    return window.location.origin;
  }
  return DEFAULT_SERVER_URL;
}

function isHTTPPage(): boolean {
  return window.location.protocol === "http:" || window.location.protocol === "https:";
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function joinPath(basePath: string, path: string): string {
  const base = basePath.replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
