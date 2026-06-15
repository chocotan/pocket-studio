import { useEffect, useState } from "react";
import { LogOut, Shield } from "lucide-react";
import { AuthScreen } from "./components/AuthScreen";
import { TokenPanel } from "./components/TokenPanel";
import { UsagePanel } from "./components/UsagePanel";
import { api } from "./lib/api";
import type { User, TokenRecord } from "./lib/utils";

export function App() {
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
