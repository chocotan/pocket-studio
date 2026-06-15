import { useMemo } from "react";
import type { TokenRecord } from "../lib/utils";

interface SnippetProps {
  title: string;
  value: string;
}

export function Snippet({ title, value }: SnippetProps) {
  return (
    <div className="snippet">
      <span>{title}</span>
      <pre>{value}</pre>
    </div>
  );
}

interface UsagePanelProps {
  tokens: TokenRecord[];
}

export function UsagePanel({ tokens }: UsagePanelProps) {
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
