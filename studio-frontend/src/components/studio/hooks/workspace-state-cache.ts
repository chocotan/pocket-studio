const workspaceStates = new Map<string, unknown>();
const pendingWorkspaceStateLoads = new Map<string, Promise<unknown>>();

export type WorkspaceStateCacheEntry = {
  found: boolean;
  state: unknown;
};

export function readWorkspaceStateCache(projectId: string): WorkspaceStateCacheEntry {
  return {
    found: workspaceStates.has(projectId),
    state: workspaceStates.get(projectId),
  };
}

export function cacheWorkspaceState(projectId: string, state: unknown) {
  workspaceStates.set(projectId, state);
}

export function loadWorkspaceState(projectId: string, loader: () => Promise<unknown>): Promise<unknown> {
  const cached = readWorkspaceStateCache(projectId);
  if (cached.found) return Promise.resolve(cached.state);

  const pending = pendingWorkspaceStateLoads.get(projectId);
  if (pending) return pending;

  const request = Promise.resolve()
    .then(loader)
    .then((state) => {
      cacheWorkspaceState(projectId, state);
      return state;
    })
    .finally(() => {
      if (pendingWorkspaceStateLoads.get(projectId) === request) {
        pendingWorkspaceStateLoads.delete(projectId);
      }
    });
  pendingWorkspaceStateLoads.set(projectId, request);
  return request;
}
