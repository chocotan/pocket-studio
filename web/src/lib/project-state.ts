import type { FileEntry, OpenFile } from "./types";

export interface ProjectUIState {
  openFiles: OpenFile[];
  activeFilePath: string;
  fileTree: FileEntry[];
  expandedPaths: string[];
  terminalLines: string[];
  explorerVisible: boolean;
  terminalVisible: boolean;
  activeTaskId: string;
}

const STORAGE_KEY = "pocketstudio_project_states";

export function getInitialProjectState(): ProjectUIState {
  return {
    openFiles: [],
    activeFilePath: "",
    fileTree: [],
    expandedPaths: ["."],
    terminalLines: [],
    explorerVisible: true,
    terminalVisible: false,
    activeTaskId: ""
  };
}

// Load all project states from localStorage
export function loadAllProjectStates(): Record<string, ProjectUIState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error("Failed to load project states", e);
    return {};
  }
}

// Save all project states to localStorage
export function saveAllProjectStates(states: Record<string, ProjectUIState>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(states));
  } catch (e) {
    console.error("Failed to save project states", e);
  }
}
