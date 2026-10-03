import AsyncStorage from "@react-native-async-storage/async-storage";

export interface AppPreferences {
  terminalScrollbackLines: number;
}

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  terminalScrollbackLines: 10_000,
};

const STORAGE_KEY = "kcoder-studio:mobile-app-preferences:v1";
const MIN_SCROLLBACK_LINES = 1_000;
const MAX_SCROLLBACK_LINES = 100_000;

let snapshot = DEFAULT_APP_PREFERENCES;
let hydratePromise: Promise<AppPreferences> | null = null;
let writeTail: Promise<void> = Promise.resolve();
let mutationRevision = 0;
const listeners = new Set<() => void>();

export function normalizeAppPreferences(value: unknown): AppPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return DEFAULT_APP_PREFERENCES;
  const candidate = value as Partial<AppPreferences>;
  const requested = Number(candidate.terminalScrollbackLines);
  const terminalScrollbackLines = Number.isFinite(requested)
    ? Math.max(
        MIN_SCROLLBACK_LINES,
        Math.min(MAX_SCROLLBACK_LINES, Math.round(requested)),
      )
    : DEFAULT_APP_PREFERENCES.terminalScrollbackLines;
  return { terminalScrollbackLines };
}

export function getAppPreferencesSnapshot(): AppPreferences {
  return snapshot;
}

export function subscribeAppPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(next: AppPreferences): void {
  if (next.terminalScrollbackLines === snapshot.terminalScrollbackLines) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

export function hydrateAppPreferences(): Promise<AppPreferences> {
  if (hydratePromise) return hydratePromise;
  const revisionAtStart = mutationRevision;
  hydratePromise = AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      if (!raw || revisionAtStart !== mutationRevision) return snapshot;
      try {
        publish(normalizeAppPreferences(JSON.parse(raw)));
      } catch {
        /* Fall back to defaults for damaged local preferences. */
      }
      return snapshot;
    })
    .catch(() => snapshot);
  return hydratePromise;
}

export function updateAppPreferences(
  update: Partial<AppPreferences>,
): AppPreferences {
  mutationRevision += 1;
  const next = normalizeAppPreferences({ ...snapshot, ...update });
  publish(next);
  writeTail = writeTail
    .catch(() => {})
    .then(() => AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)));
  return next;
}

export const appPreferencesTestHelpers = {
  reset(): void {
    snapshot = DEFAULT_APP_PREFERENCES;
    hydratePromise = null;
    writeTail = Promise.resolve();
    mutationRevision = 0;
    listeners.clear();
  },
  waitForWrites(): Promise<void> {
    return writeTail;
  },
};
