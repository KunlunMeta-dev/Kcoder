import type { createDeviceApi, DeviceListOptions, DeviceCommandReadSource } from '@/api/devices'
import type { createRuntimeWorkApi } from '@/api/runtimeWork'
import type {
  DeviceCommandResponse,
  DeviceInfo,
  LocalDeviceSkill,
  RuntimeRollbackRequest,
  RuntimeGoalClearRequest,
  RuntimeGoalClearResponse,
  RuntimeGoalGetRequest,
  RuntimeSessionModesRequest,
  RuntimeSessionModesResponse,
  RuntimeGoalGetResponse,
  RuntimeGoalSetRequest,
  RuntimeGoalSetResponse,
  RuntimeFileChangesRevertRequest,
  RuntimeFileChangesRevertResponse,
  RuntimeCompactRequest,
  RuntimeGuidanceRequest,
  RuntimeGuidanceResponse,
  RuntimeInterruptAndSendRequest,
  RuntimeSendRequest,
  RuntimeSendResponse,
  RuntimeSubagentSteerRequest,
  RuntimeSubagentSteerResponse,
  RuntimeSubagentArtifactRequest,
  RuntimeSubagentArtifactResponse,
  RuntimeTaskAddress,
  RuntimeTaskCancelRequest,
  RuntimeModelSelectionRequest,
  RuntimeModelSelectionResponse,
  RuntimeTaskCancelResponse,
  RuntimeTaskShortenWaitResponse,
  RuntimeTaskCreateRequest,
  RuntimeTaskCreateResponse,
  RuntimeTaskForkRequest,
  RuntimeTaskForkResponse,
  RuntimeTranscriptRequest,
  RuntimeTranscriptResponse,
  RuntimeWorkspaceOpenRequest,
  RuntimeWorkspaceOpenResponse,
  RuntimeWorkspaceRemoveRequest,
  RuntimeWorkspaceRenameRequest,
  RuntimeWorkListResponse,
  RuntimeWorkSearchRequest,
  RuntimeWorkSearchResponse,
  RuntimeWorkspaceSearchRequest,
  RuntimeWorkspaceSearchResponse,
} from '@/types/api'
import type { WorkspaceFileApi } from '@/types/workspace-files'

export type ExecutorTransportKind = 'local-ipc' | 'backend-relay'

export interface ExecutorRegistryEntry {
  deviceId: string
  name: string
  status: DeviceInfo['status']
  version?: string | null
  capabilities: string[]
  transportKind: ExecutorTransportKind
  device: DeviceInfo
}

export interface ExecutorRegistry {
  refresh: (options?: DeviceListOptions) => Promise<ExecutorRegistryEntry[]>
  list: () => ExecutorRegistryEntry[]
  resolve: (deviceId: string) => Promise<ExecutorRegistryEntry>
}

export interface ExecutorCommandClient extends DeviceCommandReadSource {
  listDevices: (options?: DeviceListOptions) => Promise<DeviceInfo[]>
  getHomeDirectory: (deviceId: string) => Promise<string>
  getProjectWorkspaceRoot: (deviceId: string) => Promise<string>
  listDirectories: (deviceId: string, path: string) => Promise<string[]>
  createDirectory: (deviceId: string, path: string) => Promise<void>
  executeCommand: (
    deviceId: string,
    data: {
      command_key: string
      taskId?: string
      threadId?: string | null
      path?: string
      cwd?: string
      args?: string[]
      env?: Record<string, unknown>
      timeout_seconds?: number
      max_output_bytes?: number
    }
  ) => Promise<DeviceCommandResponse>
  upgradeDevice: ReturnType<typeof createDeviceApi>['upgradeDevice']
  listSkills: (deviceId: string) => Promise<LocalDeviceSkill[]>
}

export interface ExecutorRuntimeClient {
  listRuntimeWork: (
    onProgress?: (snapshot: RuntimeWorkListResponse) => void
  ) => Promise<RuntimeWorkListResponse>
  prepareDeviceWorkspace: ReturnType<typeof createRuntimeWorkApi>['prepareDeviceWorkspace']
  deleteDeviceWorkspace: ReturnType<typeof createRuntimeWorkApi>['deleteDeviceWorkspace']
  getRuntimeTranscript: (data: RuntimeTranscriptRequest) => Promise<RuntimeTranscriptResponse>
  searchRuntimeWork: (data: RuntimeWorkSearchRequest) => Promise<RuntimeWorkSearchResponse>
  searchRuntimeWorkspace: (
    data: RuntimeWorkspaceSearchRequest
  ) => Promise<RuntimeWorkspaceSearchResponse>
  revertRuntimeFileChanges: (
    data: RuntimeFileChangesRevertRequest
  ) => Promise<RuntimeFileChangesRevertResponse>
  sendRuntimeMessage: (data: RuntimeSendRequest) => Promise<RuntimeSendResponse>
  queueRuntimeModelSelection?: (
    data: RuntimeModelSelectionRequest
  ) => Promise<RuntimeModelSelectionResponse>
  interruptAndSendRuntimeMessage: (
    data: RuntimeInterruptAndSendRequest
  ) => Promise<RuntimeSendResponse>
  rollbackRuntimeTask: (data: RuntimeRollbackRequest) => Promise<RuntimeSendResponse>
  compactRuntimeTask: (data: RuntimeCompactRequest) => Promise<RuntimeSendResponse>
  guideRuntimeTask: (data: RuntimeGuidanceRequest) => Promise<RuntimeGuidanceResponse>
  listRuntimeSubagents: ReturnType<typeof createRuntimeWorkApi>['listRuntimeSubagents']
  subscribeRuntimeSubagentConversation?: ReturnType<
    typeof createRuntimeWorkApi
  >['subscribeRuntimeSubagentConversation']
  readRuntimeSubagentLive: ReturnType<typeof createRuntimeWorkApi>['readRuntimeSubagentLive']
  readRuntimeSubagentCommand: ReturnType<typeof createRuntimeWorkApi>['readRuntimeSubagentCommand']
  listRuntimeSubagentCommands: ReturnType<
    typeof createRuntimeWorkApi
  >['listRuntimeSubagentCommands']
  archiveRuntimeSubagentCommands: ReturnType<
    typeof createRuntimeWorkApi
  >['archiveRuntimeSubagentCommands']
  stopRuntimeSubagent: ReturnType<typeof createRuntimeWorkApi>['stopRuntimeSubagent']
  steerRuntimeSubagent: (data: RuntimeSubagentSteerRequest) => Promise<RuntimeSubagentSteerResponse>
  readSubagentArtifact: (
    data: RuntimeSubagentArtifactRequest
  ) => Promise<RuntimeSubagentArtifactResponse>
  getRuntimeGoal: (data: RuntimeGoalGetRequest) => Promise<RuntimeGoalGetResponse>
  getRuntimeSessionModes?: (
    data: RuntimeSessionModesRequest
  ) => Promise<RuntimeSessionModesResponse>
  setRuntimeGoal: (data: RuntimeGoalSetRequest) => Promise<RuntimeGoalSetResponse>
  clearRuntimeGoal: (data: RuntimeGoalClearRequest) => Promise<RuntimeGoalClearResponse>
  openRuntimeWorkspace: (data: RuntimeWorkspaceOpenRequest) => Promise<RuntimeWorkspaceOpenResponse>
  upsertLocalRuntimeProject: ReturnType<typeof createRuntimeWorkApi>['upsertLocalRuntimeProject']
  renameRuntimeWorkspace: (
    data: RuntimeWorkspaceRenameRequest
  ) => Promise<RuntimeWorkspaceOpenResponse>
  removeRuntimeWorkspace: (
    data: RuntimeWorkspaceRemoveRequest
  ) => Promise<RuntimeWorkspaceOpenResponse>
  reorderRuntimeProjects: ReturnType<typeof createRuntimeWorkApi>['reorderRuntimeProjects']
  setRuntimeProjectPinned: ReturnType<typeof createRuntimeWorkApi>['setRuntimeProjectPinned']
  setRuntimeProjectAppearance: ReturnType<
    typeof createRuntimeWorkApi
  >['setRuntimeProjectAppearance']
  syncRuntimeRemoteProjects: ReturnType<typeof createRuntimeWorkApi>['syncRuntimeRemoteProjects']
  activateRuntimeProject: ReturnType<typeof createRuntimeWorkApi>['activateRuntimeProject']
  reorderRuntimeProjectTasks: ReturnType<typeof createRuntimeWorkApi>['reorderRuntimeProjectTasks']
  setRuntimeTaskPinned: ReturnType<typeof createRuntimeWorkApi>['setRuntimeTaskPinned']
  archiveRuntimeTask: ReturnType<typeof createRuntimeWorkApi>['archiveRuntimeTask']
  renameRuntimeTask: ReturnType<typeof createRuntimeWorkApi>['renameRuntimeTask']
  listArchivedConversations: ReturnType<typeof createRuntimeWorkApi>['listArchivedConversations']
  archiveConversation: ReturnType<typeof createRuntimeWorkApi>['archiveConversation']
  archiveProjectConversations: ReturnType<
    typeof createRuntimeWorkApi
  >['archiveProjectConversations']
  archiveAllConversations: ReturnType<typeof createRuntimeWorkApi>['archiveAllConversations']
  unarchiveConversation: ReturnType<typeof createRuntimeWorkApi>['unarchiveConversation']
  deleteArchivedConversation: ReturnType<typeof createRuntimeWorkApi>['deleteArchivedConversation']
  deleteArchivedConversationsBulk: ReturnType<
    typeof createRuntimeWorkApi
  >['deleteArchivedConversationsBulk']
  cancelRuntimeTask: (address: RuntimeTaskCancelRequest) => Promise<RuntimeTaskCancelResponse>
  shortenWaitRuntimeTask: (address: RuntimeTaskAddress) => Promise<RuntimeTaskShortenWaitResponse>
  createRuntimeTask: (data: RuntimeTaskCreateRequest) => Promise<RuntimeTaskCreateResponse>
  readRuntimeTaskCreation: ReturnType<typeof createRuntimeWorkApi>['readRuntimeTaskCreation']
  forkRuntimeTask: (data: RuntimeTaskForkRequest) => Promise<RuntimeTaskForkResponse>
}

export interface ExecutorReviewClient {
  loadTurnFileChangesDiff?: (subtaskId: string) => Promise<{ diff: string }>
  revertTurnFileChanges?: ReturnType<typeof createRuntimeWorkApi>['revertRuntimeFileChanges']
}

export interface ExecutorClient {
  registry: ExecutorRegistry
  runtime: ExecutorRuntimeClient
  commands: ExecutorCommandClient
  files: WorkspaceFileApi
  review: ExecutorReviewClient
}

interface ExecutorAccessApis {
  transportKind: ExecutorTransportKind
  commandTargetOwner?: 'registry' | 'runtime'
  deviceApi: Pick<
    ReturnType<typeof createDeviceApi>,
    | 'listDevices'
    | 'getHomeDirectory'
    | 'getProjectWorkspaceRoot'
    | 'listDirectories'
    | 'createDirectory'
    | 'executeCommand'
    | 'upgradeDevice'
    | 'listSkills'
    | 'listWorkspaceEntries'
    | 'readWorkspaceTextFile'
    | 'readWorkspaceFileChunk'
    | 'createWorkspaceTextFile'
    | 'createWorkspaceDirectory'
    | 'renameWorkspaceEntry'
    | 'deleteWorkspaceEntry'
  > & DeviceCommandReadSource &
    Pick<WorkspaceFileApi, 'writeWorkspaceTextFile' | 'uploadWorkspaceFile'>
  runtimeWorkApi: ExecutorRuntimeClient
  reviewApi?: ExecutorReviewClient
  resolveDevice?: (deviceId: string) => Promise<DeviceInfo | null>
}

type SourceRead<T> = { value: T } | { error: unknown }

const settleSourceRead = <T>(read: Promise<T>): Promise<SourceRead<T>> =>
  read.then(value => ({ value }), error => ({ error }))

/** Unwrap at the publication/dispatch boundary, preserving current-source errors. */
function sourceReadValue<T>(isCurrent: (() => boolean) | undefined, read: SourceRead<T>): T {
  if (isCurrent?.() === false) throw new DOMException('Executor source changed', 'AbortError')
  if ('error' in read) throw read.error
  return read.value
}

export function createInMemoryExecutorRegistry(
  loadEntries: (options?: DeviceListOptions) => Promise<ExecutorRegistryEntry[]>,
  loadEntry?: (deviceId: string) => Promise<ExecutorRegistryEntry | null>,
  captureReadSource?: DeviceCommandReadSource['captureReadSource']
): ExecutorRegistry {
  let entries: ExecutorRegistryEntry[] = []
  let entriesCurrent: (() => boolean) | undefined
  let revision = 0
  const list = () => entriesCurrent?.() === false ? [] : entries

  const refresh = async (options?: DeviceListOptions) => {
    const readRevision = ++revision
    const isCurrent = captureReadSource?.()
    const refreshed = sourceReadValue(isCurrent, await settleSourceRead(options ? loadEntries(options) : loadEntries()))
    if (readRevision === revision) {
      entries = refreshed
      entriesCurrent = isCurrent
    }
    return refreshed
  }

  const resolve = async (deviceId: string) => {
    const isCurrent = captureReadSource?.(deviceId)
    const snapshot = list()
    const loading = snapshot.length === 0 ? refresh() : null
    const readRevision = revision
    const candidates = sourceReadValue(isCurrent, loading ? await settleSourceRead(loading) : { value: snapshot })
    let entry = candidates.find(item => item.deviceId === deviceId)
    if (!entry && loadEntry) {
      const loadedEntry = sourceReadValue(isCurrent, await settleSourceRead(loadEntry(deviceId)))
      if (loadedEntry) {
        entry = loadedEntry
        if (readRevision === revision) {
          entries = [...list().filter(item => item.deviceId !== loadedEntry.deviceId), loadedEntry]
          entriesCurrent = isCurrent
        }
      }
    }
    if (!entry) {
      throw new Error(`executor-not-found:${deviceId}`)
    }
    if (entry.status === 'offline') {
      throw new Error(`executor-offline:${deviceId}`)
    }
    return entry
  }

  return {
    refresh,
    list,
    resolve,
  }
}

export function createExecutorClientFromApis({
  transportKind,
  commandTargetOwner = 'registry',
  deviceApi,
  runtimeWorkApi,
  reviewApi,
  resolveDevice,
}: ExecutorAccessApis): ExecutorClient {
  const createRegistryEntry = (device: DeviceInfo): ExecutorRegistryEntry => ({
    deviceId: device.device_id,
    name: device.name,
    status: device.status,
    version: device.executor_version,
    capabilities: device.capabilities ?? [],
    transportKind,
    device,
  })
  const registry = createInMemoryExecutorRegistry(
    async options => {
      const devices = await (options ? deviceApi.listDevices(options) : deviceApi.listDevices())
      return devices.map(createRegistryEntry)
    },
    resolveDevice
      ? async deviceId => {
          const device = await resolveDevice(deviceId)
          return device ? createRegistryEntry(device) : null
        }
      : undefined,
    deviceApi.captureReadSource?.bind(deviceApi)
  )

  const dispatch = async <T>(deviceId: string, request: () => Promise<T>): Promise<T> => {
    const isCurrent = deviceApi.captureReadSource?.(deviceId)
    sourceReadValue<unknown>(isCurrent, commandTargetOwner === 'registry'
      ? await settleSourceRead(registry.resolve(deviceId))
      : { value: undefined })
    return request()
  }
  const commands: ExecutorCommandClient = {
    captureReadSource: deviceApi.captureReadSource?.bind(deviceApi),
    listDevices: async options => {
      const entries = await registry.refresh(options)
      return entries.map(entry => entry.device)
    },
    getHomeDirectory: deviceId => dispatch(deviceId, () => deviceApi.getHomeDirectory(deviceId)),
    getProjectWorkspaceRoot: deviceId => dispatch(deviceId, () => deviceApi.getProjectWorkspaceRoot(deviceId)),
    listDirectories: (deviceId, path) => dispatch(deviceId, () => deviceApi.listDirectories(deviceId, path)),
    createDirectory: (deviceId, path) => dispatch(deviceId, () => deviceApi.createDirectory(deviceId, path)),
    executeCommand: (deviceId, data) => dispatch(deviceId, () => deviceApi.executeCommand(deviceId, data)),
    upgradeDevice: (deviceId, options) => dispatch(deviceId, () => deviceApi.upgradeDevice(deviceId, options)),
    listSkills: deviceId => dispatch(deviceId, () => deviceApi.listSkills(deviceId)),
  }

  const writeWorkspaceTextFile = deviceApi.writeWorkspaceTextFile
  const files: WorkspaceFileApi = {
    listWorkspaceEntries: (deviceId, path) => dispatch(deviceId, () => deviceApi.listWorkspaceEntries(deviceId, path)),
    searchWorkspaceEntries: (deviceId, root, query, cancellationToken) => dispatch(deviceId,
      () => runtimeWorkApi.searchRuntimeWorkspace({ deviceId, root, query, cancellationToken })),
    readWorkspaceTextFile: (deviceId, filePath) => dispatch(deviceId, () => deviceApi.readWorkspaceTextFile(deviceId, filePath)),
    async readWorkspaceFileChunk(deviceId, filePath, offset, expectedRevision) {
      return deviceApi.readWorkspaceFileChunk(deviceId, filePath, offset, expectedRevision)
    },
    ...(writeWorkspaceTextFile
      ? {
          writeWorkspaceTextFile: (deviceId: string, filePath: string, content: string, expectedRevision: string) =>
            dispatch(deviceId, () => writeWorkspaceTextFile(deviceId, filePath, content, expectedRevision)),
        }
      : {}),
    ...(deviceApi.uploadWorkspaceFile
      ? {
          uploadWorkspaceFile: ((deviceId, workspacePath, parentPath, file, options) =>
            dispatch(deviceId, () => deviceApi.uploadWorkspaceFile!(
              deviceId, workspacePath, parentPath, file, options
            ))) as NonNullable<WorkspaceFileApi['uploadWorkspaceFile']>,
        }
      : {}),
    createWorkspaceTextFile: (deviceId, parentPath, name, content) => dispatch(deviceId,
      () => deviceApi.createWorkspaceTextFile(deviceId, parentPath, name, content)),
    createWorkspaceDirectory: (deviceId, parentPath, name) => dispatch(deviceId,
      () => deviceApi.createWorkspaceDirectory(deviceId, parentPath, name)),
    renameWorkspaceEntry: (deviceId, parentPath, name, newName) => dispatch(deviceId,
      () => deviceApi.renameWorkspaceEntry(deviceId, parentPath, name, newName)),
    deleteWorkspaceEntry: (deviceId, parentPath, name, recursive) => dispatch(deviceId,
      () => deviceApi.deleteWorkspaceEntry(deviceId, parentPath, name, recursive)),
  }

  return {
    registry,
    runtime: runtimeWorkApi,
    commands,
    files,
    review: reviewApi ?? {},
  }
}
