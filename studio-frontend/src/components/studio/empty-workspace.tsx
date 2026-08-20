import { Bot, FolderTree, Terminal as TerminalIcon, Cpu, Sparkles, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { CustomAgent, Device } from "@/lib/types";
import { fetchCustomAgents, customAgentBaseLabel } from "@/lib/skill-api";
import {
  availableTerminalTypes,
  directACPMenuItems,
  type TerminalKind,
  type TerminalAccent,
} from "./terminal-types";

export function EmptyWorkspace({
  device,
  onCreate,
  onCreateAgentChat,
  onCreateFileExplorer,
  onCreateCustomAgent,
}: {
  device?: Device;
  onCreate: (kind: TerminalKind, useTmux?: boolean) => void;
  onCreateAgentChat?: (agentKind: string, agentRuntime?: "direct_acp") => void;
  onCreateFileExplorer?: () => void;
  onCreateCustomAgent?: (agent: { id: string; name: string; base_agent: string }, useTmux?: boolean) => void;
}) {
  const terminalTypes = availableTerminalTypes(device);
  const acpItems = directACPMenuItems(device);
  const [customAgents, setCustomAgents] = useState<CustomAgent[]>([]);
  const [customAgentsState, setCustomAgentsState] = useState<"idle" | "loading" | "error">("idle");
  const [customAgentsError, setCustomAgentsError] = useState("");

  useEffect(() => {
    if (!onCreateCustomAgent || !device?.id) return;
    let cancelled = false;
    setCustomAgentsState("loading");
    setCustomAgentsError("");
    fetchCustomAgents(device.id)
      .then((res) => {
        if (cancelled) return;
        setCustomAgents(Array.isArray(res?.agents) ? res.agents : []);
        setCustomAgentsState("idle");
      })
      .catch((err) => {
        if (cancelled) return;
        setCustomAgents([]);
        setCustomAgentsState("error");
        setCustomAgentsError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [device?.id, onCreateCustomAgent]);

  return (
    <div className="absolute inset-0 flex items-center justify-center border border-dashed border-border/80 bg-background/80 p-6 overflow-y-auto">
      <div className="w-full max-w-2xl text-center animate-fade-in my-auto py-4">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary shadow-sm">
          <Sparkles className="h-5 w-5" />
        </div>
        <h2 className="text-sm font-bold tracking-tight text-foreground">当前工作区没有打开的面板</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          选择一个智能 Agent 对话或终端开始干活。
        </p>

        {/* Custom Agents (daemon-managed, skill-bound) */}
        {onCreateCustomAgent && customAgentsState !== "error" && customAgents.length > 0 && (
          <div className="mt-5 text-left">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              <Bot className="h-3.5 w-3.5 text-violet-500" />
              <span>自定义智能体</span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {customAgents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  data-testid={`empty-custom-agent-${agent.id}`}
                  title={agent.description || agent.system_prompt || agent.name}
                  onClick={() => onCreateCustomAgent(agent, true)}
                  className="flex items-center gap-2.5 rounded-xl border border-border/80 bg-card p-2.5 text-left text-xs font-semibold text-foreground/90 shadow-sm transition-all duration-150 hover:border-primary/40 hover:bg-primary/5 hover:text-primary cursor-pointer"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300">
                    <Bot className="h-3.5 w-3.5" />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{agent.name}</span>
                    <span className="truncate text-[10px] font-normal text-muted-foreground">
                      {customAgentBaseLabel(agent.base_agent)} · {agent.skills?.length || 0} 技能
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        {onCreateCustomAgent && customAgentsState === "loading" && (
          <div className="mt-5 flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> 正在加载自定义智能体...
          </div>
        )}
        {onCreateCustomAgent && customAgentsState === "error" && (
          <div className="mt-5 text-center text-xs text-red-600">
            自定义智能体加载失败：{customAgentsError || "未知错误"}
          </div>
        )}

        {/* Direct ACP Agents */}
        {acpItems.length > 0 && onCreateAgentChat && (
          <div className="mt-5 text-left">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              <Cpu className="h-3.5 w-3.5 text-emerald-500" />
              <span>智能 Agent 对话</span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {acpItems.map((item) => (
                <button
                  key={item.agent}
                  type="button"
                  data-testid={`empty-acp-${item.agent}`}
                  onClick={() => onCreateAgentChat(item.agent, "direct_acp")}
                  className="flex items-center gap-2.5 rounded-xl border border-border/80 bg-card p-2.5 text-left text-xs font-semibold text-foreground/90 shadow-sm transition-all duration-150 hover:border-primary/40 hover:bg-primary/5 hover:text-primary cursor-pointer"
                >
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${toneClass(item.tone)}`}>
                    {item.icon}
                  </span>
                  <span className="truncate">{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Terminals & Tools */}
        <div className="mt-4 text-left">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            <TerminalIcon className="h-3.5 w-3.5 text-indigo-500" />
            <span>命令行终端与工具</span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {onCreateFileExplorer && (
              <button
                type="button"
                onClick={onCreateFileExplorer}
                className="flex items-center gap-2.5 rounded-xl border border-border/80 bg-card p-2.5 text-left text-xs font-semibold text-foreground/90 shadow-sm transition-all duration-150 hover:border-primary/40 hover:bg-primary/5 hover:text-primary cursor-pointer"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300">
                  <FolderTree className="h-3.5 w-3.5" />
                </span>
                <span className="truncate">文件资源管理器</span>
              </button>
            )}
            {terminalTypes.map((item) => (
              <button
                key={item.value}
                type="button"
                data-testid={`empty-create-${item.value}`}
                onClick={() => onCreate(item.value)}
                className="flex items-center gap-2.5 rounded-xl border border-border/80 bg-card p-2.5 text-left text-xs font-semibold text-foreground/90 shadow-sm transition-all duration-150 hover:border-primary/40 hover:bg-primary/5 hover:text-primary cursor-pointer"
              >
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${toneClass(item.accent)}`}>
                  {item.logo}
                </span>
                <span className="truncate">{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function toneClass(tone: TerminalAccent | string) {
  switch (tone) {
    case "amber":
      return "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300";
    case "emerald":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300";
    case "violet":
      return "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300";
    case "lime":
      return "bg-lime-100 text-lime-800 dark:bg-lime-950/60 dark:text-lime-300";
    case "cyan":
      return "bg-cyan-100 text-cyan-800 dark:bg-cyan-950/60 dark:text-cyan-300";
    case "rose":
      return "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300";
    case "sky":
    case "blue":
      return "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300";
    default:
      return "bg-muted text-muted-foreground";
  }
}
