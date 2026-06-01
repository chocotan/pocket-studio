export const ZOOM_STORAGE_KEY = "pocket-studio-page-zoom";
export const ZOOM_OPTIONS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200] as const;

export type PageZoom = (typeof ZOOM_OPTIONS)[number];

export function normalizeZoom(value: unknown): PageZoom {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : 100;
  if (!Number.isFinite(numeric)) return 100;
  const closest = ZOOM_OPTIONS.reduce((best, option) => (
    Math.abs(option - numeric) < Math.abs(best - numeric) ? option : best
  ), 100 as PageZoom);
  return closest;
}

export function loadZoom(): PageZoom {
  if (typeof window === "undefined") return 100;
  return normalizeZoom(window.localStorage.getItem(ZOOM_STORAGE_KEY));
}

export function saveZoom(zoom: PageZoom) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ZOOM_STORAGE_KEY, String(zoom));
}

export function applyZoom(zoom: PageZoom) {
  if (typeof document === "undefined") return;
  const electronAPI = (window as any).electronAPI;
  if (electronAPI?.setZoom) {
    document.documentElement.style.zoom = "";
    void electronAPI.setZoom(zoom);
    return;
  }
  document.documentElement.style.zoom = `${zoom}%`;
}
