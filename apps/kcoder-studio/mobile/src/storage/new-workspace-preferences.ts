import { workspacePreferenceProfileIdentity, withWorkspaceProfileWrite } from "./workspace-profile-fence";
import { t } from "@/i18n";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { isProfileStateRemovalPending } from "./profile-state-removal";

export type WorkspaceIsolation = "local" | "worktree";

export interface NewWorkspacePreference {
  cwd: string;
  isolation: WorkspaceIsolation;
}

const STORAGE_PREFIX = "kcoder-studio:mobile-new-workspace:v1";
const writeTails = new Map<string, Promise<void>>();
const pendingWrites = new Map<string, Set<Promise<void>>>();

export function newWorkspacePreferencePrefix(profileId: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(profileId)}:`;
}

export function newWorkspacePreferenceKey(profileId: string, serverId: string, scope: string): string {
  if (typeof scope !== "string" || !scope.trim()) throw new Error("项目偏好缺少授权范围");
  return `${newWorkspacePreferencePrefix(profileId)}${encodeURIComponent(serverId)}:scope:v2:${encodeURIComponent(scope)}`;
}

export function normalizeNewWorkspacePreference(
  value: unknown,
): NewWorkspacePreference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<NewWorkspacePreference>;
  const cwd = typeof candidate.cwd === "string" ? candidate.cwd.trim() : "";
  if (!cwd) return null;
  return {
    cwd,
    isolation: candidate.isolation === "worktree" ? "worktree" : "local",
  };
}

export async function loadNewWorkspacePreference(profileId: string, serverId: string, scope: string): Promise<NewWorkspacePreference | null> {
  const raw = await AsyncStorage.getItem(newWorkspacePreferenceKey(profileId, serverId, scope));
  if (!raw) return null;
  try {
    return normalizeNewWorkspacePreference(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function saveNewWorkspacePreference(profileId: string, serverId: string, scope: string, preference: NewWorkspacePreference): Promise<void> {
  if (isProfileStateRemovalPending(profileId)) return;
  const normalized = normalizeNewWorkspacePreference(preference);
  if (!normalized) return;
  const key = newWorkspacePreferenceKey(profileId, serverId, scope);
  const authorization = workspacePreferenceProfileIdentity(profileId, scope);
  const operation = (writeTails.get(key) ?? Promise.resolve()).catch(() => {}).then(() =>
    isProfileStateRemovalPending(profileId)
      ? undefined
      : withWorkspaceProfileWrite(authorization, async () => {
        if (isProfileStateRemovalPending(profileId)) return;
        await AsyncStorage.setItem(key, JSON.stringify(normalized));
      }),
  );
  writeTails.set(key, operation);
  const writes = pendingWrites.get(key) ?? new Set<Promise<void>>();
  writes.add(operation);
  pendingWrites.set(key, writes);
  try {
    await operation;
  } finally {
    if (writeTails.get(key) === operation) writeTails.delete(key);
    writes.delete(operation);
    if (writes.size === 0 && pendingWrites.get(key) === writes)
      pendingWrites.delete(key);
  }
}

export async function waitForNewWorkspacePreferenceWrites(profileId: string): Promise<void> {
  if (!profileId.trim()) return;
  const prefix = newWorkspacePreferencePrefix(profileId);
  const writes = [...pendingWrites]
    .filter(([key]) => key.startsWith(prefix))
    .flatMap(([, operations]) =>
      [...operations].map((operation) => operation.catch(() => {})),
    );
  await Promise.all(writes);
}

export const newWorkspacePreferencesTestHelpers = {
  reset(): void {
    pendingWrites.clear();
    writeTails.clear();
  },
};

const REASONING_LABEL_KEYS: Record<string, string> = {
  none: "task.reasoning_none",
  minimal: "task.reasoning_minimal",
  low: "task.reasoning_low",
  medium: "task.reasoning_medium",
  high: "task.reasoning_high",
  xhigh: "task.reasoning_xhigh",
  max: "task.reasoning_max",
  ultra: "task.reasoning_ultra",
};

export function reasoningEffortLabel(value: string): string {
  const key = REASONING_LABEL_KEYS[value.toLocaleLowerCase()];
  return key ? t(key) : value;
}
