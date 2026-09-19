import AsyncStorage from "@react-native-async-storage/async-storage";

export type WorkspaceIsolation = "local" | "worktree";

export interface NewWorkspacePreference {
  cwd: string;
  isolation: WorkspaceIsolation;
}

const STORAGE_PREFIX = "kcoder-studio:mobile-new-workspace:v1";

export function newWorkspacePreferenceKey(profileId: string, serverId: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(profileId)}:${encodeURIComponent(serverId)}`;
}

export function normalizeNewWorkspacePreference(value: unknown): NewWorkspacePreference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<NewWorkspacePreference>;
  const cwd = typeof candidate.cwd === "string" ? candidate.cwd.trim() : "";
  if (!cwd) return null;
  return {
    cwd,
    isolation: candidate.isolation === "worktree" ? "worktree" : "local",
  };
}

export async function loadNewWorkspacePreference(profileId: string, serverId: string): Promise<NewWorkspacePreference | null> {
  const raw = await AsyncStorage.getItem(newWorkspacePreferenceKey(profileId, serverId));
  if (!raw) return null;
  try {
    return normalizeNewWorkspacePreference(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function saveNewWorkspacePreference(profileId: string, serverId: string, preference: NewWorkspacePreference): Promise<void> {
  const normalized = normalizeNewWorkspacePreference(preference);
  if (!normalized) return;
  await AsyncStorage.setItem(newWorkspacePreferenceKey(profileId, serverId), JSON.stringify(normalized));
}

const REASONING_LABELS: Record<string, string> = {
  none: "关闭",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
  ultra: "超高",
};

export function reasoningEffortLabel(value: string): string {
  return REASONING_LABELS[value.toLocaleLowerCase()] ?? value;
}
