import { reportBackgroundRunDiagnostic, type DiagnosticConnection } from './backgroundRunDiagnostic'
import { safeGatewayFailureDiagnostic } from './gatewayRpc'
import { assertAutomationCapabilities } from './automationCapabilities'
import { scopedModelCatalog } from './gatewayModelCatalog'
import { HOOK_CONFIGURATION_CAPABILITY, HOOK_CONFIGURATION_READ, HOOK_CONFIGURATION_UPDATE, hookTargetScope } from './gatewayHookConfiguration'
import { captureAccountContextRevision, listenAccountContextChanges } from './accountContextEvents'
import { startTurnWithReceipt, TurnAcceptanceUnknownError } from './gatewayTurnReceipt'
import { modelSelectionModeParams, threadModelSelectionMode, applyThreadModelSelection, type ModelSelectionMode } from './modelSelectionMode'
import i18n from '@/i18n'
import {
  executionReasoningEffort,
  executionServiceTier,
  executionSelectedModel,
} from './executionParameters'
import { BackgroundJobRegistry } from './backgroundJobRegistry'
import { negotiateModelSelector } from '../../../shared/modelSelection'
import { sameWorkspacePath, workspacePathKey } from '@/lib/workspace-path-identity'
import { normalizeAbsoluteWorkspacePath } from '@/lib/workspace-file-path'
import { decodeProviderFailure } from '@wegent/chat-core'
import { messagePrompt, messageTitle } from './gatewayMessageInput'
import { scanWorkspaces } from './workspaceScan'
import { historyRefreshInput, requestHistoryRefreshStep } from './gatewayHistoryRefresh'
import { requestTranscriptPage } from './gatewayTranscriptPage'
import { WorkspaceListScan } from './workspaceListScan'
import { WorkspaceScanCancelledError } from './workspaceScanError'
import { interactionReplyBinding } from './interactionReplyBinding'
import {
  parseThreadRunSummary,
  transcriptSnapshotRunning,
  threadRunActivity,
  type ThreadRunActivity,
  type ThreadRunSummary,
} from './threadRunSummary'
/*
 * KCoder browser compatibility boundary.
 *
 * The Wework renderer remains the upstream Tauri renderer. On pages served by the trusted
 * KCoder gateway, Tauri IPC is projected onto the same-origin WebSocket app-server transport.
 */
import { emitRuntimeEvent as emit } from './gatewayServiceBridge'
import { NotificationReplayGuard } from './notificationReplayGuard'
import { ToolPathPreviewConsumer } from './toolPathPreview'
import { copyTextToClipboard } from '@/lib/clipboard'
import {
  desktopHost,
  installDesktopHostNavigation,
  syncDesktopPreferences,
  syncDesktopTrayState,
} from './desktopHost'
import { turnPermissionParams } from './gatewayTurnPermissions'
import { isTemporaryTaskCreate, startTaskThread } from './gatewayTemporaryThread'
import { turnModeParams } from './gatewayExecutionModes'
import { assertRemoteBrowserAvailable } from './gatewayBrowserPreflight'
import { restartOwnedAppServers, type OwnedRuntimeClient } from './gatewayAppServerRestart'
import {
  installGatewayIpc,
  installGatewayRuntimeLifecycle,
  type GatewayRuntimeLifecycleDependencies,
} from './gatewayRuntimeInstall'
import type {
  RemoteTerminalClient,
  RemoteTerminalExitPayload,
  RemoteTerminalOutputPayload,
} from '@/lib/remote-terminal-socket'
import type { DeviceSessionResponse } from '@/types/devices'
import { createRandomUuid } from '@/lib/random-id'
import { defaultQuickPhrases } from '@/tauri/appPreferences'
import {
  fetchGatewayServers,
  gatewayToken,
  GatewayRpcClient,
  GatewayRpcError,
  type GatewayServer,
} from './gatewayRpc'
import { registerGatewayWorkspaceSessionRuntime } from './gatewayServiceBridge'
import {
  isPersistedKCoderAttachmentBlock,
  parsePersistedKCoderAttachmentBlocks,
  parsePersistedKCoderUserMessage,
  visibleRuntimeUserMessage,
} from '@/lib/runtime-user-message'
import {
  ATTACHMENT_CHUNK_BYTES,
  base64ToByteValues,
  downloadGatewayAttachment,
  MAX_GATEWAY_ATTACHMENT_BYTES,
  uploadGatewayAttachment,
} from './gatewayAttachmentTransfer'
import {
  KCODER_RUNTIME_NAME,
  LEGACY_KCODER_STUDIO_STORAGE_KEYS,
  LEGACY_KCODER_STUDIO_TAURI_COMMANDS,
  isKCoderRuntimeMethod,
} from './legacyRuntimeAbi'

const EXECUTOR_EVENT = 'local-executor:event'
const PREFERENCES_KEY = 'kcoder-studio:app-preferences'
const SELECTED_SERVER_KEY = 'kcoder-studio:selected-server'
const TASK_METADATA_KEY = 'kcoder-studio:task-metadata-v1'
const KEYBINDINGS_KEY = 'kcoder-studio:keybindings-v1'
const KCODER_INSTRUCTIONS_KEY = 'kcoder-studio:kcoder-instructions-v1'
const KCODER_PERSONALITY_KEY = 'kcoder-studio:kcoder-personality-v1'
const KCODER_RUNTIME_CONFIG_KEY = 'kcoder-studio:kcoder-runtime-config-v1'
const MAX_TASK_METADATA_ENTRIES = 10_000
const MAX_BUFFERED_TERMINAL_OUTPUT_BYTES = 256 * 1024
const MAX_TERMINAL_TOMBSTONES = 256
const MAX_INTERRUPTED_BACKGROUND_TOOL_TOMBSTONES = 512
const MAX_REMOTE_BROWSER_SESSIONS = 4
const REMOTE_BROWSER_FRAME_INTERVAL_MS = 250
const PERSISTED_THREAD_MISS_THRESHOLD = 2

const RUNTIME_PROJECT_PREFIX = 'runtime-target:'

function runtimeProjectKey(serverId: string): string {
  return `${RUNTIME_PROJECT_PREFIX}${serverId}`
}

function serverIdFromRuntimeProjectKey(projectKey: string | null | undefined): string | null {
  if (!projectKey) return null
  if (projectKey.startsWith(RUNTIME_PROJECT_PREFIX)) {
    return projectKey.slice(RUNTIME_PROJECT_PREFIX.length) || null
  }
  // Compatibility key for KCoder project state and historical deep links written by the first release.
  if (projectKey.startsWith('kcoder:')) return projectKey.slice('kcoder:'.length) || null
  return null
}

function runtimeTaskId(server: GatewayServer, threadId: string): string {
  // First-release server configuration had no runtime field; treat old configuration and test fixtures as KCoder.
  return `${server.runtime ?? 'kcoder'}:${server.id}:${threadId}`
}

function isRuntimeTaskId(taskId: string | null | undefined): boolean {
  return Boolean(taskId?.startsWith('kcoder:'))
}

const defaultPreferences = {
  closeToTrayEnabled: false,
  showMainWindowOnLaunch: true,
  systemDragEnabled: false,
  preventSleepWhileTasksRunning: true,
  closeToTrayHintSeen: true,
  language: 'zh-CN',
  terminalContextInjectionEnabled: true,
  experimentalFeaturesEnabled: false,
  taskCompletionNotificationsEnabled: false,
  trayUnreadEnabled: true,
  trayRunningEnabled: true,
  trayUsageEnabled: true,
  browserExternalLinkTarget: 'system',
  browserLocalLinkTarget: 'studio',
  browserDownloadDirectory: null,
  browserAskBeforeDownload: false,
  appshotsPlaySound: true,
  quickPhrases: defaultQuickPhrases.map(phrase => ({ ...phrase })),
}

interface GatewayTask {
  ephemeral?: boolean
  serverId: string
  taskId: string
  threadId: string
  workspacePath: string
  projectKey?: string
  projectName?: string
  title: string
  runtime: typeof KCODER_RUNTIME_NAME
  model?: string
  modelSelectionMode?: ModelSelectionMode
  persisted: boolean
  running: boolean
  /** Authoritative activity derived from the server run summary (S1/S4). */
  runActivity?: ThreadRunActivity
  runSummary?: ThreadRunSummary
  createdAt: number
  updatedAt: number
  runtimeHandle: { threadId: string }
  parent?: { taskId: string; threadId: string; lastTurnId: string }
}

interface GatewayWorkspaceDescriptor {
  threadsComplete?: boolean
  threadListIssueCount?: number
  threadListSyncFailed?: boolean
  server: GatewayServer
  workspacePath: string
  workspaceKind: 'workspace' | 'worktree'
  label: string
  labelKey?: 'currentComputer'
  projectName: string
  projectKey: string
  projectSource?: string
  projectRoots?: string[]
  projectPinned: boolean
  projectPinnedOrder?: number | null
  projectActive: boolean
  projectAppearance?: unknown
  worktreeId?: string
  pinnedTaskIds: string[]
  available: boolean
  error?: string
}

interface GatewayTaskMetadata {
  title?: string
  model?: string
  archivedAt?: number
  deletedAt?: number
  parent?: { taskId: string; threadId: string; lastTurnId: string }
  createdAt?: number
  updatedAt: number
}

interface GatewayThreadMetadataPatch {
  title?: string | null
  model?: string | null
  archivedAt?: string | null
  parent?: GatewayTask['parent'] | null
}

interface GatewayThreadMetadata {
  schema: 'kcoder.thread-metadata'
  version: 1
  revision: number
  title: string | null
  model: string | null
  archivedAt: string | null
  parent: GatewayTask['parent'] | null
}

interface ActiveGatewayTurn {
  turnId: string
  internal: boolean
  completion: Promise<void>
  complete: () => void
}

interface GatewayBackgroundJob {
  parentAttemptId?: string
  runId?: string
  taskId: string
  turnId: string
  toolCallId: string
  toolName: string
  serverId: string
}

interface InterruptedGatewayBackgroundTool {
  taskId: string
  toolCallId: string
  agentId: string
  output: Record<string, unknown>
}

interface PendingGatewayQuestion {
  client: GatewayClient
  requestId: number
  taskId: string
  turnId: string
  block: Record<string, unknown>
  renderPayload: Record<string, unknown>
  approvalId?: string
  questionId?: string
  approvalDecisions?: Record<string, 'accept' | 'accept_for_session' | 'decline'>
  autoResolutionTimer?: number
  responsePending?: boolean
  submittedResponse?: Record<string, unknown>
}

interface StagedGatewayAttachment {
  serverId: string
  filename: string
  mimeType: string
  fileSize: number
  contentBase64: string
}

interface GatewayAttachmentUpload {
  serverId: string
  filename: string
  mimeType: string
  fileSize: number
  client: GatewayClient
  remoteUploadId: string
  nextIndex: number
  receivedBytes: number
  contentBase64: string
}

interface GatewayTerminalState {
  serverId: string
  wireSessionId: string
  publicSessionId: string | null
  client: GatewayClient | null
  bufferedOutput: RemoteTerminalOutputPayload[]
  bufferedOutputBytes: number
  bufferedExit: RemoteTerminalExitPayload | null
  exited: boolean
  outputHandlers: Set<(payload: RemoteTerminalOutputPayload) => void>
  exitHandlers: Set<(payload: RemoteTerminalExitPayload) => void>
}

interface GatewayBrowserPageState {
  url: string | null
  title: string | null
  faviconUrl: string | null
}

interface GatewayBrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

interface GatewayBrowserInputEntry {
  action: Record<string, unknown>
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>
}

interface GatewayBrowserState {
  label: string
  nativeLabel: string
  serverId: string
  wireSessionId: string
  client: GatewayClient
  surface: HTMLImageElement
  page: GatewayBrowserPageState
  bounds: GatewayBrowserBounds
  viewportWidth: number
  viewportHeight: number
  visible: boolean
  connected: boolean
  closed: boolean
  frameInFlight: boolean
  frameQueued: boolean
  frameTimer: number | null
  lastPointerMoveAt: number
  inputQueue: GatewayBrowserInputEntry[]
  inputProcessing: boolean
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/** Raw string extraction for streaming deltas.
 *
 * `text()` trims before checking emptiness, which silently drops deltas that
 * carry only whitespace — Ollama streams newlines as standalone chunks, so the
 * live Markdown lost every line break until the persisted text was reloaded.
 */
export function rawDeltaText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function browserBounds(value: unknown): GatewayBrowserBounds {
  const bounds = record(value)
  return {
    x: Math.max(0, finiteNumber(bounds.x)),
    y: Math.max(0, finiteNumber(bounds.y)),
    width: Math.max(1, finiteNumber(bounds.width, 1)),
    height: Math.max(1, finiteNumber(bounds.height, 1)),
  }
}

function sanitizeBrowserLabelSegment(value: string): string {
  return value
    .trim()
    .split('')
    .map(character => (/^[a-zA-Z0-9_-]$/.test(character) ? character : '-'))
    .join('')
}

function readPreferences(): Record<string, unknown> {
  try {
    return {
      ...defaultPreferences,
      ...record(JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}')),
    }
  } catch {
    return { ...defaultPreferences }
  }
}

function writePreferences(patch: unknown): Record<string, unknown> {
  const next = { ...readPreferences(), ...record(patch) }
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next))
  return next
}

function readMigratedStorageValue(currentKey: string, legacyKey: string): string | null {
  const currentValue = localStorage.getItem(currentKey)
  if (currentValue !== null) return currentValue
  const legacyValue = localStorage.getItem(legacyKey)
  if (legacyValue === null) return null
  localStorage.setItem(currentKey, legacyValue)
  localStorage.removeItem(legacyKey)
  return legacyValue
}

export function readGatewayRuntimeConfig() {
  try {
    const stored = record(
      JSON.parse(
        readMigratedStorageValue(
          KCODER_RUNTIME_CONFIG_KEY,
          LEGACY_KCODER_STUDIO_STORAGE_KEYS.runtimeConfig
        ) ?? '{}'
      )
    )
    return {
      codexHome: '',
      configPath: '',
      remoteAppsEnabled: stored.remoteAppsEnabled !== false,
    }
  } catch {
    return { codexHome: '', configPath: '', remoteAppsEnabled: true }
  }
}

export function updateGatewayRuntimeConfig(patch: unknown) {
  const current = readGatewayRuntimeConfig()
  const requested = record(patch).remoteAppsEnabled
  const next = {
    ...current,
    remoteAppsEnabled: typeof requested === 'boolean' ? requested : current.remoteAppsEnabled,
  }
  localStorage.setItem(
    KCODER_RUNTIME_CONFIG_KEY,
    JSON.stringify({
      remoteAppsEnabled: next.remoteAppsEnabled,
    })
  )
  localStorage.removeItem(LEGACY_KCODER_STUDIO_STORAGE_KEYS.runtimeConfig)
  return next
}

function readKeybindings(): unknown[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEYBINDINGS_KEY) ?? '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function writeKeybindings(value: unknown): unknown[] {
  const keybindings = Array.isArray(value) ? value : []
  const serialized = JSON.stringify(keybindings)
  if (keybindings.length > 500 || serialized.length > 256 * 1024) {
    throw new Error('快捷键配置超过 KCoder 客户端限制')
  }
  localStorage.setItem(KEYBINDINGS_KEY, serialized)
  return keybindings
}

function legacyKCoderContextValue(currentKey: string, legacyKey: string): string | null {
  return localStorage.getItem(currentKey) ?? localStorage.getItem(legacyKey)
}

function clearLegacyKCoderContext() {
  for (const key of [
    KCODER_INSTRUCTIONS_KEY,
    KCODER_PERSONALITY_KEY,
    LEGACY_KCODER_STUDIO_STORAGE_KEYS.instructions,
    LEGACY_KCODER_STUDIO_STORAGE_KEYS.personality,
  ]) {
    localStorage.removeItem(key)
  }
}

function executionProxyUrl(execution: Record<string, unknown>): string | null {
  const modelConfig = record(execution.model_config)
  if (Object.keys(modelConfig).length === 0) return null
  const runtimeConfig = record(modelConfig.runtime_config)
  const kcoderRuntimeConfig = record(runtimeConfig.kcoder)
  // Unmigrated Wework model forms may still submit runtime_config.codex. Accept only
  // its data shape here; this neither connects to nor advertises another app-server protocol.
  const effectiveRuntimeConfig =
    Object.keys(kcoderRuntimeConfig).length > 0 ? kcoderRuntimeConfig : record(runtimeConfig.codex)
  if (effectiveRuntimeConfig.use_proxy !== true) return ''
  return text(record(modelConfig.proxy).url) ?? ''
}

function metadataTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

function taskParent(value: unknown): GatewayTask['parent'] | undefined {
  let parent = record(value)
  if (typeof value === 'string') {
    try {
      parent = record(JSON.parse(value))
    } catch {
      return undefined
    }
  }
  const taskId = text(parent.taskId)
  const threadId = text(parent.threadId)
  const lastTurnId = text(parent.lastTurnId)
  return taskId && threadId && lastTurnId ? { taskId, threadId, lastTurnId } : undefined
}

function authoritativeThreadMetadata(value: unknown): GatewayThreadMetadata | undefined {
  const metadata = record(value)
  if (
    metadata.schema !== 'kcoder.thread-metadata' ||
    metadata.version !== 1 ||
    typeof metadata.revision !== 'number' ||
    !Number.isFinite(metadata.revision)
  ) {
    return undefined
  }
  const nullableText = (field: string) =>
    metadata[field] === null || typeof metadata[field] === 'string'
      ? (metadata[field] as string | null)
      : null
  return {
    schema: 'kcoder.thread-metadata',
    version: 1,
    revision: metadata.revision,
    title: nullableText('title'),
    model: nullableText('model'),
    archivedAt: nullableText('archivedAt'),
    parent: metadata.parent === null ? null : (taskParent(metadata.parent) ?? null),
  }
}

function readTaskMetadata(): Map<string, GatewayTaskMetadata> {
  try {
    const entries = record(JSON.parse(localStorage.getItem(TASK_METADATA_KEY) ?? '{}'))
    return new Map(
      Object.entries(entries).flatMap(([key, value]) => {
        const entry = record(value)
        const updatedAt = finiteNumber(entry.updatedAt)
        if (!updatedAt) return []
        const parent = record(entry.parent)
        const parentTaskId = text(parent.taskId)
        const parentThreadId = text(parent.threadId)
        const parentLastTurnId = text(parent.lastTurnId)
        return [
          [
            key,
            {
              ...(text(entry.title) ? { title: text(entry.title)! } : {}),
              ...(text(entry.model) ? { model: text(entry.model)! } : {}),
              ...(finiteNumber(entry.archivedAt)
                ? { archivedAt: finiteNumber(entry.archivedAt) }
                : {}),
              ...(finiteNumber(entry.deletedAt)
                ? { deletedAt: finiteNumber(entry.deletedAt) }
                : {}),
              ...(finiteNumber(entry.createdAt)
                ? { createdAt: finiteNumber(entry.createdAt) }
                : {}),
              ...(parentTaskId && parentThreadId && parentLastTurnId
                ? {
                    parent: {
                      taskId: parentTaskId,
                      threadId: parentThreadId,
                      lastTurnId: parentLastTurnId,
                    },
                  }
                : {}),
              updatedAt,
            },
          ] as const,
        ]
      })
    )
  } catch {
    return new Map()
  }
}

interface GatewayClient extends EventTarget {
  readonly diagnosticConnection?: import('./backgroundRunDiagnostic').DiagnosticConnection
  connect(): Promise<void>
  request<T = unknown>(method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<T>
  respond?: (id: number, result: unknown) => void
  respondError?: (id: number, code: number, message: string, data?: unknown) => void
  close(): void
  supportsExperimental?: (capability: string) => boolean
  supportsThreadResume?: () => boolean
}

function isRetryableReadonlyTaskConnectionError(error: unknown): boolean {
  return error instanceof GatewayRpcError && error.reason === 'connection'
}

export interface KCoderGatewayRuntimeOptions {
  loadServers?: () => Promise<GatewayServer[]>
  createClient?: (
    serverId: string,
    token: string,
    channel?: 'runtime' | 'browser',
    workspacePath?: string
  ) => GatewayClient
}

interface SharedRuntimeContext {
  instructions: string
  personality: 'friendly' | 'pragmatic'
  instructionsConfigured: boolean
  personalityConfigured: boolean
  configPath: string | null
}

export class KCoderGatewayRuntime {
  private readonly token: string
  private readonly loadServers: () => Promise<GatewayServer[]>
  private readonly createClient: (
    serverId: string,
    token: string,
    channel?: 'runtime' | 'browser',
    workspacePath?: string
  ) => GatewayClient
  private serversPromise: Promise<GatewayServer[]> | null = null
  private disposed = false
  private restartingAppServers = false
  private restartingServerId: string | null = null
  private readonly ownedRuntimeClients = new Map<GatewayClient, OwnedRuntimeClient>()
  private controlClientPromise: Promise<GatewayClient> | null = null
  private selectedServer: GatewayServer | null = null
  private readonly clientByTask = new Map<string, GatewayClient>()
  private readonly resumeClientByTask = new Map<string, Promise<GatewayClient>>()
  private readonly disconnectRecoveryByTask = new Map<string, Promise<void>>()
  private readonly notificationQueueByClient = new WeakMap<GatewayClient, Promise<void>>()
  private readonly notificationReplayGuard = new NotificationReplayGuard()
  private readonly toolPathPreviews = new ToolPathPreviewConsumer()
  private readonly appServerDisconnectedClients = new WeakSet<GatewayClient>()
  private readonly commandClientByServer = new Map<string, Promise<GatewayClient>>()
  private readonly workspaceOperationByKey = new Map<string, Promise<void>>()
  private readonly taskListScans = new WorkspaceListScan<
    GatewayServer,
    GatewayWorkspaceDescriptor
  >()
  private readonly transientClients = new Set<GatewayClient>()
  private workspaceScanGeneration = 0
  private readonly workspaceDescriptorCache = new Map<GatewayServer, GatewayWorkspaceDescriptor[]>()
  private readonly threadByTask = new Map<string, string>()
  private readonly taskByThread = new Map<string, string>()
  private readonly persistedThreadMisses = new Map<string, number>()
  private readonly canonicalTaskByRequested = new Map<string, string>()
  private readonly turnText = new Map<string, string>()
  private readonly turnAttemptIds = new Map<string, string>()
  private readonly toolNameByCall = new Map<string, string>()
  private readonly backgroundJobById = new BackgroundJobRegistry<GatewayBackgroundJob>()
  private readonly interruptedBackgroundToolByKey = new Map<
    string,
    InterruptedGatewayBackgroundTool
  >()
  private readonly tasks = new Map<string, GatewayTask>()
  private readonly archivedTasks = new Map<string, GatewayTask>()
  private readonly taskMetadata = readTaskMetadata()
  private readonly activeTurnByTask = new Map<string, ActiveGatewayTurn>()
  private readonly completedTurnKeys = new Set<string>()
  private readonly pendingTurnStartByTask = new Set<string>()
  private readonly pendingQuestionByKey = new Map<string, PendingGatewayQuestion>()
  private readonly attachmentByPath = new Map<string, StagedGatewayAttachment>()
  private readonly attachmentUploads = new Map<string, GatewayAttachmentUpload>()
  private readonly terminalByPublicId = new Map<string, GatewayTerminalState>()
  private readonly terminalByWireKey = new Map<string, GatewayTerminalState>()
  private readonly terminalTombstones = new Set<string>()
  private readonly browserByLabel = new Map<string, GatewayBrowserState>()
  private readonly accountEpochByTarget = new Map<string, object>()
  private readonly accountClients = new Map<GatewayClient, string>()
  private invalidateAccountTarget(targetId: string): void {
    this.accountEpochByTarget.set(targetId, {})
    const taskPrefix = `kcoder:${targetId}:`
    const taskIds = new Set([...this.tasks.values(), ...this.archivedTasks.values()]
      .filter(task => task.serverId === targetId).map(task => task.taskId))
    for (const map of [this.tasks, this.archivedTasks, this.clientByTask, this.resumeClientByTask,
      this.disconnectRecoveryByTask, this.threadByTask, this.persistedThreadMisses,
      this.canonicalTaskByRequested, this.activeTurnByTask]) {
      for (const key of map.keys()) if (key.startsWith(taskPrefix) || taskIds.has(key)) map.delete(key)
    }
    for (const map of [this.turnText, this.turnAttemptIds, this.toolNameByCall, this.interruptedBackgroundToolByKey]) {
      for (const key of map.keys()) if (key.startsWith(taskPrefix)) map.delete(key)
    }
    for (const [key, pending] of this.pendingQuestionByKey) {
      if (!key.startsWith(taskPrefix)) continue
      if (pending.autoResolutionTimer) window.clearTimeout(pending.autoResolutionTimer)
      this.pendingQuestionByKey.delete(key)
    }
    for (const [agentId, job] of this.backgroundJobById) {
      if (job.serverId === targetId) this.backgroundJobById.delete(agentId, job)
    }
    for (const key of this.taskMetadata.keys()) {
      if (key.startsWith(`${targetId}\0`)) this.taskMetadata.delete(key)
    }
    try { localStorage.setItem(TASK_METADATA_KEY, JSON.stringify(Object.fromEntries(this.taskMetadata))) } catch { /* Storage can be unavailable. */ }
    for (const key of this.taskByThread.keys()) if (key.startsWith(`${targetId}\0`)) this.taskByThread.delete(key)
    for (const key of this.completedTurnKeys) if (key.startsWith(taskPrefix)) this.completedTurnKeys.delete(key)
    for (const key of this.pendingTurnStartByTask) if (key.startsWith(taskPrefix)) this.pendingTurnStartByTask.delete(key)
    for (const key of this.attachmentByPath.keys()) if (key.startsWith(`${targetId}\0`)) this.attachmentByPath.delete(key)
    for (const [key, upload] of this.attachmentUploads) if (upload.serverId === targetId) this.attachmentUploads.delete(key)
    for (const [key, terminal] of this.terminalByWireKey) {
      if (terminal.serverId !== targetId) continue
      terminal.bufferedOutput = []
      this.terminalByWireKey.delete(key)
      if (terminal.publicSessionId) this.terminalByPublicId.delete(terminal.publicSessionId)
    }
    for (const [label, browser] of this.browserByLabel) {
      if (browser.serverId !== targetId) continue
      browser.surface.removeAttribute('src')
      void this.closeBrowser(label).catch(() => undefined)
    }
    for (const [client, owner] of this.accountClients) {
      if (owner === targetId) { client.close(); this.accountClients.delete(client) }
    }
    void emit(EXECUTOR_EVENT, { event: 'executor.account_context_invalidated', payload: { deviceId: targetId } })
    window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId } }))
  }
  private readonly handleServersChanged = (event?: Event) => {
    const targetId = (event as CustomEvent<{ targetId?: string }> | undefined)?.detail?.targetId
    this.serversPromise = null
    this.selectedServer = null
    this.invalidateWorkspaceScans()
    this.workspaceDescriptorCache.clear()
    for (const [key, client] of this.commandClientByServer) {
      if (targetId && !key.startsWith(`${targetId}\0`)) continue
      void client.then(value => value.close(), () => undefined)
      this.commandClientByServer.delete(key)
    }
  }

  private stopAccountContextListener: () => void = () => {}

  constructor(token: string, options: KCoderGatewayRuntimeOptions = {}) {
    this.token = token
    this.loadServers = options.loadServers ?? (() => fetchGatewayServers())
    this.createClient =
      options.createClient ??
      ((serverId, capabilityToken, channel, workspacePath) =>
        new GatewayRpcClient(serverId, capabilityToken, WebSocket, channel, workspacePath))
    if (typeof window !== 'undefined') {
      window.addEventListener('kcoder:servers-changed', this.handleServersChanged)
      this.stopAccountContextListener = listenAccountContextChanges(targetId => {
        this.invalidateAccountTarget(targetId)
      })
    }
  }

  private servers(): Promise<GatewayServer[]> {
    const pending = this.serversPromise ??= this.loadServers()
    return pending.then(servers => {
      if (this.serversPromise !== pending) throw new WorkspaceScanCancelledError()
      return servers
    })
  }

  private async server(): Promise<GatewayServer> {
    if (this.selectedServer) return this.selectedServer
    const servers = await this.servers()
    const selectedId = localStorage.getItem(SELECTED_SERVER_KEY)
    this.selectedServer = servers.find(server => server.id === selectedId) ?? servers[0]
    localStorage.setItem(SELECTED_SERVER_KEY, this.selectedServer.id)
    return this.selectedServer
  }

  private async sharedRuntimeContext(client: GatewayClient): Promise<SharedRuntimeContext> {
    let context = await client.request<SharedRuntimeContext>('runtime.context.get', {})
    const legacyInstructions = legacyKCoderContextValue(
      KCODER_INSTRUCTIONS_KEY,
      LEGACY_KCODER_STUDIO_STORAGE_KEYS.instructions
    )
    const legacyPersonality = legacyKCoderContextValue(
      KCODER_PERSONALITY_KEY,
      LEGACY_KCODER_STUDIO_STORAGE_KEYS.personality
    )
    const patch: Record<string, unknown> = {}
    if (!context.instructionsConfigured && legacyInstructions !== null) {
      patch.instructions = legacyInstructions
    }
    if (
      !context.personalityConfigured &&
      (legacyPersonality === 'friendly' || legacyPersonality === 'pragmatic')
    ) {
      patch.personality = legacyPersonality
    }
    if (Object.keys(patch).length > 0) {
      context = await client.request<SharedRuntimeContext>('runtime.context.update', {
        ...patch,
        onlyIfUnconfigured: true,
      })
    }
    clearLegacyKCoderContext()
    return context
  }

  private async serverForParams(params: Record<string, unknown>): Promise<GatewayServer> {
    const executionRequest = record(params.executionRequest)
    const execution = record(params.execution)
    const projectKey = text(params.runtimeProjectKey) ?? text(executionRequest.runtime_project_key)
    const requestedIds = [
      serverIdFromRuntimeProjectKey(projectKey),
      text(params.deviceId),
      text(params.device_id),
      text(execution.deviceId),
      text(execution.device_id),
    ].filter((value): value is string => Boolean(value))
    const uniqueRequestedIds = [...new Set(requestedIds)]
    if (uniqueRequestedIds.length > 1) {
      throw new Error(`KCoder 服务器选择冲突：${uniqueRequestedIds.join(', ')}`)
    }
    const requestedServerId = uniqueRequestedIds[0] ?? null
    const workspacePath =
      text(params.workspacePath) ??
      text(executionRequest.project_workspace_path) ??
      text(params.path) ??
      text(params.cwd)
    const servers = await this.servers()
    if (requestedServerId) {
      const explicit = servers.find(server => server.id === requestedServerId)
      if (!explicit) throw new Error(`未知的 KCoder 服务器：${requestedServerId}`)
      return explicit
    }
    if (workspacePath) {
      const matches = servers.filter(server =>
        sameWorkspacePath(server.workspacePath, workspacePath)
      )
      if (matches.length === 1) return matches[0]
      if (matches.length > 1) throw new Error(`工作区路径对应多个 KCoder 服务器：${workspacePath}`)
    }
    return this.server()
  }

  private async connectClient(
    server: GatewayServer,
    channel: 'runtime' | 'browser' = 'runtime',
    workspacePath?: string,
    restartProbe = false,
    onCreated?: (client: GatewayClient) => void
  ): Promise<GatewayClient> {
    if (this.isRestartingServer(server.id) && !restartProbe) {
      throw new Error('KCoder app-server restart is in progress')
    }
    const epoch = this.accountEpochByTarget.get(server.id) ?? {}
    this.accountEpochByTarget.set(server.id, epoch)
    const valid = () => this.accountEpochByTarget.get(server.id) === epoch
    const client = this.createClient(server.id, this.token, channel, workspacePath)
    this.accountClients.set(client, server.id)
    client.addEventListener('close', () => this.accountClients.delete(client), { once: true })
    const originalRequest = client.request.bind(client)
    client.request = async <T = unknown>(method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<T> => {
      if (!valid()) throw new WorkspaceScanCancelledError()
      const result = options ? await originalRequest<T>(method, params, options) : await originalRequest<T>(method, params)
      if (!valid()) throw new WorkspaceScanCancelledError()
      return result
    }

    onCreated?.(client)
    // app-server JSON-RPC notifications are wire-ordered. Project them serially so
    // rapid item/delta and turn/completed events cannot finish asynchronous emission in reverse and lose final text.
    this.notificationQueueByClient.set(client, Promise.resolve())
    client.addEventListener('close', () => this.toolPathPreviews.disconnect(client), { once: true })
    client.addEventListener('notification', event => {
      if (this.disposed || !valid()) return
      const message = (event as CustomEvent<{ method?: string; params?: Record<string, unknown> }>)
        .detail
      if (message.method) {
        const diagnosticConnection = client.diagnosticConnection
        if (message.method === 'server/disconnected') {
          this.appServerDisconnectedClients.add(client)
          this.toolPathPreviews.disconnect(client)
        }
        const notificationQueue = (this.notificationQueueByClient.get(client) ?? Promise.resolve())
          .then(() =>
            valid() ? this.forwardNotification(message.method!, message.params ?? {}, server.id, client, diagnosticConnection) : undefined
          )
          .catch(error => {
            if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
            console.error('[KCoder] Failed to forward app-server notification', safeGatewayFailureDiagnostic(error))
          })
        this.notificationQueueByClient.set(client, notificationQueue)
      }
    })
    client.addEventListener('request', event => {
      const message = (
        event as CustomEvent<{
          id?: number
          method?: string
          params?: Record<string, unknown>
        }>
      ).detail
      void (this.notificationQueueByClient.get(client) ?? Promise.resolve())
        .then(() => valid() ? this.forwardServerRequest(client, message, server.id) : undefined)
        .catch(error => {
          if (typeof message.id === 'number') {
            client.respondError?.(
              message.id,
              -32603,
              error instanceof Error ? error.message : String(error)
            )
          }
        })
    })
    try {
      const ready = client.connect()
      if (channel === 'runtime') {
        this.ownedRuntimeClients.set(client, {
          client,
          server,
          workspacePath: workspacePath ?? server.workspacePath,
          ready,
        })
        client.addEventListener('close', () => this.ownedRuntimeClients.delete(client), {
          once: true,
        })
      }
      await ready
      if (this.disposed || !valid()) {
        client.close()
        throw new Error('KCoder 网关运行时已关闭')
      }
      return client
    } catch (error) {
      this.ownedRuntimeClients.delete(client)
      client.close()
      throw error
    }
  }

  private async controlClient(): Promise<GatewayClient> {
    if (!this.controlClientPromise) {
      const attempt = this.server().then(async server => {
        const client = await this.connectClient(server)
        client.addEventListener(
          'close',
          () => {
            if (this.controlClientPromise === attempt) this.controlClientPromise = null
          },
          { once: true }
        )
        return client
      })
      this.controlClientPromise = attempt
      void attempt.catch(() => {
        if (this.controlClientPromise === attempt) this.controlClientPromise = null
      })
    }
    return this.controlClientPromise
  }

  private async commandClient(
    server: GatewayServer,
    workspacePath?: string
  ): Promise<GatewayClient> {
    if (this.isRestartingServer(server.id))
      throw new Error('KCoder app-server restart is in progress')
    const effectiveWorkspacePath = workspacePath?.trim() || server.workspacePath
    const clientKey = `${server.id}\0${workspacePathKey(effectiveWorkspacePath)}`
    const existing = this.commandClientByServer.get(clientKey)
    if (existing) return existing
    const attempt = this.connectClient(server, 'runtime', effectiveWorkspacePath).then(client => {
      client.addEventListener(
        'close',
        () => this.handleCommandClientClose(clientKey, server.id, client, attempt),
        { once: true }
      )
      return client
    })
    this.commandClientByServer.set(clientKey, attempt)
    void attempt.catch(() => {
      if (this.commandClientByServer.get(clientKey) === attempt) {
        this.commandClientByServer.delete(clientKey)
      }
    })
    return attempt
  }

  private async closeCachedCommandClient(server: GatewayServer, workspacePath: string) {
    const clientKey = `${server.id}\0${workspacePathKey(workspacePath)}`
    const pending = this.commandClientByServer.get(clientKey)
    if (!pending) return
    this.commandClientByServer.delete(clientKey)
    const client = await pending.catch(() => null)
    client?.close()
  }

  private handleCommandClientClose(
    clientKey: string,
    serverId: string,
    client: GatewayClient,
    attempt: Promise<GatewayClient>
  ) {
    if (this.commandClientByServer.get(clientKey) === attempt) {
      this.commandClientByServer.delete(clientKey)
    }
    const attachmentPrefix = `${serverId}\0`
    for (const key of this.attachmentByPath.keys()) {
      if (key.startsWith(attachmentPrefix)) this.attachmentByPath.delete(key)
    }
    for (const [uploadId, upload] of this.attachmentUploads) {
      if (upload.serverId === serverId && upload.client === client) {
        this.attachmentUploads.delete(uploadId)
      }
    }
    for (const state of this.terminalByWireKey.values()) {
      if (state.serverId !== serverId || state.client !== client || state.exited) continue
      state.exited = true
      state.client = null
      const payload = { session_id: state.publicSessionId ?? state.wireSessionId, exit_code: null }
      if (state.exitHandlers.size === 0) state.bufferedExit = payload
      else for (const handler of state.exitHandlers) handler(payload)
    }
  }

  private async withTransientClient<T>(
    server: GatewayServer,
    operation: (client: GatewayClient) => Promise<T>,
    workspacePath?: string
  ): Promise<T> {
    const generation = this.workspaceScanGeneration
    const client = await this.connectClient(server, 'runtime', workspacePath, false, created => {
      this.transientClients.add(created)
      created.addEventListener('close', () => this.transientClients.delete(created), { once: true })
    })
    try {
      if (this.disposed || generation !== this.workspaceScanGeneration) {
        throw new WorkspaceScanCancelledError()
      }
      return await operation(client)
    } finally {
      this.transientClients.delete(client)
      if (![...this.clientByTask.values()].includes(client)) client.close()
    }
  }

  private async withWorkspaceOperation<T>(
    serverId: string,
    workspacePath: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const key = `${serverId}\0${workspacePathKey(workspacePath)}`
    const previous = this.workspaceOperationByKey.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => {
      release = resolve
    })
    const tail = previous.catch(() => undefined).then(() => current)
    this.workspaceOperationByKey.set(key, tail)
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (this.workspaceOperationByKey.get(key) === tail) {
        this.workspaceOperationByKey.delete(key)
      }
    }
  }

  private async workspaceDescriptors(
    servers: GatewayServer[],
    selectedServer: GatewayServer,
    scanCancelled: () => boolean = () => false
  ): Promise<GatewayWorkspaceDescriptor[]> {
    const generation = this.workspaceScanGeneration
    const cancelled = () =>
      this.disposed || generation !== this.workspaceScanGeneration || scanCancelled()
    const descriptors = new Map<string, GatewayWorkspaceDescriptor[]>()
    const ordered = [...servers].sort(
      (a, b) => Number(b.id === selectedServer.id) - Number(a.id === selectedServer.id)
    )
    await scanWorkspaces(
      ordered,
      async server => {
        const basePath = server.workspacePath ?? `/remote/${server.id}`
        const byPath = new Map<string, GatewayWorkspaceDescriptor>()
        byPath.set(workspacePathKey(basePath), {
          server,
          workspacePath: basePath,
          workspaceKind: 'workspace',
          label: server.label,
          labelKey: server.labelKey,
          projectName: server.label,
          projectKey: runtimeProjectKey(server.id),
          projectRoots: [basePath],
          projectPinned: true,
          projectActive: server.id === selectedServer.id,
          pinnedTaskIds: [],
          available: true,
        })
        const healthStartedAt = Date.now()
        try {
          await this.withTransientClient(server, async client => {
            let rootProjectPinned = true
            if (client.supportsExperimental?.('workspaceRegistry') !== false) {
              const listed = await client.request<{
                items?: Array<Record<string, unknown>>
                pinnedTaskIds?: unknown[]
                rootProjectPinned?: boolean
              }>('runtime.workspaces.list', { deviceId: server.id })
              if (cancelled()) return
              const pinnedTaskIds = Array.isArray(listed.pinnedTaskIds)
                ? listed.pinnedTaskIds.filter(
                    (value): value is string => typeof value === 'string' && value.length > 0
                  )
                : []
              rootProjectPinned = listed.rootProjectPinned !== false
              for (const descriptor of byPath.values()) {
                descriptor.pinnedTaskIds = pinnedTaskIds
                descriptor.projectPinned = rootProjectPinned
              }
              for (const rawItem of Array.isArray(listed.items) ? listed.items : []) {
                const item = record(rawItem)
                const workspacePath = text(item.workspacePath)
                if (!workspacePath) continue
                const rawRoots = Array.isArray(item.projectRoots) ? item.projectRoots : []
                const roots = rawRoots
                  .map(value => (typeof value === 'string' ? value : null))
                  .filter((value): value is string => Boolean(value))
                byPath.set(workspacePathKey(workspacePath), {
                  server,
                  workspacePath,
                  workspaceKind: item.workspaceKind === 'worktree' ? 'worktree' : 'workspace',
                  label:
                    text(item.label) ??
                    workspacePath.split('/').filter(Boolean).at(-1) ??
                    'Workspace',
                  projectName:
                    text(item.projectName) ??
                    text(item.label) ??
                    workspacePath.split('/').filter(Boolean).at(-1) ??
                    'Workspace',
                  projectKey: text(item.projectKey) ?? workspacePath,
                  projectSource: 'local_project',
                  ...(roots.length > 0 ? { projectRoots: roots } : {}),
                  projectPinned: item.projectPinned === true,
                  projectPinnedOrder:
                    typeof item.projectPinnedOrder === 'number' ? item.projectPinnedOrder : null,
                  projectActive: item.projectActive === true,
                  pinnedTaskIds,
                  available: item.available !== false,
                  ...(text(item.error) ? { error: text(item.error)! } : {}),
                  ...(item.projectAppearance !== undefined
                    ? { projectAppearance: item.projectAppearance }
                    : {}),
                })
              }
            }
            const worktrees = await client.request<{
              items?: Array<Record<string, unknown>>
            }>('runtime.worktrees.list', { deviceId: server.id })
            if (cancelled()) return
            for (const rawItem of Array.isArray(worktrees.items) ? worktrees.items : []) {
              const item = record(rawItem)
              const workspacePath = text(item.path)
              if (!workspacePath || item.state !== 'active') continue
              byPath.set(workspacePathKey(workspacePath), {
                server,
                workspacePath,
                workspaceKind: 'worktree',
                worktreeId: text(item.worktreeId) ?? undefined,
                label: text(item.repositoryName) ?? text(item.worktreeId) ?? 'Worktree',
                projectName: server.label,
                projectKey: runtimeProjectKey(server.id),
                projectRoots: [basePath],
                projectPinned: rootProjectPinned,
                projectActive: false,
                pinnedTaskIds: byPath.get(workspacePathKey(basePath))?.pinnedTaskIds ?? [],
                available: true,
              })
            }
          })
          if (cancelled()) return
          server.status = 'online'
          server.latencyMs = Math.max(0, Date.now() - healthStartedAt)
          server.checkedAt = Date.now()
          delete server.error
          if (!cancelled()) this.workspaceDescriptorCache.set(server, [...byPath.values()])
        } catch (error) {
          if (cancelled()) return
          server.status = 'offline'
          server.latencyMs = Math.max(0, Date.now() - healthStartedAt)
          server.checkedAt = Date.now()
          server.error = error instanceof Error ? error.message : String(error)
          for (const previous of this.workspaceDescriptorCache.get(server) ?? []) {
            byPath.set(workspacePathKey(previous.workspacePath), {
              ...previous,
              server,
              available: false,
              error: server.error,
            })
          }
          console.warn(`[KCoder] 无法读取 目标 的工作区注册表`, safeGatewayFailureDiagnostic(error))
        }
        if (![...byPath.values()].some(item => item.projectActive)) {
          const base = byPath.get(workspacePathKey(basePath))
          if (base) base.projectActive = server.id === selectedServer.id
        }
        if (!cancelled()) descriptors.set(server.id, [...byPath.values()])
      },
      cancelled
    )
    return servers.flatMap(server => descriptors.get(server.id) ?? [])
  }

  private async serverForBrowserLabel(label: string): Promise<GatewayServer> {
    const matchingTasks = Array.from(this.tasks.values()).filter(
      task => `workspace-browser-${sanitizeBrowserLabelSegment(task.taskId)}` === label
    )
    const serverIds = [...new Set(matchingTasks.map(task => task.serverId))]
    if (serverIds.length > 1) {
      throw new Error(`浏览器标签对应多个 KCoder 服务器：${label}`)
    }
    if (serverIds.length === 1) {
      const server = (await this.servers()).find(candidate => candidate.id === serverIds[0])
      if (!server) throw new Error(`浏览器任务服务器已不存在：${serverIds[0]}`)
      return server
    }
    return this.server()
  }

  private browserPageResult(state: GatewayBrowserState) {
    return {
      nativeLabel: state.nativeLabel,
      title: state.page.title,
      url: state.page.url,
    }
  }

  private applyBrowserBounds(
    state: GatewayBrowserState,
    bounds: GatewayBrowserBounds,
    visible: boolean
  ) {
    state.bounds = bounds
    state.visible = visible
    Object.assign(state.surface.style, {
      left: `${Math.round(bounds.x)}px`,
      top: `${Math.round(bounds.y)}px`,
      width: `${Math.round(bounds.width)}px`,
      height: `${Math.round(bounds.height)}px`,
      display: visible ? 'block' : 'none',
      pointerEvents:
        visible && state.connected && state.surface.dataset.frameReady === 'true' ? 'auto' : 'none',
    })
  }

  private browserPoint(state: GatewayBrowserState, event: PointerEvent | WheelEvent) {
    const rect = state.surface.getBoundingClientRect()
    return {
      x: Math.max(
        0,
        Math.min(
          state.viewportWidth - 1,
          ((event.clientX - rect.left) / Math.max(1, rect.width)) * state.viewportWidth
        )
      ),
      y: Math.max(
        0,
        Math.min(
          state.viewportHeight - 1,
          ((event.clientY - rect.top) / Math.max(1, rect.height)) * state.viewportHeight
        )
      ),
    }
  }

  private queueBrowserFrame(state: GatewayBrowserState, immediate = false) {
    if (state.closed || !state.connected || !state.visible) return
    if (state.frameInFlight) {
      state.frameQueued = true
      return
    }
    if (state.frameTimer !== null) window.clearTimeout(state.frameTimer)
    state.frameTimer = window.setTimeout(
      () => {
        state.frameTimer = null
        void this.pollBrowserFrame(state)
      },
      immediate ? 0 : REMOTE_BROWSER_FRAME_INTERVAL_MS
    )
  }

  private async pollBrowserFrame(state: GatewayBrowserState) {
    if (state.closed || !state.connected || !state.visible || state.frameInFlight) return
    state.frameInFlight = true
    state.frameQueued = false
    try {
      const result = await state.client.request<{
        session_id?: string
        data_base64?: string
        mime_type?: string
        width?: number
        height?: number
        page?: { url?: string; title?: string | null; faviconUrl?: string | null }
      }>('browser/screenshot', { session_id: state.wireSessionId })
      if (state.closed || text(result.session_id) !== state.wireSessionId) return
      const data = text(result.data_base64)
      const mimeType = text(result.mime_type)
      if (!data || !mimeType?.startsWith('image/')) throw new Error('远程浏览器返回了无效画面')
      state.surface.src = `data:${mimeType};base64,${data}`
      if (typeof result.width === 'number') state.viewportWidth = result.width
      if (typeof result.height === 'number') state.viewportHeight = result.height
      const page = record(result.page)
      state.page = {
        url: text(page.url) ?? state.page.url,
        title: typeof page.title === 'string' ? page.title : null,
        faviconUrl: typeof page.faviconUrl === 'string' ? page.faviconUrl : null,
      }
      state.surface.dataset.pageUrl = state.page.url ?? ''
      state.surface.dataset.frameReady = 'true'
      state.surface.dataset.connection = 'connected'
      state.surface.style.opacity = '1'
      state.surface.style.pointerEvents = state.visible && state.connected ? 'auto' : 'none'
      delete state.surface.dataset.frameError
    } catch (error) {
      if (!state.closed) state.surface.dataset.frameError = String(error)
    } finally {
      state.frameInFlight = false
      if (!state.closed && state.connected && state.visible) {
        this.queueBrowserFrame(state, state.frameQueued)
      }
    }
  }

  private async sendBrowserAction(state: GatewayBrowserState, action: Record<string, unknown>) {
    if (state.closed) return
    const result = await state.client.request<{
      page?: { url?: string; title?: string | null; faviconUrl?: string | null }
    }>('browser/action', { session_id: state.wireSessionId, ...action })
    if (result.page) {
      state.page = {
        url: text(result.page.url) ?? state.page.url,
        title: typeof result.page.title === 'string' ? result.page.title : null,
        faviconUrl: typeof result.page.faviconUrl === 'string' ? result.page.faviconUrl : null,
      }
    }
    this.queueBrowserFrame(state, true)
  }

  private queueBrowserInput(
    state: GatewayBrowserState,
    action: Record<string, unknown>
  ): Promise<void> {
    if (state.closed || !state.connected) {
      return Promise.reject(new Error('KCoder 远程浏览器连接已断开'))
    }
    const completion = new Promise<void>((resolve, reject) => {
      const tail = state.inputQueue.at(-1)
      if (tail && tail.action.action === action.action && action.action === 'pointer_move') {
        tail.action = action
        tail.waiters.push({ resolve, reject })
        return
      }
      if (tail && tail.action.action === 'wheel' && action.action === 'wheel') {
        tail.action = {
          ...action,
          delta_x: finiteNumber(tail.action.delta_x) + finiteNumber(action.delta_x),
          delta_y: finiteNumber(tail.action.delta_y) + finiteNumber(action.delta_y),
        }
        tail.waiters.push({ resolve, reject })
        return
      }
      if (state.inputQueue.length >= 64) {
        const expendable = state.inputQueue.findIndex(entry =>
          ['pointer_move', 'wheel'].includes(String(entry.action.action))
        )
        if (expendable >= 0) {
          for (const waiter of state.inputQueue.splice(expendable, 1)[0].waiters) waiter.resolve()
        } else {
          reject(new Error('远程浏览器输入队列已满，请稍后重试'))
          return
        }
      }
      state.inputQueue.push({ action, waiters: [{ resolve, reject }] })
    })
    this.processBrowserInput(state)
    return completion
  }

  private processBrowserInput(state: GatewayBrowserState) {
    if (state.inputProcessing) return
    state.inputProcessing = true
    void (async () => {
      try {
        while (!state.closed && state.inputQueue.length > 0) {
          const next = state.inputQueue.shift()
          if (!next) continue
          try {
            await this.sendBrowserAction(state, next.action)
            for (const waiter of next.waiters) waiter.resolve()
          } catch (error) {
            for (const waiter of next.waiters) waiter.reject(error)
            throw error
          }
        }
      } catch (error) {
        for (const entry of state.inputQueue.splice(0)) {
          for (const waiter of entry.waiters) waiter.reject(error)
        }
        if (!state.closed) state.surface.dataset.frameError = String(error)
      } finally {
        state.inputProcessing = false
        if (!state.closed && state.connected && state.inputQueue.length > 0)
          this.processBrowserInput(state)
      }
    })()
  }

  private createBrowserSurface(state: GatewayBrowserState): HTMLImageElement {
    const surface = document.createElement('img')
    surface.alt = 'KCoder remote browser surface'
    surface.tabIndex = 0
    surface.draggable = false
    surface.dataset.testid = 'kcoder-remote-browser-surface'
    surface.dataset.browserLabel = state.label
    Object.assign(surface.style, {
      position: 'fixed',
      zIndex: '20',
      border: '0',
      margin: '0',
      padding: '0',
      objectFit: 'fill',
      opacity: '0',
      userSelect: 'none',
      outline: 'none',
      background: 'var(--background, #fff)',
    })
    surface.addEventListener('pointerdown', event => {
      event.preventDefault()
      surface.focus()
      surface.setPointerCapture?.(event.pointerId)
      const point = this.browserPoint(state, event)
      void this.queueBrowserInput(state, { action: 'pointer_down', ...point }).catch(
        () => undefined
      )
    })
    surface.addEventListener('pointermove', event => {
      const now = performance.now()
      if (now - state.lastPointerMoveAt < 50) return
      state.lastPointerMoveAt = now
      const point = this.browserPoint(state, event)
      void this.queueBrowserInput(state, { action: 'pointer_move', ...point }).catch(
        () => undefined
      )
    })
    surface.addEventListener('pointerup', event => {
      event.preventDefault()
      const point = this.browserPoint(state, event)
      void this.queueBrowserInput(state, { action: 'pointer_up', ...point }).catch(() => undefined)
    })
    surface.addEventListener(
      'wheel',
      event => {
        event.preventDefault()
        const point = this.browserPoint(state, event)
        void this.queueBrowserInput(state, {
          action: 'wheel',
          ...point,
          delta_x: event.deltaX,
          delta_y: event.deltaY,
        }).catch(() => undefined)
      },
      { passive: false }
    )
    surface.addEventListener('keydown', event => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      event.preventDefault()
      void this.queueBrowserInput(
        state,
        event.key.length === 1
          ? { action: 'text', text: event.key }
          : { action: 'key', key: event.key }
      ).catch(() => undefined)
    })
    surface.addEventListener('paste', event => {
      event.preventDefault()
      const value = event.clipboardData?.getData('text/plain') ?? ''
      if (value)
        void this.queueBrowserInput(state, { action: 'text', text: value }).catch(() => undefined)
    })
    surface.addEventListener('contextmenu', event => event.preventDefault())
    return surface
  }

  async openBrowser(rawParams: unknown) {
    const params = record(rawParams)
    const label = text(params.label) ?? 'workspace-browser'
    const url = text(params.url)
    if (!url) throw new Error('浏览器 URL 无效')
    const existing = this.browserByLabel.get(label)
    if (existing) return this.browserPageResult(existing)
    if (this.browserByLabel.size >= MAX_REMOTE_BROWSER_SESSIONS) {
      throw new Error(`远程浏览器最多同时打开 ${MAX_REMOTE_BROWSER_SESSIONS} 个会话`)
    }
    const server = await this.serverForBrowserLabel(label)
    const client = await this.connectClient(server, 'browser')
    try {
      await assertRemoteBrowserAvailable(client)
      const bounds = browserBounds(params.bounds)
      const result = await client.request<{
        session_id?: string
        url?: string
        width?: number
        height?: number
        sandbox_disabled?: boolean
      }>('browser/start', {
        url,
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      })
      const wireSessionId = text(result.session_id)
      if (!wireSessionId) throw new Error('KCoder app-server 未返回浏览器 session id')
      const state: GatewayBrowserState = {
        label,
        nativeLabel: `gateway-browser:${encodeURIComponent(server.id)}:${wireSessionId}`,
        serverId: server.id,
        wireSessionId,
        client,
        surface: null as unknown as HTMLImageElement,
        page: { url: text(result.url) ?? url, title: null, faviconUrl: null },
        bounds,
        viewportWidth:
          typeof result.width === 'number'
            ? result.width
            : Math.max(320, Math.min(1920, Math.round(bounds.width))),
        viewportHeight:
          typeof result.height === 'number'
            ? result.height
            : Math.max(240, Math.min(1080, Math.round(bounds.height))),
        visible: true,
        connected: true,
        closed: false,
        frameInFlight: false,
        frameQueued: false,
        frameTimer: null,
        lastPointerMoveAt: 0,
        inputQueue: [],
        inputProcessing: false,
      }
      state.surface = this.createBrowserSurface(state)
      client.addEventListener('close', () => {
        if (state.closed) return
        state.connected = false
        if (state.frameTimer !== null) window.clearTimeout(state.frameTimer)
        for (const entry of state.inputQueue.splice(0)) {
          for (const waiter of entry.waiters) {
            waiter.reject(new Error('KCoder 远程浏览器连接已断开'))
          }
        }
        state.surface.dataset.connection = 'disconnected'
        state.surface.dataset.frameError = 'KCoder app-server 连接已断开'
        state.surface.removeAttribute('src')
        state.surface.alt = 'Remote browser disconnected'
        state.surface.style.pointerEvents = 'none'
      })
      this.browserByLabel.set(label, state)
      document.body.appendChild(state.surface)
      this.applyBrowserBounds(state, bounds, true)
      this.queueBrowserFrame(state, true)
      return this.browserPageResult(state)
    } catch (error) {
      client.close()
      throw error
    }
  }

  async setBrowserBounds(rawParams: unknown) {
    const params = record(rawParams)
    const label = text(params.label) ?? 'workspace-browser'
    const state = this.browserByLabel.get(label)
    if (!state) throw new Error(`远程浏览器会话不存在：${label}`)
    const bounds = browserBounds(params.bounds)
    const resized =
      Math.round(bounds.width) !== Math.round(state.bounds.width) ||
      Math.round(bounds.height) !== Math.round(state.bounds.height)
    this.applyBrowserBounds(state, bounds, params.visible === true)
    if (resized) {
      await this.queueBrowserInput(state, {
        action: 'resize',
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      })
      state.viewportWidth = Math.max(320, Math.min(1920, Math.round(bounds.width)))
      state.viewportHeight = Math.max(240, Math.min(1080, Math.round(bounds.height)))
    }
    this.queueBrowserFrame(state, true)
  }

  async controlBrowser(labelValue: unknown, action: Record<string, unknown>) {
    const label = text(labelValue) ?? 'workspace-browser'
    const state = this.browserByLabel.get(label)
    if (!state) throw new Error(`远程浏览器会话不存在：${label}`)
    const navigating = ['navigate', 'reload', 'back', 'forward'].includes(String(action.action))
    if (navigating) state.surface.style.pointerEvents = 'none'
    try {
      await this.queueBrowserInput(state, action)
    } finally {
      if (navigating && state.connected && state.visible) state.surface.style.pointerEvents = 'auto'
    }
  }

  async evaluateBrowser(rawParams: unknown) {
    const params = record(rawParams)
    const label = text(params.label) ?? 'workspace-browser'
    const expression = text(params.expression) ?? text(params.script)
    if (!expression) throw new Error('浏览器脚本为空')
    const state = this.browserByLabel.get(label)
    if (!state) throw new Error(`远程浏览器会话不存在：${label}`)
    const result = await state.client.request<{ value?: unknown }>('browser/evaluate', {
      session_id: state.wireSessionId,
      expression,
    })
    this.queueBrowserFrame(state, true)
    return { ok: true, value: result.value }
  }

  readBrowserPageState(labelValue: unknown) {
    const label = text(labelValue) ?? 'workspace-browser'
    const state = this.browserByLabel.get(label)
    if (!state) throw new Error(`远程浏览器会话不存在：${label}`)
    if (!state.connected) throw new Error('KCoder 远程浏览器连接已断开')
    return this.browserPageResult(state)
  }

  async relabelBrowser(fromValue: unknown, toValue: unknown) {
    const fromLabel = text(fromValue)
    const toLabel = text(toValue) ?? 'workspace-browser'
    if (!fromLabel || fromLabel === toLabel) return
    const state = this.browserByLabel.get(fromLabel)
    if (!state) return
    if (this.browserByLabel.has(toLabel)) await this.closeBrowser(toLabel)
    this.browserByLabel.delete(fromLabel)
    state.label = toLabel
    state.surface.dataset.browserLabel = toLabel
    this.browserByLabel.set(toLabel, state)
  }

  async closeBrowser(labelValue: unknown) {
    const label = text(labelValue) ?? 'workspace-browser'
    const state = this.browserByLabel.get(label)
    if (!state) return
    this.browserByLabel.delete(label)
    const shouldNotifyServer = state.connected
    state.closed = true
    state.connected = false
    if (state.frameTimer !== null) window.clearTimeout(state.frameTimer)
    for (const entry of state.inputQueue.splice(0)) {
      for (const waiter of entry.waiters) waiter.reject(new Error('KCoder 远程浏览器已关闭'))
    }
    state.surface.remove()
    try {
      if (shouldNotifyServer) {
        await state.client.request('browser/close', { session_id: state.wireSessionId })
      }
    } finally {
      state.client.close()
    }
  }

  async clearBrowserData() {
    const labels = [...this.browserByLabel.keys()]
    await Promise.all(labels.map(label => this.closeBrowser(label)))
    return labels.length
  }

  async status() {
    const server = await this.server()
    if (this.isRestartingServer(server.id))
      throw new Error('KCoder app-server restart is in progress')
    try {
      await this.controlClient()
    } catch (error) {
      if (!server.security) throw error
      return { running: true, ready: false, deviceId: server.id, accountLoginServerId: server.id }
    }
    return {
      running: true,
      ready: true,
      deviceId: server.id,
      runtimeInstanceId: `kcoder-gateway:${server.id}`,
      // Wework gates device usability on its executor protocol version. The gateway implements
      // that surface independently from the renderer package version.
      version: '1.8.6-kcoder.1',
    }
  }

  async saveAttachment(rawParams: unknown): Promise<string> {
    const params = record(rawParams)
    const filename = text(params.filename)
    if (!filename || !Array.isArray(params.bytes)) throw new Error('附件名称或内容无效')
    const requestedMimeType = text(params.mimeType)
    const mimeType =
      requestedMimeType && /^[\w.+-]+\/[\w.+-]+$/.test(requestedMimeType)
        ? requestedMimeType
        : 'application/octet-stream'
    const fileSize = params.bytes.length
    const server = await this.serverForParams(params)
    const client = await this.commandClient(server)
    if (client.supportsExperimental?.('browserAttachments') === false) {
      throw new Error('KCoder app-server 不支持浏览器附件')
    }
    const uploaded = await uploadGatewayAttachment(client, filename, params.bytes)
    const { path, contentBase64 } = uploaded
    this.attachmentByPath.set(this.attachmentKey(server.id, path), {
      serverId: server.id,
      filename,
      mimeType,
      fileSize,
      contentBase64,
    })
    return path
  }

  async startAttachmentUpload(rawParams: unknown): Promise<{ uploadId: string; deviceId: string }> {
    const params = record(rawParams)
    const filename = text(params.filename)
    const fileSize =
      typeof params.fileSize === 'number'
        ? params.fileSize
        : typeof params.size === 'number'
          ? params.size
          : null
    if (
      !filename ||
      fileSize === null ||
      !Number.isSafeInteger(fileSize) ||
      fileSize < 0 ||
      fileSize > MAX_GATEWAY_ATTACHMENT_BYTES
    ) {
      throw new Error('附件名称或大小无效')
    }
    const requestedMimeType = text(params.mimeType)
    const mimeType =
      requestedMimeType && /^[\w.+-]+\/[\w.+-]+$/.test(requestedMimeType)
        ? requestedMimeType
        : 'application/octet-stream'
    const server = await this.serverForParams(params)
    const client = await this.commandClient(server)
    if (client.supportsExperimental?.('browserAttachments') === false) {
      throw new Error('KCoder app-server 不支持浏览器附件')
    }
    const started = await client.request<{ upload_id?: unknown }>('attachment/upload/start', {
      filename,
      size: fileSize,
    })
    const remoteUploadId = text(started.upload_id)
    if (!remoteUploadId) throw new Error('KCoder app-server 未返回附件上传 ID')
    const uploadId = createRandomUuid()
    this.attachmentUploads.set(uploadId, {
      serverId: server.id,
      filename,
      mimeType,
      fileSize,
      client,
      remoteUploadId,
      nextIndex: 0,
      receivedBytes: 0,
      contentBase64: '',
    })
    return { uploadId, deviceId: server.id }
  }

  async appendAttachmentUpload(rawParams: unknown): Promise<{ receivedBytes: number }> {
    const params = record(rawParams)
    const uploadId = text(params.uploadId)
    const contentBase64 = text(params.contentBase64)
    const index = typeof params.index === 'number' ? params.index : null
    if (!uploadId || !contentBase64 || index === null || !Number.isSafeInteger(index)) {
      throw new Error('附件分块参数无效')
    }
    const upload = this.attachmentUploads.get(uploadId)
    if (!upload) throw new Error('附件上传会话不存在')
    if (index !== upload.nextIndex) throw new Error('附件分块顺序无效')
    const chunkBytes = base64ToByteValues(contentBase64)
    if (chunkBytes.length > ATTACHMENT_CHUNK_BYTES) throw new Error('附件分块过大')
    if (upload.receivedBytes + chunkBytes.length > upload.fileSize) {
      throw new Error('附件分块超出声明大小')
    }
    await upload.client.request('attachment/upload/chunk', {
      upload_id: upload.remoteUploadId,
      index,
      content_base64: contentBase64,
    })
    upload.nextIndex += 1
    upload.receivedBytes += chunkBytes.length
    upload.contentBase64 += contentBase64
    return { receivedBytes: upload.receivedBytes }
  }

  async finishAttachmentUpload(rawParams: unknown): Promise<{ path: string; deviceId: string }> {
    const uploadId = text(record(rawParams).uploadId)
    if (!uploadId) throw new Error('附件上传 ID 无效')
    const upload = this.attachmentUploads.get(uploadId)
    if (!upload) throw new Error('附件上传会话不存在')
    try {
      if (upload.receivedBytes !== upload.fileSize) {
        throw new Error('附件内容不完整')
      }
      const result = await upload.client.request<{ path?: unknown }>('attachment/upload/finish', {
        upload_id: upload.remoteUploadId,
      })
      const path = typeof result.path === 'string' && result.path.trim() ? result.path : null
      if (!path) throw new Error('KCoder app-server 未返回附件路径')
      this.attachmentByPath.set(this.attachmentKey(upload.serverId, path), {
        serverId: upload.serverId,
        filename: upload.filename,
        mimeType: upload.mimeType,
        fileSize: upload.fileSize,
        contentBase64: upload.contentBase64,
      })
      return { path, deviceId: upload.serverId }
    } catch (error) {
      await upload.client
        .request('attachment/upload/cancel', { upload_id: upload.remoteUploadId })
        .catch(() => undefined)
      throw error
    } finally {
      this.attachmentUploads.delete(uploadId)
    }
  }

  async cancelAttachmentUpload(rawParams: unknown): Promise<void> {
    const uploadId = text(record(rawParams).uploadId)
    if (!uploadId) return
    const upload = this.attachmentUploads.get(uploadId)
    if (!upload) return
    this.attachmentUploads.delete(uploadId)
    await upload.client
      .request('attachment/upload/cancel', { upload_id: upload.remoteUploadId })
      .catch(() => undefined)
  }

  async saveAttachmentForIpc(rawParams: unknown) {
    const params = record(rawParams)
    const [path, server] = await Promise.all([
      this.saveAttachment(params),
      this.serverForParams(params),
    ])
    return { path, deviceId: server.id }
  }

  async readAttachment(rawParams: unknown): Promise<{
    contentBase64: string
    mimeType: string
    size: number
  }> {
    const params = record(rawParams)
    const path = text(params.path)
    if (!path) throw new Error('附件路径无效')
    const requestedServerId = text(params.deviceId) ?? text(params.device_id)
    const threadId = text(params.threadId) ?? text(params.thread_id)
    if (!threadId) {
      if (!requestedServerId) throw new Error('草稿附件缺少 device 身份')
      const cached = this.attachmentByPath.get(this.attachmentKey(requestedServerId, path))
      if (!cached) throw new Error('草稿附件不属于指定 KCoder 服务器')
      return {
        contentBase64: cached.contentBase64,
        mimeType: cached.mimeType,
        size: cached.fileSize,
      }
    }
    const server = await this.serverForParams(params)
    const workspacePath = text(params.workspacePath) ?? server.workspacePath
    const client = await this.commandClient(server, workspacePath)
    const result = await downloadGatewayAttachment(client, threadId, path)
    return {
      contentBase64: result.contentBase64,
      mimeType: text(params.mimeType) ?? 'application/octet-stream',
      size: result.size,
    }
  }

  async startTerminal(deviceId: string, cwd?: string): Promise<DeviceSessionResponse> {
    const server = await this.serverForParams({ deviceId, ...(cwd ? { cwd } : {}) })
    const client = await this.commandClient(server, cwd)
    if (client.supportsExperimental?.('terminalSessions') === false) {
      throw new Error('KCoder app-server 不支持终端会话')
    }
    const result = await client.request<{ session_id?: string; cwd?: string }>('terminal/start', {
      cwd: cwd ?? server.workspacePath ?? '/',
      rows: 24,
      cols: 80,
    })
    const sessionId = text(result.session_id)
    if (!sessionId) throw new Error('KCoder app-server 未返回终端 session id')
    const state = this.terminalState(sessionId, server.id)
    if (!state) throw new Error('KCoder app-server 返回了已关闭的终端 session id')
    state.client = client
    state.publicSessionId ??= `gateway-terminal:${encodeURIComponent(server.id)}:${sessionId}`
    this.terminalByPublicId.set(state.publicSessionId, state)
    return {
      session_id: state.publicSessionId,
      device_id: server.id,
      type: 'terminal',
      path: text(result.cwd) ?? cwd ?? server.workspacePath ?? '/',
      url: '',
      transport: 'socketio',
      expires_at: null,
    }
  }

  async restoreTerminal(
    deviceId: string,
    cwd: string | undefined,
    publicSessionId: string
  ): Promise<DeviceSessionResponse> {
    const server = await this.serverForParams({ deviceId, ...(cwd ? { cwd } : {}) })
    const prefix = `gateway-terminal:${encodeURIComponent(server.id)}:`
    if (!publicSessionId.startsWith(prefix)) {
      throw new Error('KCoder 终端会话与当前服务器不匹配')
    }
    const wireSessionId = publicSessionId.slice(prefix.length)
    if (!wireSessionId) throw new Error('KCoder 终端 session id 无效')

    const client = await this.commandClient(server, cwd)
    if (client.supportsExperimental?.('terminalSessions') === false) {
      throw new Error('KCoder app-server 不支持终端会话')
    }
    const attached = await client.request<{
      session_id?: string
      cwd?: string
      transcript?: string
    }>('terminal/attach', {
      session_id: wireSessionId,
      rows: 24,
      cols: 80,
    })
    if (text(attached.session_id) !== wireSessionId) {
      throw new Error('KCoder app-server 未恢复指定的终端会话')
    }

    const state = this.terminalState(wireSessionId, server.id)
    if (!state) throw new Error('KCoder 终端会话已经关闭')
    state.client = client
    state.publicSessionId = publicSessionId
    state.exited = false
    state.bufferedExit = null
    state.bufferedOutput = []
    state.bufferedOutputBytes = 0
    const transcript = typeof attached.transcript === 'string' ? attached.transcript : ''
    if (transcript) {
      state.bufferedOutput.push({ session_id: publicSessionId, data: transcript })
      state.bufferedOutputBytes = transcript.length
    }
    this.terminalByPublicId.set(publicSessionId, state)

    return {
      session_id: publicSessionId,
      device_id: server.id,
      type: 'terminal',
      path: text(attached.cwd) ?? cwd ?? server.workspacePath ?? '/',
      url: '',
      transport: 'socketio',
      expires_at: null,
    }
  }

  createTerminalClient(sessionId: string): RemoteTerminalClient {
    const state = this.terminalByPublicId.get(sessionId)
    if (!state) throw new Error(`KCoder 终端会话不存在：${sessionId}`)
    const forgetTerminal = () => this.forgetTerminal(state)
    const client = () => {
      if (!state.client) throw new Error('KCoder 终端连接尚未就绪')
      return state.client
    }
    return {
      async attach() {
        const buffered = state.bufferedOutput.splice(0)
        state.bufferedOutputBytes = 0
        for (const payload of buffered) {
          for (const handler of state.outputHandlers) {
            handler({ ...payload, session_id: sessionId })
          }
        }
        if (state.bufferedExit) {
          const payload = { ...state.bufferedExit, session_id: sessionId }
          state.bufferedExit = null
          for (const handler of state.exitHandlers) handler(payload)
        }
      },
      async write(data: string) {
        if (state.exited) return
        await client().request('terminal/write', { session_id: state.wireSessionId, data })
      },
      async resize(rows: number, cols: number) {
        if (state.exited) return
        await client().request('terminal/resize', {
          session_id: state.wireSessionId,
          rows,
          cols,
        })
      },
      async close() {
        if (!state.exited) {
          await client().request('terminal/close', { session_id: state.wireSessionId })
        }
        state.outputHandlers.clear()
        state.exitHandlers.clear()
        forgetTerminal()
      },
      onOutput(handler) {
        state.outputHandlers.add(handler)
        return () => state.outputHandlers.delete(handler)
      },
      onExit(handler) {
        state.exitHandlers.add(handler)
        return () => state.exitHandlers.delete(handler)
      },
      dispose: () => undefined,
    }
  }

  private terminalState(sessionId: string, serverId: string): GatewayTerminalState | null {
    const key = this.terminalWireKey(serverId, sessionId)
    if (this.terminalTombstones.has(key)) return null
    const existing = this.terminalByWireKey.get(key)
    if (existing) return existing
    const created: GatewayTerminalState = {
      serverId,
      wireSessionId: sessionId,
      publicSessionId: null,
      client: null,
      bufferedOutput: [],
      bufferedOutputBytes: 0,
      bufferedExit: null,
      exited: false,
      outputHandlers: new Set(),
      exitHandlers: new Set(),
    }
    this.terminalByWireKey.set(key, created)
    return created
  }

  private terminalWireKey(serverId: string, sessionId: string): string {
    return `${serverId}\0${sessionId}`
  }

  private threadKey(serverId: string, threadId: string): string {
    return `${serverId}\0${threadId}`
  }

  private attachmentKey(serverId: string, path: string): string {
    return `${serverId}\0${path}`
  }

  private resolveTaskId(value: string | null): string | null {
    return value ? (this.canonicalTaskByRequested.get(value) ?? value) : null
  }

  private forgetTerminal(state: GatewayTerminalState) {
    if (state.publicSessionId) this.terminalByPublicId.delete(state.publicSessionId)
    const key = this.terminalWireKey(state.serverId, state.wireSessionId)
    this.terminalByWireKey.delete(key)
    this.terminalTombstones.add(key)
    while (this.terminalTombstones.size > MAX_TERMINAL_TOMBSTONES) {
      const oldest = this.terminalTombstones.values().next().value
      if (typeof oldest !== 'string') break
      this.terminalTombstones.delete(oldest)
    }
  }

  async request(method: string, rawParams: unknown, options?: { signal?: AbortSignal }): Promise<unknown> {
    const params = record(rawParams)
    const pluginAccountValid = method === 'runtime.plugins.request' ? captureAccountContextRevision() : null
    const requestGeneration = this.workspaceScanGeneration
    if (this.restartingAppServers) await this.assertRequestTargetAvailable(params)
    const server = await this.server()
    if (method === 'runtime.usage.stats') {
      if (!text(params.serverId)) throw new Error('A usage statistics target is required')
      const target = await this.serverForParams({ deviceId: params.serverId })
      const client = await this.commandClient(target)
      if (client.supportsExperimental?.('usageHistory') !== true)
        throw new Error('请升级目标 KCoder 以查看最近 30 天用量')
      return client.request('usage/stats', {})
    }
    if (method === 'runtime.tools.catalog') {
      const taskId = text(params.taskId)
      const descriptor = taskId ? await this.taskDescriptor({ taskId }) : null
      if (!descriptor && !text(params.serverId))
        throw new Error('A tools catalog target is required')
      if (descriptor && text(params.serverId) && params.serverId !== descriptor.server.id)
        throw new Error('Tools catalog target does not match the task')
      const inspect = async (client: GatewayClient) => {
        if (client.supportsExperimental?.('toolsCatalog') !== true) return null
        return client.request(
          'tools/catalog',
          descriptor ? { threadId: descriptor.task.threadId } : {}
        )
      }
      if (descriptor) {
        const client = this.clientByTask.get(descriptor.task.taskId)
        if (!client || this.disconnectRecoveryByTask.has(descriptor.task.taskId))
          throw new Error('Tools catalog task is not resident')
        return inspect(client)
      }
      const target = await this.serverForParams({ deviceId: params.serverId })
      return this.withTransientClient(
        target,
        inspect,
        text(params.workspacePath) ?? target.workspacePath
      )
    }
    if (method === 'runtime.diagnostics.request') {
      const operation = text(params.method)
      if (
        operation !== 'diagnostics/storage/read' &&
        operation !== 'diagnostics/storage/cancel' &&
        operation !== 'diagnostics/storage/clean' &&
        operation !== 'diagnostics/debug-log/disable'
      )
        throw new Error('Unsupported diagnostics operation')
      if (!text(params.serverId)) throw new Error('A diagnostics target is required')
      const target = await this.serverForParams({ deviceId: params.serverId })
      const client = await this.commandClient(target)
      if (client.supportsExperimental?.('storageDiagnosticsV1') !== true)
        throw new Error(i18n.t('common:storageSettings.upgradeRequired'))
      const fields = { ...record(params.params) }
      if (operation === 'diagnostics/storage/cancel' && client.supportsExperimental?.('storageScanCancellationV1') !== true)
        throw new Error(i18n.t('common:storageSettings.cancelUnsupported'))
      if (operation === 'diagnostics/storage/clean' && !('confirm' in fields)) fields.confirm = true
      return client.request(operation, fields)
    }
    if (method === 'runtime.settings.request') {
      const operation = text(params.method)
      if (
        operation !== 'settings/templates/list' &&
        operation !== 'settings/templates/read' &&
        operation !== 'settings/templates/save' &&
        operation !== 'settings/templates/delete' &&
        operation !== 'settings/templates/default' &&
        operation !== 'settings/turn-file-changes/read' &&
        operation !== 'settings/turn-file-changes/save' &&
        operation !== 'settings/tools/read' &&
        operation !== 'settings/tools/save'
      )
        throw new Error('Unsupported settings operation')
      if (!text(params.serverId)) throw new Error('A settings target is required')
      const target = await this.serverForParams({ deviceId: params.serverId })
      const client = await this.commandClient(target)
      if (operation === 'settings/tools/read' || operation === 'settings/tools/save') {
        if (client.supportsExperimental?.('toolProfilesV1') !== true)
          throw new Error(i18n.t('common:toolProfile.unsupported'))
      } else if (client.supportsExperimental?.('settingsTemplatesV1') !== true) {
        throw new Error('请升级目标 KCoder 以使用会话配置模板')
      }
      const fields = { ...record(params.params) }
      if (operation === 'settings/templates/default' && !('id' in fields)) fields.id = null
      return client.request(operation, fields)
    }
    if (method === 'runtime.providers.request') {
      const operation = text(params.method)
      if (
        operation !== 'runtime.providers.list' &&
        operation !== 'runtime.providers.templates' &&
        operation !== 'runtime.providers.upsert' &&
        operation !== 'runtime.providers.delete'
      )
        throw new Error('Unsupported provider configuration operation')
      if (!text(params.serverId)) throw new Error('A provider configuration target is required')
      const target = await this.serverForParams({ deviceId: params.serverId })
      const client = await this.commandClient(target)
      if (client.supportsExperimental?.('providerConfiguration') !== true)
        throw new Error('请升级目标 KCoder 以使用 API 配置')
      const supportsAuthenticationPolicy =
        client.supportsExperimental?.('providerAuthenticationPolicy') === true
      if (
        operation === 'runtime.providers.upsert' &&
        record(params.params).capabilities !== undefined &&
        client.supportsExperimental?.('providerModelCapabilities') !== true
      ) {
        throw new Error('[provider_probe_unsupported] 请升级目标 KCoder 以编辑模型能力')
      }
      if (operation === 'runtime.providers.templates') {
        const result =
          client.supportsExperimental?.('providerTemplates') === true
            ? record(await client.request(operation, record(params.params)))
            : { templates: [] }
        return { ...result, supportsAuthenticationPolicy }
      }
      if (
        operation === 'runtime.providers.upsert' &&
        client.supportsExperimental?.('providerConnectionValidation') !== true
      )
        throw new Error(
          '[provider_probe_unsupported] 请升级目标 KCoder；当前版本不支持保存前的 API 连通性验证'
        )
      if (
        operation === 'runtime.providers.delete' &&
        client.supportsExperimental?.('providerDeletion') !== true
      )
        throw new Error('请升级目标 KCoder 以删除 API 配置')
      const fields = { ...record(params.params) }
      if (operation === 'runtime.providers.upsert' && !supportsAuthenticationPolicy) {
        if (fields.authentication !== undefined && record(fields.authentication).mode !== 'api_key')
          throw new Error('[provider_probe_unsupported] 请升级目标 KCoder 以使用此认证策略')
        delete fields.authentication
      }
      return client.request(operation, fields)
    }
    if (method === 'runtime.providers.restart') {
      if (!text(params.serverId)) throw new Error('A provider configuration target is required')
      const target = await this.serverForParams({ deviceId: params.serverId })
      const client = await this.commandClient(target)
      const validation = await client.request<{ valid?: boolean }>('runtime.providers.validate', {})
      if (validation.valid !== true) throw new Error('Provider configuration validation failed')
      return this.restartAppServers({ serverId: target.id, ifIdle: true })
    }
    if (method === 'runtime.automations.request') {
      const operation = text(params.method)
      if (!operation || !['cron/list', 'cron/create', 'cron/delete', 'cron/preview'].includes(operation))
        throw new Error('Unsupported scheduled task operation')
      const address = record(params.address)
      const target = await this.serverForParams(params)
      const workspacePath = text(address.workspacePath) ?? text(params.workspacePath)
      if (!workspacePath) throw new Error('Scheduled tasks require a project workspace')
      const client = await this.commandClient(target, workspacePath)
      const fields = record(params.params)
      assertAutomationCapabilities(client, operation, fields)
      return client.request(operation, fields)
    }
    if (method === 'runtime.history.refresh') {
      const workspacePath = text(params.workspacePath)
      if (!text(params.deviceId) || !workspacePath)
        throw new Error('History refresh requires an explicit server and workspace')
      const input = historyRefreshInput(params)
      const target = await this.serverForParams(params)
      const client = await this.commandClient(target, workspacePath)
      if (client.supportsExperimental?.('threadHistoryIndexRefresh') !== true)
        throw new Error(
          'The target KCoder server does not support threadHistoryIndexRefresh; upgrade it first'
        )
      if ('acknowledgeExternalWriters' in input) this.invalidateWorkspaceScans()
      const result = await this.withWorkspaceOperation(target.id, workspacePath, () =>
        requestHistoryRefreshStep(client, input)
      )
      if (result.status === 'ready') {
        // Retire snapshots taken before publication before reloading only this workspace.
        this.invalidateWorkspaceScans()
        const generation = this.workspaceScanGeneration
        const cancelled = () => this.disposed || generation !== this.workspaceScanGeneration
        const workspaces = await this.workspaceDescriptors([target], target, cancelled)
        const workspace = workspaces.find(
          value => sameWorkspacePath(value.workspacePath, workspacePath) && value.available
        )
        if (cancelled()) throw new WorkspaceScanCancelledError()
        if (!workspace) throw new Error('The refreshed workspace is no longer available')
        await this.hydratePersistedTasks([workspace], cancelled)
      }
      return result
    }
    if (method === 'runtime.plugins.request') {
      const { PLUGIN_RPC_METHODS, requiredPluginCapabilities } = await import('./gatewayPluginApi')
      const pluginMethod = text(params.method)
      if (!pluginMethod || !PLUGIN_RPC_METHODS.has(pluginMethod)) {
        throw new Error('Unsupported KCoder plugin operation')
      }
      const pluginTarget = await this.serverForParams(params)
      const pluginTargetScope = hookTargetScope(pluginTarget)
      const assertPluginScope = () => {
        if (this.disposed || !pluginAccountValid?.(pluginTarget.id))
          throw new GatewayRpcError('Plugin target or account changed', -32049, { kind: 'plugin_scope_changed' }, 'plugin-manage', 'remote')
      }
      assertPluginScope()
      const client = await this.commandClient(
        pluginTarget,
        text(params.workspacePath) ?? undefined
      )
      assertPluginScope()
      if (hookTargetScope(await this.serverForParams(params)) !== pluginTargetScope)
        throw new GatewayRpcError('Plugin connection scope changed', -32049, { kind: 'plugin_scope_changed' }, 'plugin-manage', 'remote')
      assertPluginScope()
      const capabilities = requiredPluginCapabilities(pluginMethod, record(params.params))
      if (capabilities.some(capability => !client.supportsExperimental?.(capability))) {
        throw new GatewayRpcError(
          'Target runtime upgrade required for directory trust, plugin network settings or Git refresh',
          -32000,
          { kind: 'plugin_update_required' }
        )
      }
      return client.request(pluginMethod, record(params.params))
    }
    if (method === 'runtime.tasks.list') {
      return this.taskListScans.read(server, params, {
        servers: await this.servers(),
        discover: (target, cancelled) => this.workspaceDescriptors([target], server, cancelled),
        hydrate: (workspace, cancelled) => this.hydratePersistedTasks([workspace], cancelled),
        disposed: () => this.disposed,
        project: workspaces => ({
          workspaces: workspaces.map(workspace => ({
            workspacePath: workspace.workspacePath,
            workspaceKind: workspace.workspaceKind,
            ...(workspace.worktreeId ? { worktreeId: workspace.worktreeId } : {}),
            label: workspace.label,
            labelKey: workspace.labelKey,
            deviceNameKey: workspace.server.labelKey,
            projectName: workspace.projectName,
            projectKey: workspace.projectKey,
            ...(workspace.projectSource ? { projectSource: workspace.projectSource } : {}),
            ...(workspace.projectRoots ? { projectRoots: workspace.projectRoots } : {}),
            projectActive: workspace.projectActive,
            projectPinned: workspace.projectPinned,
            ...(workspace.projectPinnedOrder !== undefined
              ? { projectPinnedOrder: workspace.projectPinnedOrder }
              : {}),
            ...(workspace.projectAppearance !== undefined
              ? { projectAppearance: workspace.projectAppearance }
              : {}),
            // Gateway targets belong to the local service surface even when their transport is
            // SSH. Marking them as cloud-style remote work would make upstream disconnected-cloud
            // filtering hide them; the KCoder service adapter preserves the explicit deviceId.
            workspaceSource: 'local',
            deviceId: workspace.server.id,
            deviceName: workspace.server.label,
            deviceStatus:
              workspace.server.status ??
              (workspace.server.transport === 'local' ? 'online' : 'offline'),
            available: workspace.available,
            threadsComplete: workspace.threadsComplete === true,
            threadListIssueCount: workspace.threadListIssueCount ?? 1,
            ...(workspace.threadListSyncFailed ? { threadListSyncFailed: true } : {}),
            ...(workspace.error ? { error: workspace.error } : {}),
            tasks: Array.from(this.tasks.values())
              .filter(task => !task.ephemeral)
              .filter(
                task =>
                  task.serverId === workspace.server.id &&
                  sameWorkspacePath(task.workspacePath, workspace.workspacePath)
              )
              .map(task => {
                const pinnedOrder = workspace.pinnedTaskIds.indexOf(task.threadId)
                return {
                  ...task,
                  ...(task.model || task.modelSelectionMode === 'follow_target_default'
                    ? {
                        modelSelection: {
                          modelName: task.modelSelectionMode === 'follow_target_default' ? '' : task.model!,
                          modelType: null,
                          options: {},
                        },
                      }
                    : {}),
                  pinned: pinnedOrder >= 0,
                  pinnedOrder: pinnedOrder >= 0 ? pinnedOrder : null,
                }
              }),
          })),
        }),
      })
    }
    if (method === 'runtime.keybindings.get') return { keybindings: readKeybindings() }
    if (method === 'runtime.keybindings.update') {
      return { keybindings: writeKeybindings(params.keybindings) }
    }
    if (isKCoderRuntimeMethod(method, 'instructionsRead')) {
      const target = await this.serverForParams(params)
      const client = await this.commandClient(target)
      const context = await this.sharedRuntimeContext(client)
      return { instructions: context.instructions, configPath: context.configPath }
    }
    if (isKCoderRuntimeMethod(method, 'instructionsWrite')) {
      const instructions = typeof params.instructions === 'string' ? params.instructions : ''
      if (instructions.length > 64 * 1024) throw new Error('自定义指令超过 64 KiB 限制')
      const target = await this.serverForParams(params)
      const client = await this.commandClient(target)
      const context = await client.request<SharedRuntimeContext>('runtime.context.update', {
        instructions,
      })
      clearLegacyKCoderContext()
      return { instructions: context.instructions, configPath: context.configPath }
    }
    if (isKCoderRuntimeMethod(method, 'personalityRead')) {
      const target = await this.serverForParams(params)
      const client = await this.commandClient(target)
      const context = await this.sharedRuntimeContext(client)
      return { personality: context.personality }
    }
    if (isKCoderRuntimeMethod(method, 'personalityWrite')) {
      if (params.personality !== 'friendly' && params.personality !== 'pragmatic') {
        throw new Error('不支持的 KCoder 个性')
      }
      const target = await this.serverForParams(params)
      const client = await this.commandClient(target)
      const context = await client.request<SharedRuntimeContext>('runtime.context.update', {
        personality: params.personality,
      })
      clearLegacyKCoderContext()
      return { personality: context.personality }
    }
    if (method === HOOK_CONFIGURATION_READ || method === HOOK_CONFIGURATION_UPDATE) {
      const target = await this.serverForParams(params)
      const assertScope = () => {
        if (this.disposed || requestGeneration !== this.workspaceScanGeneration || params.targetScope !== hookTargetScope(target))
          throw new GatewayRpcError('Hook configuration target or account changed', -32049, { kind: 'hook_config_scope_changed' })
      }
      assertScope()
      const client = await this.commandClient(target)
      assertScope()
      if (client.supportsExperimental?.(HOOK_CONFIGURATION_CAPABILITY) !== true)
        throw new GatewayRpcError('Target requires Hook configuration support', -32000, { kind: 'hook_config_unsupported' })
      return client.request(method === HOOK_CONFIGURATION_READ ? 'hooks/config/read' : 'hooks/config/update',
        method === HOOK_CONFIGURATION_READ ? {} : { hooks: params.hooks, expectedRevision: params.expectedRevision })
    }
    if (method === 'runtime.hooks.list' || method === 'runtime.hooks.reload') {
      throw new GatewayRpcError('Use target-scoped Hook configuration management', -32000, { kind: 'hook_config_unsupported' })
    }
    if (isKCoderRuntimeMethod(method, 'modelsList')) {
      const target = await this.serverForParams(params)
      const taskId = text(params.taskId)
      const task = taskId ? this.tasks.get(taskId) : undefined
      if (task && task.serverId !== target.id)
        throw new Error('Model catalog target does not match the conversation')
      const resident = taskId ? this.clientByTask.get(taskId) : undefined
      const client =
        resident ?? (await this.commandClient(target, text(params.workspacePath) ?? undefined))
      const catalog = await client.request<Record<string, unknown>>('runtime.models.list', {
        ...params,
        ...(resident && task ? { threadId: task.threadId } : {}),
      }, options)
      return scopedModelCatalog(catalog, target, client.supportsExperimental?.('modelSelectionModeV1') === true)
    }
    if (isKCoderRuntimeMethod(method, 'homeMigrationStatus')) {
      return {
        weworkCodexHome: '',
        nativeCodexHome: '',
        weworkCodexHomeExists: true,
        nativeCodexHomeExists: false,
        shouldPromptMigration: false,
      }
    }
    if (isKCoderRuntimeMethod(method, 'catalogCustomWrite')) {
      throw new Error('请通过 KCoder 运行目标设置管理模型目录，不支持旧版自定义模型目录写入')
    }
    if (isKCoderRuntimeMethod(method, 'appServerRestart')) return this.restartAppServers(params)
    if (method === 'device.execute_command') {
      return this.executeDeviceCommand(params, await this.serverForParams(params))
    }
    if (method === 'runtime.tasks.dispose') return this.disposeTemporaryTask(params)
    if (method === 'runtime.tasks.create') {
      return this.createTask(params, await this.serverForParams(params))
    }
    if (method === 'runtime.tasks.fork_at_turn') return this.forkTaskAtTurn(params)
    if (method === 'runtime.tasks.import_fork') {
      return {
        accepted: false,
        success: false,
        runtime: KCODER_RUNTIME_NAME,
        source: record(params.source),
        target: record(params.target),
        error: 'KCoder 客户端只支持同一服务器内按回合分叉，不支持导入外部运行时分叉包',
        code: 'unsupported_runtime_import',
      }
    }
    if (method === 'runtime.tasks.send' || method === 'runtime.tasks.interrupt_and_send') {
      const address = record(params.address)
      const taskId = this.resolveTaskId(text(params.taskId) ?? text(address.taskId))
      const task = taskId ? this.tasks.get(taskId) : undefined
      const target = (await this.servers()).find(item => item.id === task?.serverId) ?? server
      return this.sendTask(params, target, method === 'runtime.tasks.interrupt_and_send')
    }
    if (method === 'runtime.tasks.compact') return this.compactTask(params)
    if (method === 'runtime.tasks.rollback') return this.rollbackTask(params)
    if (method === 'runtime.tasks.revert_file_changes') return this.revertTaskFileChanges(params)
    if (method === 'runtime.tasks.guidance') return this.guideTask(params)
    if (method === 'runtime.tasks.agent_steer') return this.steerSubagent(params)
    if (method === 'runtime.tasks.agent_artifact_read') return this.readSubagentArtifact(params)
    if (method === 'runtime.session.modes') {
      const address = record(params.address)
      const descriptor = address.taskId ? await this.taskDescriptor(params) : null
      const server = descriptor?.server ?? (await this.serverForParams(params))
      const workspace =
        descriptor?.task.workspacePath ?? text(params.workspacePath) ?? server.workspacePath
      const inspect = async (client: GatewayClient) => {
        if (client.supportsExperimental?.('sessionModes') !== true) {
          throw new Error('目标 KCoder 不支持执行模式查询，请升级后重试')
        }
        return client.request(
          'session/modes',
          descriptor ? { threadId: descriptor.task.threadId } : {}
        )
      }
      return descriptor
        ? inspect(await this.readyTaskClient(descriptor.task))
        : this.withTransientClient(server, inspect, workspace)
    }
    if (method === 'runtime.tasks.goal.get') return this.getTaskGoal(params)
    if (method === 'runtime.tasks.goal.set') return this.setTaskGoal(params)
    if (method === 'runtime.tasks.goal.clear') return this.clearTaskGoal(params)
    if (method === 'runtime.tasks.cancel') return this.cancelTask(params)
    if (method === 'runtime.tasks.shorten_wait') return this.shortenWaitTask(params)
    if (method === 'runtime.tasks.rename') return this.renameTask(params)
    if (method === 'runtime.tasks.archive') return this.archiveTask(params)
    if (method === 'runtime.tasks.transcript') return this.loadTaskTranscript(params)
    if (method === 'runtime.tasks.search') return this.searchTasks(params)
    if (method === 'runtime.workspace.search') {
      const target = await this.serverForParams(params)
      const client = await this.commandClient(
        target,
        text(params.root) ?? text(params.workspacePath) ?? text(params.path) ?? undefined
      )
      return client.request(method, params)
    }
    if (method === 'runtime.archived_conversations.list') return this.listArchivedTasks(params)
    if (method === 'runtime.archived_conversations.unarchive') return this.unarchiveTask(params)
    if (method === 'runtime.archived_conversations.delete') return this.deleteArchivedTask(params)
    if (method === 'runtime.archived_conversations.delete_bulk') {
      return this.deleteArchivedTasksBulk(params)
    }
    if (method === 'runtime.archived_conversations.cleanup_preview') {
      return this.cleanupArchivedTasks(params, false)
    }
    if (method === 'runtime.archived_conversations.cleanup') {
      return this.cleanupArchivedTasks(params, true)
    }
    if (method === 'runtime.archived_conversations.archive_project') {
      return this.archiveProjectTasks(params)
    }
    if (method === 'runtime.archived_conversations.archive_all') {
      return this.archiveAllTasks()
    }
    if (
      method === 'runtime.worktrees.settings.get' ||
      method === 'runtime.worktrees.settings.update' ||
      method === 'runtime.worktrees.prepare' ||
      method === 'runtime.worktrees.list' ||
      method === 'runtime.worktrees.restore' ||
      method === 'runtime.worktrees.forget' ||
      method === 'runtime.worktrees.prune'
    ) {
      const target = await this.serverForParams(params)
      const client = await this.commandClient(target)
      return client.request(method, params)
    }
    if (method === 'runtime.worktrees.archive.preview') {
      const target = await this.serverForParams(params)
      const client = await this.commandClient(target)
      const workspacePath = text(params.path) ?? text(params.workspacePath)
      if (!workspacePath) throw new Error('工作树路径不能为空')
      if (!sameWorkspacePath(workspacePath, target.workspacePath)) {
        await this.closeCachedCommandClient(target, workspacePath)
      }
      await client.request('gateway/workspace/release', { workspacePath })
      return client.request(method, params)
    }
    if (method === 'runtime.worktrees.archive') {
      const target = await this.serverForParams(params)
      const client = await this.commandClient(target)
      const workspacePath = text(params.path) ?? text(params.workspacePath)
      const archivedConversations = workspacePath
        ? this.worktreeConversationReferences(target.id, workspacePath)
        : []
      return client.request(method, {
        ...params,
        ...(archivedConversations.length > 0 ? { archivedConversations } : {}),
      })
    }
    if (method === 'runtime.worktrees.delete') {
      const target = await this.serverForParams(params)
      const client = await this.commandClient(target)
      const workspacePath = text(params.path) ?? text(params.workspacePath)
      const archivedConversations = workspacePath
        ? this.worktreeConversationReferences(target.id, workspacePath)
        : []
      return client.request(method, {
        ...params,
        ...(archivedConversations.length > 0 ? { archivedConversations } : {}),
      })
    }
    if (method === 'runtime.sidebar.tasks.pin') {
      const target = await this.serverForParams(params)
      const threadId = text(params.threadId)
      const taskId = threadId
        ? this.taskByThread.get(this.threadKey(target.id, threadId))
        : undefined
      // A command socket must not mutate a thread owned by the task socket.
      const owner = taskId ? this.clientByTask.get(taskId) : undefined
      const client = owner ?? (await this.commandClient(target))
      return client.request(method, params)
    }
    if (
      method === 'runtime.workspaces.open' ||
      method === 'runtime.workspaces.prepare' ||
      method === 'runtime.workspaces.delete' ||
      method === 'runtime.projects.upsert_local' ||
      method === 'runtime.workspaces.rename' ||
      method === 'runtime.workspaces.remove' ||
      method === 'runtime.sidebar.projects.reorder' ||
      method === 'runtime.sidebar.projects.appearance' ||
      method === 'runtime.sidebar.projects.sync_remote' ||
      method === 'runtime.sidebar.tasks.reorder'
    ) {
      const target = await this.serverForParams(params)
      const client = await this.commandClient(target)
      return client.request(method, params)
    }
    if (method === 'runtime.sidebar.projects.pin') {
      const target = await this.serverForParams(params)
      const client = await this.commandClient(target)
      const synthetic = text(params.projectKey) === runtimeProjectKey(target.id)
      if (params.rootProject !== undefined)
        throw new Error('Root project routing is owned by the gateway')
      if (synthetic && client.supportsExperimental?.('sidebarRootPinning') !== true) {
        throw new Error('Upgrade the target KCoder to change root project pinning')
      }
      return client.request(
        method,
        synthetic ? { ...params, projectKey: target.workspacePath, rootProject: true } : params
      )
    }
    if (method === 'runtime_tasks.context') return {}
    if (method === 'projects.list') return []
    if (method === 'runtime.sidebar.projects.activate') {
      // Wework stores remote-project sidebar state on the local state device, so activation may
      // carry deviceId=local even when its workspace belongs to another gateway target. Resolve
      // the concrete workspace/project first and only fall back to that state-owner device id.
      const target = await this.serverForParams(
        text(params.workspacePath) || text(params.projectKey)
          ? Object.fromEntries(
              Object.entries(params).filter(([key]) => key !== 'deviceId' && key !== 'device_id')
            )
          : params
      )
      const previousControl = this.controlClientPromise
      this.controlClientPromise = null
      if (this.selectedServer !== target) this.invalidateWorkspaceScans()
      this.selectedServer = target
      localStorage.setItem(SELECTED_SERVER_KEY, target.id)
      void previousControl?.then(client => client.close())
      const client = await this.commandClient(target)
      return client.request(method, { ...params, deviceId: target.id })
    }
    throw new Error(`KCoder 网关尚未实现运行时方法：${method}`)
  }

  private async executeDeviceCommand(params: Record<string, unknown>, server: GatewayServer) {
    const command = text(params.command_key)
    if (command === 'runtime_auth_status') {
      return { success: true, exit_code: 0, stdout: { exists: false }, stderr: '' }
    }
    if (command === 'project_workspace_root') {
      return { success: true, exit_code: 0, stdout: `${server.workspacePath ?? '/'}\n`, stderr: '' }
    }
    if (
      command === 'home_dir' ||
      command === 'ls_dirs' ||
      command === 'mkdir_p' ||
      command === 'workspace_tree' ||
      command === 'workspace_read_text_file' ||
      command === 'workspace_read_file_chunk' ||
      command === 'workspace_write_text_file' ||
      command === 'workspace_create_text_file' ||
      command === 'workspace_create_directory' ||
      command === 'workspace_rename_entry' ||
      command === 'workspace_delete_entry'
    ) {
      const client = await this.commandClient(
        server,
        text(params.path) ?? text(params.cwd) ?? text(params.workspacePath) ?? undefined
      )
      if (client.supportsExperimental?.('workspaceFiles') === false) {
        throw new Error('KCoder app-server 不支持工作区文件访问')
      }
      return client.request('device/execute', params)
    }
    if (command === 'turn_file_changes_review') {
      const { task, client } = await this.taskConnection(params)
      return client.request('device/execute', { ...params, threadId: task.threadId })
    }
    if (command === 'ls_skills') {
      const client = await this.commandClient(server)
      return client.request('device/execute', params)
    }
    if (
      command === 'git_is_worktree' ||
      command === 'git_branch' ||
      command === 'git_branch_diff' ||
      command === 'git_branch_diff_shortstat' ||
      command === 'git_diff_unstaged' ||
      command === 'git_diff_staged' ||
      command === 'git_diff_last_commit' ||
      command === 'git_status_porcelain' ||
      command === 'git_remote_url' ||
      command === 'git_branch_list' ||
      command === 'git_add_all' ||
      command === 'git_commit' ||
      command === 'git_commit_all' ||
      command === 'git_push' ||
      command === 'git_checkout' ||
      command === 'git_checkout_new' ||
      command === 'git_generate_commit_message'
    ) {
      const client = await this.commandClient(
        server,
        text(params.path) ?? text(params.cwd) ?? text(params.workspacePath) ?? undefined
      )
      return client.request('device/execute', params)
    }
    throw new Error(`KCoder app-server does not implement device command: ${command ?? 'unknown'}`)
  }

  private persistLocalTaskMetadata(key: string, metadata: GatewayTaskMetadata) {
    const next = new Map(this.taskMetadata)
    next.set(key, metadata)
    const retained = [...next.entries()]
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, MAX_TASK_METADATA_ENTRIES)
    localStorage.setItem(TASK_METADATA_KEY, JSON.stringify(Object.fromEntries(retained)))
    this.taskMetadata.clear()
    for (const [entryKey, entry] of retained) this.taskMetadata.set(entryKey, entry)
  }

  private async updateTaskMetadata(
    task: GatewayTask,
    patch: GatewayThreadMetadataPatch,
    metadata: GatewayTaskMetadata
  ) {
    if (task.ephemeral) return
    const server = (await this.servers()).find(item => item.id === task.serverId)
    if (!server) throw new Error(`任务服务器已不存在：${task.serverId}`)
    const remotePatch: GatewayThreadMetadataPatch = patch
    if (Object.keys(remotePatch).length > 0) {
      const update = (client: GatewayClient) =>
        client.request('thread/metadata/update', { threadId: task.threadId, ...remotePatch })
      const activeClient = this.clientByTask.get(task.taskId)
      if (activeClient) await update(activeClient)
      else {
        await this.withTransientClient(server, update, task.workspacePath)
      }
    }
    this.persistLocalTaskMetadata(this.threadKey(task.serverId, task.threadId), metadata)
  }

  private async storedTask(params: Record<string, unknown>) {
    const address = record(params.address)
    const requestedTaskId = text(params.taskId) ?? text(address.taskId)
    let taskId = this.resolveTaskId(requestedTaskId)
    let task = taskId ? (this.tasks.get(taskId) ?? this.archivedTasks.get(taskId)) : undefined
    if (!task && isRuntimeTaskId(requestedTaskId)) {
      await this.hydrateAllPersistedTasks()
      taskId = this.resolveTaskId(requestedTaskId)
      task = taskId ? (this.tasks.get(taskId) ?? this.archivedTasks.get(taskId)) : undefined
    }
    if (!taskId || !task) throw new Error('任务地址不存在或尚未恢复')
    return { taskId, task }
  }

  private async renameTask(params: Record<string, unknown>) {
    const { taskId, task } = await this.storedTask(params)
    const title = text(params.title)
    if (!title) throw new Error('任务标题不能为空')
    const normalizedTitle = title.slice(0, 200)
    const updatedAt = Date.now()
    const nextTask = { ...task, title: normalizedTitle, updatedAt }
    await this.updateTaskMetadata(
      task,
      { title: normalizedTitle },
      {
        ...this.taskMetadata.get(this.threadKey(task.serverId, task.threadId)),
        title: normalizedTitle,
        updatedAt,
      }
    )
    if (this.tasks.has(taskId)) this.tasks.set(taskId, nextTask)
    if (this.archivedTasks.has(taskId)) this.archivedTasks.set(taskId, nextTask)
    return { accepted: true, taskId, workspacePath: task.workspacePath }
  }

  private async archiveTask(params: Record<string, unknown>) {
    const { taskId, task: resolvedTask } = await this.storedTask(params)
    // Share hydration's queue so a pre-mutation list response cannot undo the archive projection.
    return this.withWorkspaceOperation(
      resolvedTask.serverId,
      resolvedTask.workspacePath,
      async () => {
        const task = this.tasks.get(taskId) ?? this.archivedTasks.get(taskId)
        if (!task) throw new Error('任务地址不存在或尚未恢复')
        if (this.activeTurnByTask.has(taskId)) {
          throw new Error('任务运行中，暂时无法归档')
        }
        if (this.archivedTasks.has(taskId)) {
          return { accepted: true, taskId, workspacePath: task.workspacePath }
        }
        const updatedAt = Date.now()
        await this.updateTaskMetadata(
          task,
          { archivedAt: new Date(updatedAt).toISOString() },
          {
            ...this.taskMetadata.get(this.threadKey(task.serverId, task.threadId)),
            title: task.title,
            archivedAt: updatedAt,
            updatedAt,
          }
        )
        const taskClient = this.clientByTask.get(taskId)
        this.clientByTask.delete(taskId)
        taskClient?.close()
        this.tasks.delete(taskId)
        this.archivedTasks.set(taskId, { ...task, running: false, updatedAt })
        return { accepted: true, taskId, workspacePath: task.workspacePath }
      }
    )
  }

  private async listArchivedTasks(params: Record<string, unknown>) {
    const servers = await this.servers()
    await this.hydratePersistedTasks(await this.workspaceDescriptors(servers, await this.server()))
    await this.hydrateArchivedWorktreeTasks(servers)
    const serverById = new Map(servers.map(server => [server.id, server]))
    const requestedDeviceId = text(params.deviceId)
    const requestedWorkspace = text(params.workspacePath)
    const requestedProjectKey = text(params.runtimeProjectKey)
    const requestedServerFromProject = serverIdFromRuntimeProjectKey(requestedProjectKey)
    const search = (text(params.search) ?? '').toLocaleLowerCase()
    const items = [...this.archivedTasks.values()]
      .filter(task => !requestedDeviceId || task.serverId === requestedDeviceId)
      .filter(task => !requestedServerFromProject || task.serverId === requestedServerFromProject)
      .filter(
        task => !requestedWorkspace || sameWorkspacePath(task.workspacePath, requestedWorkspace)
      )
      .filter(
        task =>
          !search || `${task.title}\n${task.workspacePath}`.toLocaleLowerCase().includes(search)
      )
      .map(task => {
        const server = serverById.get(task.serverId)
        return {
          id: this.threadKey(task.serverId, task.threadId),
          taskId: task.taskId,
          threadId: task.threadId,
          title: task.title,
          projectKey: task.projectKey ?? runtimeProjectKey(task.serverId),
          projectName: task.projectName ?? server?.label ?? task.serverId,
          workspacePath: task.workspacePath,
          workspaceKind: 'workspace',
          runtimeHandle: task.runtimeHandle,
          deviceId: task.serverId,
          deviceName: server?.label ?? task.serverId,
          source: 'local' as const,
          runtime: task.runtime,
          createdAt: new Date(task.createdAt).toISOString(),
          updatedAt: new Date(task.updatedAt).toISOString(),
        }
      })
    if (params.sort === 'alphabetical') {
      items.sort((left, right) => left.title.localeCompare(right.title))
    } else if (params.sort === 'created') {
      items.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    } else {
      items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    }
    const groups = new Map<string, { projectKey: string; projectName: string; count: number }>()
    for (const item of items) {
      const existing = groups.get(item.projectKey)
      if (existing) existing.count += 1
      else {
        groups.set(item.projectKey, {
          projectKey: item.projectKey,
          projectName: item.projectName,
          count: 1,
        })
      }
    }
    return { items, projectGroups: [...groups.values()], total: items.length }
  }

  private async unarchiveTask(params: Record<string, unknown>) {
    const { taskId, task: resolvedTask } = await this.storedTask(params)
    return this.withWorkspaceOperation(
      resolvedTask.serverId,
      resolvedTask.workspacePath,
      async () => {
        const task = this.archivedTasks.get(taskId) ?? this.tasks.get(taskId)
        if (!task) throw new Error('任务地址不存在或尚未恢复')
        if (!this.archivedTasks.has(taskId)) {
          return { accepted: true, taskId, workspacePath: task.workspacePath }
        }
        const key = this.threadKey(task.serverId, task.threadId)
        const previous = this.taskMetadata.get(key)
        const updatedAt = Date.now()
        await this.restoreArchivedTaskWorkspace(task)
        await this.updateTaskMetadata(
          task,
          { archivedAt: null },
          {
            ...(previous?.title ? { title: previous.title } : {}),
            ...(previous?.deletedAt ? { deletedAt: previous.deletedAt } : {}),
            updatedAt,
          }
        )
        await this.removeArchivedWorktreeConversation(task)
        this.archivedTasks.delete(taskId)
        this.tasks.set(taskId, { ...task, updatedAt })
        this.threadByTask.set(taskId, task.threadId)
        this.taskByThread.set(key, taskId)
        return { accepted: true, taskId, workspacePath: task.workspacePath }
      }
    )
  }

  private async deleteArchivedTask(params: Record<string, unknown>) {
    const { taskId, task } = await this.storedTask(params)
    if (!this.archivedTasks.has(taskId)) throw new Error('只能永久删除已归档任务')
    const server = (await this.servers()).find(item => item.id === task.serverId)
    if (!server) throw new Error(`任务服务器已不存在：${task.serverId}`)
    return this.withWorkspaceOperation(task.serverId, task.workspacePath, async () => {
      await this.restoreArchivedTaskWorkspace(task)
      await this.removeArchivedWorktreeConversation(task)
      const result = await this.withTransientClient(
        server,
        client =>
          client.request<{ deleted?: boolean }>('thread/delete', {
            threadId: task.threadId,
          }),
        task.workspacePath
      )
      if (result.deleted !== true) throw new Error('KCoder app-server 未确认删除历史会话')
      const key = this.threadKey(task.serverId, task.threadId)
      const updatedAt = Date.now()
      this.persistLocalTaskMetadata(key, {
        ...this.taskMetadata.get(key),
        title: task.title,
        archivedAt: this.taskMetadata.get(key)?.archivedAt ?? updatedAt,
        deletedAt: updatedAt,
        updatedAt,
      })
      this.archivedTasks.delete(taskId)
      this.tasks.delete(taskId)
      this.threadByTask.delete(taskId)
      this.taskByThread.delete(key)
      return { accepted: true, deleted: true, taskId, workspacePath: task.workspacePath }
    })
  }

  private async deleteArchivedTasksBulk(params: Record<string, unknown>) {
    const items = Array.isArray(params.items) ? params.items : []
    const results: Array<Record<string, unknown>> = []
    let acceptedCount = 0
    for (const item of items) {
      try {
        const result = (await this.deleteArchivedTask(record(item))) as Record<string, unknown>
        results.push(result)
        acceptedCount += 1
      } catch (error) {
        results.push({
          accepted: false,
          taskId: text(record(item).taskId),
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return {
      accepted: acceptedCount === items.length,
      requestedCount: items.length,
      acceptedCount,
      deletedCount: acceptedCount,
      results,
    }
  }

  private async cleanupArchivedTasks(params: Record<string, unknown>, deleteTargets: boolean) {
    await this.hydrateAllPersistedTasks()
    const addresses = Array.isArray(params.items) ? params.items.map(record) : []
    const results: Array<Record<string, unknown>> = []
    for (const address of addresses) {
      const requestedTaskId = text(address.taskId)
      const taskId = this.resolveTaskId(requestedTaskId)
      const task = taskId ? this.archivedTasks.get(taskId) : undefined
      if (!taskId || !task) {
        results.push({
          taskId: requestedTaskId ?? '',
          workspacePath: text(address.workspacePath) ?? '',
          targetCount: 0,
          cleanableCount: 0,
          skippedCount: 0,
          errorCount: 1,
          bytes: 0,
          items: [],
          error: '已归档任务不存在',
        })
        continue
      }
      const server = (await this.servers()).find(item => item.id === task.serverId)
      if (!server) {
        results.push({
          taskId,
          workspacePath: task.workspacePath,
          targetCount: 0,
          cleanableCount: 0,
          skippedCount: 0,
          errorCount: 1,
          bytes: 0,
          items: [],
          error: `任务服务器已不存在：${task.serverId}`,
        })
        continue
      }
      try {
        const client = await this.commandClient(server)
        const listed = await client.request<{ items?: Array<Record<string, unknown>> }>(
          'runtime.worktrees.list',
          { deviceId: server.id, measureBytes: !deleteTargets }
        )
        const managed = (Array.isArray(listed.items) ? listed.items : [])
          .map(record)
          .find(item => sameWorkspacePath(text(item.path), task.workspacePath))
        if (!managed) {
          results.push({
            taskId,
            workspacePath: task.workspacePath,
            targetCount: 0,
            cleanableCount: 0,
            skippedCount: 0,
            errorCount: 0,
            bytes: 0,
            items: [],
          })
          continue
        }
        const measuredBytes = deleteTargets ? 0 : Math.max(0, Number(managed.bytes) || 0)
        let status = 'preview'
        let error: string | null = null
        if (deleteTargets) {
          try {
            await client.request('gateway/workspace/release', { workspacePath: task.workspacePath })
            const previewResult = await client.request<{ preview?: Record<string, unknown> }>(
              'runtime.worktrees.archive.preview',
              {
                deviceId: server.id,
                path: task.workspacePath,
              }
            )
            const preview = record(previewResult.preview)
            if (preview.archiveAllowed !== true || preview.requiresConfirmation === true) {
              throw new Error('工作树包含需要人工确认的内容，已跳过自动清理')
            }
            const revision = Number(preview.revision)
            const contentToken = text(preview.contentToken)
            if (!Number.isSafeInteger(revision) || !contentToken) {
              throw new Error('工作树归档预检结果无效')
            }
            await client.request('runtime.worktrees.archive', {
              deviceId: server.id,
              path: task.workspacePath,
              expectedRevision: revision,
              expectedContentToken: contentToken,
              riskAccepted: false,
              archivedConversations: this.worktreeConversationReferences(
                server.id,
                task.workspacePath
              ),
            })
            status = 'cleaned'
          } catch (cleanupError) {
            status = 'failed'
            error = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }
        }
        results.push({
          taskId,
          workspacePath: task.workspacePath,
          targetCount: 1,
          cleanableCount: error ? 0 : 1,
          skippedCount: 0,
          errorCount: error ? 1 : 0,
          bytes: measuredBytes,
          items: [
            {
              kind: 'worktree',
              path: task.workspacePath,
              exists: managed.state === 'active',
              bytes: measuredBytes,
              status,
              ...(error ? { error } : {}),
            },
          ],
          ...(error ? { error } : {}),
        })
      } catch (cleanupError) {
        results.push({
          taskId,
          workspacePath: task.workspacePath,
          targetCount: 0,
          cleanableCount: 0,
          skippedCount: 0,
          errorCount: 1,
          bytes: 0,
          items: [],
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        })
      }
    }
    const sum = (key: string) =>
      results.reduce((total, result) => total + Number(result[key] ?? 0), 0)
    return {
      success: results.every(result => Number(result.errorCount ?? 0) === 0),
      deleted: deleteTargets,
      taskCount: results.length,
      targetCount: sum('targetCount'),
      cleanableCount: sum('cleanableCount'),
      skippedCount: sum('skippedCount'),
      errorCount: sum('errorCount'),
      bytes: sum('bytes'),
      results,
    }
  }

  private async archiveMatchingTasks(predicate: (task: GatewayTask) => boolean) {
    const candidates = [...this.tasks.values()].filter(task => !task.ephemeral && predicate(task))
    const results: Array<Record<string, unknown>> = []
    let acceptedCount = 0
    for (const task of candidates) {
      try {
        const result = (await this.archiveTask({ taskId: task.taskId })) as Record<string, unknown>
        results.push(result)
        acceptedCount += 1
      } catch (error) {
        results.push({
          accepted: false,
          taskId: task.taskId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return {
      accepted: acceptedCount === candidates.length,
      requestedCount: candidates.length,
      acceptedCount,
      results,
    }
  }

  private async archiveProjectTasks(params: Record<string, unknown>) {
    await this.hydrateAllPersistedTasks()
    const projectKey = text(params.runtimeProjectKey)
    const serverId = serverIdFromRuntimeProjectKey(projectKey) ?? text(params.deviceId)
    const workspacePath = text(params.workspacePath)
    if (!serverId && !workspacePath) throw new Error('归档项目缺少 KCoder 服务器或工作区')
    return this.archiveMatchingTasks(
      task =>
        (!serverId || task.serverId === serverId) &&
        (!workspacePath || sameWorkspacePath(task.workspacePath, workspacePath))
    )
  }

  private async archiveAllTasks() {
    await this.hydrateAllPersistedTasks()
    return this.archiveMatchingTasks(() => true)
  }

  private async searchTasks(params: Record<string, unknown>) {
    const query = (text(params.query) ?? '').toLocaleLowerCase()
    if (!query) return { items: [] }
    await this.hydrateAllPersistedTasks()
    const limitValue = typeof params.limit === 'number' ? Math.trunc(params.limit) : 20
    const limit = Math.min(Math.max(limitValue, 1), 100)
    const servers = new Map((await this.servers()).map(server => [server.id, server]))
    const requestedDeviceId = text(params.deviceId)
    const requestedWorkspace = text(params.workspacePath)
    const candidates = [
      ...this.tasks.values(),
      ...(params.includeArchived === true ? this.archivedTasks.values() : []),
    ]
      .filter(task => !task.ephemeral)
      .filter(task => !requestedDeviceId || task.serverId === requestedDeviceId)
      .filter(
        task => !requestedWorkspace || sameWorkspacePath(task.workspacePath, requestedWorkspace)
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)
    const items: Array<Record<string, unknown>> = []
    const clients = new Map<string, GatewayClient>()
    try {
      for (const task of candidates) {
        if (items.length >= limit) break
        const titleMatch = task.title.toLocaleLowerCase().indexOf(query)
        let snippet = titleMatch >= 0 ? task.title : null
        let matchStart = titleMatch
        let transcriptMatch: Awaited<ReturnType<KCoderGatewayRuntime['searchTaskTranscript']>> =
          null
        if (snippet === null) {
          try {
            const server = servers.get(task.serverId)
            if (!server) continue
            const clientKey = `${task.serverId}\0${workspacePathKey(task.workspacePath)}`
            let client = clients.get(clientKey)
            if (!client) {
              client = await this.connectClient(server, 'runtime', task.workspacePath)
              clients.set(clientKey, client)
            }
            transcriptMatch = await this.searchTaskTranscript(client, task, query)
            if (!transcriptMatch) continue
            snippet = transcriptMatch.snippet
            matchStart = transcriptMatch.matchStart
          } catch (error) {
            console.warn(`[KCoder] 无法搜索任务 当前任务 的 transcript`, safeGatewayFailureDiagnostic(error))
            continue
          }
        }
        items.push({
          address: {
            deviceId: task.serverId,
            taskId: task.taskId,
            threadId: task.threadId,
            workspacePath: task.workspacePath,
          },
          runtime: task.runtime,
          title: task.title,
          snippet,
          matchStart,
          matchEnd: matchStart + query.length,
          ...(transcriptMatch
            ? {
                messageId: transcriptMatch.messageId,
                messageRole: transcriptMatch.messageRole,
                messageCreatedAt: transcriptMatch.messageCreatedAt,
              }
            : {}),
          updatedAt: new Date(task.updatedAt).toISOString(),
          deviceName: servers.get(task.serverId)?.label ?? task.serverId,
          workspacePath: task.workspacePath,
          archived: this.archivedTasks.has(task.taskId),
          project: null,
        })
      }
    } finally {
      for (const client of clients.values()) client.close()
    }
    return { success: true, items }
  }

  private async searchTaskTranscript(
    client: GatewayClient,
    task: GatewayTask,
    query: string
  ): Promise<{
    snippet: string
    matchStart: number
    messageId: string | null
    messageRole: string | null
    messageCreatedAt: string | null
  } | null> {
    let beforeCursor: string | null = null
    let pages = 0
    const transcriptMessages: Array<Record<string, unknown>> = []
    // A cursor can be invalidated between two pages (compaction or rollback).
    // The server answers TRANSCRIPT_CURSOR_STALE (-32041), and the only safe
    // recovery is to restart from an authoritative cursor-less snapshot: pages
    // are never reordered or merged by timestamp.
    let restartAllowed = true
    for (;;) {
      let requestedCursor: string | null = beforeCursor
      try {
        do {
          requestedCursor = beforeCursor
          const result: {
            messages?: Array<Record<string, unknown>>
            hasMoreBefore?: boolean
            beforeCursor?: string | null
          } = await client.request('thread/read', {
            threadId: task.threadId,
            limit: 100,
            ...(beforeCursor ? { beforeCursor } : {}),
          })
          const messages = Array.isArray(result.messages) ? result.messages : []
          transcriptMessages.unshift(...messages)
          pages += 1
          beforeCursor = result.hasMoreBefore === true ? text(result.beforeCursor) : null
        } while (beforeCursor && pages < 5)
        break
      } catch (error) {
        if (
          !restartAllowed ||
          !requestedCursor ||
          !(error instanceof GatewayRpcError && error.code === -32041)
        )
          throw error
        // Exactly one restart: a cursor that keeps going stale must surface
        // instead of spinning.
        restartAllowed = false
        beforeCursor = null
        pages = 0
        transcriptMessages.length = 0
      }
    }
    for (const rawMessage of transcriptMessages) {
      const rawContent = text(record(rawMessage).content) ?? ''
      const content =
        text(record(rawMessage).role) === 'user'
          ? visibleRuntimeUserMessage(rawContent)
          : rawContent
      const found = content.toLocaleLowerCase().indexOf(query)
      if (found < 0) continue
      const start = Math.max(0, found - 60)
      const end = Math.min(content.length, found + query.length + 100)
      const prefix = start > 0 ? '…' : ''
      const suffix = end < content.length ? '…' : ''
      return {
        snippet: `${prefix}${content.slice(start, end)}${suffix}`,
        matchStart: prefix.length + found - start,
        messageId: text(record(rawMessage).id),
        messageRole: text(record(rawMessage).role),
        messageCreatedAt:
          typeof record(rawMessage).timestampMs === 'number'
            ? new Date(Number(record(rawMessage).timestampMs)).toISOString()
            : null,
      }
    }
    return null
  }

  private async hydrateAllPersistedTasks(): Promise<void> {
    const servers = await this.servers()
    await this.hydratePersistedTasks(await this.workspaceDescriptors(servers, await this.server()))
    await this.hydrateArchivedWorktreeTasks(servers)
  }

  private async managedWorktrees(server: GatewayServer): Promise<Array<Record<string, unknown>>> {
    const client = await this.commandClient(server)
    const result = await client.request<{ items?: Array<Record<string, unknown>> }>(
      'runtime.worktrees.list',
      { deviceId: server.id }
    )
    return Array.isArray(result.items) ? result.items.map(record) : []
  }

  private async hydrateArchivedWorktreeTasks(servers: GatewayServer[]): Promise<void> {
    for (const server of servers) {
      let worktrees: Array<Record<string, unknown>>
      try {
        worktrees = await this.managedWorktrees(server)
      } catch (error) {
        if (!this.disposed) {
          console.warn(`[KCoder] 无法读取 目标 的工作树归档索引`, safeGatewayFailureDiagnostic(error))
        }
        continue
      }
      for (const worktree of worktrees) {
        const conversations = Array.isArray(worktree.conversations)
          ? worktree.conversations.map(record)
          : []
        for (const conversation of conversations) {
          const threadId = text(conversation.threadId)
          const taskId =
            text(conversation.taskId) ?? (threadId ? runtimeTaskId(server, threadId) : null)
          const workspacePath =
            text(conversation.workspacePath) ?? text(worktree.path) ?? server.workspacePath
          if (!threadId || !taskId || !workspacePath || this.tasks.has(taskId)) continue
          const now = Date.now()
          const createdAt = Number(conversation.createdAt)
          const updatedAt = Number(conversation.updatedAt)
          const task: GatewayTask = {
            serverId: server.id,
            taskId,
            threadId,
            workspacePath,
            ...(text(conversation.projectKey)
              ? { projectKey: text(conversation.projectKey)! }
              : {}),
            ...(text(conversation.projectName)
              ? { projectName: text(conversation.projectName)! }
              : {}),
            title: text(conversation.title) ?? `KCoder 会话 ${threadId.slice(0, 8)}`,
            runtime: 'kcoder',
            ...(text(conversation.model) ? { model: text(conversation.model)! } : {}),
            persisted: true,
            running: false,
            createdAt: Number.isFinite(createdAt) ? createdAt : now,
            updatedAt: Number.isFinite(updatedAt) ? updatedAt : now,
            runtimeHandle: { threadId },
          }
          this.archivedTasks.set(taskId, task)
          this.threadByTask.set(taskId, threadId)
          this.taskByThread.set(this.threadKey(server.id, threadId), taskId)
        }
      }
    }
  }

  private async restoreArchivedTaskWorkspace(task: GatewayTask): Promise<void> {
    const server = (await this.servers()).find(item => item.id === task.serverId)
    if (!server) throw new Error(`任务服务器已不存在：${task.serverId}`)
    const worktree = (await this.managedWorktrees(server)).find(item =>
      sameWorkspacePath(text(item.path), task.workspacePath)
    )
    if (!worktree || worktree.state === 'active') return
    if (worktree.state !== 'restorable') {
      throw new Error(`任务工作树不可恢复：${task.workspacePath}`)
    }
    const revision = Number(worktree.revision)
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error(`任务工作树缺少有效版本：${task.workspacePath}`)
    }
    const client = await this.commandClient(server)
    await client.request('runtime.worktrees.restore', {
      deviceId: server.id,
      path: task.workspacePath,
      expectedRevision: revision,
    })
  }

  private async removeArchivedWorktreeConversation(task: GatewayTask): Promise<void> {
    const server = (await this.servers()).find(item => item.id === task.serverId)
    if (!server) throw new Error(`任务服务器已不存在：${task.serverId}`)
    const worktree = (await this.managedWorktrees(server)).find(item =>
      sameWorkspacePath(text(item.path), task.workspacePath)
    )
    if (!worktree) return
    const client = await this.commandClient(server)
    await client.request('runtime.worktrees.conversations.remove', {
      deviceId: server.id,
      path: task.workspacePath,
      taskId: task.taskId,
    })
  }

  private worktreeConversationReferences(
    serverId: string,
    workspacePath: string
  ): Array<Record<string, unknown>> {
    const conversations = new Map<string, GatewayTask>()
    for (const task of [...this.tasks.values(), ...this.archivedTasks.values()]) {
      if (task.serverId === serverId && sameWorkspacePath(task.workspacePath, workspacePath)) {
        conversations.set(task.taskId, task)
      }
    }
    return [...conversations.values()].map(task => ({
      deviceId: task.serverId,
      taskId: task.taskId,
      threadId: task.threadId,
      workspacePath: task.workspacePath,
      title: task.title,
      model: task.model ?? null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    }))
  }

  private async linkManagedWorktreeConversation(
    server: GatewayServer,
    task: GatewayTask
  ): Promise<void> {
    if (sameWorkspacePath(task.workspacePath, server.workspacePath)) return
    const worktree = (await this.managedWorktrees(server)).find(item =>
      sameWorkspacePath(text(item.path), task.workspacePath)
    )
    if (!worktree) return
    const client = await this.commandClient(server)
    await client.request('runtime.worktrees.conversations.link', {
      deviceId: server.id,
      path: task.workspacePath,
      conversation: {
        deviceId: task.serverId,
        taskId: task.taskId,
        threadId: task.threadId,
        workspacePath: task.workspacePath,
        ...(task.projectKey ? { projectKey: task.projectKey } : {}),
        ...(task.projectName ? { projectName: task.projectName } : {}),
        title: task.title,
        model: task.model ?? null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
    })
  }

  private async hydratePersistedTasks(
    workspaces: GatewayWorkspaceDescriptor[],
    scanCancelled: () => boolean = () => false
  ): Promise<void> {
    const generation = this.workspaceScanGeneration
    const cancelled = () =>
      this.disposed || generation !== this.workspaceScanGeneration || scanCancelled()
    const ordered = [...workspaces].sort(
      (a, b) => Number(b.projectActive) - Number(a.projectActive)
    )
    await scanWorkspaces(
      ordered,
      async workspace => {
        workspace.threadsComplete = false
        workspace.threadListIssueCount = 1
        workspace.threadListSyncFailed = false
        if (!workspace.available || workspace.server.status === 'offline') return
        const { server, workspacePath } = workspace
        try {
          await this.withWorkspaceOperation(server.id, workspacePath, () =>
            cancelled()
              ? Promise.resolve()
              : this.withTransientClient(
                  server,
                  async client => {
                    if (client.supportsThreadResume?.() !== true) return
                    const persistedThreads: Array<Record<string, unknown>> = []
                    const allowPartial =
                      client.supportsExperimental?.('threadListCompleteness') === true
                    let threadsComplete = true
                    const archiveModes: Array<boolean | undefined> = [undefined]
                    for (const archived of archiveModes) {
                      let cursor: string | null = null
                      let snapshotMetadata:
                        { completeness: 'complete' | 'partial'; issueCount: number } | undefined
                      const seenCursors = new Set<string>()
                      do {
                        const result = await client.request<{
                          threads?: Array<Record<string, unknown>>
                          nextCursor?: string | null
                          completeness?: 'complete' | 'partial'
                          issueCount?: number
                        }>('thread/list', {
                          limit: 100,
                          ...(allowPartial ? { allowPartial: true } : {}),
                          ...(archived === undefined ? {} : { archived }),
                          ...(cursor ? { cursor } : {}),
                        })
                        if (cancelled()) return
                        if (!Array.isArray(result.threads)) {
                          throw new Error('运行目标返回了无效的 thread/list 结果')
                        }
                        if (
                          allowPartial &&
                          (!['complete', 'partial'].includes(result.completeness ?? '') ||
                            !Number.isSafeInteger(result.issueCount) ||
                            result.issueCount! < 0 ||
                            (result.completeness === 'complete' && result.issueCount !== 0))
                        )
                          throw new Error('运行目标返回了无效的 thread/list 完整性状态')
                        if (allowPartial) {
                          if (
                            snapshotMetadata &&
                            (snapshotMetadata.completeness !== result.completeness ||
                              snapshotMetadata.issueCount !== result.issueCount)
                          )
                            throw new Error('运行目标的 thread/list 快照完整性在分页期间发生变化')
                          snapshotMetadata ??= {
                            completeness: result.completeness!,
                            issueCount: result.issueCount!,
                          }
                        }
                        threadsComplete = result.completeness !== 'partial'
                        workspace.threadListIssueCount = result.issueCount ?? 0
                        persistedThreads.push(...result.threads)
                        const nextCursor = text(result.nextCursor)
                        if (!nextCursor) {
                          cursor = null
                          break
                        }
                        if (seenCursors.has(nextCursor)) {
                          throw new Error('运行目标返回了重复的 thread/list cursor')
                        }
                        seenCursors.add(nextCursor)
                        cursor = nextCursor
                      } while (persistedThreads.length <= 10_000)
                      if (cursor) throw new Error('运行目标的持久任务数量超过 10000')
                    }
                    const seenThreadKeys = new Set<string>()
                    workspace.threadsComplete = threadsComplete
                    for (const value of persistedThreads) {
                      const thread = record(value)
                      const threadId = text(thread.id)
                      const threadKey = threadId ? this.threadKey(server.id, threadId) : null
                      if (!threadId || !threadKey) continue
                      seenThreadKeys.add(threadKey)
                      this.persistedThreadMisses.delete(threadKey)
                      const now = Date.now()
                      const updatedAt = Number(thread.updatedAt ?? thread.updated_at)
                      const createdAt = Number(thread.createdAt ?? thread.created_at)
                      const localMetadata = this.taskMetadata.get(threadKey)
                      const serverMetadata = authoritativeThreadMetadata(thread.metadata)
                      const model = serverMetadata
                        ? (serverMetadata.model ?? undefined)
                        : (text(thread.model) ?? localMetadata?.model)
                      const archivedAt = serverMetadata
                        ? metadataTimestamp(serverMetadata.archivedAt)
                        : (metadataTimestamp(thread.archivedAt) ?? localMetadata?.archivedAt)
                      const parent = serverMetadata
                        ? (serverMetadata.parent ?? undefined)
                        : (taskParent(thread.parent) ?? localMetadata?.parent)
                      if (localMetadata?.deletedAt) {
                        this.archivedTasks.delete(runtimeTaskId(server, threadId))
                        continue
                      }
                      const existingTaskId = this.taskByThread.get(threadKey)
                      const existing = existingTaskId ? this.tasks.get(existingTaskId) : undefined
                      if (existing && !existing.persisted) continue
                      const hasLocalActiveTurn = existingTaskId
                        ? this.activeTurnByTask.has(existingTaskId)
                        : false
                      const syntheticTaskId = runtimeTaskId(server, threadId)
                      let taskId = existingTaskId ?? syntheticTaskId
                      if (!existingTaskId && this.tasks.has(taskId)) {
                        let suffix = 2
                        while (this.tasks.has(`${syntheticTaskId}:${suffix}`)) suffix += 1
                        taskId = `${syntheticTaskId}:${suffix}`
                      }
                      const hydratedTask: GatewayTask = {
                        serverId: server.id,
                        taskId,
                        threadId,
                        workspacePath: sameWorkspacePath(text(thread.cwd), workspacePath)
                          ? workspacePath
                          : (text(thread.cwd) ?? workspacePath),
                        projectKey: workspace.projectKey,
                        projectName: workspace.projectName,
                        title:
                          (serverMetadata
                            ? (serverMetadata.title ?? undefined)
                            : (text(thread.title) ?? localMetadata?.title)) ??
                          `KCoder 会话 ${threadId.slice(0, 8)}`,
                        runtime: KCODER_RUNTIME_NAME,
                        ...(model ? { model } : {}),
                        modelSelectionMode: threadModelSelectionMode(thread),
                        ...(parent ? { parent } : {}),
                        persisted: true,
                        // Persistent KCoder thread status=running currently means an app-server connection
                        // holds the session lease, not that a model turn is still executing. Sidebar
                        // running state trusts only the active turn tracked by the current renderer.
                        running: hasLocalActiveTurn,
                        runSummary: parseThreadRunSummary(thread.runSummary),
                        runActivity: threadRunActivity(
                          thread.status,
                          parseThreadRunSummary(thread.runSummary)
                        ),
                        createdAt:
                          localMetadata?.createdAt ??
                          (Number.isFinite(createdAt) ? createdAt : now),
                        updatedAt:
                          (serverMetadata ? undefined : localMetadata?.updatedAt) ??
                          (Number.isFinite(updatedAt) ? updatedAt : now),
                        runtimeHandle: { threadId },
                      }
                      this.threadByTask.set(taskId, threadId)
                      this.taskByThread.set(threadKey, taskId)
                      if (archivedAt) {
                        this.tasks.delete(taskId)
                        this.archivedTasks.set(taskId, { ...hydratedTask, running: false })
                      } else {
                        this.archivedTasks.delete(taskId)
                        this.tasks.set(taskId, hydratedTask)
                      }
                    }
                    if (!threadsComplete) return
                    for (const task of this.tasks.values()) {
                      const threadKey = this.threadKey(server.id, task.threadId)
                      if (
                        task.serverId !== server.id ||
                        !sameWorkspacePath(task.workspacePath, workspacePath) ||
                        !task.persisted ||
                        task.ephemeral ||
                        seenThreadKeys.has(threadKey)
                      )
                        continue
                      if (this.activeTurnByTask.has(task.taskId)) {
                        this.persistedThreadMisses.delete(threadKey)
                        continue
                      }
                      const misses = (this.persistedThreadMisses.get(threadKey) ?? 0) + 1
                      this.persistedThreadMisses.set(threadKey, misses)
                      if (misses < PERSISTED_THREAD_MISS_THRESHOLD) continue
                      this.tasks.delete(task.taskId)
                      this.threadByTask.delete(task.taskId)
                      this.taskByThread.delete(threadKey)
                      this.persistedThreadMisses.delete(threadKey)
                    }
                    for (const task of this.archivedTasks.values()) {
                      if (
                        task.serverId === server.id &&
                        sameWorkspacePath(task.workspacePath, workspacePath) &&
                        task.persisted &&
                        !seenThreadKeys.has(this.threadKey(server.id, task.threadId))
                      ) {
                        this.archivedTasks.delete(task.taskId)
                        this.threadByTask.delete(task.taskId)
                        this.taskByThread.delete(this.threadKey(server.id, task.threadId))
                      }
                    }
                  },
                  workspacePath
                )
          )
        } catch (error) {
          if (cancelled()) return
          // One unavailable target must not hide tasks from the remaining gateway servers.
          workspace.threadsComplete = false
          workspace.threadListIssueCount = Math.max(1, workspace.threadListIssueCount ?? 0)
          workspace.threadListSyncFailed = true
          console.warn(`[KCoder] 无法同步 目标 的持久任务`, safeGatewayFailureDiagnostic(error))
        }
      },
      cancelled
    )
  }

  private async loadTaskTranscript(params: Record<string, unknown>) {
    const address = record(params.address)
    const requestedTaskId = text(params.taskId) ?? text(address.taskId)
    const taskId = this.resolveTaskId(requestedTaskId)
    let task = taskId ? (this.tasks.get(taskId) ?? this.archivedTasks.get(taskId)) : undefined
    if (!task && isRuntimeTaskId(requestedTaskId)) {
      await this.hydrateAllPersistedTasks()
      const hydratedTaskId = this.resolveTaskId(requestedTaskId) ?? ''
      task = this.tasks.get(hydratedTaskId) ?? this.archivedTasks.get(hydratedTaskId)
    }
    const threadId = task?.threadId ?? text(params.threadId) ?? text(address.threadId)
    if (!task && requestedTaskId && !isRuntimeTaskId(requestedTaskId)) {
      return {
        taskId: requestedTaskId,
        messages: [],
        fullContent: true,
        rangeStart: 0,
        rangeEnd: 0,
        hasMoreBefore: false,
        beforeCursor: null,
        hasMoreAfter: false,
        afterCursor: null,
      }
    }
    if (!taskId || !threadId || !task) throw new Error('任务地址不存在或尚未恢复')
    let loadedTask = task
    const server = (await this.servers()).find(item => item.id === loadedTask.serverId)
    if (!server) throw new Error(`任务服务器已不存在：${loadedTask.serverId}`)
    if (this.archivedTasks.has(taskId)) await this.restoreArchivedTaskWorkspace(loadedTask)
    const borrowedClient = loadedTask.ephemeral === true
    const client = borrowedClient
      ? this.clientByTask.get(taskId)
      : await this.connectClient(server, 'runtime', loadedTask.workspacePath)
    if (!client) throw new Error('临时会话连接已结束')
    if (!borrowedClient && client.supportsThreadResume?.() !== true) {
      client.close()
      throw new Error('KCoder app-server 不支持历史会话读取')
    }
    type ThreadReadResult = {
      thread?: Record<string, unknown>
      historyReset?: boolean
      messages?: Array<Record<string, unknown>>
      rangeStart?: number
      rangeEnd?: number
      hasMoreBefore?: boolean
      beforeCursor?: string | null
    }
    const readParams = {
      threadId,
      limit: Math.trunc(Math.min(Math.max(Number(params.limit) || 50, 1), 100)),
      ...(text(params.beforeCursor) ? { beforeCursor: text(params.beforeCursor) } : {}),
    }
    let result: ThreadReadResult | undefined
    let readSucceeded = false
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          result = await requestTranscriptPage<ThreadReadResult>(client, readParams)
          readSucceeded = true
          break
        } catch (error) {
          const newlyStartedPersistenceRace =
            loadedTask.persisted === false &&
            error instanceof Error &&
            error.message.toLowerCase().includes('persisted thread not found')
          if (!newlyStartedPersistenceRace) throw error
          if (attempt < 3) {
            await new Promise(resolveDelay => window.setTimeout(resolveDelay, 40 * (attempt + 1)))
          }
        }
      }
    } finally {
      if (!borrowedClient) client.close()
    }
    // thread/start returns the canonical id before the first history snapshot is guaranteed to be
    // visible. The active stream already owns the optimistic/seeded messages, so an empty page is
    // safer than emitting a false transcript failure after the bounded persistence retry.
    result ??= {
      messages: [],
      rangeStart: 0,
      rangeEnd: 0,
      hasMoreBefore: false,
      beforeCursor: null,
    }
    if (readSucceeded && loadedTask.persisted === false) {
      loadedTask = { ...loadedTask, persisted: true }
      this.tasks.set(taskId, loadedTask)
    }
    const rangeStart = Number.isFinite(result.rangeStart) ? Number(result.rangeStart) : 0
    const messages = Array.isArray(result.messages)
      ? result.messages.flatMap((value, index) => {
          const message = record(value)
          const id = text(message.id)
          const role = text(message.role)
          const rawContent = typeof message.content === 'string' ? message.content : ''
          const persistedUserMessage =
            role === 'user'
              ? parsePersistedKCoderUserMessage(rawContent)
              : { content: rawContent, attachments: [], clientMessageId: undefined }
          const structuredAttachments =
            role === 'user' ? parsePersistedKCoderAttachmentBlocks(message.blocks) : []
          const persistedAttachments =
            structuredAttachments.length > 0
              ? structuredAttachments
              : persistedUserMessage.attachments
          const content = persistedUserMessage.content
          const blocks = Array.isArray(message.blocks)
            ? message.blocks
                .filter(value => !isPersistedKCoderAttachmentBlock(value))
                .map(value => {
                  const block = record(value)
                  const blockId = text(block.id) ?? text(block.tool_use_id)
                  const interrupted = blockId
                    ? this.interruptedBackgroundToolByKey.get(`${taskId}\0${blockId}`)
                    : undefined
                  const recoveredBlock = interrupted
                    ? {
                        ...block,
                        status: 'error',
                        tool_output: interrupted.output,
                        toolOutput: interrupted.output,
                      }
                    : block
                  if (text(recoveredBlock.type) !== 'file_changes') {
                    return interrupted ? recoveredBlock : value
                  }
                  const fileChanges = record(
                    recoveredBlock.fileChanges ?? recoveredBlock.file_changes
                  )
                  if (!text(fileChanges.artifact_id)) {
                    return interrupted ? recoveredBlock : value
                  }
                  const normalized = { ...fileChanges, device_id: loadedTask.serverId }
                  return {
                    ...recoveredBlock,
                    fileChanges: normalized,
                    file_changes: normalized,
                  }
                })
            : []
          if (
            !id ||
            !role ||
            (!content &&
              blocks.length === 0 &&
              persistedAttachments.length === 0 &&
              !['cancelled', 'failed'].includes(text(message.status) ?? ''))
          )
            return []
          const timestamp = Number(message.timestampMs)
          const validTimestamp =
            Number.isFinite(timestamp) && timestamp >= 0 && timestamp <= 8_640_000_000_000_000
          return [
            {
              id,
              ...(persistedUserMessage.clientMessageId
                ? { clientMessageId: persistedUserMessage.clientMessageId }
                : text(message.clientMessageId)
                  ? { clientMessageId: text(message.clientMessageId) }
                  : {}),
              ...(text(message.turnId) ? { turnId: text(message.turnId) } : {}),
              role,
              content,
              ...(persistedAttachments.length > 0
                ? {
                    attachments: persistedAttachments.map((attachment, attachmentIndex) => ({
                      id: -((rangeStart + index + 1) * 1_000 + attachmentIndex + 1),
                      filename: attachment.filename,
                      file_size: attachment.fileSize,
                      mime_type: attachment.mimeType,
                      status: 'ready',
                      file_extension: attachment.filename.includes('.')
                        ? `.${attachment.filename.split('.').at(-1)}`
                        : '',
                      created_at: new Date(validTimestamp ? timestamp : Date.now()).toISOString(),
                      local_path: attachment.path,
                      local_preview_url: attachment.path,
                      runtime_device_id: loadedTask.serverId,
                      runtime_thread_id: threadId,
                      runtime_workspace_path: loadedTask.workspacePath,
                    })),
                  }
                : {}),
              ...(blocks.length > 0 ? { blocks } : {}),
              contentTruncated: message.contentTruncated === true,
              contentOriginalChars:
                typeof message.contentOriginalChars === 'number'
                  ? message.contentOriginalChars
                  : undefined,
              messageIndex: rangeStart + index,
              subtaskId: `${threadId}:history:${rangeStart + index}`,
              status: text(message.status) || 'done',
              ...(text(message.error) ? { error: text(message.error) } : {}),
              ...(text(message.errorType) ? { errorType: text(message.errorType) } : {}),
              attemptId: text(message.attemptId) ?? undefined,
              continuedByAttemptId: text(message.continuedByAttemptId) ?? undefined,
              providerFailure: decodeProviderFailure(
                message.providerFailure ?? message.provider_failure
              ),
              createdAt: new Date(validTimestamp ? timestamp : Date.now()).toISOString(),
            },
          ]
        })
      : []
    return {
      taskId,
      workspacePath: loadedTask.workspacePath,
      runtime: loadedTask.runtime,
      running: transcriptSnapshotRunning(result.thread, loadedTask.running),
      title: loadedTask.title,
      messages,
      fullContent:
        result.hasMoreBefore !== true &&
        !messages.some(message => message.contentTruncated === true),
      historyReset: result.historyReset === true,
      rangeStart,
      rangeEnd: Number.isFinite(result.rangeEnd)
        ? Number(result.rangeEnd)
        : rangeStart + messages.length,
      hasMoreBefore: result.hasMoreBefore === true,
      beforeCursor: text(result.beforeCursor),
      hasMoreAfter: false,
      afterCursor: null,
    }
  }

  private async disposeTemporaryTask(params: Record<string, unknown>) {
    const address = record(params.address)
    const taskId = this.resolveTaskId(text(params.taskId) ?? text(address.taskId))
    const task = taskId ? this.tasks.get(taskId) : undefined
    if (!task || !taskId) return { disposed: false }
    if (!task.ephemeral) throw new Error('只能关闭临时会话，不能删除普通会话')
    const client = this.clientByTask.get(taskId)
    if (!client) throw new Error('临时会话的连接已丢失，请重新连接运行目标')
    // Preserve ownership and turn mappings until disposal is acknowledged.
    const result = await client.request('thread/dispose', { threadId: task.threadId })
    this.toolPathPreviews.clearTask(taskId)
    this.activeTurnByTask.get(taskId)?.complete()
    this.clientByTask.delete(taskId)
    this.tasks.delete(taskId)
    this.threadByTask.delete(taskId)
    this.taskByThread.delete(this.threadKey(task.serverId, task.threadId))
    this.activeTurnByTask.delete(taskId)
    for (const [alias, canonical] of this.canonicalTaskByRequested) {
      if (canonical === taskId) this.canonicalTaskByRequested.delete(alias)
    }
    client.close()
    return result
  }

  private async createTask(params: Record<string, unknown>, server: GatewayServer) {
    const ephemeral = isTemporaryTaskCreate(params)
    const execution = record(params.executionRequest)
    const clientMessageId = text(params.clientMessageId) ?? text(execution.clientMessageId)
    const reasoningEffort = executionReasoningEffort(execution)
    const proxyUrl = executionProxyUrl(execution)
    const serviceTier = executionServiceTier(execution)
    const modelSelection = record(params.modelSelection)
    const selectionMode = params.modelSelectionMode ?? execution.modelSelectionMode
    let selectedModel =
      executionSelectedModel(execution, modelSelection) ?? text(modelSelection.providerId)
    const requestedTaskId = text(params.taskId) ?? text(execution.task_id) ?? createRandomUuid()
    if (isRuntimeTaskId(requestedTaskId)) {
      throw new Error('任务 ID 使用了运行目标保留命名空间')
    }
    const rawPrompt = messagePrompt(execution, params.message)
    if (this.canonicalTaskByRequested.has(requestedTaskId)) {
      throw new Error(`任务已存在：${requestedTaskId}`)
    }
    // The gateway reuses one resident-thread app-server connection per workspace while
    // each task retains independent client ownership for precise notification,
    // approval/question, and terminal-resource routing.
    const workspacePath = text(params.workspacePath) ?? server.workspacePath ?? '/'
    let client = await this.connectClient(server, 'runtime', workspacePath)
    let prompt: string
    let started: { thread?: { id?: string } }
    try {
      modelSelectionModeParams(selectionMode, client, selectedModel ?? undefined)
      selectedModel = (await negotiateModelSelector(client, selectedModel)) ?? null
      prompt = await this.promptWithAttachmentsForClient(rawPrompt, execution, server, client)
      started = await startTaskThread(client, {
        serverId: server.id,
        workspacePath,
        params,
        model: selectedModel,
        creationRequestId: requestedTaskId,
        recoverClient: () => this.connectClient(server, 'runtime', workspacePath),
        onRecoveredClient: recovered => { if (client !== recovered) client.close(); client = recovered },
      })
    } catch (error) {
      client.close()
      throw error
    }
    const threadId = text(started.thread?.id)
    if (!threadId) {
      client.close()
      throw new Error('KCoder app-server 未返回 thread id')
    }
    const deleteEmptyThread = async () => {
      try {
        await client.request(ephemeral ? 'thread/dispose' : 'thread/delete', { threadId })
      } catch {
        // Preserve the original creation error; deletion only reclaims a resident thread whose turn never started successfully.
      }
    }
    // The app-server thread id is the only task identity that survives a renderer reload. Return
    // and route this deterministic id from the first response so a deep link does not change after
    // hydration reconstructs the task from persisted history.
    const taskId = runtimeTaskId(server, threadId)
    if (this.tasks.has(taskId)) {
      await deleteEmptyThread()
      client.close()
      throw new Error(`任务已存在：${taskId}`)
    }
    this.canonicalTaskByRequested.set(requestedTaskId, taskId)
    this.threadByTask.set(taskId, threadId)
    this.taskByThread.set(this.threadKey(server.id, threadId), taskId)
    this.bindTaskClient(taskId, client)
    const now = Date.now()
    const createdTask: GatewayTask = {
      ...(ephemeral ? { ephemeral: true } : {}),
      serverId: server.id,
      taskId,
      threadId,
      workspacePath,
      ...(text(params.runtimeProjectKey) ? { projectKey: text(params.runtimeProjectKey)! } : {}),
      ...(text(params.runtimeProjectName) ? { projectName: text(params.runtimeProjectName)! } : {}),
      title: text(params.title) ?? messageTitle(execution, rawPrompt),
      runtime: KCODER_RUNTIME_NAME,
      ...modelSelectionModeParams(selectionMode, client, selectedModel ?? undefined),
      ...(selectedModel ? { model: selectedModel } : {}),
      persisted: false,
      running: true,
      createdAt: now,
      updatedAt: now,
      runtimeHandle: { threadId },
    }
    this.tasks.set(taskId, createdTask)
    try {
      await this.updateTaskMetadata(
        createdTask,
        {
          title: createdTask.title,
          ...(selectedModel ? { model: selectedModel } : {}),
        },
        {
          title: createdTask.title,
          ...(selectedModel ? { model: selectedModel } : {}),
          createdAt: now,
          updatedAt: now,
        }
      )
      // An initial goal must exist in the engine before it builds the first model
      // request. A renderer-only goal seed is not an active persistent goal.
      if (params.initialGoal != null) {
        await this.setTaskGoal({ ...record(params.initialGoal), taskId })
      }
      if (!ephemeral) await this.linkManagedWorktreeConversation(server, createdTask)
    } catch (error) {
      this.tasks.delete(taskId)
      this.canonicalTaskByRequested.delete(requestedTaskId)
      this.threadByTask.delete(taskId)
      this.taskByThread.delete(this.threadKey(server.id, threadId))
      this.clientByTask.delete(taskId)
      await deleteEmptyThread()
      client.close()
      throw error
    }
    this.pendingTurnStartByTask.add(taskId)
    try {
      const submitted = await startTurnWithReceipt(client, {
        ...turnModeParams(params, client),
        ...modelSelectionModeParams(selectionMode, client, selectedModel ?? undefined),
        threadId,
        input: [{ type: 'text', text: prompt }],
        ...(clientMessageId ? { clientMessageId } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(proxyUrl !== null ? { proxyUrl } : {}),
        ...(serviceTier ? { serviceTier } : {}),
        ...turnPermissionParams(execution, client),
      }, () => this.readyTaskClient(createdTask))
      const turn = submitted.result
      const turnId = text(turn.turn?.id)
      if (!turnId) throw new Error('KCoder app-server 未返回 turn id')
      this.pendingTurnStartByTask.delete(taskId)
      const terminalReceipt = submitted.recovered && turn.turn?.status !== 'running'
      if (terminalReceipt) {
        const current = this.tasks.get(taskId) ?? createdTask
        this.tasks.set(taskId, { ...current, persisted: true, running: false, updatedAt: Date.now() })
      }
      if (!this.completedTurnKeys.delete(`${taskId}:${turnId}`) && !terminalReceipt) {
        this.trackActiveTurn(taskId, turnId)
      }
    } catch (error) {
      this.pendingTurnStartByTask.delete(taskId)
      if (error instanceof TurnAcceptanceUnknownError) {
        // Preserve the discoverable thread and the caller's draft. Unknown acceptance
        // is not a model failure and cannot safely trigger automatic re-submission.
        const current = this.tasks.get(taskId) ?? createdTask
        this.tasks.set(taskId, { ...current, persisted: true, updatedAt: Date.now() })
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      this.tasks.set(taskId, {
        ...createdTask,
        persisted: true,
        running: false,
        updatedAt: Date.now(),
      })
      const failedTurnId = `turn-start-failed-${createRandomUuid()}`
      await emit(EXECUTOR_EVENT, {
        event: 'response.created',
        payload: { taskId, subtaskId: failedTurnId, deviceId: server.id, data: {} },
      }).catch(emitError => console.warn('[KCoder] 无法创建首轮失败投影', safeGatewayFailureDiagnostic(emitError)))
      await emit(EXECUTOR_EVENT, {
        event: 'response.failed',
        payload: {
          taskId,
          subtaskId: failedTurnId,
          deviceId: server.id,
          ...(error instanceof GatewayRpcError &&
          record(error.data).error_type === 'local_runtime_error'
            ? { type: 'local_runtime_error' }
            : {}),
          data: { message, retryable: true },
        },
      }).catch(emitError => console.warn('[KCoder] 无法报告首轮发送失败', safeGatewayFailureDiagnostic(emitError)))
    }
    return {
      accepted: true,
      deviceId: server.id,
      taskId,
      workspacePath,
      runtime: KCODER_RUNTIME_NAME,
      runtimeHandle: { threadId },
    }
  }

  private async forkTaskAtTurn(params: Record<string, unknown>) {
    const source = record(params.source)
    const sourceTaskId = this.resolveTaskId(text(params.taskId) ?? text(source.taskId))
    const lastTurnId = text(params.lastTurnId) ?? text(params.last_turn_id)
    if (!sourceTaskId || !lastTurnId) {
      return {
        accepted: false,
        success: false,
        runtime: KCODER_RUNTIME_NAME,
        source,
        target: record(params.target),
        error: '分叉任务缺少源任务或 lastTurnId',
        code: 'bad_request',
      }
    }
    let task = this.tasks.get(sourceTaskId)
    if (!task) {
      await this.hydrateAllPersistedTasks()
      task = this.tasks.get(sourceTaskId)
    }
    if (!task) {
      return {
        accepted: false,
        success: false,
        runtime: KCODER_RUNTIME_NAME,
        source,
        target: record(params.target),
        error: '源任务不存在或尚未恢复',
        code: 'task_not_found',
      }
    }
    const target = record(params.target)
    const targetDeviceId = text(target.deviceId) ?? task.serverId
    const targetWorkspacePath = text(target.workspacePath) ?? task.workspacePath
    if (
      targetDeviceId !== task.serverId ||
      !sameWorkspacePath(targetWorkspacePath, task.workspacePath)
    ) {
      return {
        accepted: false,
        success: false,
        runtime: KCODER_RUNTIME_NAME,
        source: { deviceId: task.serverId, taskId: task.taskId },
        target,
        error: '按回合分叉必须保留在源 KCoder 服务器和工作区；跨服务器请新建任务',
        code: 'cross_device_fork_unsupported',
      }
    }
    const server = (await this.servers()).find(item => item.id === task.serverId)
    if (!server) throw new Error(`任务服务器已不存在：${task.serverId}`)
    const sourceClient = this.clientByTask.get(task.taskId) ?? (await this.resumeTask(task))
    try {
      const forked = await sourceClient.request<{ thread?: { id?: string } }>('thread/fork', {
        threadId: task.threadId,
        lastTurnId,
        cwd: task.workspacePath,
        excludeTurns: true,
      })
      const threadId = text(forked.thread?.id)
      if (!threadId) throw new Error('KCoder app-server 未返回分叉 thread id')
      const taskId = runtimeTaskId(server, threadId)
      const deleteUnownedFork = () =>
        sourceClient
          .request('thread/delete', { threadId })
          .catch(deleteError =>
            console.warn('[KCoder] 无法清理恢复失败后的分叉 thread', safeGatewayFailureDiagnostic(deleteError))
          )
      let client: GatewayClient
      try {
        client = await this.connectClient(server, 'runtime', task.workspacePath)
      } catch (error) {
        await deleteUnownedFork()
        throw error
      }
      try {
        await client.request('thread/resume', { threadId })
      } catch (error) {
        client.close()
        await deleteUnownedFork()
        throw error
      }
      const now = Date.now()
      const parent = { taskId: task.taskId, threadId: task.threadId, lastTurnId }
      const forkTask: GatewayTask = {
        serverId: server.id,
        taskId,
        threadId,
        workspacePath: task.workspacePath,
        ...(task.projectKey ? { projectKey: task.projectKey } : {}),
        ...(task.projectName ? { projectName: task.projectName } : {}),
        title: text(params.title) ?? task.title,
        runtime: KCODER_RUNTIME_NAME,
        ...(task.model ? { model: task.model } : {}),
        persisted: true,
        running: false,
        createdAt: now,
        updatedAt: now,
        runtimeHandle: { threadId },
        parent,
      }
      this.tasks.set(taskId, forkTask)
      this.threadByTask.set(taskId, threadId)
      this.taskByThread.set(this.threadKey(server.id, threadId), taskId)
      this.bindTaskClient(taskId, client)
      try {
        await this.updateTaskMetadata(
          forkTask,
          {
            title: forkTask.title,
            ...(forkTask.model ? { model: forkTask.model } : {}),
            parent,
          },
          {
            title: forkTask.title,
            ...(forkTask.model ? { model: forkTask.model } : {}),
            parent,
            updatedAt: now,
          }
        )
      } catch (error) {
        this.tasks.delete(taskId)
        this.threadByTask.delete(taskId)
        this.taskByThread.delete(this.threadKey(server.id, threadId))
        this.clientByTask.delete(taskId)
        await client
          .request('thread/delete', { threadId })
          .catch(deleteError => console.warn('[KCoder] 无法清理分叉失败后的 thread', safeGatewayFailureDiagnostic(deleteError)))
        client.close()
        throw error
      }
      return {
        success: true,
        accepted: true,
        source: { deviceId: task.serverId, taskId: task.taskId },
        target: {
          deviceId: server.id,
          taskId,
          threadId,
          workspacePath: task.workspacePath,
          runtimeHandle: { threadId },
        },
        runtime: KCODER_RUNTIME_NAME,
      }
    } catch (error) {
      return {
        success: false,
        accepted: false,
        source: { deviceId: task.serverId, taskId: task.taskId },
        target: { deviceId: server.id, workspacePath: task.workspacePath },
        runtime: KCODER_RUNTIME_NAME,
        error: error instanceof Error ? error.message : String(error),
        code: 'fork_failed',
      }
    }
  }

  private isRestartingServer(serverId: string): boolean {
    return (
      this.restartingAppServers &&
      (this.restartingServerId === null || this.restartingServerId === serverId)
    )
  }

  private async assertRequestTargetAvailable(params: Record<string, unknown>): Promise<void> {
    if (this.restartingServerId === null)
      throw new Error('KCoder app-server restart is in progress')
    const address = record(params.address)
    const taskId = this.resolveTaskId(text(params.taskId) ?? text(address.taskId))
    const task = taskId ? (this.tasks.get(taskId) ?? this.archivedTasks.get(taskId)) : undefined
    // Task-owned requests need not repeat their device ID; keep their authoritative routing.
    if (task && this.isRestartingServer(task.serverId))
      throw new Error('KCoder app-server restart is in progress')
    const target = await this.serverForParams({
      ...params,
      deviceId:
        text(params.serverId) ?? text(params.deviceId) ?? text(address.deviceId) ?? task?.serverId,
      workspacePath: text(params.workspacePath) ?? text(address.workspacePath),
    })
    if (this.isRestartingServer(target.id))
      throw new Error('KCoder app-server restart is in progress')
  }

  private async restartAppServers(params: Record<string, unknown>) {
    if (this.restartingAppServers) throw new Error('KCoder app-server restart is in progress')
    const activeTaskIds = new Set(this.activeTurnByTask.keys())
    for (const job of this.backgroundJobById.values()) activeTaskIds.add(job.taskId)
    const selectedServerId = text(params.serverId)
    const activeTaskCount = [...activeTaskIds].filter(taskId => {
      const task = this.tasks.get(taskId)
      return !selectedServerId || !task || task.serverId === selectedServerId
    }).length
    if (params.ifIdle === true && params.force !== true && activeTaskCount > 0) {
      return { restarted: false, requiresConfirmation: true, activeTaskCount }
    }
    this.restartingServerId = selectedServerId
    this.restartingAppServers = true
    try {
      const restarted = await restartOwnedAppServers(
        [...this.ownedRuntimeClients.values()].filter(
          target => !text(params.serverId) || target.server.id === text(params.serverId)
        ),
        params.force === true,
        client => this.releaseRestartClient(client),
        (server, workspacePath) => this.connectClient(server, 'runtime', workspacePath, true)
      )
      return { restarted, requiresConfirmation: false, activeTaskCount }
    } finally {
      this.restartingAppServers = false
      this.restartingServerId = null
    }
  }

  private async releaseRestartClient(client: GatewayClient) {
    this.ownedRuntimeClients.delete(client)
    for (const [taskId, taskClient] of this.clientByTask) {
      if (taskClient !== client) continue
      this.clientByTask.delete(taskId)
      this.resumeClientByTask.delete(taskId)
      this.activeTurnByTask.get(taskId)?.complete()
      this.activeTurnByTask.delete(taskId)
      const task = this.tasks.get(taskId)
      if (task) this.tasks.set(taskId, { ...task, running: false, updatedAt: Date.now() })
      for (const [jobId, job] of this.backgroundJobById) {
        if (job.taskId === taskId) this.backgroundJobById.delete(jobId, job)
      }
    }
    for (const [key, pending] of this.commandClientByServer) {
      if ((await pending) === client && this.commandClientByServer.get(key) === pending) {
        this.commandClientByServer.delete(key)
      }
    }
    const control = this.controlClientPromise
    if (control && (await control) === client && this.controlClientPromise === control) {
      this.controlClientPromise = null
    }
  }

  private async sendTask(
    params: Record<string, unknown>,
    server: GatewayServer,
    interruptFirst: boolean
  ) {
    const address = record(params.address)
    const taskId = this.resolveTaskId(text(params.taskId) ?? text(address.taskId))
    const threadId = (taskId && this.threadByTask.get(taskId)) ?? text(address.threadId)
    const questionResponse = record(
      params.requestUserInputResponse ?? params.request_user_input_response
    )
    if (Object.keys(questionResponse).length > 0) {
      return this.respondToTaskQuestion(taskId, questionResponse)
    }
    const execution = record(params.executionRequest)
    const clientMessageId = text(params.clientMessageId) ?? text(execution.clientMessageId)
    if (!taskId || !threadId) throw new Error('任务地址或消息不完整')
    const retryFromTurnId = text(params.retryFromTurnId)
    const retryFromAttemptId = text(params.retryFromAttemptId)
    const retryCurrentConfiguration = params.retryModelConfiguration === 'current'
    const rawPrompt = retryFromTurnId ? '' : messagePrompt(execution, params.message)
    const task = this.tasks.get(taskId)
    const reasoningEffort = executionReasoningEffort(execution)
    const proxyUrl = executionProxyUrl(execution)
    const serviceTier = executionServiceTier(execution)
    const explicitModel = executionSelectedModel(execution, record(params.modelSelection)) ??
      text(record(params.modelSelection).providerId)
    if (!task) throw new Error('任务连接已失效，请重新打开或恢复任务')
    let client = await this.readyTaskClient(task)
    if (retryCurrentConfiguration && (!retryFromTurnId || !retryFromAttemptId || !explicitModel)) {
      throw new Error(i18n.t('workbench.failed_turn_current_identity_required'))
    }
    if (retryCurrentConfiguration && !client.supportsExperimental?.('retryModelConfigurationV1')) {
      throw new Error(i18n.t('workbench.failed_turn_current_unsupported'))
    }

    let modelSelectionMode = params.modelSelectionMode ?? execution.modelSelectionMode ??
      (!explicitModel && !retryFromTurnId ? task.modelSelectionMode : undefined)
    let requestedModel = retryFromTurnId && !explicitModel ? undefined : modelSelectionMode === 'follow_target_default' ? explicitModel : explicitModel ?? task.model
    let selectedModel = requestedModel
    modelSelectionModeParams(modelSelectionMode, client, selectedModel, retryFromTurnId)
    selectedModel = await negotiateModelSelector(client, selectedModel)
    if (interruptFirst) {
      const active = this.activeTurnByTask.get(taskId)
      if (active) {
        const result = await client.request<{ interrupted?: boolean }>('turn/interrupt', {
          threadId,
          turnId: active.turnId,
        })
        if (result.interrupted !== true) throw new Error('KCoder app-server 未能中断当前任务')
        await this.waitForTurnCompletion(active)
      }
    }
    const updatedAt = Date.now()
    if (!retryFromTurnId && task && selectedModel && selectedModel !== task.model) {
      await this.updateTaskMetadata(
        task,
        { model: selectedModel },
        {
          ...this.taskMetadata.get(this.threadKey(task.serverId, task.threadId)),
          model: selectedModel,
          updatedAt,
        }
      )
    }
    // Metadata writes may span a connection replacement; reacquire the client from the latest recovery generation before sending.
    client = await this.readyTaskClient(task)
    modelSelectionMode = params.modelSelectionMode ?? execution.modelSelectionMode ??
      (!explicitModel && !retryFromTurnId ? task.modelSelectionMode : undefined)
    requestedModel = retryFromTurnId && !explicitModel ? undefined : modelSelectionMode === 'follow_target_default' ? explicitModel : explicitModel ?? task.model
    modelSelectionModeParams(modelSelectionMode, client, requestedModel, retryFromTurnId)
    selectedModel = await negotiateModelSelector(client, requestedModel)
    if (retryFromTurnId && (
      !client.supportsExperimental?.('failedTurnContinuationV1') ||
      !client.supportsExperimental?.('turnRetryOperationV1') ||
      (Boolean(retryFromAttemptId && retryFromAttemptId !== retryFromTurnId) &&
        !client.supportsExperimental?.('turnAttemptRetryV1'))
    )) {
      throw new Error(i18n.t('workbench.failed_turn_continuation_unsupported'))
    }
    const prompt = retryFromTurnId
      ? ''
      : await this.promptWithAttachmentsForClient(rawPrompt, execution, server, client, threadId)
    let turnId: string
    let receiptStatus: string | undefined
    if (retryFromTurnId) this.completedTurnKeys.delete(`${taskId}:${retryFromTurnId}`)
    this.pendingTurnStartByTask.add(taskId)
    try {
      const submitted = await startTurnWithReceipt(client, {
        ...(retryFromTurnId
          ? {
              retryFromTurnId,
              // One recovery of one failed turn: any client that computes the
              // same name is answered with the attempt that already accepted it
              // instead of starting a second one (R054).
              ...(retryFromAttemptId && client.supportsExperimental?.('turnAttemptRetryV1')
                ? { retryFromAttemptId } : {}),
              retryOperationId: `retry:${threadId}:${retryFromAttemptId || retryFromTurnId}${retryCurrentConfiguration ? ':current' : ''}`,
              ...(retryCurrentConfiguration ? { retryModelConfiguration: 'current' } : {}),
            }
          : turnModeParams(params, client)),
        ...modelSelectionModeParams(modelSelectionMode, client, selectedModel, retryFromTurnId),
        threadId,
        input: retryFromTurnId ? [] : [{ type: 'text', text: prompt }],
        ...(!retryFromTurnId && clientMessageId ? { clientMessageId } : {}),
        ...(params.resubmit === true ? { resubmit: true } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(proxyUrl !== null ? { proxyUrl } : {}),
        ...(serviceTier ? { serviceTier } : {}),
        ...turnPermissionParams(execution, client),
      }, () => this.readyTaskClient(task))
      client = submitted.client
      const turn = submitted.result
      if (submitted.recovered || turn.turn?.status !== 'running') receiptStatus = turn.turn?.status
      if (this.clientByTask.get(taskId) !== client || this.disconnectRecoveryByTask.has(taskId)) {
        throw new Error('消息发送期间任务连接再次中断，请重试')
      }
      const resolvedTurnId = text(turn.turn?.id)
      if (!resolvedTurnId) throw new Error('KCoder app-server 未返回 turn id')
      turnId = resolvedTurnId
      const acceptedMode = modelSelectionModeParams(modelSelectionMode, client, selectedModel, retryFromTurnId).modelSelectionMode
      if (acceptedMode) {
        task.modelSelectionMode = acceptedMode
        const currentTask = this.tasks.get(taskId)
        if (currentTask) this.tasks.set(taskId, { ...currentTask, modelSelectionMode: acceptedMode })
      } else if (explicitModel) {
        task.modelSelectionMode = 'explicit'
        const currentTask = this.tasks.get(taskId)
        if (currentTask) this.tasks.set(taskId, { ...currentTask, modelSelectionMode: 'explicit' })
      }
    } catch (error) {
      this.pendingTurnStartByTask.delete(taskId)
      if (error instanceof TurnAcceptanceUnknownError) throw error
      if (retryFromTurnId) {
        if (error instanceof GatewayRpcError && error.code === -32602 && error.message.includes('retry_model_incompatible:')) {
          throw new Error(i18n.t('workbench.failed_turn_current_incompatible'), { cause: error })
        }
        if (error instanceof GatewayRpcError && error.code === -32046) {
          throw new Error(i18n.t('workbench.failed_turn_continuation_unavailable'), {
            cause: error,
          })
        }
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      this.tasks.set(taskId, { ...task, running: false, updatedAt: Date.now() })
      // After rejecting turn/start, the server emits neither turn/started nor
      // turn/completed. Project a terminal failure so the optimistically inserted
      // user message stops waiting and becomes retryable.
      const failedTurnId = `turn-start-failed-${createRandomUuid()}`
      await emit(EXECUTOR_EVENT, {
        event: 'response.created',
        payload: { taskId, subtaskId: failedTurnId, deviceId: task.serverId, data: {} },
      }).catch(emitError => console.warn('[KCoder] 无法创建 turn/start 失败投影', safeGatewayFailureDiagnostic(emitError)))
      await emit(EXECUTOR_EVENT, {
        event: 'response.failed',
        payload: {
          taskId,
          subtaskId: failedTurnId,
          deviceId: task.serverId,
          ...(error instanceof GatewayRpcError &&
          record(error.data).error_type === 'local_runtime_error'
            ? { type: 'local_runtime_error' }
            : {}),
          data: { message, retryable: true },
        },
      }).catch(emitError => console.warn('[KCoder] 无法报告 turn/start 失败', safeGatewayFailureDiagnostic(emitError)))
      throw error
    }
    this.pendingTurnStartByTask.delete(taskId)
    const completedBeforeAcknowledgement = this.completedTurnKeys.delete(`${taskId}:${turnId}`) ||
      (receiptStatus !== undefined && receiptStatus !== 'running')
    if (receiptStatus !== undefined) {
      const current = this.tasks.get(taskId)
      if (current) this.tasks.set(taskId, { ...current, running: receiptStatus === 'running', updatedAt: Date.now() })
      window.dispatchEvent(new CustomEvent('kcoder:turn-receipt-reconciled', {
        detail: { taskId, deviceId: server.id },
      }))
    }
    if (!completedBeforeAcknowledgement) this.trackActiveTurn(taskId, turnId)
    if (task && !completedBeforeAcknowledgement) {
      this.tasks.set(taskId, {
        ...task,
        ...(selectedModel ? { model: selectedModel } : {}),
        running: true,
        updatedAt,
      })
    }
    return { accepted: true, deviceId: server.id, taskId }
  }

  private async resumeTask(task: GatewayTask): Promise<GatewayClient> {
    const existing = this.resumeClientByTask.get(task.taskId)
    if (existing) return existing
    const attempt = this.resumeTaskOnce(task)
    this.resumeClientByTask.set(task.taskId, attempt)
    void attempt
      .finally(() => {
        if (this.resumeClientByTask.get(task.taskId) === attempt) {
          this.resumeClientByTask.delete(task.taskId)
        }
      })
      .catch(() => undefined)
    return attempt
  }

  private async readyTaskClient(task: GatewayTask): Promise<GatewayClient> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      if (this.isRestartingServer(task.serverId))
        throw new Error('KCoder app-server restart is in progress')
      const recovery = this.disconnectRecoveryByTask.get(task.taskId)
      if (recovery) {
        await recovery
        continue
      }
      const client = this.clientByTask.get(task.taskId)
      if (client) {
        // Let the queued close handler install the next recovery generation before confirming that this connection can send.
        await Promise.resolve()
        if (
          this.clientByTask.get(task.taskId) === client &&
          !this.disconnectRecoveryByTask.has(task.taskId)
        ) {
          if (this.isRestartingServer(task.serverId))
            throw new Error('KCoder app-server restart is in progress')
          return client
        }
        continue
      }
      await this.resumeTask(task)
    }
    throw new Error('任务连接持续变化，无法安全发送请求')
  }

  private async taskDescriptor(params: Record<string, unknown>) {
    const address = record(params.address)
    const requestedTaskId = text(params.taskId) ?? text(address.taskId)
    let taskId = this.resolveTaskId(requestedTaskId)
    let task = taskId ? this.tasks.get(taskId) : undefined
    if (!task && isRuntimeTaskId(requestedTaskId)) {
      await this.hydrateAllPersistedTasks()
      taskId = this.resolveTaskId(requestedTaskId)
      task = taskId ? this.tasks.get(taskId) : undefined
    }
    if (!taskId || !task) throw new Error('任务地址不存在或尚未恢复')
    const server = (await this.servers()).find(item => item.id === task.serverId)
    if (!server) throw new Error(`任务服务器已不存在：${task.serverId}`)
    return { taskId, task, server }
  }

  private async taskConnection(params: Record<string, unknown>) {
    const { taskId, task, server } = await this.taskDescriptor(params)
    const client = await this.readyTaskClient(task)
    return { taskId, task, server, client }
  }

  private async compactTask(params: Record<string, unknown>) {
    const { taskId, task, client } = await this.taskConnection(params)
    if (this.activeTurnByTask.has(taskId)) throw new Error('任务运行中，暂时无法压缩上下文')
    await client.request('thread/compact', { threadId: task.threadId })
    this.tasks.set(taskId, { ...task, updatedAt: Date.now() })
    return { accepted: true, taskId }
  }

  private async rollbackTask(params: Record<string, unknown>) {
    const { taskId, task, server, client } = await this.taskConnection(params)
    if (this.activeTurnByTask.has(taskId)) throw new Error('任务运行中，暂时无法编辑上一条消息')
    const result = await client.request<{ failedFiles?: number; removedMessages?: number }>(
      'thread/rollback',
      {
        threadId: task.threadId,
      }
    )
    if (Number(result.failedFiles ?? 0) > 0) {
      throw new Error(`回滚未完整恢复 ${result.failedFiles} 个文件，已停止提交替换消息`)
    }
    if (Number(result.removedMessages ?? 0) <= 0) {
      throw new Error('压缩后的上下文中已找不到上一条消息边界，无法安全提交替换消息')
    }
    return this.sendTask(params, server, false)
  }

  private async revertTaskFileChanges(params: Record<string, unknown>) {
    const { task, client } = await this.taskConnection(params)
    const fileChanges = record(params.fileChanges ?? params.file_changes)
    const artifactId = text(fileChanges.artifact_id)
    if (!artifactId) throw new Error('文件变更缺少服务器 artifact id')
    const workspacePath = text(fileChanges.workspace_path) ?? task.workspacePath
    if (!sameWorkspacePath(workspacePath, task.workspacePath)) {
      throw new Error('文件变更所属工作区与任务不一致')
    }
    const result = await client.request<{
      success?: boolean
      stdout?: unknown
      stderr?: string
    }>('device/execute', {
      deviceId: task.serverId,
      command_key: 'turn_file_changes_revert',
      threadId: task.threadId,
      path: task.workspacePath,
      args: [artifactId],
      timeout_seconds: 30,
      max_output_bytes: 64 * 1024,
    })
    const stdout = record(result.stdout)
    const authoritative = record(stdout.file_changes)
    if (!text(authoritative.artifact_id)) {
      throw new Error(result.stderr || 'Git 无法安全回滚这组文件变更')
    }
    const reverted = { ...authoritative, device_id: task.serverId }
    return { fileChanges: reverted, file_changes: reverted }
  }

  private async guideTask(params: Record<string, unknown>) {
    const { taskId, server } = await this.taskConnection(params)
    const attachmentIds = Array.isArray(params.attachmentIds)
      ? params.attachmentIds
      : Array.isArray(params.attachment_ids)
        ? params.attachment_ids
        : []
    if (attachmentIds.length > 0 && !Array.isArray(params.attachments)) {
      throw new Error('KCoder 网关不支持仅使用云端 attachmentIds 的引导附件')
    }
    const rawMessage = text(params.message)
    if (!rawMessage) throw new Error('引导消息不能为空')
    const message = this.promptWithApplicationContext(
      rawMessage,
      params.additionalContext ?? params.additional_context
    )
    const response = await this.sendTask(
      {
        ...params,
        executionRequest: {
          prompt: message,
          ...(Array.isArray(params.attachments) ? { attachments: params.attachments } : {}),
        },
      },
      server,
      this.activeTurnByTask.has(taskId)
    )
    const turnId = this.activeTurnByTask.get(taskId)?.turnId
    const guidanceId =
      text(params.clientGuidanceId) ?? text(params.client_guidance_id) ?? createRandomUuid()
    await emit(EXECUTOR_EVENT, {
      event: 'response.guidance.applied',
      payload: {
        taskId,
        subtaskId: turnId,
        deviceId: server.id,
        data: { guidanceId, message: rawMessage, appliedAtMs: Date.now() },
      },
    })
    return { ...response, success: true, guidanceId, turnId }
  }

  private async steerSubagent(params: Record<string, unknown>) {
    const { taskId, task, server, client } = await this.taskConnection(params)
    if (client.supportsExperimental?.('agentSteering') !== true) {
      throw new Error('当前 KCoder app-server 不支持定向调整子智能体')
    }
    const agentId = text(params.agentId) ?? text(params.agent_id)
    const message = text(params.message)
    if (!agentId || !message) throw new Error('子智能体地址或调整消息不完整')
    if (new TextEncoder().encode(message).byteLength > 64 * 1024) {
      throw new Error('子智能体调整消息超过 64 KiB 限制')
    }
    const clientMessageId =
      text(params.clientMessageId) ?? text(params.client_message_id) ?? createRandomUuid()
    const result = await client.request<Record<string, unknown>>('agent/steer', {
      threadId: task.threadId,
      agentId,
      message,
      clientMessageId,
    })
    const status = text(result.status) ?? 'rejected'
    const messageId = text(result.messageId)
    const accepted = result.queued === true
    await emit(EXECUTOR_EVENT, {
      event: 'response.subagent.activity',
      payload: {
        taskId,
        subtaskId: this.activeTurnByTask.get(taskId)?.turnId ?? task.threadId,
        deviceId: server.id,
        data: {
          agent_path: agentId,
          agent_id: agentId,
          kind: 'background',
          status: 'running',
          steer_status: status,
          message_id: messageId,
          client_message_id: clientMessageId,
          occurred_at_ms: Date.now(),
        },
      },
    })
    return {
      ...result,
      accepted,
      success: accepted,
      taskId,
      agentId,
      clientMessageId,
      ...(messageId ? { messageId } : {}),
    }
  }

  private async readSubagentArtifact(params: Record<string, unknown>) {
    const { task, client } = await this.taskConnection(params)
    if (client.supportsExperimental?.('agentArtifactsV1') !== true) {
      throw new Error('KCoder app-server 不支持 subagent 报告读取')
    }
    const requestedPath = text(params.path)
    const kind = text(params.kind) === 'transcript' ? 'transcript' : 'output'
    if (!requestedPath) throw new Error('artifact path is required')
    let normalizedTarget: string
    try {
      normalizedTarget = normalizeAbsoluteWorkspacePath(
        requestedPath,
        'invalid artifact path'
      ).toLowerCase()
    } catch {
      throw new Error('artifact path is invalid')
    }
    const list = await client.request<{ agents?: Array<Record<string, unknown>> }>('agent/list', {
      threadId: task.threadId,
    })
    const match = (Array.isArray(list.agents) ? list.agents : []).map(record).find(agent => {
      const candidate = text(kind === 'transcript' ? agent.transcriptPath : agent.outputPath)
      if (!candidate) return false
      try {
        return (
          normalizeAbsoluteWorkspacePath(candidate, 'invalid artifact path').toLowerCase() ===
          normalizedTarget
        )
      } catch {
        return false
      }
    })
    const agentId = match ? text(match.agentId) : undefined
    if (!agentId) throw new Error('未找到对应的 subagent 报告')
    return client.request('agent/artifact/read', { threadId: task.threadId, agentId, kind })
  }

  private promptWithApplicationContext(message: string, rawContext: unknown) {
    const entries = Object.entries(record(rawContext)).flatMap(([name, rawEntry]) => {
      const entry = record(rawEntry)
      return entry.kind === 'application' && typeof entry.value === 'string'
        ? [`[${name}]\n${entry.value}`]
        : []
    })
    return entries.length > 0
      ? `<application_context>\n${entries.join('\n\n')}\n</application_context>\n\n${message}`
      : message
  }

  private async getTaskGoal(params: Record<string, unknown>) {
    const address = record(params.address)
    const requestedTaskId = text(params.taskId) ?? text(address.taskId)
    if (
      requestedTaskId &&
      !isRuntimeTaskId(requestedTaskId) &&
      !this.canonicalTaskByRequested.has(requestedTaskId)
    ) {
      return { accepted: false, taskId: requestedTaskId, goal: null }
    }
    const retryDelays = [0, 75, 150, 300, 600]
    let lastError: unknown
    for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
      if (retryDelays[attempt] > 0) {
        await new Promise(resolve => window.setTimeout(resolve, retryDelays[attempt]))
      }
      try {
        const { taskId, task, server } = await this.taskDescriptor(params)
        const result = await this.withTransientClient(
          server,
          client =>
            client.request<{ goal?: Record<string, unknown> | null }>('thread/goal/get', {
              threadId: task.threadId,
            }),
          task.workspacePath
        )
        return { accepted: true, taskId, goal: result.goal ?? null }
      } catch (error) {
        if (!isRetryableReadonlyTaskConnectionError(error)) throw error
        lastError = error
      }
    }
    throw lastError
  }

  private async setTaskGoal(params: Record<string, unknown>) {
    const { taskId, task, client } = await this.taskConnection(params)
    if (params.status === 'cancelled' && client.supportsExperimental?.('goalCancellationV1') !== true) {
      throw new Error('Goal cancellation is unsupported by this server; update the remote KCoder server first.')
    }
    const result = await client.request<{ goal?: Record<string, unknown> }>('thread/goal/set', {
      threadId: task.threadId,
      ...(typeof params.objective === 'string' ? { objective: params.objective } : {}),
      ...(typeof params.status === 'string' ? { status: params.status } : {}),
      ...(typeof params.mode === 'string' ? { mode: params.mode } : {}),
      ...(typeof params.verificationKind === 'string'
        ? { verificationKind: params.verificationKind }
        : {}),
      ...(typeof params.tokenBudget === 'number' ? { tokenBudget: params.tokenBudget } : {}),
      ...(params.tokenBudget === null ? { clearTokenBudget: true } : {}),
    })
    if (!result.goal) throw new Error('KCoder app-server 未返回 goal')
    return { accepted: true, taskId, goal: result.goal }
  }

  private async clearTaskGoal(params: Record<string, unknown>) {
    const { taskId, task, client } = await this.taskConnection(params)
    const result = await client.request<{ cleared?: boolean }>('thread/goal/clear', {
      threadId: task.threadId,
    })
    return { accepted: true, taskId, cleared: result.cleared === true }
  }

  private async resumeTaskOnce(task: GatewayTask): Promise<GatewayClient> {
    if (task.ephemeral) throw new Error('临时会话连接已结束，请重新打开临时聊天')
    const server = (await this.servers()).find(item => item.id === task.serverId)
    if (!server) throw new Error(`任务服务器已不存在：${task.serverId}`)
    const client = await this.connectClient(server, 'runtime', task.workspacePath)
    try {
      const result = await client.request<{ thread?: Record<string, unknown> }>('thread/resume', {
        threadId: task.threadId,
      })
      if (text(result.thread?.id) !== task.threadId) {
        throw new Error('KCoder app-server 恢复了错误的 thread')
      }
      if (this.disposed) throw new Error('KCoder 网关运行时已关闭')
      if (this.isRestartingServer(task.serverId))
        throw new Error('KCoder app-server restart is in progress')
      const snapshot = record(result.thread)
      const summary = parseThreadRunSummary(snapshot.runSummary)
      const activity = threadRunActivity(snapshot.status, summary)
      if (!this.activeTurnByTask.has(task.taskId)) {
        task.runSummary = summary
        task.runActivity = activity
        task.running = transcriptSnapshotRunning(snapshot, task.running) ?? task.running
        const current = this.tasks.get(task.taskId)
        if (current && current !== task) {
          current.runSummary = summary
          current.runActivity = activity
          current.running = task.running
        }
      }
      applyThreadModelSelection(task, record(result.thread))
      const currentTask = this.tasks.get(task.taskId)
      if (currentTask && currentTask !== task) applyThreadModelSelection(currentTask, record(result.thread))
    } catch (error) {
      client.close()
      throw error
    }
    this.bindTaskClient(task.taskId, client)
    this.threadByTask.set(task.taskId, task.threadId)
    this.taskByThread.set(this.threadKey(task.serverId, task.threadId), task.taskId)
    await this.emitSubagentSnapshot(task, client)
    return client
  }

  private async emitSubagentSnapshot(task: GatewayTask, client: GatewayClient): Promise<void> {
    if (client.supportsExperimental?.('agentSteering') !== true) return
    const result = await client
      .request<{ agents?: Array<Record<string, unknown>> }>('agent/list', {
        threadId: task.threadId,
      })
      .catch(() => ({ agents: [] }))
    for (const rawAgent of Array.isArray(result.agents) ? result.agents : []) {
      const agent = record(rawAgent)
      const agentId = text(agent.agentId)
      const status = text(agent.status) ?? 'failed'
      const run = record(agent.backgroundRun)
      if (!this.notificationReplayGuard.canSeedBackgroundRun(run, status, task.serverId)) continue
      const queueDepth = finiteNumber(agent.queueDepth)
      if (!agentId) {
        continue
      }
      const agentName = text(agent.agentName) ?? 'spawn_agent'
      const existingJob = this.backgroundJobById.get(agentId, task.taskId, task.serverId)
      // A reconnect snapshot adds steering state, not a new tool-call identity.
      // Keep the original message target so terminal events update its visible block.
      let job: GatewayBackgroundJob =
        existingJob?.taskId === task.taskId
          ? existingJob
          : {
              taskId: task.taskId,
              turnId:
                this.activeTurnByTask.get(task.taskId)?.turnId ?? `${task.threadId}:reconnect`,
              toolCallId: text(agent.parentToolCallId) ?? `recovered-${agentId}`,
              toolName: agentName,
              serverId: task.serverId,
            }
      job = { ...job, runId: text(run.runId) ?? existingJob?.runId }
      this.backgroundJobById.set(agentId, job)
      const terminal = ['completed', 'failed', 'cancelled', 'halted'].includes(status)
      if (terminal && (existingJob || text(agent.parentToolCallId))) {
        await this.emitBackgroundToolLifecycle(
          agentId,
          job,
          status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'interrupted'
        )
      } else if (status === 'paused') {
        await this.emitBackgroundToolLifecycle(agentId, job, 'paused')
      }
      const turnId = job.turnId
      const headStatus = text(agent.headStatus)
      const steerStatus =
        queueDepth === 0
          ? undefined
          : headStatus === 'blocked'
            ? 'queued_behind_blocked'
            : status === 'paused'
              ? 'queued_paused'
              : ['failed', 'completed', 'cancelled', 'halted'].includes(status)
                ? 'resuming'
                : 'queued_live'
      await emit(EXECUTOR_EVENT, {
        event: 'response.subagent.activity',
        payload: {
          taskId: task.taskId,
          subtaskId: turnId,
          deviceId: task.serverId,
          data: {
            agent_path: agentId,
            agent_id: agentId,
            agent_name: agentName,
            kind: 'background',
            status: status === 'cancelled' ? 'interrupted' : status,
            steer_status: steerStatus,
            retained_runs: finiteNumber(agent.retainedRuns),
            retained_run_limit: finiteNumber(agent.retainedRunLimit),
            capacity_warning: agent.capacityWarning === true,
            message_id: text(agent.headMessageId),
            occurred_at_ms: Date.now(),
          },
        },
      })
      if (terminal) this.backgroundJobById.delete(agentId, job)
      this.notificationReplayGuard.seedBackgroundRun(run, status, task.serverId)
    }
  }

  private recoverTaskAfterDisconnect(task: GatewayTask, disconnectProjection: Promise<void>): void {
    if (this.disposed || this.isRestartingServer(task.serverId)) return
    const previousRecovery = this.disconnectRecoveryByTask.get(task.taskId)
    const reconnectBlockId = `runtime-reconnecting-${task.threadId}-${crypto.randomUUID()}`
    const reconnectSubtaskId = reconnectBlockId
    const recovery = Promise.resolve().then(async () => {
      await disconnectProjection
      if (previousRecovery) await previousRecovery.catch(() => undefined)
      if (
        this.disposed ||
        this.isRestartingServer(task.serverId) ||
        !this.tasks.has(task.taskId) ||
        this.disconnectRecoveryByTask.get(task.taskId) !== recovery
      ) {
        return
      }
      await emit(EXECUTOR_EVENT, {
        event: 'response.block.created',
        payload: {
          taskId: task.taskId,
          subtaskId: reconnectSubtaskId,
          deviceId: task.serverId,
          data: {
            block: {
              id: reconnectBlockId,
              type: 'tool',
              tool_name: 'runtime_reconnecting',
              toolName: 'runtime_reconnecting',
              status: 'pending',
              timestamp: Date.now(),
            },
          },
        },
      }).catch(error => console.warn('[KCoder] 无法报告任务重连状态', safeGatewayFailureDiagnostic(error)))
      const delays = [0, 250, 750, 1_500]
      let lastError: unknown
      for (const delay of delays) {
        if (
          this.disposed ||
          this.isRestartingServer(task.serverId) ||
          !this.tasks.has(task.taskId) ||
          this.disconnectRecoveryByTask.get(task.taskId) !== recovery
        ) {
          return
        }
        if (delay > 0) await new Promise(resolve => window.setTimeout(resolve, delay))
        if (this.isRestartingServer(task.serverId)) return
        try {
          const client = await this.resumeTask(task)
          if (
            this.clientByTask.get(task.taskId) !== client ||
            this.disconnectRecoveryByTask.get(task.taskId) !== recovery
          ) {
            return
          }
          await emit(EXECUTOR_EVENT, {
            event: 'response.block.updated',
            payload: {
              taskId: task.taskId,
              subtaskId: reconnectSubtaskId,
              deviceId: task.serverId,
              data: { blockId: reconnectBlockId, updates: { status: 'done' } },
            },
          }).catch(error => console.warn('[KCoder] 无法报告任务重连成功', safeGatewayFailureDiagnostic(error)))
          return
        } catch (error) {
          lastError = error
        }
      }
      console.warn(`[KCoder] 无法自动恢复任务连接 当前任务`, safeGatewayFailureDiagnostic(lastError))
      await emit(EXECUTOR_EVENT, {
        event: 'response.block.updated',
        payload: {
          taskId: task.taskId,
          subtaskId: reconnectSubtaskId,
          deviceId: task.serverId,
          data: {
            blockId: reconnectBlockId,
            updates: {
              status: 'error',
              tool_output: '自动重连失败，请手动重新打开任务。',
              toolOutput: '自动重连失败，请手动重新打开任务。',
            },
          },
        },
      }).catch(error => console.warn('[KCoder] 无法报告任务重连失败', safeGatewayFailureDiagnostic(error)))
      throw new Error(
        `自动恢复任务连接失败：${lastError instanceof Error ? lastError.message : String(lastError)}`
      )
    })
    this.disconnectRecoveryByTask.set(task.taskId, recovery)
    const clearRecovery = () => {
      if (this.disconnectRecoveryByTask.get(task.taskId) === recovery) {
        this.disconnectRecoveryByTask.delete(task.taskId)
      }
    }
    void recovery.then(clearRecovery, clearRecovery)
  }

  private bindTaskClient(taskId: string, client: GatewayClient) {
    const previousClient = this.clientByTask.get(taskId)
    this.clientByTask.set(taskId, client)
    if (previousClient && previousClient !== client) previousClient.close()
    client.addEventListener(
      'close',
      () => {
        if (this.clientByTask.get(taskId) !== client) return
        this.clientByTask.delete(taskId)
        const task = this.tasks.get(taskId)
        if (!task || this.disposed || this.isRestartingServer(task.serverId)) return
        const disconnectProjection = this.projectTaskClientDisconnect(taskId, client)
        if (task.ephemeral) {
          void disconnectProjection.finally(() => {
            this.tasks.delete(taskId)
            this.threadByTask.delete(taskId)
            this.taskByThread.delete(this.threadKey(task.serverId, task.threadId))
          })
          return
        }
        this.recoverTaskAfterDisconnect(task, disconnectProjection)
      },
      { once: true }
    )
  }

  private async projectTaskClientDisconnect(taskId: string, client: GatewayClient) {
    // WebSocket close guarantees only that earlier messages entered listeners, not that
    // asynchronous UI projection finished. Drain the queue before closing background
    // agents from final association state so an associated event cannot restore running after cleanup.
    await this.notificationQueueByClient.get(client)?.catch(error => {
      console.warn('[KCoder] 断线前通知投影失败', safeGatewayFailureDiagnostic(error))
    })
    if (this.disposed) return

    if (globalThis.localStorage?.getItem('wework:debug-runtime') === '1') {
      console.debug('[KCoder] Background disconnect projection', {
        taskId,
        jobs: [...this.backgroundJobById.entries()]
          .filter(([, job]) => job.taskId === taskId)
          .map(([jobId, job]) => ({
            jobId,
            turnId: job.turnId,
            toolCallId: job.toolCallId,
          })),
      })
    }

    for (const [key, pending] of this.pendingQuestionByKey) {
      if (pending.taskId !== taskId || pending.client !== client) continue
      this.pendingQuestionByKey.delete(key)
      if (pending.autoResolutionTimer !== undefined) {
        window.clearTimeout(pending.autoResolutionTimer)
      }
      await emit(EXECUTOR_EVENT, {
        event: 'response.block.updated',
        payload: {
          taskId,
          subtaskId: pending.turnId,
          deviceId: this.tasks.get(taskId)?.serverId,
          data: {
            blockId: pending.block.id,
            updates: { status: 'error' },
          },
        },
      }).catch(error => console.warn('[KCoder] 无法关闭已断线的交互请求', safeGatewayFailureDiagnostic(error)))
    }

    if (this.appServerDisconnectedClients.has(client)) {
      for (const [jobId, job] of this.backgroundJobById) {
        if (job.taskId !== taskId) continue
        this.backgroundJobById.delete(jobId, job)
        this.toolNameByCall.delete(`${job.taskId}\0${job.toolCallId}`)
        const output = {
          agent_id: jobId,
          status: 'interrupted',
          output: 'app-server 已退出，后台子 Agent 已中止。',
        }
        this.rememberInterruptedBackgroundTool(jobId, job, output)
        const jobBase = {
          taskId: job.taskId,
          subtaskId: job.turnId,
          deviceId: job.serverId,
        }
        await emit(EXECUTOR_EVENT, {
          event: 'response.output_item.done',
          payload: {
            ...jobBase,
            data: {
              item: {
                type: 'function_call',
                call_id: job.toolCallId,
                name: job.toolName,
                status: 'failed',
                output,
              },
            },
          },
        }).catch(error =>
          console.warn('[KCoder] 无法结束已退出 app-server 的后台子 Agent 工具块', safeGatewayFailureDiagnostic(error))
        )
        await emit(EXECUTOR_EVENT, {
          event: 'response.subagent.activity',
          payload: {
            ...jobBase,
            data: {
              agent_path: jobId,
              agent_name: job.toolName,
              kind: 'background',
              status: 'interrupted',
            },
          },
        }).catch(error =>
          console.warn('[KCoder] 无法结束已退出 app-server 的后台子 Agent 状态', safeGatewayFailureDiagnostic(error))
        )
      }
    }

    const active = this.activeTurnByTask.get(taskId)
    const preserveInternalTurn =
      active?.internal === true && !this.appServerDisconnectedClients.has(client)
    if (active && !preserveInternalTurn) {
      active.complete()
      this.activeTurnByTask.delete(taskId)
    }
    const task = this.tasks.get(taskId)
    if (!task) return
    this.tasks.set(taskId, { ...task, running: preserveInternalTurn, updatedAt: Date.now() })
    if (active && !preserveInternalTurn) {
      this.turnText.delete(`${taskId}:${active.turnId}`)
      this.turnAttemptIds.delete(`${taskId}:${active.turnId}`)
      await emit(EXECUTOR_EVENT, {
        event: 'response.failed',
        payload: {
          taskId,
          subtaskId: active.turnId,
          deviceId: task.serverId,
          data: { message: 'KCoder app-server 连接已断开，已停止当前任务' },
        },
      }).catch(error => {
        console.warn('[KCoder] 无法报告任务连接中断', safeGatewayFailureDiagnostic(error))
      })
    }
  }

  private rememberInterruptedBackgroundTool(
    jobId: string,
    job: GatewayBackgroundJob,
    output: Record<string, unknown>
  ) {
    const key = `${job.taskId}\0${job.toolCallId}`
    this.interruptedBackgroundToolByKey.delete(key)
    this.interruptedBackgroundToolByKey.set(key, {
      taskId: job.taskId,
      toolCallId: job.toolCallId,
      agentId: jobId,
      output,
    })
    while (this.interruptedBackgroundToolByKey.size > MAX_INTERRUPTED_BACKGROUND_TOOL_TOMBSTONES) {
      const oldest = this.interruptedBackgroundToolByKey.keys().next().value
      if (typeof oldest !== 'string') break
      this.interruptedBackgroundToolByKey.delete(oldest)
    }
  }

  private async emitBackgroundToolLifecycle(
    jobId: string,
    job: GatewayBackgroundJob,
    status: 'running' | 'paused' | 'completed' | 'failed' | 'interrupted',
    outputText = ''
  ) {
    await emit(EXECUTOR_EVENT, {
      event: 'response.output_item.done',
      payload: {
        taskId: job.taskId,
        subtaskId: job.turnId,
        deviceId: job.serverId,
        data: {
          item: {
            type: 'function_call',
            call_id: job.toolCallId,
            name: job.toolName,
            status: status === 'failed' || status === 'interrupted' ? 'failed' : 'completed',
            output: {
              agent_id: jobId,
              status,
              ...(outputText ? { output: outputText } : {}),
            },
          },
        },
      },
    })
  }

  private async cancelTask(params: Record<string, unknown>) {
    const address = record(params.address)
    const taskId = this.resolveTaskId(text(params.taskId) ?? text(address.taskId))
    const threadId = (taskId && this.threadByTask.get(taskId)) ?? text(address.threadId)
    const client = taskId ? this.clientByTask.get(taskId) : undefined
    const active = taskId ? this.activeTurnByTask.get(taskId) : undefined
    if (!taskId || !threadId || !client || !active) {
      return { accepted: false, interrupted: false, taskId }
    }
    const result = await client.request<{ interrupted?: boolean }>('turn/interrupt', {
      threadId,
      turnId: active.turnId,
    })
    return {
      accepted: result.interrupted === true,
      interrupted: result.interrupted === true,
      taskId,
    }
  }

  private async shortenWaitTask(params: Record<string, unknown>) {
    const address = record(params.address)
    const taskId = this.resolveTaskId(text(params.taskId) ?? text(address.taskId))
    const threadId = (taskId && this.threadByTask.get(taskId)) ?? text(address.threadId)
    const client = taskId ? this.clientByTask.get(taskId) : undefined
    const active = taskId ? this.activeTurnByTask.get(taskId) : undefined
    if (!taskId || !threadId || !client || !active) {
      return { accepted: false, shortened: false, taskId }
    }
    const result = await client.request<{ shortened?: boolean }>('turn/shorten_wait', {
      threadId,
      turnId: active.turnId,
    })
    return {
      accepted: true,
      shortened: result.shortened === true,
      taskId,
    }
  }

  private trackActiveTurn(taskId: string, turnId: string, internal = false) {
    let complete: () => void = () => {}
    const completion = new Promise<void>(resolve => {
      complete = resolve
    })
    this.activeTurnByTask.set(taskId, { turnId, internal, completion, complete })
  }

  private promptWithAttachments(
    prompt: string,
    execution: Record<string, unknown>,
    server: GatewayServer,
    sharedContext: Pick<SharedRuntimeContext, 'instructions' | 'personality'>,
    replacementPaths: ReadonlyMap<string, string> = new Map()
  ): string {
    const attachments = Array.isArray(execution.attachments) ? execution.attachments : []
    const lines = attachments.map(value => {
      const attachment = record(value)
      const path = text(attachment.local_path) ?? text(attachment.localPath)
      if (!path) throw new Error('附件缺少目标机路径')
      const staged = this.attachmentByPath.get(this.attachmentKey(server.id, path))
      if (!staged) {
        throw new Error(`附件不属于当前 KCoder 服务器：${server.id}`)
      }
      // Do not trust attachment metadata repeated by the caller. The filename was validated and
      // bound to this exact staged path by attachment/save; caller-controlled newlines here could
      // otherwise escape the structured prompt block.
      return JSON.stringify({
        filename: staged.filename,
        mimeType: staged.mimeType,
        fileSize: staged.fileSize,
        path: replacementPaths.get(path) ?? path,
      })
    })
    const withAttachments =
      lines.length > 0
        ? `${prompt}\n\n<kcoder_attachments version="1">\n${lines.join('\n')}\n</kcoder_attachments>`
        : prompt
    const instructions = sharedContext.instructions.trim()
    const personality = sharedContext.personality
    if (!instructions && personality === 'pragmatic') return withAttachments
    return `<kcoder_client_context personality="${personality}">\n${instructions}\n</kcoder_client_context>\n\n${withAttachments}`
  }

  private async promptWithAttachmentsForClient(
    prompt: string,
    execution: Record<string, unknown>,
    server: GatewayServer,
    client: GatewayClient,
    ownerThreadId?: string
  ): Promise<string> {
    const sharedContext = await this.sharedRuntimeContext(client)
    const attachments = Array.isArray(execution.attachments) ? execution.attachments : []
    const replacementPaths = new Map<string, string>()
    for (const value of attachments) {
      const attachment = record(value)
      const path = text(attachment.local_path) ?? text(attachment.localPath)
      if (!path) throw new Error('附件缺少目标机路径')
      let staged = this.attachmentByPath.get(this.attachmentKey(server.id, path))
      const attachmentThreadId =
        text(record(value).runtime_thread_id) ?? text(record(value).runtimeThreadId)
      if (attachmentThreadId && attachmentThreadId !== ownerThreadId) {
        throw new Error('历史附件所属 thread 与当前任务不一致')
      }
      if (attachmentThreadId && ownerThreadId) {
        const historical = await downloadGatewayAttachment(client, ownerThreadId, path)
        const contentBase64 = historical.contentBase64
        const filename = text(record(value).filename)
        if (!contentBase64 || !filename) throw new Error('历史附件内容或名称无效')
        const requestedMimeType = text(record(value).mime_type) ?? text(record(value).mimeType)
        staged = {
          serverId: server.id,
          filename,
          mimeType:
            requestedMimeType && /^[\w.+-]+\/[\w.+-]+$/.test(requestedMimeType)
              ? requestedMimeType
              : 'application/octet-stream',
          fileSize: historical.size,
          contentBase64,
        }
        this.attachmentByPath.set(this.attachmentKey(server.id, path), staged)
      }
      if (!staged) throw new Error(`附件不属于当前 KCoder 服务器：${server.id}`)
      const uploaded = await uploadGatewayAttachment(
        client,
        staged.filename,
        base64ToByteValues(staged.contentBase64)
      )
      replacementPaths.set(path, uploaded.path)
    }
    return this.promptWithAttachments(prompt, execution, server, sharedContext, replacementPaths)
  }

  private async waitForTurnCompletion(active: ActiveGatewayTurn) {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        active.completion,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('等待 KCoder app-server 中断任务超时')),
            10_000
          )
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private invalidateWorkspaceScans() {
    this.workspaceScanGeneration += 1
    this.taskListScans.invalidate()
    for (const client of this.transientClients) client.close()
    this.transientClients.clear()
  }

  dispose() {
    this.turnAttemptIds.clear()
    this.disposed = true
    this.stopAccountContextListener()
    this.toolPathPreviews.dispose()
    this.invalidateWorkspaceScans()
    if (typeof window !== 'undefined') {
      window.removeEventListener('kcoder:servers-changed', this.handleServersChanged)
    }
    for (const label of [...this.browserByLabel.keys()]) void this.closeBrowser(label)
    for (const client of this.clientByTask.values()) client.close()
    this.clientByTask.clear()
    this.canonicalTaskByRequested.clear()
    this.persistedThreadMisses.clear()
    this.resumeClientByTask.clear()
    for (const client of this.commandClientByServer.values())
      void client.then(
        value => value.close(),
        () => undefined
      )
    this.commandClientByServer.clear()
    void this.controlClientPromise?.then(
      client => client.close(),
      () => undefined
    )
    this.terminalByPublicId.clear()
    this.terminalByWireKey.clear()
    this.terminalTombstones.clear()
    this.attachmentUploads.clear()
    this.attachmentByPath.clear()
    for (const pending of this.pendingQuestionByKey.values()) {
      if (pending.autoResolutionTimer !== undefined)
        window.clearTimeout(pending.autoResolutionTimer)
    }
    this.pendingQuestionByKey.clear()
    this.toolNameByCall.clear()
    this.backgroundJobById.clear()
    this.interruptedBackgroundToolByKey.clear()
  }

  private async forwardServerRequest(
    client: GatewayClient,
    message: { id?: number; method?: string; params?: Record<string, unknown> },
    sourceServerId: string
  ) {
    if (
      (message.method !== 'question/request' && message.method !== 'approval/request') ||
      typeof message.id !== 'number'
    ) {
      if (typeof message.id === 'number') {
        client.respondError?.(
          message.id,
          -32601,
          `不支持的 app-server 请求：${message.method ?? ''}`
        )
      }
      return
    }
    const params = record(message.params)
    const threadId = text(params.threadId)
    const turnId = text(params.turnId)
    const taskId = threadId
      ? this.taskByThread.get(this.threadKey(sourceServerId, threadId))
      : undefined
    if (!taskId || !threadId || !turnId) {
      client.respondError?.(message.id, -32040, '交互请求无法关联到活动任务')
      return
    }
    if (message.method === 'approval/request') {
      await this.forwardApprovalRequest(client, message.id, params, taskId, turnId)
      return
    }
    const questions = Array.isArray(params.questions)
      ? params.questions.map((value, index) => {
          const question = record(value)
          return {
            id: text(question.id) ?? `question-${index + 1}`,
            header: text(question.header) ?? '',
            question: text(question.prompt) ?? text(question.question) ?? `Question ${index + 1}`,
            options: Array.isArray(question.options)
              ? question.options.map(optionValue => {
                  const option = record(optionValue)
                  return {
                    label: text(option.label) ?? text(option.value) ?? '',
                    description: text(option.description) ?? '',
                    ...(text(option.preview) ? { preview: text(option.preview) } : {}),
                  }
                })
              : [],
            isOther: question.allowsFreeform !== false,
            isSecret: question.isSecret === true,
            multiSelect: question.multiSelect === true,
          }
        })
      : []
    const requestId = message.id
    const itemId = text(params.questionId) ?? `question-${requestId}`
    const renderPayload = {
      kind: 'request_user_input',
      requestId,
      itemId,
      questions,
      ...(params.annotations === undefined ? {} : { annotations: params.annotations }),
    }
    const block = {
      id: `request-user-input-${requestId}`,
      type: 'tool',
      tool_name: 'request_user_input',
      toolName: 'request_user_input',
      status: 'pending',
      timestamp: Date.now(),
      render_payload: renderPayload,
      renderPayload,
    }
    const pendingQuestion: PendingGatewayQuestion = {
      client,
      requestId,
      taskId,
      turnId,
      block,
      renderPayload,
      questionId: itemId,
    }
    const autoResolutionMs = Number(params.autoResolutionMs)
    if (
      Number.isFinite(autoResolutionMs) &&
      autoResolutionMs >= 1_000 &&
      autoResolutionMs <= 240_000
    ) {
      pendingQuestion.autoResolutionTimer = window.setTimeout(() => {
        void this.respondToTaskQuestion(taskId, {
          requestId,
          answers: {},
          annotations: { autoResolved: true },
        }).catch(error => console.warn('[KCoder] 自动解决交互请求失败', safeGatewayFailureDiagnostic(error)))
      }, autoResolutionMs)
    }
    this.pendingQuestionByKey.set(`${taskId}\0${requestId}`, pendingQuestion)
    await emit(EXECUTOR_EVENT, {
      event: 'response.block.created',
      payload: {
        taskId,
        subtaskId: turnId,
        deviceId: sourceServerId,
        data: { block },
      },
    })
  }

  private async forwardApprovalRequest(
    client: GatewayClient,
    requestId: number,
    params: Record<string, unknown>,
    taskId: string,
    turnId: string
  ) {
    const approvalId = text(params.approvalId) ?? `approval-${requestId}`
    const action = record(params.action)
    const actionType = text(action.type)
    const toolInput =
      actionType === 'tool' ? (JSON.stringify(record(action.input), null, 2) ?? '{}') : ''
    const permissionInput =
      actionType === 'permission'
        ? (JSON.stringify(record(action.permissions), null, 2) ?? '{}')
        : ''
    const validAction =
      (actionType === 'command' && Boolean(text(action.command))) ||
      (actionType === 'file_change' && Boolean(text(action.itemId))) ||
      (actionType === 'permission' && permissionInput.length <= 4_000) ||
      (actionType === 'tool' && Boolean(text(action.name)) && toolInput.length <= 4_000)
    if (!validAction) {
      // Even this fail-closed decline must be attributable on a bound
      // connection, otherwise the server keeps the interaction pending.
      const declineBinding = interactionReplyBinding({
        requiresBinding: client.supportsExperimental?.('interactionBindingV1') === true,
        approvalId: text(params.approvalId),
        threadId: text(params.threadId),
        turnId: text(params.turnId),
      })
      client.respond?.(requestId, {
        decision: 'decline',
        ...(declineBinding.ok ? declineBinding.fields : {}),
      })
      await emit(EXECUTOR_EVENT, {
        event: 'response.failed',
        payload: {
          taskId,
          subtaskId: turnId,
          deviceId: this.tasks.get(taskId)?.serverId,
          data: {
            message:
              i18n.t('approvalUi.unsafe'),
          },
        },
      })
      return
    }
    const actionDescription =
      actionType === 'command'
        ? `Command: ${text(action.command)}`
        : actionType === 'file_change'
          ? `File change: ${text(action.path) ?? 'The current task requests a file write (no additional directory requested)'}`
          : actionType === 'permission'
            ? `Permission scope (cwd: ${text(action.cwd) ?? 'unknown'}):\n${permissionInput}`
            : `Tool: ${text(action.name)}\n${toolInput}`
    const reason = text(params.reason)
    const availableDecisions = Array.isArray(params.availableDecisions)
      ? params.availableDecisions.filter(value => typeof value === 'string')
      : []
    const allowsSession = availableDecisions.some(
      decision => decision === 'acceptForSession' || decision === 'accept_for_session'
    )
    const questions = [
      {
        id: approvalId,
        header: 'Permission request',
        question: [reason, actionDescription].filter(Boolean).join('\n\n'),
        options: [
          { label: 'Allow once', description: 'Allow this operation once.' },
          ...(allowsSession
            ? [
                {
                  label: 'Always allow for this session',
                  description: 'Allow similar operations for the current session.',
                },
              ]
            : []),
          { label: 'Decline', description: 'Decline this operation.' },
        ],
        isOther: false,
        multiSelect: false,
      },
    ]
    const renderPayload = {
      approvalPresentation: {
        kind: actionType,
        subject: actionType === 'command' ? text(action.command) : actionType === 'file_change' ? text(action.path) : actionType === 'permission' ? text(action.cwd) : text(action.name),
        input: actionType === 'permission' ? permissionInput : actionType === 'tool' ? toolInput : null,
        reason,
      },
      kind: 'request_user_input',
      requestId,
      itemId: approvalId,
      questions,
    }
    const block = {
      id: `request-user-input-${requestId}`,
      type: 'tool',
      tool_name: 'request_user_input',
      toolName: 'request_user_input',
      status: 'pending',
      timestamp: Date.now(),
      render_payload: renderPayload,
      renderPayload,
    }
    this.pendingQuestionByKey.set(`${taskId}\0${requestId}`, {
      client,
      requestId,
      taskId,
      turnId,
      block,
      renderPayload,
      approvalId,
      approvalDecisions: {
        'Allow once': 'accept',
        ...(allowsSession
          ? { 'Always allow for this session': 'accept_for_session' as const }
          : {}),
        Decline: 'decline',
      },
    })
    await emit(EXECUTOR_EVENT, {
      event: 'response.block.created',
      payload: {
        taskId,
        subtaskId: turnId,
        deviceId: this.tasks.get(taskId)?.serverId,
        data: { block },
      },
    })
  }

  private async respondToTaskQuestion(taskId: string | null, response: Record<string, unknown>) {
    if (!taskId) throw new Error('问题响应缺少任务地址')
    const responseRequestId =
      typeof response.requestId === 'number' || typeof response.requestId === 'string'
        ? String(response.requestId)
        : typeof response.request_id === 'number' || typeof response.request_id === 'string'
          ? String(response.request_id)
          : null
    const taskPending = [...this.pendingQuestionByKey.values()].filter(
      pending => pending.taskId === taskId
    )
    const pending = responseRequestId
      ? this.pendingQuestionByKey.get(`${taskId}\0${responseRequestId}`)
      : taskPending.length === 1
        ? taskPending[0]
        : undefined
    if (!pending) {
      return {
        success: false,
        accepted: false,
        taskId,
        runtime: KCODER_RUNTIME_NAME,
        error:
          taskPending.length > 1 && !responseRequestId
            ? 'request_user_input response is ambiguous without requestId'
            : 'request_user_input is not pending',
        code:
          taskPending.length > 1 && !responseRequestId
            ? 'ambiguous_request_user_input'
            : 'missing_request_user_input',
      }
    }
    if (!pending.client.respond) throw new Error('KCoder RPC 客户端不支持双向问题响应')
    if (pending.responsePending) {
      return {
        success: false,
        accepted: false,
        taskId,
        runtime: KCODER_RUNTIME_NAME,
        error: 'request_user_input response is awaiting server confirmation',
        code: 'request_user_input_response_pending',
      }
    }
    const answers = record(response.answers)
    const selectedApprovalLabel = Object.values(answers)
      .flatMap(value => {
        const answerValues = record(value).answers
        return Array.isArray(answerValues) ? answerValues : []
      })
      .find(value => typeof value === 'string')
    // A connection that negotiated `interactionBindingV1` rejects a reply that
    // does not name the interaction, so the identity is echoed here and a reply
    // that cannot be attributed is refused before it is sent.
    const binding = interactionReplyBinding({
      requiresBinding: pending.client.supportsExperimental?.('interactionBindingV1') === true,
      approvalId: pending.approvalId,
      questionId: pending.questionId,
      threadId: this.threadByTask.get(pending.taskId),
      turnId: pending.turnId,
    })
    if (!binding.ok) throw new Error(`无法确认交互归属：${binding.reason}`)
    pending.responsePending = true
    pending.submittedResponse = response
    try {
      pending.client.respond(
        pending.requestId,
        pending.approvalDecisions
          ? {
              decision:
                (typeof selectedApprovalLabel === 'string'
                  ? pending.approvalDecisions[selectedApprovalLabel]
                  : undefined) ?? 'decline',
              ...binding.fields,
            }
          : {
              answers,
              ...(response.annotations === undefined ? {} : { annotations: response.annotations }),
              ...binding.fields,
            }
      )
    } catch (error) {
      this.pendingQuestionByKey.delete(`${taskId}\0${pending.requestId}`)
      if (pending.autoResolutionTimer !== undefined)
        window.clearTimeout(pending.autoResolutionTimer)
      const message = error instanceof Error ? error.message : String(error)
      await emit(EXECUTOR_EVENT, {
        event: 'response.block.updated',
        payload: {
          taskId,
          subtaskId: pending.turnId,
          deviceId: this.tasks.get(taskId)?.serverId,
          data: {
            blockId: pending.block.id,
            updates: {
              status: 'error',
              tool_output: `响应发送失败：${message}`,
              toolOutput: `响应发送失败：${message}`,
            },
          },
        },
      })
      return {
        success: false,
        accepted: false,
        taskId,
        runtime: KCODER_RUNTIME_NAME,
        error: message,
        code: 'request_user_input_send_failed',
      }
    }
    const task = this.tasks.get(taskId)
    return {
      success: true,
      accepted: true,
      deviceId: task?.serverId,
      taskId,
      runtime: KCODER_RUNTIME_NAME,
      pendingServerConfirmation: true,
    }
  }

  private async forwardNotification(
    method: string,
    params: Record<string, unknown>,
    sourceServerId?: string,
    sourceClient?: GatewayClient,
    diagnosticConnection?: DiagnosticConnection
  ) {
    if (this.disposed) return
    if (!this.notificationReplayGuard.accept(method, params, sourceServerId)) return
    try {
      return await this.forwardAcceptedNotification(method, params, sourceServerId, sourceClient, diagnosticConnection)
    } catch (error) {
      this.notificationReplayGuard.release(method, params, sourceServerId)
      throw error
    }
  }

  private async forwardAcceptedNotification(
    method: string,
    params: Record<string, unknown>,
    sourceServerId?: string,
    sourceClient?: GatewayClient,
    diagnosticConnection?: DiagnosticConnection
  ) {
    if (method === 'mcp/authorizationChanged') {
      window.dispatchEvent(
        new CustomEvent('kcoder:mcp-authorization-changed', {
          detail: { ...params, deviceId: sourceServerId },
        })
      )
      return
    }
    if (method === 'automation/runStarted' && sourceServerId) {
      const threadId = text(params.threadId)
      const workspacePath = text(params.workspacePath)
      const server = (await this.servers()).find(server => server.id === sourceServerId)
      if (!threadId || !workspacePath || !server) return
      const taskId = runtimeTaskId(server, threadId)
      if (this.tasks.has(taskId)) return
      const now = Date.now()
      this.tasks.set(taskId, {
        serverId: server.id,
        taskId,
        threadId,
        workspacePath,
        title: text(params.title) ?? 'Scheduled task',
        runtime: 'kcoder',
        persisted: true,
        running: true,
        createdAt: now,
        updatedAt: now,
        runtimeHandle: { threadId },
      })
      this.taskByThread.set(this.threadKey(server.id, threadId), taskId)
      this.threadByTask.set(taskId, threadId)
      return
    }
    if (method === 'terminal/output') {
      const sessionId = text(params.session_id)
      const data = typeof params.data === 'string' ? params.data : ''
      if (!sessionId || !sourceServerId || !data) return
      const state = this.terminalState(sessionId, sourceServerId)
      if (!state) return
      const payload = { session_id: state.publicSessionId ?? sessionId, data }
      if (state.outputHandlers.size === 0) {
        state.bufferedOutput.push(payload)
        state.bufferedOutputBytes += data.length
        while (
          state.bufferedOutput.length > 1 &&
          state.bufferedOutputBytes > MAX_BUFFERED_TERMINAL_OUTPUT_BYTES
        ) {
          state.bufferedOutputBytes -= state.bufferedOutput.shift()?.data.length ?? 0
        }
      } else for (const handler of state.outputHandlers) handler(payload)
      return
    }
    if (method === 'terminal/exit') {
      const sessionId = text(params.session_id)
      if (!sessionId || !sourceServerId) return
      const state = this.terminalState(sessionId, sourceServerId)
      if (!state) return
      state.exited = true
      const payload = {
        session_id: state.publicSessionId ?? sessionId,
        exit_code: typeof params.exit_code === 'number' ? params.exit_code : null,
      }
      if (state.exitHandlers.size === 0) state.bufferedExit = payload
      else for (const handler of state.exitHandlers) handler(payload)
      return
    }
    if (method === 'question/resolved') {
      const requestId =
        typeof params.requestId === 'number' && Number.isFinite(params.requestId)
          ? params.requestId
          : undefined
      const threadId = text(params.threadId)
      const taskId =
        threadId && sourceServerId
          ? this.taskByThread.get(this.threadKey(sourceServerId, threadId))
          : undefined
      const pending =
        requestId !== undefined && taskId
          ? this.pendingQuestionByKey.get(`${taskId}\0${requestId}`)
          : undefined
      if (
        !pending ||
        pending.approvalDecisions ||
        (pending.questionId && pending.questionId !== text(params.questionId))
      )
        return
      this.pendingQuestionByKey.delete(`${pending.taskId}\0${pending.requestId}`)
      if (pending.autoResolutionTimer !== undefined)
        window.clearTimeout(pending.autoResolutionTimer)
      const reason = text(params.reason) ?? 'cancelled'
      const status = reason === 'client_response' ? 'done' : 'error'
      const explanation =
        reason === 'response_error'
          ? '回答发送后未被服务端接受。'
          : reason === 'cancelled'
            ? '问题请求已取消。'
            : '回答已由服务端确认。'
      const response = pending.submittedResponse
      const renderPayload = response
        ? { ...pending.renderPayload, response }
        : pending.renderPayload
      await emit(EXECUTOR_EVENT, {
        event: 'response.block.updated',
        payload: {
          taskId: pending.taskId,
          subtaskId: pending.turnId,
          deviceId: sourceServerId,
          data: {
            blockId: pending.block.id,
            updates: {
              status,
              renderPayload,
              tool_output: response ?? explanation,
              toolOutput: response ?? explanation,
            },
          },
        },
      })
      return
    }
    if (method === 'approval/resolved') {
      const requestId =
        typeof params.requestId === 'number' && Number.isFinite(params.requestId)
          ? params.requestId
          : undefined
      const threadId = text(params.threadId)
      const taskId =
        threadId && sourceServerId
          ? this.taskByThread.get(this.threadKey(sourceServerId, threadId))
          : undefined
      const pending =
        requestId !== undefined && taskId
          ? this.pendingQuestionByKey.get(`${taskId}\0${requestId}`)
          : undefined
      if (!pending || (pending.approvalId && pending.approvalId !== text(params.approvalId))) return
      this.pendingQuestionByKey.delete(`${pending.taskId}\0${pending.requestId}`)
      if (pending.autoResolutionTimer !== undefined)
        window.clearTimeout(pending.autoResolutionTimer)
      const reason = text(params.reason) ?? 'cancelled'
      const decision = text(params.decision) ?? 'decline'
      const status = reason === 'client_response' ? 'done' : 'error'
      const explanation =
        reason === 'timeout'
          ? i18n.t('approvalUi.timeout')
          : reason === 'response_error'
            ? i18n.t('approvalUi.responseFailed')
            : reason === 'cancelled'
              ? i18n.t('approvalUi.cancelled')
              : decision === 'accept'
                ? i18n.t('approvalUi.allowed')
                : i18n.t('approvalUi.declined')
      await emit(EXECUTOR_EVENT, {
        event: 'response.block.updated',
        payload: {
          taskId: pending.taskId,
          subtaskId: pending.turnId,
          deviceId: sourceServerId,
          data: {
            blockId: pending.block.id,
            updates: {
              status,
              tool_output: explanation,
              toolOutput: explanation,
            },
          },
        },
      })
      return
    }
    const threadId = text(params.threadId) ?? text(record(params.thread).id)
    const taskId =
      (threadId && sourceServerId
        ? this.taskByThread.get(this.threadKey(sourceServerId, threadId))
        : null) ??
      threadId ??
      'kcoder-task'
    const turn = record(params.turn)
    const turnId = text(params.turnId) ?? text(turn.id) ?? 'kcoder-turn'
    const turnKey = `${taskId}:${turnId}`
    const currentAttempt = this.turnAttemptIds.get(turnKey)
    const terminalAttempt = text(params.attemptId) ?? text(turn.attemptId)
    // A late terminal from an earlier continuation must not consume the
    // current attempt's text, identity or running state.
    if (method === 'turn/completed' && currentAttempt && terminalAttempt && currentAttempt !== terminalAttempt) return
    if (method === 'turn/started')
      this.turnAttemptIds.set(turnKey, text(params.attemptId) ?? turnId)
    const task = this.tasks.get(taskId)
    if (task && sourceServerId && sourceClient?.supportsExperimental?.('toolPathPreviewV1')) {
      this.toolPathPreviews.handle(method, params, sourceServerId, taskId, sourceClient)
    }
    const base = {
      taskId,
      subtaskId: this.turnAttemptIds.get(turnKey) ?? turnId,
      deviceId: task?.serverId ?? (await this.server()).id,
    }
    if (method === 'thread/goal/updated' || method === 'thread/goal/continuation') {
      await emit(EXECUTOR_EVENT, {
        event:
          method === 'thread/goal/continuation'
            ? 'runtime.goal.continuation'
            : params.goal == null
              ? 'runtime.goal.cleared'
              : 'runtime.goal.updated',
        payload: { ...base, subtaskId: text(params.turnId), data: { ...params, threadId } },
      })
      return
    }
    if (method === 'turn/started') {
      if (this.activeTurnByTask.get(taskId)?.turnId !== turnId) {
        this.trackActiveTurn(taskId, turnId, turn.internal === true)
      }
      if (task) this.tasks.set(taskId, { ...task, running: true, updatedAt: Date.now() })
      this.turnText.set(turnKey, '')
      await emit(EXECUTOR_EVENT, { event: 'response.created', payload: { ...base, data: {} } })
      return
    }
    if (method === 'item/delta') {
      const delta = rawDeltaText(record(params.delta).text)
      if (delta === null || delta === '') return
      this.turnText.set(turnKey, `${this.turnText.get(turnKey) ?? ''}${delta}`)
      await emit(EXECUTOR_EVENT, {
        event: 'response.output_text.delta',
        payload: { ...base, data: { delta } },
      })
      return
    }
    if (method === 'agent/steer/applied') {
      const agentId = text(params.agentId)
      const messageId = text(params.messageId)
      if (!agentId || !messageId) return
      const job = this.backgroundJobById.get(agentId, taskId, base.deviceId)
      await emit(EXECUTOR_EVENT, {
        event: 'response.subagent.activity',
        payload: {
          ...base,
          data: {
            agent_path: agentId,
            agent_id: agentId,
            agent_name: job?.toolName,
            kind: 'background',
            status: 'running',
            steer_status: 'applied',
            message_id: messageId,
            client_message_id: text(params.clientMessageId),
            occurred_at_ms: finiteNumber(params.appliedAtMs, Date.now()),
          },
        },
      })
      return
    }
    if (method === 'item/event') {
      const event = record(params.event)
      const eventType = text(event.type)
      if (eventType === 'error') {
        const providerFailure = decodeProviderFailure(event.provider_failure)
        if (!providerFailure) return
        await emit(EXECUTOR_EVENT, {
          event: 'response.failed',
          payload: {
            ...base,
            data: {
              message: text(event.error) ?? 'Provider request failed',
              provider_failure: providerFailure,
            },
          },
        })
        return
      }
      if (eventType === 'background_job_associated') {
        const jobId = text(event.id)
        const toolCallId = text(event.tool_call_id)
        if (!jobId || !toolCallId) return
        const toolName = this.toolNameByCall.get(`${taskId}\0${toolCallId}`) ?? 'spawn_agent'
        const job = {
          runId: text(record(record(params.identity).run).runId) ?? undefined,
          parentAttemptId: currentAttempt ?? text(params.attemptId) ?? undefined,
          taskId,
          turnId,
          toolCallId,
          toolName,
          serverId: base.deviceId,
        }
        const interrupted = this.interruptedBackgroundToolByKey.get(`${taskId}\0${toolCallId}`)
        if (interrupted) {
          await this.emitBackgroundToolLifecycle(
            interrupted.agentId,
            job,
            'interrupted',
            text(interrupted.output.output) ?? ''
          )
          await emit(EXECUTOR_EVENT, {
            event: 'response.subagent.activity',
            payload: {
              ...base,
              data: {
                agent_path: interrupted.agentId,
                agent_name: toolName,
                kind: 'background',
                status: 'interrupted',
              },
            },
          })
          return
        }
        this.backgroundJobById.set(jobId, job)
        await this.emitBackgroundToolLifecycle(jobId, job, 'running')
        await emit(EXECUTOR_EVENT, {
          event: 'response.subagent.activity',
          payload: {
            ...base,
            data: {
              agent_path: jobId,
              agent_name: toolName,
              kind: 'background',
              status: 'running',
            },
          },
        })
        reportBackgroundRunDiagnostic({ connection: diagnosticConnection,
          threadId, runId: job.runId, attemptId: job.parentAttemptId, status: 'running' })
        return
      }
      if (
        eventType === 'background_job_progress' ||
        eventType === 'background_job_promoted' ||
        eventType === 'background_job_paused'
      ) {
        const jobId = text(event.id)
        const job = jobId ? this.backgroundJobById.get(jobId, taskId, base.deviceId) : undefined
        if (!jobId || !job) return
        const runId = text(record(record(params.identity).run).runId)
        if (runId && job.runId !== runId) return
        const status = eventType === 'background_job_paused' ? 'paused' : 'running'
        await this.emitBackgroundToolLifecycle(jobId, job, status, text(event.reason) ?? '')
        await emit(EXECUTOR_EVENT, {
          event: 'response.subagent.activity',
          payload: {
            taskId: job.taskId,
            subtaskId: job.turnId,
            deviceId: job.serverId,
            data: {
              agent_path: jobId,
              agent_name: job.toolName,
              kind: 'background',
              status,
            },
          },
        })
        return
      }
      if (
        eventType === 'background_job_completed' ||
        eventType === 'background_job_failed' ||
        eventType === 'background_job_cancelled' ||
        eventType === 'background_job_halted'
      ) {
        const jobId = text(event.id)
        const job = jobId ? this.backgroundJobById.get(jobId, taskId, base.deviceId) : undefined
        if (!jobId || !job) return
        const runId = text(record(record(params.identity).run).runId)
        if (runId && job.runId !== runId) return
        const status =
          eventType === 'background_job_completed'
            ? event.is_error === true
              ? 'failed'
              : 'completed'
            : eventType === 'background_job_cancelled' || eventType === 'background_job_halted'
              ? 'interrupted'
              : 'failed'
        const output = text(event.text) ?? text(event.error) ?? text(event.reason) ?? ''
        const jobBase = {
          taskId: job.taskId,
          subtaskId: job.turnId,
          deviceId: job.serverId,
        }
        await this.emitBackgroundToolLifecycle(jobId, job, status, output)
        await emit(EXECUTOR_EVENT, {
          event: 'response.subagent.activity',
          payload: {
            ...jobBase,
            data: {
              agent_path: jobId,
              agent_name: job.toolName,
              kind: 'background',
              status,
            },
          },
        })
        if (runId) reportBackgroundRunDiagnostic({ connection: diagnosticConnection,
          threadId, runId, attemptId: job.parentAttemptId, status })
        this.backgroundJobById.delete(jobId, job)
        this.toolNameByCall.delete(`${job.taskId}\0${job.toolCallId}`)
        return
      }
      if (eventType !== 'assistant_thinking_delta') return
      const delta = text(event.text)
      if (!delta) return
      await emit(EXECUTOR_EVENT, {
        event: 'response.reasoning_summary_text.delta',
        payload: { ...base, data: { delta } },
      })
      return
    }
    if (method === 'item/started') {
      const item = record(params.item)
      if (item.type !== 'toolCall') return
      const callId = text(item.id)
      const toolName = text(item.name) ?? 'tool'
      if (callId) {
        const callKey = `${taskId}\0${callId}`
        const interrupted = this.interruptedBackgroundToolByKey.get(callKey)
        if (interrupted) {
          await this.emitBackgroundToolLifecycle(
            interrupted.agentId,
            {
              taskId,
              turnId,
              toolCallId: callId,
              toolName,
              serverId: base.deviceId,
            },
            'interrupted',
            text(interrupted.output.output) ?? ''
          )
          return
        }
        this.toolNameByCall.set(callKey, toolName)
      }
      await emit(EXECUTOR_EVENT, {
        event: 'response.output_item.added',
        payload: {
          ...base,
          data: {
            item: {
              type: 'function_call',
              call_id: callId,
              name: toolName,
              arguments: JSON.stringify(record(item.input)),
            },
          },
        },
      })
      return
    }
    if (method === 'item/completed') {
      const item = record(params.item)
      if (item.type !== 'toolCall') return
      const callId = text(item.id)
      const callKey = callId ? `${taskId}\0${callId}` : undefined
      const interrupted = callKey ? this.interruptedBackgroundToolByKey.get(callKey) : undefined
      if (callId && interrupted) {
        await this.emitBackgroundToolLifecycle(
          interrupted.agentId,
          {
            taskId,
            turnId,
            toolCallId: callId,
            toolName: text(item.name) ?? 'spawn_agent',
            serverId: base.deviceId,
          },
          'interrupted',
          text(interrupted.output.output) ?? ''
        )
        return
      }
      const backgroundEntry = callId
        ? [...this.backgroundJobById.entries()].find(
            ([, job]) => job.taskId === taskId && job.toolCallId === callId
          )
        : undefined
      const backgroundOutput = backgroundEntry
        ? {
            ...record(item.output),
            ...(typeof item.output === 'string' && item.output ? { output: item.output } : {}),
            agent_id: backgroundEntry[0],
            status: 'running',
          }
        : undefined
      await emit(EXECUTOR_EVENT, {
        event: 'response.output_item.done',
        payload: {
          ...base,
          data: {
            item: {
              type: 'function_call',
              call_id: callId,
              name: text(item.name) ?? 'tool',
              status: item.status === 'failed' ? 'failed' : 'completed',
              output: backgroundOutput ?? item.output,
            },
          },
        },
      })
      if (
        callId &&
        ![...this.backgroundJobById.values()].some(
          job => job.taskId === taskId && job.toolCallId === callId
        )
      ) {
        this.toolNameByCall.delete(`${taskId}\0${callId}`)
      }
      return
    }
    if (method === 'turn/completed') {
      const status = text(turn.status) ?? 'completed'
      const terminalError = text(record(params.error).message)
      const content = this.turnText.get(turnKey) ?? ''
      this.turnText.delete(turnKey)
      this.turnAttemptIds.delete(turnKey)
      if (this.pendingTurnStartByTask.has(taskId)) {
        this.completedTurnKeys.add(turnKey)
        if (this.completedTurnKeys.size > 512) {
          const oldest = this.completedTurnKeys.values().next().value
          if (oldest) this.completedTurnKeys.delete(oldest)
        }
      }
      const active = this.activeTurnByTask.get(taskId)
      if (task && (!active || active.turnId === turnId))
        this.tasks.set(taskId, { ...task, running: false, updatedAt: Date.now() })
      if (active?.turnId === turnId) {
        active.complete()
        this.activeTurnByTask.delete(taskId)
      }
      for (const [key, pending] of this.pendingQuestionByKey) {
        if (pending.taskId !== taskId || pending.turnId !== turnId) continue
        this.pendingQuestionByKey.delete(key)
        if (pending.autoResolutionTimer !== undefined) {
          window.clearTimeout(pending.autoResolutionTimer)
        }
        await emit(EXECUTOR_EVENT, {
          event: 'response.block.updated',
          payload: {
            ...base,
            data: {
              blockId: pending.block.id,
              updates: {
                status: 'error',
                tool_output: '交互请求随当前回合结束，未收到服务端确认。',
                toolOutput: '交互请求随当前回合结束，未收到服务端确认。',
              },
            },
          },
        })
      }
      await emit(EXECUTOR_EVENT, {
        event: status === 'completed' ? 'response.completed' : 'response.failed',
        payload: {
          ...base,
          data: {
            ...(status === 'completed' ? { value: content } : { message: terminalError ?? status }),
            ...(status !== 'completed'
              ? { provider_failure: decodeProviderFailure(record(params.error).details) }
              : {}),
            turnId,
            turn_id: turnId,
            ...(text(record(params.fileChanges).artifact_id)
              ? {
                  file_changes: {
                    ...record(params.fileChanges),
                    device_id: base.deviceId,
                  },
                }
              : {}),
          },
        },
      })
    }
  }
}

export function installGatewayPageRuntime(
  overrides: Partial<GatewayRuntimeLifecycleDependencies<KCoderGatewayRuntime>> = {}
) {
  const installation = installGatewayRuntimeLifecycle({
    readToken: () => (typeof document === 'undefined' ? null : gatewayToken()),
    createRuntime: token => new KCoderGatewayRuntime(token),
    createIpcHandler: createGatewayPageIpcHandler,
    installIpc: installGatewayIpc,
    installNavigation: installDesktopHostNavigation,
    registerWorkspaceRuntime: registerGatewayWorkspaceSessionRuntime,
    addBeforeUnload: listener => addEventListener('beforeunload', listener, { once: true }),
    removeBeforeUnload: listener => removeEventListener('beforeunload', listener),
    ...overrides,
  })
  if (installation)
    void syncDesktopPreferences(readPreferences()).catch(error => {
      console.error('Failed to synchronize desktop preferences', safeGatewayFailureDiagnostic(error))
    })
  return installation
}

function createGatewayPageIpcHandler(runtime: KCoderGatewayRuntime) {
  return async (command: string, payload?: unknown) => {
    const args = record(payload)
    if (command === 'local_executor_copy_debug_info') {
      if (typeof args.text !== 'string' || args.text.length > 1024 * 1024)
        throw new Error('Invalid clipboard text')
      return copyTextToClipboard(args.text)
    }
    if (command === 'get_app_preferences') return syncDesktopPreferences(readPreferences())
    if (command === 'update_app_preferences') {
      return syncDesktopPreferences(writePreferences(args.patch))
    }
    if (command === 'set_tray_menu_state') return syncDesktopTrayState(record(args.state))
    if (command === 'close_main_window_to_tray') {
      const host = desktopHost()
      if (!host) throw new Error('System tray is only available in the desktop application')
      return host.hideToTray()
    }
    if (desktopHost() && command.startsWith('plugin:window|')) {
      const actions: Record<string, string> = {
        'plugin:window|close': 'close',
        'plugin:window|minimize': 'minimize',
        'plugin:window|is_maximized': 'isMaximized',
        'plugin:window|toggle_maximize': 'toggleMaximize',
      }
      const action = actions[command]
      if (action) return desktopHost()?.windowAction(action)
    }
    if (
      command === 'local_executor_ensure_started' ||
      command === 'local_executor_status' ||
      command === 'local_executor_connect_backend' ||
      command === 'local_executor_disconnect_backend'
    ) {
      return runtime.status()
    }
    if (command === 'local_executor_request') {
      return runtime.request(text(args.method) ?? '', args.params, { signal: args.signal instanceof AbortSignal ? args.signal : undefined })
    }
    if (command === LEGACY_KCODER_STUDIO_TAURI_COMMANDS.readRuntimeConfig) {
      return readGatewayRuntimeConfig()
    }
    if (command === LEGACY_KCODER_STUDIO_TAURI_COMMANDS.updateRuntimeConfig) {
      return updateGatewayRuntimeConfig(args.patch)
    }
    if (command === 'save_local_attachment_file') return runtime.saveAttachmentForIpc(args)
    if (command === 'start_local_attachment_upload') return runtime.startAttachmentUpload(args)
    if (command === 'append_local_attachment_upload') return runtime.appendAttachmentUpload(args)
    if (command === 'finish_local_attachment_upload') return runtime.finishAttachmentUpload(args)
    if (command === 'cancel_local_attachment_upload') return runtime.cancelAttachmentUpload(args)
    if (command === 'read_local_attachment_file') return runtime.readAttachment(args)
    if (command === 'embedded_browser_open') return runtime.openBrowser(args)
    if (command === 'embedded_browser_set_bounds') return runtime.setBrowserBounds(args)
    if (command === 'embedded_browser_navigate') {
      return runtime.controlBrowser(args.label, {
        action: 'navigate',
        url: text(args.url),
      })
    }
    if (command === 'embedded_browser_reload') {
      return runtime.controlBrowser(args.label, { action: 'reload' })
    }
    if (command === 'embedded_browser_go_back') {
      return runtime.controlBrowser(args.label, { action: 'back' })
    }
    if (command === 'embedded_browser_go_forward') {
      return runtime.controlBrowser(args.label, { action: 'forward' })
    }
    if (command === 'embedded_browser_eval') {
      await runtime.evaluateBrowser(args)
      return null
    }
    if (command === 'embedded_browser_eval_json') return runtime.evaluateBrowser(args)
    if (command === 'embedded_browser_page_state') {
      return runtime.readBrowserPageState(args.label)
    }
    if (command === 'embedded_browser_relabel') {
      return runtime.relabelBrowser(args.fromLabel, args.toLabel)
    }
    if (command === 'embedded_browser_close') return runtime.closeBrowser(args.label)
    if (command === 'embedded_browser_clear_data') return runtime.clearBrowserData()
    if (
      command === 'embedded_browser_pause_download' ||
      command === 'embedded_browser_resume_download' ||
      command === 'embedded_browser_delete_download'
    ) {
      throw new Error('KCoder 远程浏览器暂不支持下载管理')
    }
    if (command === 'local_executor_read_log') {
      const status = await runtime.status()
      return {
        path: '',
        content: 'KCoder browser gateway transport',
        truncated: false,
        lineCount: 1,
        transport: 'stdio',
        transportConnected: true,
        processPids: [],
        processPaths: [],
        sidecarSource: 'browser-gateway',
        sidecarPath: '',
        currentDir: '',
        executorHome: '',
        backendUrl: null,
        hasBackendAuthToken: false,
        pendingRequestCount: 0,
        status,
      }
    }
    if (command === 'take_pending_system_drag_drops') return []
    if (command === 'get_appshots_status') {
      return {
        supported: false,
        shortcut: 'CommandOrControl+Shift+2',
        shortcutRegistered: false,
        screenCapturePermissionGranted: false,
        accessibilityPermissionGranted: false,
      }
    }
    if (
      command === 'take_pending_local_workspace_open_requests' ||
      command === 'take_pending_appshots'
    ) {
      return []
    }
    if (command === 'get_process_diagnostics_snapshot') return { processes: [] }
    if (
      command === 'register_frontend_recovery_bridge' ||
      command === 'acknowledge_frontend_resume_probe' ||
      command === 'log_system_drag_debug' ||
      command === 'open_appshots_permission_settings' ||
      command === 'acknowledge_appshot' ||
      command === 'plugin:log|log'
    ) {
      return null
    }
    if (command.startsWith('plugin:window|')) return null
    throw new Error(`KCoder browser mode does not support native command: ${command}`)
  }
}

installGatewayPageRuntime()
