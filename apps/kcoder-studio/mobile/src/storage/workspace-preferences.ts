import AsyncStorage from "@react-native-async-storage/async-storage";
import { MAX_ATTACHMENT_BYTES } from "@/protocol/attachment-limits";
import {
  MAX_QUEUED_TASK_MESSAGES,
  MAX_TASK_MESSAGE_CHARACTERS,
} from "@/protocol/task-message-limits";

export type WorkspaceTab =
  "agent" | "changes" | "terminal" | "browser" | "files";

export interface WorkspaceFileDraft {
  path: string;
  revision: string;
  content: string;
  updatedAt: number;
}

export interface WorkspaceQueuedMessage {
  id: string;
  content: string;
  attachments: Array<{
    filename: string;
    mimeType: string;
    fileSize: number;
    path: string;
  }>;
  createdAt: number;
}

export interface WorkspacePanelState {
  id: string;
  kind: WorkspaceTab;
  title: string;
  terminalSessionId?: string;
  browserUrl?: string;
  directoryPath?: string;
  fileDraft?: WorkspaceFileDraft;
}

export interface WorkspaceViewState {
  activeTab: WorkspaceTab;
  model?: string;
  reasoningEffort?: string;
  queuedMessages?: WorkspaceQueuedMessage[];
  composerDraft?: string;
  browserUrl?: string;
  directoryPath?: string;
  fileDraft?: WorkspaceFileDraft;
  activePanelId?: string;
  panels?: WorkspacePanelState[];
}

const LEGACY_STORAGE_PREFIX = "kcoder-studio:mobile-workspace-tab:v1";
const LEGACY_STATE_PREFIX = "kcoder-studio:mobile-workspace-state:v2";
const STORAGE_PREFIX = "kcoder-studio:mobile-workspace-state:v3";
const VALID_TABS = new Set<WorkspaceTab>([
  "agent",
  "changes",
  "terminal",
  "browser",
  "files",
]);
const MAX_DRAFT_CHARACTERS = 1_000_000;
// v2 may already contain 12 user panels; v3 migration inserts a fixed Changes panel and must not truncate old drafts.
const MAX_PANELS = 13;
const pendingWrites = new Map<string, Promise<WorkspaceViewState>>();
const deletedStateKeys = new Set<string>();
const deletedProfilePrefixes = new Set<string>();

function stateKeyIsDeleted(key: string): boolean {
  return (
    deletedStateKeys.has(key) ||
    [...deletedProfilePrefixes].some((prefix) => key.startsWith(prefix))
  );
}

export function isWorkspaceTab(value: unknown): value is WorkspaceTab {
  return typeof value === "string" && VALID_TABS.has(value as WorkspaceTab);
}

function routeStorageSuffix(
  profileId: string,
  serverId: string,
  threadId: string,
): string {
  return `${encodeURIComponent(profileId)}:${encodeURIComponent(serverId)}:${encodeURIComponent(threadId)}`;
}

export function workspaceTabStorageKey(
  profileId: string,
  serverId: string,
  threadId: string,
): string {
  return `${LEGACY_STORAGE_PREFIX}:${routeStorageSuffix(profileId, serverId, threadId)}`;
}

export function workspaceStateStorageKey(
  profileId: string,
  serverId: string,
  threadId: string,
): string {
  return `${STORAGE_PREFIX}:${routeStorageSuffix(profileId, serverId, threadId)}`;
}

function legacyWorkspaceStateStorageKey(
  profileId: string,
  serverId: string,
  threadId: string,
): string {
  return `${LEGACY_STATE_PREFIX}:${routeStorageSuffix(profileId, serverId, threadId)}`;
}

export function normalizeWorkspaceViewState(
  value: unknown,
): WorkspaceViewState {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const fileDraftRaw =
    raw.fileDraft &&
    typeof raw.fileDraft === "object" &&
    !Array.isArray(raw.fileDraft)
      ? (raw.fileDraft as Record<string, unknown>)
      : null;
  const draft =
    fileDraftRaw &&
    typeof fileDraftRaw.path === "string" &&
    typeof fileDraftRaw.revision === "string" &&
    typeof fileDraftRaw.content === "string" &&
    fileDraftRaw.content.length <= MAX_DRAFT_CHARACTERS
      ? {
          path: fileDraftRaw.path,
          revision: fileDraftRaw.revision,
          content: fileDraftRaw.content,
          updatedAt:
            typeof fileDraftRaw.updatedAt === "number"
              ? fileDraftRaw.updatedAt
              : Date.now(),
        }
      : undefined;
  const panelIds = new Set<string>();
  const panels = Array.isArray(raw.panels)
    ? raw.panels
        .flatMap((value): WorkspacePanelState[] => {
          if (!value || typeof value !== "object" || Array.isArray(value))
            return [];
          const panel = value as Record<string, unknown>;
          if (
            typeof panel.id !== "string" ||
            !/^[A-Za-z0-9._-]{1,80}$/.test(panel.id) ||
            panelIds.has(panel.id) ||
            !isWorkspaceTab(panel.kind)
          )
            return [];
          if ((panel.kind === "agent") !== (panel.id === "agent")) return [];
          panelIds.add(panel.id);
          const panelDraftRaw =
            panel.fileDraft &&
            typeof panel.fileDraft === "object" &&
            !Array.isArray(panel.fileDraft)
              ? (panel.fileDraft as Record<string, unknown>)
              : null;
          const panelDraft =
            panelDraftRaw &&
            typeof panelDraftRaw.path === "string" &&
            typeof panelDraftRaw.revision === "string" &&
            typeof panelDraftRaw.content === "string" &&
            panelDraftRaw.content.length <= MAX_DRAFT_CHARACTERS
              ? {
                  path: panelDraftRaw.path,
                  revision: panelDraftRaw.revision,
                  content: panelDraftRaw.content,
                  updatedAt:
                    typeof panelDraftRaw.updatedAt === "number"
                      ? panelDraftRaw.updatedAt
                      : Date.now(),
                }
              : undefined;
          return [
            {
              id: panel.id,
              kind: panel.kind,
              title:
                typeof panel.title === "string" && panel.title.trim()
                  ? panel.title.trim().slice(0, 40)
                  : panel.kind,
              terminalSessionId:
                panel.kind === "terminal" &&
                typeof panel.terminalSessionId === "string" &&
                /^[A-Za-z0-9._:-]{1,256}$/.test(panel.terminalSessionId)
                  ? panel.terminalSessionId
                  : undefined,
              browserUrl:
                typeof panel.browserUrl === "string" &&
                /^https?:\/\//i.test(panel.browserUrl)
                  ? panel.browserUrl
                  : undefined,
              directoryPath:
                typeof panel.directoryPath === "string" &&
                panel.directoryPath.startsWith("/")
                  ? panel.directoryPath
                  : undefined,
              fileDraft: panelDraft,
            },
          ];
        })
        .slice(0, MAX_PANELS)
    : undefined;
  if (panels && !panels.some((panel) => panel.id === "agent")) {
    if (panels.length >= MAX_PANELS) panels.pop();
    panels.unshift({ id: "agent", kind: "agent", title: "智能体" });
  }
  const activePanelId =
    typeof raw.activePanelId === "string" &&
    panels?.some((panel) => panel.id === raw.activePanelId)
      ? raw.activePanelId
      : undefined;
  const queuedMessages = Array.isArray(raw.queuedMessages)
    ? raw.queuedMessages
        .flatMap((value): WorkspaceQueuedMessage[] => {
          if (!value || typeof value !== "object" || Array.isArray(value))
            return [];
          const message = value as Record<string, unknown>;
          if (
            typeof message.id !== "string" ||
            !/^queued-[A-Za-z0-9-]{1,100}$/.test(message.id)
          )
            return [];
          if (
            typeof message.content !== "string" ||
            message.content.length > MAX_TASK_MESSAGE_CHARACTERS
          )
            return [];
          const attachments = Array.isArray(message.attachments)
            ? message.attachments
                .flatMap(
                  (attachment): WorkspaceQueuedMessage["attachments"] => {
                    if (
                      !attachment ||
                      typeof attachment !== "object" ||
                      Array.isArray(attachment)
                    )
                      return [];
                    const item = attachment as Record<string, unknown>;
                    if (
                      typeof item.filename !== "string" ||
                      item.filename.length > 255 ||
                      typeof item.mimeType !== "string" ||
                      item.mimeType.length > 160 ||
                      typeof item.path !== "string" ||
                      !item.path.startsWith("/") ||
                      typeof item.fileSize !== "number" ||
                      item.fileSize < 0 ||
                      item.fileSize > MAX_ATTACHMENT_BYTES
                    )
                      return [];
                    return [
                      {
                        filename: item.filename,
                        mimeType: item.mimeType,
                        fileSize: item.fileSize,
                        path: item.path,
                      },
                    ];
                  },
                )
                .slice(0, 32)
            : [];
          if (!message.content.trim() && attachments.length === 0) return [];
          return [
            {
              id: message.id,
              content: message.content,
              attachments,
              createdAt:
                typeof message.createdAt === "number"
                  ? message.createdAt
                  : Date.now(),
            },
          ];
        })
        .slice(0, MAX_QUEUED_TASK_MESSAGES)
    : undefined;
  return {
    activeTab: isWorkspaceTab(raw.activeTab) ? raw.activeTab : "agent",
    model:
      typeof raw.model === "string" && raw.model.trim().length <= 200
        ? raw.model.trim() || undefined
        : undefined,
    reasoningEffort:
      typeof raw.reasoningEffort === "string" &&
      /^[A-Za-z0-9._-]{1,40}$/.test(raw.reasoningEffort)
        ? raw.reasoningEffort
        : undefined,
    queuedMessages,
    composerDraft:
      typeof raw.composerDraft === "string" &&
      raw.composerDraft.length <= 50_000
        ? raw.composerDraft
        : undefined,
    browserUrl:
      typeof raw.browserUrl === "string" && /^https?:\/\//i.test(raw.browserUrl)
        ? raw.browserUrl
        : undefined,
    directoryPath:
      typeof raw.directoryPath === "string" && raw.directoryPath.startsWith("/")
        ? raw.directoryPath
        : undefined,
    fileDraft: draft,
    ...(panels
      ? { panels, activePanelId: activePanelId ?? panels[0]?.id }
      : {}),
  };
}

export async function loadWorkspaceState(
  profileId: string,
  serverId: string,
  threadId: string,
): Promise<WorkspaceViewState> {
  const key = workspaceStateStorageKey(profileId, serverId, threadId);
  if (stateKeyIsDeleted(key)) return { activeTab: "agent" };
  const stored = await AsyncStorage.getItem(key);
  if (stored) {
    try {
      return normalizeWorkspaceViewState(JSON.parse(stored));
    } catch {
      await AsyncStorage.removeItem(key);
    }
  }
  const legacyStateKey = legacyWorkspaceStateStorageKey(
    profileId,
    serverId,
    threadId,
  );
  const legacyState = await AsyncStorage.getItem(legacyStateKey);
  if (legacyState) {
    try {
      const normalized = normalizeWorkspaceViewState(JSON.parse(legacyState));
      await AsyncStorage.setItem(key, JSON.stringify(normalized));
      await AsyncStorage.removeItem(legacyStateKey);
      return normalized;
    } catch {
      await AsyncStorage.removeItem(legacyStateKey);
    }
  }
  const legacy = await AsyncStorage.getItem(
    workspaceTabStorageKey(profileId, serverId, threadId),
  );
  return { activeTab: isWorkspaceTab(legacy) ? legacy : "agent" };
}

export async function saveWorkspaceState(
  profileId: string,
  serverId: string,
  threadId: string,
  update: Partial<WorkspaceViewState>,
): Promise<WorkspaceViewState> {
  const key = workspaceStateStorageKey(profileId, serverId, threadId);
  if (stateKeyIsDeleted(key)) return { activeTab: "agent" };
  const previous =
    pendingWrites.get(key) ?? loadWorkspaceState(profileId, serverId, threadId);
  const operation = previous.then(async (current) => {
    const next = normalizeWorkspaceViewState({ ...current, ...update });
    if (stateKeyIsDeleted(key)) return next;
    await AsyncStorage.setItem(key, JSON.stringify(next));
    return next;
  });
  pendingWrites.set(key, operation);
  try {
    return await operation;
  } finally {
    if (pendingWrites.get(key) === operation) pendingWrites.delete(key);
  }
}

export async function loadWorkspaceTab(
  profileId: string,
  serverId: string,
  threadId: string,
): Promise<WorkspaceTab> {
  return (await loadWorkspaceState(profileId, serverId, threadId)).activeTab;
}

export async function saveWorkspaceTab(
  profileId: string,
  serverId: string,
  threadId: string,
  tab: WorkspaceTab,
): Promise<void> {
  await saveWorkspaceState(profileId, serverId, threadId, { activeTab: tab });
}

export function workspaceStateKeysForProfile(
  keys: readonly string[],
  profileId: string,
): string[] {
  const encodedProfile = encodeURIComponent(profileId);
  const prefixes = [
    `${STORAGE_PREFIX}:${encodedProfile}:`,
    `${LEGACY_STATE_PREFIX}:${encodedProfile}:`,
    `${LEGACY_STORAGE_PREFIX}:${encodedProfile}:`,
  ];
  return keys.filter((key) =>
    prefixes.some((prefix) => key.startsWith(prefix)),
  );
}

export async function removeWorkspaceState(
  profileId: string,
  serverId: string,
  threadId: string,
): Promise<void> {
  const stateKey = workspaceStateStorageKey(profileId, serverId, threadId);
  deletedStateKeys.add(stateKey);
  const pending = pendingWrites.get(stateKey);
  if (pending) await pending.catch(() => undefined);
  await AsyncStorage.multiRemove([
    stateKey,
    legacyWorkspaceStateStorageKey(profileId, serverId, threadId),
    workspaceTabStorageKey(profileId, serverId, threadId),
  ]);
}

export async function removeWorkspaceStatesForProfile(
  profileId: string,
): Promise<void> {
  deletedProfilePrefixes.add(
    `${STORAGE_PREFIX}:${encodeURIComponent(profileId)}:`,
  );
  deletedProfilePrefixes.add(
    `${LEGACY_STATE_PREFIX}:${encodeURIComponent(profileId)}:`,
  );
  const matchingPending = workspaceStateKeysForProfile(
    [...pendingWrites.keys()],
    profileId,
  )
    .map((key) => pendingWrites.get(key))
    .filter((operation): operation is Promise<WorkspaceViewState> =>
      Boolean(operation),
    );
  await Promise.all(
    matchingPending.map((operation) => operation.catch(() => undefined)),
  );
  const keys = workspaceStateKeysForProfile(
    await AsyncStorage.getAllKeys(),
    profileId,
  );
  if (keys.length > 0) await AsyncStorage.multiRemove(keys);
}
