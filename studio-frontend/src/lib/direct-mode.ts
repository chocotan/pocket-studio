import type { Project } from "@/components/studio/studio-dashboard";

const DIRECT_MODE_KEY = "pocket-studio-direct-mode";

type DirectModePreferences = Record<string, boolean>;

export function loadDirectModePreferences(): DirectModePreferences {
  if (typeof window === "undefined" || !window.localStorage) return {};
  try {
    const raw = window.localStorage.getItem(DIRECT_MODE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const preferences: DirectModePreferences = {};
    Object.entries(parsed).forEach(([projectId, value]) => {
      if (typeof value === "boolean") preferences[projectId] = value;
    });
    return preferences;
  } catch {
    return {};
  }
}

export function saveDirectModePreference(projectId: string, directMode: boolean) {
  if (typeof window === "undefined" || !window.localStorage || !projectId) return;
  try {
    const preferences = loadDirectModePreferences();
    preferences[projectId] = directMode;
    window.localStorage.setItem(DIRECT_MODE_KEY, JSON.stringify(preferences));
  } catch {
    // Ignore storage failures in restricted browser contexts.
  }
}

export function projectDirectMode(projectId: string) {
  return Boolean(loadDirectModePreferences()[projectId]);
}

export function applyDirectModePreferences<T extends Project>(projects: T[]): T[] {
  const preferences = loadDirectModePreferences();
  return projects.map((project) => ({
    ...project,
    direct_mode: Boolean(preferences[project.id]),
  }));
}
