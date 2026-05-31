import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Copy, KeyRound, LogOut, Plus, RefreshCw, Shield, Trash2 } from "lucide-react";
import "./styles.css";

interface User {
  id: string;
  username: string;
  created_at: number;
}

interface TokenRecord {
  id: string;
  name: string;
  prefix: string;
  value?: string;
  created_at: number;
  last_used_at?: number;
  revoked_at?: number;
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [tokens, setTokens] = useState<TokenRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void refreshSession();
  }, []);

  async function refreshSession() {
    setError("");
    try {
      const res = await api<{ user: User }>("/api/auth/me");
      setUser(res.user);
      await refreshTokens();
    } catch {
      setUser(null);
      setTokens([]);
    }
  }

  async function refreshTokens() {
    const res = await api<{ tokens: TokenRecord[] }>("/api/tokens");
    setTokens(res.tokens || []);
  }

  async function handleAuth(mode: "login" | "register", username: string, password: string) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/auth/${mode}`, { method: "POST", body: { username, password } });
      if (mode === "register") {
        await api("/api/auth/login", { method: "POST", body: { username, password } });
      }
      await refreshSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    await api("/api/auth/logout", { method: "POST", body: {} });
    setUser(null);
    setTokens([]);
  }

  async function handleCreateToken(name: string) {
    setBusy(true);
    setError("");
    try {
      const res = await api<{ token: TokenRecord; secret: string }>("/api/tokens", {
        method: "POST",
        body: { name },
      });
      setTokens((items) => [res.token, ...items]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(id: string) {
    setBusy(true);
    setError("");
    try {
      await api("/api/tokens/revoke", { method: "POST", body: { id } });
      await refreshTokens();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!user) {
    return <AuthScreen busy={busy} error={error} onSubmit={handleAuth} />;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><Shield size={18} /></div>
          <div>
            <h1>Pocket Studio</h1>
            <p>{user.username}</p>
          </div>
        </div>
        <button className="icon-button" type="button" onClick={handleLogout} title="退出登录">
          <LogOut size={18} />
        </button>
      </header>

      <section className="content-grid">
        <TokenPanel
          busy={busy}
          tokens={tokens}
          onCreate={handleCreateToken}
          onRefresh={refreshTokens}
          onRevoke={handleRevoke}
        />
        <UsagePanel tokens={tokens} />
      </section>

      {error && <div className="toast">{error}</div>}
    </main>
  );
}

function AuthScreen({
  busy,
  error,
  onSubmit,
}: {
  busy: boolean;
  error: string;
  onSubmit: (mode: "login" | "register", username: string, password: string) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  return (
    <main className="auth-page">
      <form
        className="auth-panel"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(mode, username, password);
        }}
      >
        <div className="auth-mark"><KeyRound size={22} /></div>
        <h1>{mode === "login" ? "登录" : "注册"}</h1>
        <div className="segmented">
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>登录</button>
          <button type="button" className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>注册</button>
        </div>
        {error && <div className="form-error">{error}</div>}
        <label>
          用户名
          <input required value={username} autoComplete="username" onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label>
          密码
          <input required minLength={8} type="password" value={password} autoComplete={mode === "login" ? "current-password" : "new-password"} onChange={(event) => setPassword(event.target.value)} />
        </label>
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? "处理中..." : mode === "login" ? "登录" : "注册并登录"}
        </button>
      </form>
    </main>
  );
}

function TokenPanel({
  busy,
  tokens,
  onCreate,
  onRefresh,
  onRevoke,
}: {
  busy: boolean;
  tokens: TokenRecord[];
  onCreate: (name: string) => void;
  onRefresh: () => void;
  onRevoke: (id: string) => void;
}) {
  const [name, setName] = useState("");

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>Tokens</h2>
          <p>用于 daemon 和 studio-frontend 连接 server</p>
        </div>
        <button className="icon-button" type="button" onClick={onRefresh} title="刷新">
          <RefreshCw size={17} />
        </button>
      </div>

      <form
        className="token-form"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate(name);
          setName("");
        }}
      >
        <input value={name} placeholder="例如 my laptop" onChange={(event) => setName(event.target.value)} />
        <button className="primary-button compact" type="submit" disabled={busy}>
          <Plus size={16} />
          创建
        </button>
      </form>

      <div className="token-list">
        {tokens.length === 0 ? (
          <div className="empty">暂无 token</div>
        ) : (
          tokens.map((token) => (
            <div className={token.revoked_at ? "token-card revoked" : "token-card"} key={token.id}>
              <div className="token-card-header">
                <strong>{token.name}</strong>
                <span>{formatTime(token.created_at)}</span>
              </div>
              <code>{token.value || `${token.prefix}...`}</code>
              {!token.value && (
                <div className="hint compact-hint">这是旧 token，数据库里没有明文。需要直接跳转 Studio 时请创建一个新 token。</div>
              )}
              <div className="token-actions">
                {token.value && <CopyButton value={token.value} />}
                {token.value && (
                  <a className="studio-link inline-link" href={studioLink(token.value)}>
                    前往 Studio
                  </a>
                )}
                {!token.revoked_at && (
                  <button className="danger-button" type="button" onClick={() => onRevoke(token.id)} title="吊销">
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="icon-button"
      type="button"
      title="复制"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "已复制" : <Copy size={17} />}
    </button>
  );
}

function UsagePanel({ tokens }: { tokens: TokenRecord[] }) {
  const latestToken = tokens.find((token) => !token.revoked_at);
  const visibleToken = latestToken?.value || "ps_xxxxx";
  const daemonCommand = useMemo(
    () => `go run ./cmd/daemon -daemon.server.url ws://localhost:18080/ws/daemon -daemon.server.token ${visibleToken}`,
    [visibleToken],
  );
  const studioURL = useMemo(
    () => `/studio/?server_url=${encodeURIComponent(window.location.origin)}&token=${encodeURIComponent(visibleToken)}`,
    [visibleToken],
  );

  return (
    <section className="panel usage-panel">
      <div className="panel-header">
        <div>
          <h2>配置示例</h2>
          <p>daemon 和 studio-frontend 使用同一个 token</p>
        </div>
      </div>
      <Snippet title="daemon 启动命令" value={daemonCommand} />
      <Snippet title="Studio 入口" value={studioURL} />
    </section>
  );
}

function Snippet({ title, value }: { title: string; value: string }) {
  return (
    <div className="snippet">
      <span>{title}</span>
      <pre>{value}</pre>
    </div>
  );
}

async function api<T>(path: string, options?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: options?.method || "GET",
    credentials: "include",
    headers: options?.body ? { "Content-Type": "application/json" } : undefined,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(data?.error || `Request failed with status ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function formatTime(value?: number) {
  if (!value) return "";
  return new Date(value * 1000).toLocaleString();
}

function studioLink(token: string) {
  const url = new URL("/studio/", window.location.origin);
  url.searchParams.set("server_url", window.location.origin);
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.pathname + url.search;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
