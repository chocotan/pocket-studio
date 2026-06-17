export interface PocketElectronAPI {
  syncDaemonConfig?: (config: { server_url: string; token: string }) => Promise<void> | void;
  switchToLocalMode?: () => Promise<{ ok?: boolean; server_url?: string; error?: string }> | { ok?: boolean; server_url?: string; error?: string };
  writeClipboardText?: (text: string) => Promise<void> | void;
  setZoom?: (zoom: number) => Promise<void> | void;
}

export function pocketElectronAPI(): PocketElectronAPI | undefined {
  return (window as Window & { electronAPI?: PocketElectronAPI }).electronAPI;
}
