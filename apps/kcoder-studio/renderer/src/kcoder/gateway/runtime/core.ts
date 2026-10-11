import { listenAccountContextChanges } from '../../accountContextEvents'
import { BackgroundJobRegistry } from '../../backgroundJobRegistry'
import { type OwnedRuntimeClient } from '../../gatewayAppServerRestart'
import { GatewayBrowserRuntime } from '../../gatewayBrowserRuntime'
import { GatewayRemoteSessions } from '../../gatewayRemoteSessions'
import { fetchGatewayServers, GatewayRpcClient, type GatewayServer } from '../../gatewayRpc'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
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
} from './contracts'
import * as history from './history'
import * as interactions from './interactions'
import * as lifecycle from './lifecycle'
import * as notifications from './notifications'
import * as recovery from './recovery'
import * as resources from './resources'
import * as threads from './threads'
import * as turns from './turns'

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
  readonly ownedRuntimeClients = new Map<GatewayClient, OwnedRuntimeClient>()
  controlClientPromise: Promise<GatewayClient> | null = null
  selectedServer: GatewayServer | null = null
  readonly agentConversationSubscriptions = new Map<
    string,
    {
      client: GatewayClient
      serverId: string
      taskId: string
      threadId: string
      agentId: string
      assertCurrent: () => void
      removeCloseListener?: () => void
    }
  >()
  readonly clientByTask = new Map<string, GatewayClient>()
  readonly resumeClientByTask = new Map<string, Promise<GatewayClient>>()
  readonly disconnectRecoveryByTask = new Map<string, Promise<void>>()
  readonly notificationQueueByClient = new WeakMap<GatewayClient, Promise<void>>()
  readonly notificationReplayGuard = new NotificationReplayGuard()
  readonly toolPathPreviews = new ToolPathPreviewConsumer()
  readonly appServerDisconnectedClients = new WeakSet<GatewayClient>()
  readonly pendingAsyncJobs = new Set<Promise<void>>()
  readonly commandClientByServer = new Map<string, Promise<GatewayClient>>()
  readonly workspaceOperationByKey = new Map<string, Promise<void>>()
  readonly taskListScans = new WorkspaceListScan<GatewayServer, GatewayWorkspaceDescriptor>()
  readonly transientClients = new Set<GatewayClient>()
  workspaceScanGeneration = 0
  readonly workspaceDescriptorCache = new Map<GatewayServer, GatewayWorkspaceDescriptor[]>()
  readonly threadByTask = new Map<string, string>()
  readonly taskByThread = new Map<string, string>()
  readonly persistedThreadMisses = new Map<string, number>()
  readonly canonicalTaskByRequested = new Map<string, string>()
  readonly turnText = new Map<string, string>()
  readonly turnAttemptIds = new Map<string, string>()
  readonly toolNameByCall = new Map<string, string>()
  readonly backgroundJobById = new BackgroundJobRegistry<GatewayBackgroundJob>()
  readonly interruptedBackgroundToolByKey = new Map<string, InterruptedGatewayBackgroundTool>()
  readonly tasks = new Map<string, GatewayTask>()
  readonly archivedTasks = new Map<string, GatewayTask>()
  readonly taskMetadata = readTaskMetadata()
  readonly activeTurnByTask = new Map<string, ActiveGatewayTurn>()
  readonly completedTurnKeys = new Set<string>()
  readonly pendingTurnStartByTask = new Set<string>()
  readonly pendingQuestionByKey = new Map<string, PendingGatewayQuestion>()
  readonly browserRuntime: GatewayBrowserRuntime
  readonly remoteSessions: GatewayRemoteSessions
  readonly accountEpochByTarget = new Map<string, object>()
  readonly accountClients = new Map<GatewayClient, string>()
  readonly handleServersChanged = (event?: Event) => {
    const targetId = (event as CustomEvent<{ targetId?: string }> | undefined)?.detail?.targetId
    this.serversPromise = null
    this.selectedServer = null
    this.invalidateWorkspaceScans()
    this.workspaceDescriptorCache.clear()
    for (const [key, client] of this.commandClientByServer) {
      if (targetId && !key.startsWith(`${targetId}\0`)) continue
      void client.then(
        value => value.close(),
        () => undefined
      )
      this.commandClientByServer.delete(key)
    }
  }
  stopAccountContextListener: () => void = () => {}
  invalidateAccountTarget = connections.invalidateAccountTarget
  trackAsyncJob = connections.trackAsyncJob
  servers = connections.servers
  server = connections.server
  sharedRuntimeContext = connections.sharedRuntimeContext
  serverForParams = connections.serverForParams
  connectClient = connections.connectClient
  controlClient = connections.controlClient
  commandClient = connections.commandClient
  closeCachedCommandClient = connections.closeCachedCommandClient
  handleCommandClientClose = connections.handleCommandClientClose
  withTransientClient = connections.withTransientClient
  withWorkspaceOperation = connections.withWorkspaceOperation
  workspaceDescriptors = connections.workspaceDescriptors
  serverForBrowserLabel = resources.serverForBrowserLabel
  openBrowser = resources.openBrowser
  setBrowserBounds = resources.setBrowserBounds
  controlBrowser = resources.controlBrowser
  evaluateBrowser = resources.evaluateBrowser
  readBrowserPageState = resources.readBrowserPageState
  relabelBrowser = resources.relabelBrowser
  closeBrowser = resources.closeBrowser
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
  releaseRestartClient = lifecycle.releaseRestartClient
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
    this.remoteSessions = new GatewayRemoteSessions({
      resolveServer: params => this.serverForParams(params),
      commandClient: (server, workspacePath) => this.commandClient(server, workspacePath),
    })
    if (typeof window !== 'undefined') {
      window.addEventListener('kcoder:servers-changed', this.handleServersChanged)
      this.stopAccountContextListener = listenAccountContextChanges(targetId =>
        this.invalidateAccountTarget(targetId)
      )
    }
  }
}
