import { useState } from "react";
import { KeyRound, Sparkles } from "lucide-react";

interface AuthScreenProps {
  busy: boolean;
  error: string;
  onSubmit: (mode: "login" | "register", username: string, password: string) => void;
}

export function AuthScreen({
  busy,
  error,
  onSubmit,
}: AuthScreenProps) {
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
        <div className="auth-kicker">
          <Sparkles size={12} />
          Pocket Studio
        </div>
        <div className="auth-mark" aria-hidden="true">
          <KeyRound size={20} />
        </div>
        <h1>{mode === "login" ? "欢迎回来" : "创建账号"}</h1>
        <p className="auth-lead">
          {mode === "login"
            ? "登录后管理访问令牌，连接 daemon 与 Studio 工作台。"
            : "注册后即可创建访问令牌，部署你的远程开发链路。"}
        </p>
        <div className="segmented" role="tablist" aria-label="登录或注册">
          <button
            type="button"
            className={mode === "login" ? "active" : ""}
            onClick={() => setMode("login")}
            aria-selected={mode === "login"}
          >
            登录
          </button>
          <button
            type="button"
            className={mode === "register" ? "active" : ""}
            onClick={() => setMode("register")}
            aria-selected={mode === "register"}
          >
            注册
          </button>
        </div>
        {error && <div className="form-error" role="alert">{error}</div>}
        <label>
          用户名
          <input
            required
            value={username}
            autoComplete="username"
            placeholder="your-name"
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label>
          密码
          <input
            required
            minLength={8}
            type="password"
            value={password}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            placeholder={mode === "login" ? "输入密码" : "至少 8 位"}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? "处理中..." : mode === "login" ? "登录" : "注册并登录"}
        </button>
      </form>
    </main>
  );
}
