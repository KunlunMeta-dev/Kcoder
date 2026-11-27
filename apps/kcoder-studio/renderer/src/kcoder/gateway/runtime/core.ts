import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { listenAccountContextChanges } from '../../accountContextEvents'
import { BackgroundJobRegistry } from '../../backgroundJobRegistry'
import { GatewayBrowserRuntime } from '../../gatewayBrowserRuntime'
import { browserProfiles } from '../../gatewayBrowserProfiles'
import { GatewayRemoteSessions } from '../../gatewayRemoteSessions'
import { fetchGatewayServers, GatewayRpcClient, type GatewayServer } from '../../gatewayRpc'
import type { GatewayClient, OwnedGatewayConnection } from '../../gatewayRuntimeTypes'
import { NotificationReplayGuard } from '../../notificationReplayGuard'
import { ToolPathPreviewConsumer } from '../../toolPathPreview'
import { WorkspaceListScan } from '../../workspaceListScan'
import * as archives from './archives'
import * as catalog from './catalog'
import { standaloneCompatibility, type GatewayRuntimeCompatibility } from './compatibility'
import * as connections from './connections'
import {
  readTaskMetadata,
  type ActiveGatewayTurn,
  type GatewayBackgroundJob,
  type GatewayTask,
  type GatewayWorkspaceDescriptor,
  type InterruptedGatewayBackgroundTool,
  type KCoderGatewayRuntimeOptions,
  type PendingGatewayQuestion,
  type SharedRuntimeContext,
} from './contracts'
import * as history from './history'
import * as interactions from './interactions'
import * as lifecycle from './lifecycle'
import * as notifications from './notifications'
import * as recovery from './recovery'
import * as resources from './resources'
import * as threads from './threads'
import * as turns from './turns'
import type { TaskViewGeneration } from './sessionLifetime'
import { captureResidencyOwner, requestResidentTaskRpc } from './threadResidency'

/** Single owner of connections, subscriptions, registries and runtime state. */
export class GatewayRuntimeCore {
  readonly compatibility: GatewayRuntimeCompatibility
  readonly token: string
  readonly loadServers: () => Promise<GatewayServer[]>
  readonly createClient: (
    serverId: string,
    token: string,
    channel?: 'runtime' | 'browser',
    workspacePath?: string
  ) => GatewayClient
  serversPromise: Promise<GatewayServer[]> | null = null
  disposed = false
  restartingAppServers = false
  restartingServerId: string | null = null
  readonly connectionsByClient = new Map<GatewayClient, OwnedGatewayConnection>()
  selectedServer: GatewayServer | null = null
  readonly agentConversationSubscriptions = new Map<
    string,
    {
      client: GatewayClient
      serverId: string
      taskId: string
      threadId: string
      agentId: string
      expectedBackgroundRun?: import('../../../../../shared/generated/contracts').BackgroundRunKey
      assertCurrent: () => void
      removeCloseListener?: () => void
    }
  >()
  readonly taskViewGenerations = new Map<string, TaskViewGeneration>()
  readonly clientByTask = new Map<string, GatewayClient>()
  readonly resumeClientByTask = new Map<string, Promise<GatewayClient>>()
  readonly disconnectRecoveryByTask = new Map<string, Promise<void>>()
  readonly runtimeContextReads = new WeakMap<GatewayClient, {
    generation: number
    connectionId: string | undefined
    promise: Promise<SharedRuntimeContext>
  }>()
  readonly notificationQueueByClient = new WeakMap<GatewayClient, Promise<void>>()
  readonly notificationReplayGuard = new NotificationReplayGuard()
  readonly toolPathPreviews = new ToolPathPreviewConsumer()
  readonly appServerDisconnectedClients = new WeakSet<GatewayClient>()
  readonly pendingAsyncJobs = new Set<Promise<void>>()
  readonly commandClientScopeByKey = new Map<string, string>()
  readonly serverIdentityById = new Map<string, string>()
  readonly configurationEpochByTarget = new Map<string, object>()
  commandDirectorySequence = 0
  readonly commandDirectoryRefresh = new Map<
    string | undefined,
    { sequence: number; result: Promise<GatewayServer[]> }
  >()
  readonly commandClientByServer = new Map<string, Promise<GatewayClient>>()
  readonly workspaceOperationByKey = new Map<string, Promise<void>>()
  readonly taskListScans = new WorkspaceListScan<GatewayServer, GatewayWorkspaceDescriptor>()
  workspaceScanGeneration = 0
  workspaceScanAbort = new AbortController()
  readonly workspaceDescriptorCache = new Map<GatewayServer, GatewayWorkspaceDescriptor[]>()
  readonly threadByTask = new Map<string, string>()
  readonly taskByThread = new Map<string, string>()
  readonly persistedThreadMisses = new Map<string, number>()
  readonly canonicalTaskByRequested = new Map<string, string>()
  /** Null means a disconnect left a gap in the turn's streamed text. */
  readonly turnText = new Map<string, string | null>()
  readonly turnAttemptIds = new Map<string, string>()
  readonly toolNameByCall = new Map<string, string>()
  readonly backgroundJobById = new BackgroundJobRegistry<GatewayBackgroundJob>()
  readonly interruptedBackgroundToolByKey = new Map<string, InterruptedGatewayBackgroundTool>()
  readonly tasks = new Map<string, GatewayTask>()
  readonly archivedTasks = new Map<string, GatewayTask>()
  readonly taskMetadata = readTaskMetadata()
  readonly activeTurnByTask = new Map<string, ActiveGatewayTurn>()
  readonly turnReceiptObservers = new Map<string, AbortController>()
  readonly completedTurnKeys = new Set<string>()
  readonly completedTurnAttemptKeys = new Set<string>()
  readonly pendingTurnStartByTask = new Set<string>()
  pendingTaskInputs = new Map<string, Set<symbol>>()
  readonly pendingQuestionByKey = new Map<string, PendingGatewayQuestion>()
  readonly browserRuntime: GatewayBrowserRuntime
  readonly remoteSessions: GatewayRemoteSessions
  readonly accountEpochByTarget = new Map<string, object>()
  readonly handleServersChanged = (event?: Event) => {
    const targetId = (event as CustomEvent<{ targetId?: string }> | undefined)?.detail?.targetId
    const previousIdentities = new Map(this.serverIdentityById)
    this.serversPromise = null
    this.selectedServer = null
    this.invalidateWorkspaceScans()
    this.workspaceDescriptorCache.clear()
    connections.refreshCommandDirectory.call(this, targetId, previousIdentities)
  }
  /** Reuse directory and target identities without caching an authorization verdict. */
  captureReadSource(targetId?: string): () => boolean {
    if (this.disposed) throw new DOMException('Executor source is disposed', 'AbortError')
    if (!targetId) {
      const sequence = this.commandDirectorySequence
      return () => !this.disposed && sequence === this.commandDirectorySequence
    }
    const account = this.accountEpochByTarget.get(targetId) ?? {}
    this.accountEpochByTarget.set(targetId, account)
    const configuration = this.configurationEpochByTarget.get(targetId)
    const allTargets = this.commandDirectoryRefresh.get(undefined)
    const target = this.commandDirectoryRefresh.get(targetId)
    return () => !this.disposed && account === this.accountEpochByTarget.get(targetId) &&
      configuration === this.configurationEpochByTarget.get(targetId) &&
      allTargets === this.commandDirectoryRefresh.get(undefined) && target === this.commandDirectoryRefresh.get(targetId)
  }
  stopAccountContextListener: () => void = () => {}
  invalidateAccountTarget = connections.invalidateAccountTarget
  trackAsyncJob = connections.trackAsyncJob
  servers = connections.servers
  server = connections.server
  sharedRuntimeContext = connections.sharedRuntimeContext
  serverForParams = connections.serverForParams
  connectClient = connections.connectClient
  assertCommandTarget = (server: GatewayServer) => connections.assertCommandOwner(this, server)
  commandClient = connections.commandClient
  closeCachedCommandClient = connections.closeCachedCommandClient
  handleCommandClientClose = connections.handleCommandClientClose
  withTransientClient = connections.withTransientClient
  withWorkspaceReadClient = connections.withWorkspaceReadClient
  withWorkspaceOperation = connections.withWorkspaceOperation
  workspaceDescriptors = connections.workspaceDescriptors
  serverForBrowserLabel = resources.serverForBrowserLabel
  openBrowser = resources.openBrowser
  browserProfiles = browserProfiles
  browserHandoff = resources.browserHandoff
  setBrowserBounds = resources.setBrowserBounds
  controlBrowser = resources.controlBrowser
  evaluateBrowser = resources.evaluateBrowser
  readBrowserPageState = resources.readBrowserPageState
  relabelBrowser = resources.relabelBrowser
  closeBrowser = resources.closeBrowser
  closeBrowserForAccountSwitch = resources.closeBrowserForAccountSwitch
  clearBrowserData = resources.clearBrowserData
  status = resources.status
  saveAttachment = resources.saveAttachment
  startAttachmentUpload = resources.startAttachmentUpload
  appendAttachmentUpload = resources.appendAttachmentUpload
  finishAttachmentUpload = resources.finishAttachmentUpload
  cancelAttachmentUpload = resources.cancelAttachmentUpload
  saveAttachmentForIpc = resources.saveAttachmentForIpc
  readAttachment = resources.readAttachment
  startTerminal = resources.startTerminal
  restoreTerminal = resources.restoreTerminal
  createTerminalClient = resources.createTerminalClient
  threadKey = resources.threadKey
  resolveTaskId = resources.resolveTaskId
  request = catalog.request
  executeDeviceCommand = resources.executeDeviceCommand
  persistLocalTaskMetadata = archives.persistLocalTaskMetadata
  updateTaskMetadata = archives.updateTaskMetadata
  storedTask = archives.storedTask
  renameTask = archives.renameTask
  archiveTask = archives.archiveTask
  listArchivedTasks = archives.listArchivedTasks
  unarchiveTask = archives.unarchiveTask
  deleteArchivedTask = archives.deleteArchivedTask
  deleteArchivedTasksBulk = archives.deleteArchivedTasksBulk
  cleanupArchivedTasks = archives.cleanupArchivedTasks
  archiveMatchingTasks = archives.archiveMatchingTasks
  archiveProjectTasks = archives.archiveProjectTasks
  archiveAllTasks = archives.archiveAllTasks
  searchTasks = history.searchTasks
  searchTaskTranscript = history.searchTaskTranscript
  hydrateAllPersistedTasks = history.hydrateAllPersistedTasks
  managedWorktrees = history.managedWorktrees
  hydrateArchivedWorktreeTasks = history.hydrateArchivedWorktreeTasks
  restoreArchivedTaskWorkspace = history.restoreArchivedTaskWorkspace
  removeArchivedWorktreeConversation = history.removeArchivedWorktreeConversation
  worktreeConversationReferences = history.worktreeConversationReferences
  linkManagedWorktreeConversation = history.linkManagedWorktreeConversation
  hydratePersistedTasks = history.hydratePersistedTasks
  loadTaskTranscript = history.loadTaskTranscript
  disposeTemporaryTask = threads.disposeTemporaryTask
  createTask = threads.createTask
  forkTaskAtTurn = threads.forkTaskAtTurn
  isRestartingServer = lifecycle.isRestartingServer
  assertRequestTargetAvailable = lifecycle.assertRequestTargetAvailable
  restartAppServers = lifecycle.restartAppServers
  unregisterClient = lifecycle.unregisterClient
  releaseClient = lifecycle.releaseClient
  sendTask = turns.sendTask
  resumeTask = turns.resumeTask
  readyTaskClient = turns.readyTaskClient
  taskDescriptor = turns.taskDescriptor
  taskConnection = turns.taskConnection
  compactTask = turns.compactTask
  rollbackTask = turns.rollbackTask
  revertTaskFileChanges = turns.revertTaskFileChanges
  guideTask = turns.guideTask
  steerSubagent = turns.steerSubagent
  readSubagentArtifact = turns.readSubagentArtifact
  promptWithApplicationContext = turns.promptWithApplicationContext
  getTaskGoal = turns.getTaskGoal
  setTaskGoal = turns.setTaskGoal
  clearTaskGoal = turns.clearTaskGoal
  resumeTaskOnce = recovery.resumeTaskOnce
  emitSubagentSnapshot = recovery.emitSubagentSnapshot
  recoverTaskAfterDisconnect = recovery.recoverTaskAfterDisconnect
  bindTaskClient = recovery.bindTaskClient
  projectTaskClientDisconnect = recovery.projectTaskClientDisconnect
  rememberInterruptedBackgroundTool = recovery.rememberInterruptedBackgroundTool
  emitBackgroundToolLifecycle = recovery.emitBackgroundToolLifecycle
  cancelTask = turns.cancelTask
  shortenWaitTask = turns.shortenWaitTask
  trackActiveTurn = turns.trackActiveTurn
  waitForTurnCompletion = turns.waitForTurnCompletion
  invalidateWorkspaceScans = lifecycle.invalidateWorkspaceScans
  dispose = lifecycle.dispose
  disposeAsync = lifecycle.disposeAsync
  forwardServerRequest = interactions.forwardServerRequest
  forwardApprovalRequest = interactions.forwardApprovalRequest
  respondToTaskQuestion = interactions.respondToTaskQuestion
  forwardNotification = notifications.forwardNotification
  forwardAcceptedNotification = notifications.forwardAcceptedNotification
  constructor(
    token: string,
    options: KCoderGatewayRuntimeOptions = {},
    compatibility = standaloneCompatibility
  ) {
    this.compatibility = compatibility
    this.token = token
    this.loadServers = options.loadServers ?? (() => fetchGatewayServers())
    this.createClient =
      options.createClient ??
      ((serverId, capabilityToken, channel, workspacePath) =>
        new GatewayRpcClient(serverId, capabilityToken, WebSocket, channel, workspacePath))
    this.browserRuntime = new GatewayBrowserRuntime({
      resolveServerForLabel: label => this.serverForBrowserLabel(label),
      connectBrowserClient: server => this.connectClient(server, 'browser'),
    })
    const attachmentTask = (server: GatewayServer, workspacePath: string | undefined, threadId: string) =>
      [...this.tasks.values()].find(
        task => task.serverId === server.id && task.threadId === threadId &&
          (!workspacePath || sameWorkspacePath(task.workspacePath, workspacePath))
      )
    this.remoteSessions = new GatewayRemoteSessions({
      resolveServer: params => this.serverForParams(params),
      commandClient: (server, workspacePath) => this.commandClient(server, workspacePath),
      taskClient: async (server, workspacePath, threadId) => {
        const task = attachmentTask(server, workspacePath, threadId)
        if (!task) throw new Error('Attachment task owner is unavailable')
        return this.readyTaskClient(task)
      },
      attachedTaskReader: (server, workspacePath, threadId) => {
        const task = attachmentTask(server, workspacePath, threadId)
        const client = task ? this.clientByTask.get(task.taskId) : undefined
        if (!task || !client) return undefined
        const assertCurrent = captureResidencyOwner(this, task, client)
        return {
          client,
          request: <T>(method: string, params?: Record<string, unknown>, options?: { signal?: AbortSignal }) =>
            requestResidentTaskRpc<T>(this, task, client, method, params ?? {}, { ...options, assertCurrent }),
        }
      },
    })
    if (typeof window !== 'undefined') {
      window.addEventListener('kcoder:servers-changed', this.handleServersChanged)
      this.stopAccountContextListener = listenAccountContextChanges(targetId =>
        this.invalidateAccountTarget(targetId)
      )
    }
  }
}
