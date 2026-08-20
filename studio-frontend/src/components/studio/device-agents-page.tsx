import { ArrowLeft, Bot, Server } from "lucide-react";
import type { Device } from "@/lib/types";
import { deviceDisplayName } from "./project-switcher";
import { SkillAgentManagerContent } from "./skill-agent-manager";

interface DeviceAgentsPageProps {
  deviceId: string;
  devices: Device[];
  onSwitchDevice: (deviceId: string) => void;
  onBack: () => void;
}

/**
 * 机器级智能体编辑页: 从 Dashboard 设备卡片进入,管理该设备的技能库与
 * 自定义 Agent。技能与 Agent 数据全部按设备(daemon)隔离。
 */
export function DeviceAgentsPage({ deviceId, devices, onSwitchDevice, onBack }: DeviceAgentsPageProps) {
  const device = devices.find((d) => d.id === deviceId);

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/45">
      {/* ── 顶部导航 ── */}
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border/80 bg-card px-3 shadow-sm">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="flex h-7 items-center gap-1 rounded-lg border border-border bg-card px-2 text-[11px] font-bold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
            title="返回设备列表"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            返回
          </button>
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Bot className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-xs font-bold text-foreground">机器智能体</div>
            <div className="truncate text-[10px] text-muted-foreground">
              技能库 · 自定义 Agent · 技能编辑（按设备隔离）
            </div>
          </div>
        </div>

        {/* 设备切换器: 机器级入口,切换即切换管理目标 */}
        <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
          <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {devices.map((d) => {
            const active = d.id === deviceId;
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => onSwitchDevice(d.id)}
                className={`flex h-6 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-[11px] font-semibold transition-colors cursor-pointer ${
                  active
                    ? "border-primary/30 bg-accent text-foreground"
                    : "border-border/70 bg-card text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
                title={`切换到 ${deviceDisplayName(d, d.id)}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${d.workspaces !== undefined ? "bg-emerald-500" : "bg-border"}`} />
                <span className="max-w-32 truncate">{deviceDisplayName(d, d.id)}</span>
              </button>
            );
          })}
        </div>
      </header>

      {/* ── 管理内容(当前设备) ── */}
      <main className="min-h-0 flex-1 overflow-hidden">
        <div className="h-full overflow-y-auto">
          {device ? (
            <SkillAgentManagerContent deviceId={device.id} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center p-8 text-center text-muted-foreground">
              <Bot className="mb-3 h-10 w-10 text-muted-foreground/40" />
              <span className="text-sm font-bold text-foreground">设备不在线或未找到</span>
              <span className="mt-1 text-xs">请确认目标设备的 daemon 已连接，然后从左上角返回设备列表重试。</span>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
