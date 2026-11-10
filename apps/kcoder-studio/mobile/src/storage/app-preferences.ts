import { normalizeConversationLineSpacing, normalizeConversationSpacing, normalizeConversationFontFamily, type ConversationLineSpacing, type ConversationSpacing, type ConversationFontFamily } from '../../../shared/conversationReading';
export type { ConversationLineSpacing, ConversationSpacing, ConversationFontFamily } from '../../../shared/conversationReading';
import AsyncStorage from "@react-native-async-storage/async-storage";

export interface AppPreferences {
  interfaceVersion: InterfaceVersion;
  language: AppLanguagePreference;
  theme: AppThemePreference;
  terminalScrollbackLines: number;
  conversationFontScale: ConversationFontScale;
  conversationLineSpacing: ConversationLineSpacing;
  conversationBlockSpacing: ConversationSpacing;
  conversationLetterSpacing: ConversationSpacing;
  conversationFontFamily: ConversationFontFamily;
  thinkingCollapsedByDefault: boolean;
  toolsCollapsedByDefault: boolean;
  quickPhrases: QuickPhrase[];
}

export type AppLanguagePreference = "system" | "en" | "zh-CN";
export type InterfaceVersion = "modern" | "classic" | "v3";
export type AppThemePreference = "system" | "light" | "dark";
export type ConversationFontScale = "small" | "normal" | "large";

export interface QuickPhrase {
  id: string;
  title: string;
  content: string;
}

export type AppPreferencesHydrationState = "idle" | "loading" | "ready" | "error";

export interface AppPreferencesStorageStatus {
  hydration: AppPreferencesHydrationState;
  writeError: boolean;
}

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  interfaceVersion: "v3",
  language: "system",
  theme: "system",
  terminalScrollbackLines: 10_000,
  conversationFontScale: "normal",
  conversationLineSpacing: "normal",
  conversationBlockSpacing: "normal",
  conversationLetterSpacing: "normal",
  conversationFontFamily: "noto-sans-sc",
  thinkingCollapsedByDefault: true,
  toolsCollapsedByDefault: true,
  quickPhrases: [],
};

const STORAGE_KEY = "kcoder-studio:mobile-app-preferences:v1";
const MIN_SCROLLBACK_LINES = 1_000;
const MAX_SCROLLBACK_LINES = 100_000;

let snapshot = DEFAULT_APP_PREFERENCES;
let hydratePromise: Promise<AppPreferences> | null = null;
let writeTail: Promise<void> = Promise.resolve();
let mutationRevision = 0;
const listeners = new Set<() => void>();
const storageStatusListeners = new Set<() => void>();
let storageStatus: AppPreferencesStorageStatus = {
  hydration: "idle",
  writeError: false,
};

function publishStorageStatus(next: AppPreferencesStorageStatus): void {
  if (
    next.hydration === storageStatus.hydration &&
    next.writeError === storageStatus.writeError
  ) return;
  storageStatus = next;
  for (const listener of storageStatusListeners) listener();
}

function normalizeQuickPhrases(value: unknown): QuickPhrase[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item): QuickPhrase[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Partial<QuickPhrase>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
    const content = typeof candidate.content === "string" ? candidate.content : "";
    if (!id || !title || !content.trim() || seen.has(id)) return [];
    seen.add(id);
    return [{ id, title, content }];
  });
}

export function normalizeAppPreferences(value: unknown): AppPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return DEFAULT_APP_PREFERENCES;
  const candidate = value as Partial<AppPreferences>;
  const language: AppLanguagePreference =
    candidate.language === "en" || candidate.language === "zh-CN"
      ? candidate.language
      : "system";
  const theme: AppThemePreference =
    candidate.theme === "light" || candidate.theme === "dark"
      ? candidate.theme
      : "system";
  const requested = Number(candidate.terminalScrollbackLines);
  const terminalScrollbackLines = Number.isFinite(requested)
    ? Math.max(
        MIN_SCROLLBACK_LINES,
        Math.min(MAX_SCROLLBACK_LINES, Math.round(requested)),
      )
    : DEFAULT_APP_PREFERENCES.terminalScrollbackLines;
  const conversationFontScale: ConversationFontScale =
    candidate.conversationFontScale === "small" || candidate.conversationFontScale === "large"
      ? candidate.conversationFontScale
      : "normal";
  const conversationLineSpacing = normalizeConversationLineSpacing(candidate.conversationLineSpacing);
  const interfaceVersion = candidate.interfaceVersion;
  return {
    interfaceVersion: interfaceVersion === "classic" || interfaceVersion === "modern" || interfaceVersion === "v3"
      ? interfaceVersion : DEFAULT_APP_PREFERENCES.interfaceVersion,
    language,
    theme,
    terminalScrollbackLines,
    conversationFontScale,
    conversationLineSpacing,
    conversationBlockSpacing: normalizeConversationSpacing(candidate.conversationBlockSpacing),
    conversationLetterSpacing: normalizeConversationSpacing(candidate.conversationLetterSpacing),
    conversationFontFamily: normalizeConversationFontFamily(candidate.conversationFontFamily),
    thinkingCollapsedByDefault: typeof candidate.thinkingCollapsedByDefault === "boolean"
      ? candidate.thinkingCollapsedByDefault
      : true,
    toolsCollapsedByDefault: typeof candidate.toolsCollapsedByDefault === "boolean"
      ? candidate.toolsCollapsedByDefault
      : true,
    quickPhrases: normalizeQuickPhrases(candidate.quickPhrases),
  };
}

export function getAppPreferencesSnapshot(): AppPreferences {
  return snapshot;
}

export function subscribeAppPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAppPreferencesStorageStatus(): AppPreferencesStorageStatus {
  return storageStatus;
}

export function subscribeAppPreferencesStorageStatus(listener: () => void): () => void {
  storageStatusListeners.add(listener);
  return () => storageStatusListeners.delete(listener);
}

function sameQuickPhrases(left: QuickPhrase[], right: QuickPhrase[]): boolean {
  return left.length === right.length && left.every((phrase, index) => {
    const other = right[index];
    return phrase.id === other.id && phrase.title === other.title && phrase.content === other.content;
  });
}

function publish(next: AppPreferences): void {
  if (
    next.interfaceVersion === snapshot.interfaceVersion &&
    next.language === snapshot.language &&
    next.theme === snapshot.theme &&
    next.terminalScrollbackLines === snapshot.terminalScrollbackLines &&
    next.conversationFontScale === snapshot.conversationFontScale &&
    next.conversationLineSpacing === snapshot.conversationLineSpacing &&
    next.conversationBlockSpacing === snapshot.conversationBlockSpacing &&
    next.conversationLetterSpacing === snapshot.conversationLetterSpacing &&
    next.conversationFontFamily === snapshot.conversationFontFamily &&
    next.thinkingCollapsedByDefault === snapshot.thinkingCollapsedByDefault &&
    next.toolsCollapsedByDefault === snapshot.toolsCollapsedByDefault &&
    sameQuickPhrases(next.quickPhrases, snapshot.quickPhrases)
  ) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

export function hydrateAppPreferences(): Promise<AppPreferences> {
  if (hydratePromise) return hydratePromise;
  const revisionAtStart = mutationRevision;
  publishStorageStatus({ ...storageStatus, hydration: "loading" });
  hydratePromise = AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      if (revisionAtStart === mutationRevision && raw) {
        try {
          publish(normalizeAppPreferences(JSON.parse(raw)));
        } catch {
          publishStorageStatus({ ...storageStatus, hydration: "error" });
          return snapshot;
        }
      }
      publishStorageStatus({ ...storageStatus, hydration: "ready" });
      return snapshot;
    })
    .catch(() => {
      publishStorageStatus({ ...storageStatus, hydration: "error" });
      return snapshot;
    });
  return hydratePromise;
}

export function retryHydrateAppPreferences(): Promise<AppPreferences> {
  if (storageStatus.hydration !== "error") return hydrateAppPreferences();
  hydratePromise = null;
  return hydrateAppPreferences();
}

export function updateAppPreferences(
  update: Partial<AppPreferences>,
): AppPreferences {
  mutationRevision += 1;
  const next = normalizeAppPreferences({ ...snapshot, ...update });
  publish(next);
  writeTail = writeTail
    .catch(() => {})
    .then(() => AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)))
    .then(
      () => publishStorageStatus({ ...storageStatus, writeError: false }),
      () => publishStorageStatus({ ...storageStatus, writeError: true }),
    );
  return next;
}

export async function updateAppPreferencesAndWait(
  update: Partial<AppPreferences>,
): Promise<AppPreferences> {
  const next = updateAppPreferences(update);
  await writeTail;
  if (storageStatus.writeError) throw new Error("Could not save local app preferences");
  return next;
}

export async function retryAppPreferencesSave(): Promise<void> {
  updateAppPreferences({});
  await writeTail;
  if (storageStatus.writeError) throw new Error("Could not save local app preferences");
}

export const appPreferencesTestHelpers = {
  reset(): void {
    snapshot = DEFAULT_APP_PREFERENCES;
    hydratePromise = null;
    writeTail = Promise.resolve();
    mutationRevision = 0;
    listeners.clear();
    storageStatus = { hydration: "idle", writeError: false };
    storageStatusListeners.clear();
  },
  waitForWrites(): Promise<void> {
    return writeTail;
  },
};
