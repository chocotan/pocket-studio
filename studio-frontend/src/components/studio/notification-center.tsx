import { useEffect, useState } from "react";
import { Bell, BellOff, BellRing, Check, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TerminalNotification } from "./terminal-notifications";

interface NotificationCenterProps {
  notifications: TerminalNotification[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (notification: TerminalNotification) => void;
  onMarkAllRead: () => void;
  webNotificationsSupported?: boolean;
  webNotificationsEnabled?: boolean;
  onToggleWebNotifications?: () => void;
}

export function NotificationCenter({
  notifications,
  open,
  onOpenChange,
  onSelect,
  onMarkAllRead,
  webNotificationsSupported = false,
  webNotificationsEnabled = false,
  onToggleWebNotifications,
}: NotificationCenterProps) {
  const unreadNotifications = notifications.filter((item) => !item.read);
  const unreadCount = unreadNotifications.length;
  const tickerItems = unreadNotifications.slice(0, 4);
  const [tickerIndex, setTickerIndex] = useState(0);
  const [tickerSliding, setTickerSliding] = useState(false);
  const [tickerResetting, setTickerResetting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const activeTickerItem = tickerItems.length > 0 ? tickerItems[tickerIndex % tickerItems.length] : null;
  const nextTickerItem = tickerItems.length > 1 ? tickerItems[(tickerIndex + 1) % tickerItems.length] : null;
  const visibleTickerItem = tickerSliding && nextTickerItem ? nextTickerItem : activeTickerItem;

  useEffect(() => {
    if (tickerItems.length <= 1) {
      setTickerIndex(0);
      setTickerSliding(false);
      setTickerResetting(false);
      return;
    }
    const timer = window.setInterval(() => {
      setTickerSliding(true);
      window.setTimeout(() => {
        setTickerResetting(true);
        setTickerIndex((value) => (value + 1) % tickerItems.length);
        setTickerSliding(false);
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => setTickerResetting(false));
        });
      }, 260);
    }, 2400);
    return () => window.clearInterval(timer);
  }, [tickerItems.length]);

  useEffect(() => {
    if (tickerIndex >= tickerItems.length) setTickerIndex(0);
  }, [tickerIndex, tickerItems.length]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="relative flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
      {visibleTickerItem && activeTickerItem && (
        <button
          type="button"
          onClick={() => onSelect(visibleTickerItem)}
          data-alert={unreadCount > 0 ? "true" : "false"}
          className="studio-notification-ticker-button relative hidden h-6 min-w-0 overflow-hidden rounded-md border border-border bg-card px-2 text-left text-muted-foreground shadow-sm transition-colors hover:border-primary/25 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring dark:border-border dark:bg-card dark:text-foreground/80 sm:block"
          title={notificationTickerText(visibleTickerItem, now)}
          aria-label={`跳转消息：${notificationTickerText(visibleTickerItem, now)}`}
        >
          <span className="studio-notification-ticker block h-4 overflow-hidden">
            <span
              className="studio-notification-ticker-track block"
              data-sliding={tickerSliding ? "true" : "false"}
              data-resetting={tickerResetting ? "true" : "false"}
            >
              <TickerLine item={activeTickerItem} now={now} />
              {nextTickerItem && <TickerLine item={nextTickerItem} now={now} />}
            </span>
          </span>
        </button>
      )}

      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        data-alert={unreadCount > 0 ? "true" : "false"}
        className="studio-notification-button relative flex h-6 items-center gap-1 rounded-md border border-border bg-card px-2 text-muted-foreground shadow-sm transition-colors hover:border-primary/25 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring dark:border-border dark:bg-card dark:text-foreground/80"
        title="消息列表"
        aria-label={`消息列表${unreadCount ? `，${unreadCount} 条未读` : ""}`}
      >
        <Bell className="h-3.5 w-3.5 shrink-0" />
        <span className="text-[10px] font-bold leading-none">{unreadCount}</span>
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-500 px-1 text-[8px] font-bold leading-none text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40 cursor-default" onClick={() => onOpenChange(false)} />
          <div className="absolute right-0 top-8 z-50 w-[min(22rem,calc(100dvw-1rem))] overflow-hidden rounded-lg border border-border bg-card shadow-xl dark:border-border dark:bg-card">
            <div className="flex h-9 items-center justify-between border-b border-border/70 px-3 dark:border-border">
              <span className="text-xs font-bold text-foreground dark:text-foreground">消息</span>
              <div className="flex items-center gap-1">
                {webNotificationsSupported && onToggleWebNotifications && (
                  <button
                    type="button"
                    onClick={onToggleWebNotifications}
                    className={cn(
                      "flex h-6 items-center gap-1 rounded-md px-1.5 text-[10px] font-semibold hover:bg-muted/50 dark:hover:bg-muted",
                      webNotificationsEnabled
                        ? "text-primary hover:text-primary/85"
                        : "text-muted-foreground hover:text-foreground/85 dark:text-muted-foreground dark:hover:text-foreground"
                    )}
                    title={webNotificationsEnabled ? "网页通知已开启，点击关闭" : "开启网页通知（窗口失焦时推送系统通知）"}
                    aria-label={webNotificationsEnabled ? "关闭网页通知" : "开启网页通知"}
                    aria-pressed={webNotificationsEnabled}
                  >
                    {webNotificationsEnabled ? <BellRing className="h-3 w-3" /> : <BellOff className="h-3 w-3" />}
                    网页通知
                  </button>
                )}
              <button
                type="button"
                onClick={onMarkAllRead}
                disabled={unreadCount === 0}
                className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[10px] font-semibold text-muted-foreground hover:bg-muted/50 hover:text-foreground/85 disabled:opacity-40 dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground"
              >
                <Check className="h-3 w-3" />
                全部已读
              </button>
              </div>
            </div>

            {notifications.length === 0 ? (
              <div className="flex h-32 flex-col items-center justify-center gap-2 text-muted-foreground/80">
                <Inbox className="h-5 w-5" />
                <span className="text-xs font-semibold">暂无消息</span>
              </div>
            ) : (
              <div className="max-h-[min(26rem,70dvh)] overflow-y-auto">
                {notifications.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelect(item)}
                    className={cn(
                      "block w-full border-b border-border/70 px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-muted/50 dark:border-border dark:hover:bg-muted/80",
                      !item.read && "bg-amber-50/55 dark:bg-amber-400/10"
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", item.read ? "bg-border dark:bg-muted-foreground/40" : "bg-amber-500")} />
                      <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-foreground dark:text-foreground">
                        {item.projectName} / {item.terminalTitle}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground/80">{formatNotificationTime(item.createdAt)}</span>
                    </span>
                    <span className="mt-1 block truncate pl-3.5 text-[11px] text-muted-foreground dark:text-muted-foreground">
                      {item.message || notificationReasonText(item.reason)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function TickerLine({ item, now }: { item: TerminalNotification; now: number }) {
  return (
    <span className="flex h-4 min-w-0 items-center gap-1 text-[10px] font-semibold leading-4">
      <span className="min-w-0 truncate">{notificationTickerMainText(item)}</span>
      <span className="shrink-0 text-muted-foreground/80 dark:text-muted-foreground/80">{relativeNotificationTime(item.createdAt, now)}</span>
    </span>
  );
}

function notificationTickerText(item: TerminalNotification, now = Date.now()) {
  return `${notificationTickerMainText(item)} | ${relativeNotificationTime(item.createdAt, now)}`;
}

function notificationTickerMainText(item: TerminalNotification) {
  return `${item.deviceName || item.projectName} | ${item.terminalTitle} | ${item.message || notificationReasonText(item.reason)}`;
}

function notificationReasonText(reason?: string) {
  if (reason === "agent_done") return "任务已完成";
  if (reason === "notification") return "终端通知";
  if (reason === "bell") return "终端响铃";
  return "终端提醒";
}

function formatNotificationTime(value: number) {
  return relativeNotificationTime(value, Date.now());
}

function relativeNotificationTime(value: number, now: number) {
  const diff = Math.max(0, now - value);
  if (diff < 5_000) return "刚刚";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}秒前`;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}分钟前`;
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
