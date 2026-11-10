import { metadataStorage, type MetadataAuthority } from "./metadata-authority";
import { removeWorkspaceOperationRecordsV2, pendingWorkspaceOperationPrefixV2 } from "./pending-workspace-operation-v2";
import { withWorkspaceProfileMetadata, workspaceProfileIdentityForId, workspaceProfileIdentityForScope, workspaceProfileIdentityFromScope, WorkspaceProfileFenceError, type WorkspaceProfileIdentity } from "./workspace-profile-fence";
import { withLocalMetadata } from "./context-lock";
import { t } from "@/i18n";
import { normalizeTranscriptAction, type TranscriptActionRecord } from "./transcript-action";
import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { pendingWorkspaceOperationPrefix, waitForWorkspaceOperationWrites } from "./pending-workspace-operation";
import { pendingThreadCreationPrefix, waitForPendingThreadCreationWrites } from "./pending-thread-creation";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { MAX_ATTACHMENT_BYTES } from "@/protocol/attachment-limits";
import { isPermissionMode, type PermissionMode } from "@/protocol/task-permission-mode";
import {
  MAX_QUEUED_TASK_MESSAGES,
  MAX_TASK_MESSAGE_CHARACTERS,
} from "@/protocol/task-message-limits";
import {
  collapsedServerSectionsKey,
  waitForCollapsedServerSectionsWrites,
} from "./collapsed-server-sections";
import {
  newWorkspacePreferencePrefix,
  waitForNewWorkspacePreferenceWrites,
} from "./new-workspace-preferences";
import {
  clearProfileStateRemoval,
  markProfileStateRemoval,
} from "./profile-state-removal";
import { isAbsoluteWorkspacePath, safeWorkspacePathRelative } from "./workspace-path";
import {
  WORKSPACE_TAB_V1 as LEGACY_STORAGE_PREFIX,
  WORKSPACE_STATE_V2 as LEGACY_STATE_PREFIX,
  WORKSPACE_STATE_V3 as STORAGE_PREFIX,
  parseWorkspaceStateDocument,
} from "./migrations/workspace-state";

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
  /** Optional for older queue entries; frozen on their first dispatch attempt. */
  permissionMode?: PermissionMode;
}

/** A persisted receipt observation, never permission to resend or synthesize history. */
export interface WorkspaceSubmissionAcceptedTurn {
  threadId: string;
  turnId: string;
  attemptId?: string;
}

export function normalizeWorkspaceSubmissionAcceptedTurn(value: unknown): WorkspaceSubmissionAcceptedTurn | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !["threadId", "turnId", "attemptId"].includes(key))) return undefined;
  const identity = (item: unknown): item is string => typeof item === "string" && item.trim() === item && item.length > 0 &&
    item.length <= 512 && !/\p{Cc}/u.test(item);
  if (!identity(row.threadId) || !identity(row.turnId) || (row.attemptId !== undefined && !identity(row.attemptId))) return undefined;
  return { threadId: row.threadId, turnId: row.turnId, ...(typeof row.attemptId === "string" ? { attemptId: row.attemptId } : {}) };
}

export interface WorkspaceFailedSubmission {
  id: string;
  content: string;
  attachments: WorkspaceQueuedMessage["attachments"];
  createdAt: number;
  outcome: "failed" | "unknown";
  acceptedTurn?: WorkspaceSubmissionAcceptedTurn;
  error?: string;
  /** Preserves the original turn/start payload when retrying this message identity. */
  permissionMode?: PermissionMode;
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
  transcriptAction?: TranscriptActionRecord;
  activeTab: WorkspaceTab;
  /** Legacy/unscoped drafts are retained but never silently attached to another authorization. */
  retainedOtherScopeState?: boolean;
  model?: string;
  reasoningEffort?: string;
  queuedMessages?: WorkspaceQueuedMessage[];
  failedSubmissions?: WorkspaceFailedSubmission[];
  composerDraft?: string;
  browserUrl?: string;
  directoryPath?: string;
  fileDraft?: WorkspaceFileDraft;
  recentFiles?: string[];
  activePanelId?: string;
  panels?: WorkspacePanelState[];
}

const SCOPE_INDEX_PREFIX = "kcoder-studio:mobile-workspace-scope-index:v1";
export const MAX_WORKSPACE_AUTHORIZATION_SCOPES = 16;
const scopeIndexTails = new Map<string, Promise<unknown>>();
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
const MAX_FAILED_SUBMISSIONS = MAX_QUEUED_TASK_MESSAGES;
const MAX_RECENT_WORKSPACE_FILES = 20;
const pendingWrites = new Map<string, Promise<WorkspaceViewState>>();
const pendingMigrationWrites = new Map<string, Promise<boolean>>();
const deletedStateKeys = new Set<string>();
const deletedProfilePrefixes = new Set<string>();
const REMOVAL_TOMBSTONE_SUFFIX = ":removed:v1";

function removalTombstoneKey(key: string): string {
  return `${key}${REMOVAL_TOMBSTONE_SUFFIX}`;
}

function stateKeyIsDeleted(key: string): boolean {
  return (
    deletedStateKeys.has(key) ||
    [...deletedProfilePrefixes].some((prefix) => key.startsWith(prefix))
  );
}

async function workspaceStateIsDeleted(key: string, authority?: MetadataAuthority): Promise<boolean> {
  if (stateKeyIsDeleted(key)) return true;
  return (await metadataStorage(authority).getItem(removalTombstoneKey(key))) !== null;
}

async function withWorkspaceStateProfileMetadata<T>(
  profileId: string,
  authorizationScope: string | undefined,
  operation: (authority?: MetadataAuthority) => Promise<T>,
  parent?: MetadataAuthority,
): Promise<T> {
  const identity = authorizationScope
    ? await workspaceProfileIdentityForScope(profileId, authorizationScope, parent)
    : await workspaceProfileIdentityForId(profileId, parent);
  return withWorkspaceProfileMetadata(identity, operation, parent);
}

export function isWorkspaceTab(value: unknown): value is WorkspaceTab {
  return typeof value === "string" && VALID_TABS.has(value as WorkspaceTab);
}

async function migrateLegacyWorkspaceState(
  key: string,
  legacyStateKey: string,
  normalized: WorkspaceViewState,
  profileId: string,
  authorizationScope?: string,
  parent?: MetadataAuthority,
): Promise<boolean> {
  const existing = pendingMigrationWrites.get(key);
  if (existing) return existing;
  const operation = Promise.resolve().then(async () => {
    if (await workspaceStateIsDeleted(key, parent)) return false;
    return withWorkspaceStateProfileMetadata(profileId, authorizationScope, async authority => {
      if (await workspaceStateIsDeleted(key, authority)) return false;
      await metadataStorage(authority).setItem(key, JSON.stringify(normalized));
      if (await workspaceStateIsDeleted(key, authority)) {
        await metadataStorage(authority).removeItem(key);
        return false;
      }
      await metadataStorage(authority).removeItem(legacyStateKey);
      return true;
    }, parent);
  });
  pendingMigrationWrites.set(key, operation);
  try {
    return await operation;
  } finally {
    if (pendingMigrationWrites.get(key) === operation)
      pendingMigrationWrites.delete(key);
  }
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

function scopeIndexKey(profileId: string, serverId: string, threadId: string): string { return `${SCOPE_INDEX_PREFIX}:${routeStorageSuffix(profileId, serverId, threadId)}`; }
async function readAuthorizationScopes(key: string, authority?: MetadataAuthority): Promise<string[]> {
  const raw = await metadataStorage(authority).getItem(key); if (!raw) return [];
  const scopes: unknown = JSON.parse(raw);
  if (!Array.isArray(scopes) || scopes.length > MAX_WORKSPACE_AUTHORIZATION_SCOPES || scopes.some(scope => typeof scope !== "string" || scope.length > 32_768)) throw new Error("工作区授权索引无效；已有草稿仍保留");
  return scopes as string[];
}
function serializeScopeIndex<T>(key: string, operation: (authority?: MetadataAuthority) => Promise<T>, parent?: MetadataAuthority): Promise<T> {
  const result = (scopeIndexTails.get(key) ?? Promise.resolve()).catch(() => {}).then(() => withLocalMetadata(`workspace-scope-index:${key}`, operation, parent));
  scopeIndexTails.set(key, result); void result.finally(() => { if (scopeIndexTails.get(key) === result) scopeIndexTails.delete(key); }).catch(() => {}); return result;
}

export function workspaceStateAuthorizationScope(profile: GatewayProfile, server: KCoderServer): string {
  return JSON.stringify([profile.baseUrl, profile.authorizationGeneration ?? `legacy:${profile.id}`, server.id, server.workspacePath, server.transport, server.host, server.user, server.port, server.command, server.profile, server.settingsFile, server.accountIdentity?.principalId, server.accountIdentity?.role]);
}

export function workspaceStateStorageKey(
  profileId: string,
  serverId: string,
  threadId: string,
  authorizationScope?: string,
): string {
  return `${STORAGE_PREFIX}:${routeStorageSuffix(profileId, serverId, threadId)}${authorizationScope ? `:scope:${encodeURIComponent(authorizationScope)}` : ""}`;
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
                isAbsoluteWorkspacePath(panel.directoryPath)
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
  const normalizeAttachments = (
    value: unknown,
  ): WorkspaceQueuedMessage["attachments"] =>
    Array.isArray(value)
      ? value
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
          const attachments = normalizeAttachments(message.attachments);
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
              ...(Object.prototype.hasOwnProperty.call(message, "permissionMode")
                ? {
                    permissionMode: isPermissionMode(message.permissionMode)
                      ? message.permissionMode
                      : "default",
                  }
                : {}),
            },
          ];
        })
        .slice(0, MAX_QUEUED_TASK_MESSAGES)
    : undefined;
  const failedSubmissions = Array.isArray(raw.failedSubmissions)
    ? raw.failedSubmissions
        .flatMap((value): WorkspaceFailedSubmission[] => {
          if (!value || typeof value !== "object" || Array.isArray(value))
            return [];
          const submission = value as Record<string, unknown>;
          if (
            typeof submission.id !== "string" ||
            !/^[A-Za-z0-9._:-]{1,160}$/.test(submission.id) ||
            typeof submission.content !== "string" ||
            submission.content.length > MAX_TASK_MESSAGE_CHARACTERS ||
            (submission.outcome !== "failed" && submission.outcome !== "unknown") ||
            !Array.isArray(submission.attachments) ||
            submission.attachments.length > 32
          )
            return [];
          const attachments = normalizeAttachments(submission.attachments);
          if (attachments.length !== submission.attachments.length) return [];
          if (!submission.content.trim() && attachments.length === 0) return [];
          const acceptedTurn = submission.outcome === "unknown"
            ? normalizeWorkspaceSubmissionAcceptedTurn(submission.acceptedTurn) : undefined;
          return [
            {
              id: submission.id,
              content: submission.content,
              attachments,
              createdAt:
                typeof submission.createdAt === "number" &&
                Number.isFinite(submission.createdAt)
                  ? submission.createdAt
                  : Date.now(),
              outcome: submission.outcome,
              ...(acceptedTurn ? { acceptedTurn } : {}),
              ...(typeof submission.error === "string"
                ? { error: submission.error.slice(0, 4_000) }
                : {}),
              ...(isPermissionMode(submission.permissionMode)
                ? { permissionMode: submission.permissionMode }
                : {}),
            },
          ];
        })
        .slice(0, MAX_FAILED_SUBMISSIONS)
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
    failedSubmissions,
    transcriptAction: normalizeTranscriptAction(raw.transcriptAction),
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
      typeof raw.directoryPath === "string" && isAbsoluteWorkspacePath(raw.directoryPath)
        ? raw.directoryPath
        : undefined,
    fileDraft: draft,
    recentFiles:
      Array.isArray(raw.recentFiles)
        ? [...new Set(raw.recentFiles.flatMap((path) =>
            typeof path === "string" &&
            isAbsoluteWorkspacePath(path) &&
            path.length <= 4096 &&
            !/\p{Cc}/u.test(path)
              ? [path]
              : [],
          ))].slice(0, 20)
        : undefined,
    ...(panels
      ? { panels, activePanelId: activePanelId ?? panels[0]?.id }
      : {}),
  };
}

export async function loadWorkspaceState(
  profileId: string,
  serverId: string,
  threadId: string,
  authorizationScope?: string,
): Promise<WorkspaceViewState> {
  const key = workspaceStateStorageKey(profileId, serverId, threadId, authorizationScope);
  return withLocalMetadata(`workspace-state:${key}`, authority =>
    loadWorkspaceStateUnlocked(profileId, serverId, threadId, authorizationScope, key, authority),
  );
}

function containsRetainedDraft(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const state = normalizeWorkspaceViewState(JSON.parse(raw));
    const fileDrafts = [state.fileDraft, ...(state.panels ?? [])
      .filter(panel => panel.kind === "files").map(panel => panel.fileDraft)];
    return Boolean(
      state.composerDraft?.trim() ||
      state.queuedMessages?.some(message => message.content.trim() || message.attachments.length) ||
      state.failedSubmissions?.some(message => message.content.trim() || message.attachments.length) ||
      fileDrafts.some(draft => draft && isAbsoluteWorkspacePath(draft.path)),
    );
  } catch {
    // Inspect only; another authorization's unreadable bytes must remain untouched.
    return false;
  }
}

async function loadWorkspaceStateUnlocked(
  profileId: string,
  serverId: string,
  threadId: string,
  authorizationScope: string | undefined,
  key: string,
  authority?: MetadataAuthority,
): Promise<WorkspaceViewState> {
  if (await workspaceStateIsDeleted(key, authority)) return { activeTab: "agent" };
  const stored = await metadataStorage(authority).getItem(key);
  if (await workspaceStateIsDeleted(key, authority)) return { activeTab: "agent" };
  if (stored) {
    try {
      return normalizeWorkspaceViewState(parseWorkspaceStateDocument(stored));
    } catch {
      // Draft-bearing state is authoritative local user data. A failed read
      // must also fence subsequent save attempts, not silently reset it.
      throw new Error("workspace_state_corrupt");
    }
  }
  if (authorizationScope) {
    const scopes = await readAuthorizationScopes(scopeIndexKey(profileId, serverId, threadId), authority);
    const retainedKeys = [
      workspaceStateStorageKey(profileId, serverId, threadId),
      ...scopes.filter(scope => scope !== authorizationScope)
        .map(scope => workspaceStateStorageKey(profileId, serverId, threadId, scope)),
    ];
    for (const retainedKey of retainedKeys) {
      if (await workspaceStateIsDeleted(retainedKey, authority)) continue;
      const retained = await metadataStorage(authority).getItem(retainedKey);
      if (await workspaceStateIsDeleted(key, authority)) return { activeTab: "agent" };
      if (!await workspaceStateIsDeleted(retainedKey, authority) && containsRetainedDraft(retained))
        return { activeTab: "agent", retainedOtherScopeState: true };
    }
    return { activeTab: "agent" };
  }
  const legacyStateKey = legacyWorkspaceStateStorageKey(
    profileId,
    serverId,
    threadId,
  );
  const legacyState = await metadataStorage(authority).getItem(legacyStateKey);
  if (await workspaceStateIsDeleted(key, authority)) return { activeTab: "agent" };
  if (legacyState) {
    let normalized: WorkspaceViewState | undefined;
    try {
      normalized = normalizeWorkspaceViewState(parseWorkspaceStateDocument(legacyState));
    } catch {
      throw new Error("workspace_state_corrupt");
    }
    if (normalized) {
      if (await migrateLegacyWorkspaceState(key, legacyStateKey, normalized, profileId, undefined, authority))
        return normalized;
      return { activeTab: "agent" };
    }
  }
  const legacy = await metadataStorage(authority).getItem(
    workspaceTabStorageKey(profileId, serverId, threadId),
  );
  if (await workspaceStateIsDeleted(key, authority)) return { activeTab: "agent" };
  return { activeTab: isWorkspaceTab(legacy) ? legacy : "agent" };
}

function isRecentWorkspaceFilePath(root: string, path: string): boolean {
  return safeWorkspacePathRelative(root, path) !== null;
}

function mergeRecentWorkspaceFile(
  root: string,
  recentFiles: readonly string[],
  path: string,
): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const candidate of [path, ...recentFiles]) {
    if (
      typeof candidate !== "string" ||
      !isRecentWorkspaceFilePath(root, candidate) ||
      seen.has(candidate)
    ) continue;
    seen.add(candidate);
    next.push(candidate);
    if (next.length >= MAX_RECENT_WORKSPACE_FILES) break;
  }
  return next;
}

async function updateWorkspaceState(
  profileId: string,
  serverId: string,
  threadId: string,
  update: (current: WorkspaceViewState) => WorkspaceViewState,
  authorizationScope?: string,
  capturedIdentity?: WorkspaceProfileIdentity,
): Promise<WorkspaceViewState> {
  const scopeIdentity = workspaceProfileIdentityFromScope(profileId, authorizationScope);
  const authorization = capturedIdentity ?? scopeIdentity;
  if (authorization.id !== profileId || (scopeIdentity.baseUrl && (authorization.baseUrl !== scopeIdentity.baseUrl || authorization.authorizationGeneration !== scopeIdentity.authorizationGeneration))) throw new WorkspaceProfileFenceError();
  const key = workspaceStateStorageKey(profileId, serverId, threadId, authorizationScope);
  if (stateKeyIsDeleted(key)) return { activeTab: "agent" };
  const previous = pendingWrites.get(key) ?? Promise.resolve({ activeTab: "agent" as const });
  // A rejected compare-and-set belongs to its caller, not to the next writer.
  const operation = previous.catch(() => undefined).then(() => withLocalMetadata("workspace-state:" + key, async stateAuthority => {
    if (await workspaceStateIsDeleted(key, stateAuthority)) return { activeTab: "agent" as const };
    const current = await loadWorkspaceStateUnlocked(profileId, serverId, threadId, authorizationScope, key, stateAuthority);
    if (await workspaceStateIsDeleted(key, stateAuthority)) return { activeTab: "agent" as const };
    const next = normalizeWorkspaceViewState(update(current));
    if (await workspaceStateIsDeleted(key, stateAuthority)) return { activeTab: "agent" as const };
    let persisted = false;
    if (authorizationScope) {
      const indexKey = scopeIndexKey(profileId, serverId, threadId);
      persisted = await serializeScopeIndex(indexKey, scopeAuthority => withWorkspaceProfileMetadata(authorization, async authority => {
        if (await workspaceStateIsDeleted(key, authority)) return false;
        const scopes = await readAuthorizationScopes(indexKey, authority);
        if (!scopes.includes(authorizationScope) && scopes.length >= MAX_WORKSPACE_AUTHORIZATION_SCOPES) throw new Error("此任务已保留 16 个授权范围的草稿，请先在原身份下清理不需要的草稿");
        if (await workspaceStateIsDeleted(key, authority)) return false;
        if (!scopes.includes(authorizationScope)) await metadataStorage(authority).setItem(indexKey, JSON.stringify([...scopes, authorizationScope]));
        await metadataStorage(authority).setItem(key, JSON.stringify(next));
        return true;
      }, scopeAuthority), stateAuthority);
    } else persisted = await withWorkspaceProfileMetadata(authorization, async authority => {
      if (await workspaceStateIsDeleted(key, authority)) return false;
      await metadataStorage(authority).setItem(key, JSON.stringify(next));
      return true;
    }, stateAuthority);
    return persisted ? next : { activeTab: "agent" as const };
  }));
  pendingWrites.set(key, operation);
  try {
    return await operation;
  } finally {
    if (pendingWrites.get(key) === operation) pendingWrites.delete(key);
  }
}

export function saveWorkspaceState(
  profileId: string,
  serverId: string,
  threadId: string,
  update: Partial<WorkspaceViewState>,
  authorizationScope?: string,
  capturedIdentity?: WorkspaceProfileIdentity,
): Promise<WorkspaceViewState> {
  return updateWorkspaceState(
    profileId,
    serverId,
    threadId,
    (current) => ({ ...current, ...update }),
    authorizationScope,
    capturedIdentity,
  );
}

/** Compare-and-set under the existing cross-tab identity lock. No RPC is replayed here. */
export function updateWorkspaceTranscriptAction(
  profileId: string, serverId: string, threadId: string,
  expected: TranscriptActionRecord | undefined, action: TranscriptActionRecord | undefined,
  authorizationScope: string, capturedIdentity: WorkspaceProfileIdentity,
): Promise<WorkspaceViewState> {
  return updateWorkspaceState(profileId, serverId, threadId, current => {
    if (current.transcriptAction?.id !== expected?.id || current.transcriptAction?.phase !== expected?.phase) throw new Error(t("task.transcript_owner_changed"));
    return { ...current, transcriptAction: action };
  }, authorizationScope, capturedIdentity);
}

export function saveWorkspaceRecentFile(
  profileId: string,
  serverId: string,
  threadId: string,
  root: string,
  path: string,
  authorizationScope?: string,
  capturedIdentity?: WorkspaceProfileIdentity,
): Promise<WorkspaceViewState> {
  return updateWorkspaceState(
    profileId,
    serverId,
    threadId,
    (current) => ({
      ...current,
      recentFiles: mergeRecentWorkspaceFile(root, current.recentFiles ?? [], path),
    }),
    authorizationScope,
    capturedIdentity,
  );
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
  if (!profileId.trim()) return [];
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

export function profileScopedStorageKeysForProfile(
  keys: readonly string[],
  profileId: string,
): string[] {
  if (!profileId.trim()) return [];
  const workspaceKeys = new Set(workspaceStateKeysForProfile(keys, profileId));
  for (const key of keys) if (key === `kcoder-studio:mobile-thread-deletion-cleanup:v1:${encodeURIComponent(profileId)}`) workspaceKeys.add(key);
  const collapsedKey = collapsedServerSectionsKey(profileId);
  const newWorkspacePrefix = newWorkspacePreferencePrefix(profileId);
  return keys.filter(
    (key) =>
      workspaceKeys.has(key) ||
      key.startsWith(`${SCOPE_INDEX_PREFIX}:${encodeURIComponent(profileId)}:`) ||
      key === collapsedKey ||
      key.startsWith(newWorkspacePrefix) ||
      key.startsWith(pendingThreadCreationPrefix(profileId)) ||
      key.startsWith(pendingWorkspaceOperationPrefix(profileId)) || key.startsWith(pendingWorkspaceOperationPrefixV2(profileId)),
  );
}

export async function removeWorkspaceState(
  profileId: string,
  serverId: string,
  threadId: string,
  authorizationScope?: string,
): Promise<void> {
  const stateKey = workspaceStateStorageKey(profileId, serverId, threadId, authorizationScope);
  deletedStateKeys.add(stateKey);
  await withLocalMetadata(`workspace-state:${stateKey}`, async stateAuthority => {
    const persistRemoval = async (authority?: MetadataAuthority) => {
      await metadataStorage(authority).setItem(removalTombstoneKey(stateKey), "1");
      await metadataStorage(authority).removeItem(stateKey);
      if (authorizationScope) {
        const indexKey = scopeIndexKey(profileId, serverId, threadId);
        const scopes = (await readAuthorizationScopes(indexKey, authority)).filter(scope => scope !== authorizationScope);
        if (scopes.length) await metadataStorage(authority).setItem(indexKey, JSON.stringify(scopes));
        else await metadataStorage(authority).removeItem(indexKey);
      } else {
        await metadataStorage(authority).multiRemove([
          legacyWorkspaceStateStorageKey(profileId, serverId, threadId),
          workspaceTabStorageKey(profileId, serverId, threadId),
        ]);
      }
    };
    if (authorizationScope) {
      const indexKey = scopeIndexKey(profileId, serverId, threadId);
      await serializeScopeIndex(indexKey, scopeAuthority => withWorkspaceStateProfileMetadata(profileId, authorizationScope, persistRemoval, scopeAuthority), stateAuthority);
    } else {
      await withWorkspaceStateProfileMetadata(profileId, undefined, persistRemoval, stateAuthority);
    }
  });
}

export function markWorkspaceStateRemoval(
  profileId: string,
  generation?: number,
): number | null {
  if (!profileId.trim()) return null;
  const removalGeneration = markProfileStateRemoval(profileId, generation);
  if (removalGeneration === null) return null;
  deletedProfilePrefixes.add(
    `${STORAGE_PREFIX}:${encodeURIComponent(profileId)}:`,
  );
  deletedProfilePrefixes.add(
    `${LEGACY_STATE_PREFIX}:${encodeURIComponent(profileId)}:`,
  );
  deletedProfilePrefixes.add(
    `${LEGACY_STORAGE_PREFIX}:${encodeURIComponent(profileId)}:`,
  );
  return removalGeneration;
}

export function clearWorkspaceStateRemoval(
  profileId: string,
  generation: number,
): boolean {
  if (!clearProfileStateRemoval(profileId, generation)) return false;
  deletedProfilePrefixes.delete(
    `${STORAGE_PREFIX}:${encodeURIComponent(profileId)}:`,
  );
  deletedProfilePrefixes.delete(
    `${LEGACY_STATE_PREFIX}:${encodeURIComponent(profileId)}:`,
  );
  deletedProfilePrefixes.delete(
    `${LEGACY_STORAGE_PREFIX}:${encodeURIComponent(profileId)}:`,
  );
  return true;
}

export async function removeWorkspaceStatesForProfile(
  profileId: string,
  generation?: number,
): Promise<void> {
  if (markWorkspaceStateRemoval(profileId, generation) === null) return;
  const matchingPending = workspaceStateKeysForProfile(
    [...pendingWrites.keys()],
    profileId,
  )
    .map((key) => pendingWrites.get(key))
    .filter((operation): operation is Promise<WorkspaceViewState> =>
      Boolean(operation),
    );
  const matchingMigrations = workspaceStateKeysForProfile(
    [...pendingMigrationWrites.keys()],
    profileId,
  )
    .map((key) => pendingMigrationWrites.get(key))
    .filter((operation): operation is Promise<boolean> => Boolean(operation));
  await Promise.all([
    ...matchingPending.map((operation) => operation.catch(() => undefined)),
    ...matchingMigrations.map((operation) => operation.catch(() => false)),
    waitForCollapsedServerSectionsWrites(profileId),
    waitForNewWorkspacePreferenceWrites(profileId),
    waitForWorkspaceOperationWrites(profileId),
    waitForPendingThreadCreationWrites(profileId),
  ]);
  await removeWorkspaceOperationRecordsV2(profileId);
  const keys = profileScopedStorageKeysForProfile(
    await AsyncStorage.getAllKeys(),
    profileId,
  );
  if (keys.length > 0) await AsyncStorage.multiRemove(keys);
}

export const workspacePreferencesTestHelpers = {
  reset(): void {
    pendingWrites.clear();
    scopeIndexTails.clear();
    pendingMigrationWrites.clear();
    deletedStateKeys.clear();
    deletedProfilePrefixes.clear();
  },
};
