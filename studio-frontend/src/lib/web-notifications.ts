const WEB_NOTIFICATIONS_KEY = "pocket-studio-web-notifications";

export function isWebNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/**
 * The persisted preference only counts as "enabled" when the browser
 * permission is still granted (the user may have revoked it later).
 */
export function loadWebNotificationPreference(): boolean {
  if (!isWebNotificationSupported()) return false;
  try {
    return window.localStorage.getItem(WEB_NOTIFICATIONS_KEY) === "on"
      && Notification.permission === "granted";
  } catch {
    return false;
  }
}

export function saveWebNotificationPreference(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WEB_NOTIFICATIONS_KEY, enabled ? "on" : "off");
  } catch {
    // Ignore storage failures in restricted browser contexts.
  }
}

/**
 * Returns the current permission state ("granted" | "denied" | "default"),
 * or null when web notifications are not supported.
 */
export function webNotificationPermission(): NotificationPermission | null {
  if (!isWebNotificationSupported()) return null;
  return Notification.permission;
}

export async function ensureWebNotificationPermission(): Promise<boolean> {
  if (!isWebNotificationSupported()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

interface ShowWebNotificationOptions {
  title: string;
  body: string;
  tag?: string;
  onClick?: () => void;
}

export function showWebNotification({ title, body, tag, onClick }: ShowWebNotificationOptions) {
  if (!isWebNotificationSupported() || Notification.permission !== "granted") return;
  try {
    const notification = new Notification(title, { body, tag });
    notification.onclick = () => {
      window.focus();
      onClick?.();
      notification.close();
    };
  } catch {
    // Some environments (e.g. Android WebView) only allow notifications
    // from a service worker registration; fail silently.
  }
}
