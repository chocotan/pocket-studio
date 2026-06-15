import { useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { CopyButton } from "./CopyButton";
import { type TokenRecord, formatTime, studioLink } from "../lib/utils";

interface TokenPanelProps {
  busy: boolean;
  tokens: TokenRecord[];
  onCreate: (name: string) => void;
  onRefresh: () => void;
  onRevoke: (id: string) => void;
}

export function TokenPanel({
  busy,
  tokens,
  onCreate,
  onRefresh,
  onRevoke,
}: TokenPanelProps) {
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
