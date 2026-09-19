import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_PREFIX = "kcoder-studio:mobile-collapsed-server-sections:v1";
const writeTails = new Map<string, Promise<void>>();
const hydratePromises = new Map<string, Promise<CollapsedServerSectionsSnapshot>>();
const snapshots = new Map<string, CollapsedServerSectionsSnapshot>();
const listeners = new Map<string, Set<() => void>>();

export interface CollapsedServerSectionsSnapshot {
  serverIds: ReadonlySet<string>;
  hydrated: boolean;
}

export function collapsedServerSectionsKey(profileId: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(profileId)}`;
}

export function normalizeCollapsedServerIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))];
}

export function toggleCollapsedServerId(current: ReadonlySet<string>, serverId: string): Set<string> {
  const next = new Set(current);
  if (next.has(serverId)) next.delete(serverId);
  else next.add(serverId);
  return next;
}

export async function loadCollapsedServerIds(profileId: string): Promise<Set<string>> {
  try {
    const key = collapsedServerSectionsKey(profileId);
    await writeTails.get(key)?.catch(() => {});
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return new Set();
    return new Set(normalizeCollapsedServerIds(JSON.parse(raw)));
  } catch {
    return new Set();
  }
}

export function getCollapsedServerSectionsSnapshot(profileId: string): CollapsedServerSectionsSnapshot {
  let snapshot = snapshots.get(profileId);
  if (!snapshot) {
    snapshot = { serverIds: new Set(), hydrated: false };
    snapshots.set(profileId, snapshot);
  }
  return snapshot;
}

export function subscribeCollapsedServerSections(profileId: string, listener: () => void): () => void {
  let profileListeners = listeners.get(profileId);
  if (!profileListeners) {
    profileListeners = new Set();
    listeners.set(profileId, profileListeners);
  }
  profileListeners.add(listener);
  return () => {
    profileListeners?.delete(listener);
    if (profileListeners?.size === 0) listeners.delete(profileId);
  };
}

function publishCollapsedServerSections(profileId: string, snapshot: CollapsedServerSectionsSnapshot): void {
  snapshots.set(profileId, snapshot);
  for (const listener of listeners.get(profileId) ?? []) listener();
}

export function hydrateCollapsedServerSections(profileId: string): Promise<CollapsedServerSectionsSnapshot> {
  const current = getCollapsedServerSectionsSnapshot(profileId);
  if (current.hydrated) return Promise.resolve(current);
  const existing = hydratePromises.get(profileId);
  if (existing) return existing;
  const hydrate = loadCollapsedServerIds(profileId)
    .then((serverIds) => {
      const snapshot = { serverIds, hydrated: true };
      publishCollapsedServerSections(profileId, snapshot);
      return snapshot;
    })
    .finally(() => hydratePromises.delete(profileId));
  hydratePromises.set(profileId, hydrate);
  return hydrate;
}

export function toggleProfileServerCollapsed(profileId: string, serverId: string): void {
  const current = getCollapsedServerSectionsSnapshot(profileId);
  if (!current.hydrated) return;
  const serverIds = toggleCollapsedServerId(current.serverIds, serverId);
  publishCollapsedServerSections(profileId, { serverIds, hydrated: true });
  void saveCollapsedServerIds(profileId, serverIds).catch(() => {});
}

export async function saveCollapsedServerIds(profileId: string, serverIds: ReadonlySet<string>): Promise<void> {
  const key = collapsedServerSectionsKey(profileId);
  const value = JSON.stringify(normalizeCollapsedServerIds([...serverIds]));
  const previous = writeTails.get(key) ?? Promise.resolve();
  const write = previous.catch(() => {}).then(() => AsyncStorage.setItem(key, value));
  writeTails.set(key, write);
  try {
    await write;
  } finally {
    if (writeTails.get(key) === write) writeTails.delete(key);
  }
}

export const collapsedServerSectionsTestHelpers = {
  reset(): void {
    writeTails.clear();
    hydratePromises.clear();
    snapshots.clear();
    listeners.clear();
  },
};
