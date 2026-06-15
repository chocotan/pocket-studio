import { useState } from "react";
import { KeyRound } from "lucide-react";

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
