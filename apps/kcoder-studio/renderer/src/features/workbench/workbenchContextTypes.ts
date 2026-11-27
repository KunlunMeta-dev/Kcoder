import type { RuntimeInputError, RuntimeInputRecovery } from '@/kcoder/runtimeTaskCreationError'
import type { AgentTaskBinding } from '../../../../shared/generated/contracts'
import type { EnvironmentDiffMode, EnvironmentInfoLoadOptions } from '@/api/environment'
import type {
  Attachment,
  AttachmentUploadError,
  BindRuntimeTaskIMSessionsResponse,
  CreateGitWorkspaceProjectRequest,
  CreateProjectRequest,
  DeleteDeviceWorkspaceRequest,
  DeviceWorkspacePrepareRequest,
  DeviceWorkspacePrepareResponse,
  GitBranch,
  GitRepoInfo,
  LocalDeviceApp,
  IMPrivateSessionListResponse,
  LocalDeviceSkill,
  ModelOptions,
  PluginPathComponent,
  ProjectExecutionMode,
  RuntimeContextUsage,
  ProjectWithTasks,
  RuntimeGoalClearResponse,
  RuntimeGoalCreateInput,
  RuntimeExecutionModes,
  RuntimeAdditionalContext,
  RuntimeGoalGetResponse,
  RuntimeSessionModesRequest,
  RuntimeSessionModesResponse,
  RuntimeGoalSetRequest,
  RuntimeGoalSetResponse,
  RuntimeGuidanceRequest,
  RuntimeGlobalIMNotificationUpdateRequest,
  RuntimeRollbackRequest,
  RuntimeIMNotificationSettingsResponse,
  RuntimeSendRequest,
  RuntimeSubagentSteerRequest,
  RuntimeSubagentSteerResponse,
  RuntimeSubagentArtifactRequest,
  RuntimeSubagentArtifactResponse,
  RuntimeTaskAddress,
  RuntimeTaskCreationReadResponse,
  RuntimeTaskCancelRequest,
  RuntimeTaskForkTarget,
  RuntimeProjectAppearanceRequest,
  RuntimeProjectPinRequest,
  RuntimeProjectReorderRequest,
  RuntimeProjectTaskReorderRequest,
  RuntimeTaskPinRequest,
  RuntimeTaskIMNotificationSubscriptionRequest,
  RuntimeTaskIMNotificationSubscriptionResponse,
  RuntimeWorkSearchRequest,
  RuntimeWorkSearchResponse,
  SkillRef,
  TurnFileChangesSummary,
  UnifiedModel,
  UnifiedSkill,
  User,
} from '@/types/api'
import type { DeviceUpgradeState } from '@/types/device-events'
import type { DockerRemoteDeviceCommandResponse } from '@/types/devices'
import type { EnvironmentInfo } from '@/types/environment'
import type { CodeCommentContext, WorkspaceFileApi, WorkspaceTarget } from '@/types/workspace-files'
import type {
  CloudWorkStatus,
  RuntimeTranscriptLoader,
  WorkbenchMessage,
  WorkbenchState,
} from '@/types/workbench'
import type { ReactNode } from 'react'
import type { RuntimeTaskStreamHandlers } from './runtimePaneMessages'
import type { RuntimeTaskReminderState } from './runtimeTaskReminders'
import type { WorkbenchServices } from './workbenchServices'

export type ProjectMutationOptions = {
  refreshWorkLists?: boolean
}

export type ArchiveRuntimeTaskOptions = {
  force?: boolean
}

export type ArchiveRuntimeTaskResult = {
  status: 'archived' | 'dirty_worktree' | 'failed'
  error?: string
}

export type ArchiveRuntimeConversationsResult = ArchiveRuntimeTaskResult

export type RecoverRuntimeTask = (
  address: RuntimeTaskAddress,
  open?: boolean
) => Promise<RuntimeTaskCreationReadResponse>

export interface SendCurrentInputOptions extends RuntimeExecutionModes, RuntimePaneActionOptions {
  computerUse?: import('@/types/api').RuntimeComputerUseAuthorization
  clientMessageId?: string
  codeCommentContexts?: CodeCommentContext[]
  initialGoal?: RuntimeGoalCreateInput | null
  onRuntimeTaskOptimisticOpen?: (
    address: RuntimeTaskAddress,
    context?: { previousAddress?: RuntimeTaskAddress }
  ) => void
  additionalContext?: RuntimeAdditionalContext
}

export interface CreateTemporaryRuntimeTaskOptions extends RuntimePaneActionOptions {
  project?: ProjectWithTasks | null
  source?: RuntimeTaskAddress | null
  attachments?: Attachment[]
  onRuntimeTaskOptimisticOpen?: SendCurrentInputOptions['onRuntimeTaskOptimisticOpen']
}

export interface CreateProjectRuntimeTaskOptions extends RuntimePaneActionOptions {
  project: ProjectWithTasks
  attachments?: Attachment[]
  initialGoal?: RuntimeGoalCreateInput | null
  collaborationMode?: 'default' | 'plan'
  deliveryId?: string
  cloudProjectId?: string
}

export interface RuntimePaneActionOptions {
  onRejected?: () => void
  onError: (error: string, recovery?: RuntimeInputRecovery) => void
}

export interface RuntimePaneGuidanceResult {
  rejected?: boolean
  sent: boolean
  turnId?: string
  code?: string | null
  error?: string | null
}

export interface WorkbenchContextValue {
  services: WorkbenchServices
  state: WorkbenchState
  isStartupReady: boolean
  workspaceFileApi: WorkspaceFileApi
  runtimeTaskReminders: RuntimeTaskReminderState
  cloudWorkStatus: CloudWorkStatus
  projectChat: {
    models: UnifiedModel[]
    skills: UnifiedSkill[]
    selectedModel: UnifiedModel | null
    activeModel?: UnifiedModel | null
    selectedModelOptions: ModelOptions
    isModelSelectionReady: boolean
    input: string
    creationError?: RuntimeInputError | null
    setCreationError?: (error: RuntimeInputError | null) => void
    trialTemplates: PluginPathComponent[]
    selectedSkills: SkillRef[]
    attachments: Attachment[]
    uploadingFiles: Map<string, { file: File; progress: number; cancel?: () => void }>
    errors: Map<string, AttachmentUploadError>
    contextUsage?: RuntimeContextUsage
    isOptionsLocked: boolean
    isAttachmentReadyToSend: boolean
    setSelectedModel: (model: UnifiedModel | null) => void
    setSelectedModelAndOptions?: (model: UnifiedModel, options: ModelOptions) => void
    queueActiveTurnModelSelection?: (model: UnifiedModel) => Promise<boolean>
    setSelectedModelOption: (optionId: string, value: string) => void
    getSelectedModel?: () => UnifiedModel | null
    isSelectedModelUnavailable?: () => boolean
    getModelSelectionMode?: () => import('@/types/model-selection').ModelSelectionMode | undefined
    getSelectedModelOptions?: () => ModelOptions
    onBlockedModelSelect: (model: UnifiedModel, message?: string) => void
    setInput: (value: string) => void
    restoreInput?: (value: string) => void
    setSelectedSkills: (skills: SkillRef[]) => void
    toggleSkill: (skill: SkillRef) => void
    handleFileSelect: (files: File | File[]) => Promise<void>
    cancelUpload: (fileId: string) => void
    addExistingAttachment: (attachment: Attachment) => void
    removeAttachment: (attachmentId: number) => Promise<void>
    resetAttachments: (submittedIds?: readonly number[]) => void
    listLocalSkills: () => Promise<LocalDeviceSkill[]>
    listLocalApps: () => Promise<LocalDeviceApp[]>
  }
  upgradingDevices: Record<string, DeviceUpgradeState>
  projectExecutionMode: ProjectExecutionMode
  setProjectExecutionMode: (mode: ProjectExecutionMode) => void
  setWorkbenchError: (error: string | null) => void
  projectWorktreeBranch: string | null
  setProjectWorktreeBranch: (branchName: string | null) => void
  selectProject: (projectId: number | null) => void
  selectProjectWorkspace: (projectId: number, deviceWorkspaceId: number | null) => void
  selectStandaloneDevice: (deviceId: string | null) => void
  openStandaloneWorkspace: (
    deviceId: string,
    workspacePath: string,
    label?: string,
    projectRoots?: string[]
  ) => Promise<void>
  switchStudioWorkMode?: (mode: import('./studioWorkMode').StudioWorkMode) => void
  startNewChat: () => void
  startNewSkillChat: (
    skillNames: string[],
    options?: { allowLocalSkills?: boolean }
  ) => Promise<boolean>
  startExpertTask?: (expert: Omit<import('@/types/workbench').ExpertTaskDraft, 'draftKey'>) => void
  selectDraftExpert?: import('@/types/workbench').SelectDraftExpert
  startStandaloneChat: () => void
  startNewProjectChat: (projectId: number) => void
  openRuntimeTask: (address: RuntimeTaskAddress, options?: { navigate?: boolean }) => Promise<void>
  updateRuntimeTaskExpertBinding: (
    address: RuntimeTaskAddress,
    binding: AgentTaskBinding | null
  ) => void
  recoverRuntimeTask: RecoverRuntimeTask
  appendRuntimeTaskDraft?: (address: RuntimeTaskAddress, text: string) => boolean
  searchRuntimeWork: (request: RuntimeWorkSearchRequest) => Promise<RuntimeWorkSearchResponse>
  loadRuntimeTranscriptForPane: RuntimeTranscriptLoader
  subscribeRuntimeTaskStream: (
    address: RuntimeTaskAddress,
    handlers: RuntimeTaskStreamHandlers
  ) => () => void
  renameRuntimeTask: (address: RuntimeTaskAddress, title: string, options?: { throwOnRejection?: boolean }) => Promise<void>
  archiveRuntimeTask: (
    address: RuntimeTaskAddress,
    options?: ArchiveRuntimeTaskOptions
  ) => Promise<ArchiveRuntimeTaskResult>
  archiveProjectConversations: (
    runtimeProjectKey: string,
    options?: ArchiveRuntimeTaskOptions
  ) => Promise<ArchiveRuntimeConversationsResult>
  archiveProjectsConversations: (
    runtimeProjectKeys: string[],
    options?: ArchiveRuntimeTaskOptions
  ) => Promise<ArchiveRuntimeConversationsResult>
  archiveChatConversations: (
    addresses: RuntimeTaskAddress[],
    options?: ArchiveRuntimeTaskOptions
  ) => Promise<ArchiveRuntimeConversationsResult>
  forkCurrentRuntimeTask: (
    target: RuntimeTaskForkTarget,
    options?: { lastTurnId?: string; title?: string; onError?: (error: string) => void }
  ) => Promise<void>
  getRuntimeGoal: (address: RuntimeTaskAddress) => Promise<RuntimeGoalGetResponse>
  getRuntimeSessionModes: (
    request: RuntimeSessionModesRequest
  ) => Promise<RuntimeSessionModesResponse>
  setRuntimeGoal: (request: RuntimeGoalSetRequest) => Promise<RuntimeGoalSetResponse>
  clearRuntimeGoal: (address: RuntimeTaskAddress) => Promise<RuntimeGoalClearResponse>
  listImPrivateSessions: () => Promise<IMPrivateSessionListResponse>
  bindRuntimeTaskToImSessions: (
    address: RuntimeTaskAddress,
    sessionKeys: string[]
  ) => Promise<BindRuntimeTaskIMSessionsResponse>
  getImNotificationSettings: () => Promise<RuntimeIMNotificationSettingsResponse>
  updateGlobalImNotification: (
    data: RuntimeGlobalIMNotificationUpdateRequest
  ) => Promise<RuntimeIMNotificationSettingsResponse>
  subscribeRuntimeTaskNotifications: (
    data: RuntimeTaskIMNotificationSubscriptionRequest
  ) => Promise<RuntimeTaskIMNotificationSubscriptionResponse>
  unsubscribeRuntimeTaskNotifications: (
    address: RuntimeTaskAddress
  ) => Promise<RuntimeTaskIMNotificationSubscriptionResponse>
  rememberExecutionDevice: (deviceId: string) => void
  refreshWorkLists: (options?: { requireRuntimeWork?: boolean; refreshDevices?: boolean }) => Promise<void>
  refreshDevices: () => Promise<void>
  getRemoteDeviceStartupCommand: () => Promise<DockerRemoteDeviceCommandResponse>
  upgradeDevice: (deviceId: string) => Promise<void>
  createProject: (
    data: CreateProjectRequest,
    options?: ProjectMutationOptions
  ) => Promise<ProjectWithTasks>
  createGitWorkspaceProject: (data: CreateGitWorkspaceProjectRequest) => Promise<ProjectWithTasks>
  prepareDeviceWorkspace: (
    data: DeviceWorkspacePrepareRequest,
    options?: ProjectMutationOptions
  ) => Promise<DeviceWorkspacePrepareResponse>
  deleteDeviceWorkspace: (data: DeleteDeviceWorkspaceRequest) => Promise<void>
  listGitRepositories: () => Promise<GitRepoInfo[]>
  listGitBranches: (repo: GitRepoInfo) => Promise<GitBranch[]>
  updateProjectName: (projectId: number, name: string) => Promise<void>
  updateLocalRuntimeProject: (data: {
    deviceId: string
    projectKey: string
    name: string
    roots: string[]
  }) => Promise<void>
  removeProject: (projectId: number) => Promise<void>
  reorderRuntimeProjects: (data: RuntimeProjectReorderRequest) => Promise<void>
  setRuntimeProjectPinned: (data: RuntimeProjectPinRequest) => Promise<void>
  setRuntimeProjectAppearance: (data: RuntimeProjectAppearanceRequest) => Promise<void>
  reorderRuntimeProjectTasks: (data: RuntimeProjectTaskReorderRequest) => Promise<void>
  setRuntimeTaskPinned: (data: RuntimeTaskPinRequest) => Promise<void>
  getDeviceHomeDirectory: (deviceId: string) => Promise<string>
  getProjectWorkspaceRoot: (deviceId: string) => Promise<string>
  listDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  createDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  loadEnvironmentInfo: (
    project: ProjectWithTasks | null,
    workspaceTarget?: WorkspaceTarget | null,
    options?: EnvironmentInfoLoadOptions
  ) => Promise<EnvironmentInfo>
  loadEnvironmentDiff: (
    project: ProjectWithTasks | null,
    workspaceTarget?: WorkspaceTarget | null,
    mode?: EnvironmentDiffMode
  ) => Promise<string>
  commitEnvironmentChanges: (
    project: ProjectWithTasks | null,
    message: string,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<void>
  commitAndPushEnvironmentChanges: (
    project: ProjectWithTasks | null,
    message: string,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<void>
  pushEnvironmentChanges: (
    project: ProjectWithTasks | null,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<void>
  listEnvironmentBranches: (
    project: ProjectWithTasks | null,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<string[]>
  checkoutEnvironmentBranch: (
    project: ProjectWithTasks | null,
    branchName: string,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<void>
  createEnvironmentBranch: (
    project: ProjectWithTasks | null,
    branchName: string,
    workspaceTarget?: WorkspaceTarget | null
  ) => Promise<void>
  sendRuntimePaneMessage: (
    request: RuntimeSendRequest,
    options: RuntimePaneActionOptions
  ) => Promise<boolean>
  interruptAndSendRuntimePaneMessage: (
    request: RuntimeSendRequest,
    options: RuntimePaneActionOptions
  ) => Promise<boolean>
  sendRuntimePaneGuidance: (
    request: RuntimeGuidanceRequest,
    options: RuntimePaneActionOptions
  ) => Promise<RuntimePaneGuidanceResult>
  steerRuntimePaneSubagent: (
    request: RuntimeSubagentSteerRequest
  ) => Promise<RuntimeSubagentSteerResponse>
  readRuntimePaneSubagentArtifact: (
    request: RuntimeSubagentArtifactRequest
  ) => Promise<RuntimeSubagentArtifactResponse>
  compactRuntimePaneTask: (
    address: RuntimeTaskAddress,
    options: RuntimePaneActionOptions
  ) => Promise<boolean>
  editLastUserMessage: (
    request: RuntimeRollbackRequest,
    options: RuntimePaneActionOptions
  ) => Promise<boolean>
  cancelRuntimePaneTask: (
    address: RuntimeTaskCancelRequest,
    options: RuntimePaneActionOptions
  ) => Promise<boolean>
  sendCurrentInput: (
    inputOverride: string | undefined,
    options: SendCurrentInputOptions
  ) => Promise<boolean | RuntimeTaskAddress>
  createTemporaryRuntimeTask: (
    input: string,
    options: CreateTemporaryRuntimeTaskOptions
  ) => Promise<RuntimeTaskAddress | false>
  createProjectRuntimeTask: (
    input: string,
    options: CreateProjectRuntimeTaskOptions
  ) => Promise<RuntimeTaskAddress | false>
  retryFailedMessage: (
    messageId: string,
    messagesOverride: WorkbenchMessage[] | undefined,
    retryUserMessageOverride: WorkbenchMessage | undefined,
    retryModelConfiguration: 'snapshot' | 'current',
    options: RuntimePaneActionOptions
  ) => Promise<boolean>
  pauseCurrentResponse: (options: RuntimePaneActionOptions) => Promise<void>
  shortenCurrentWait: (options: RuntimePaneActionOptions) => Promise<void>
  loadTurnFileChangesDiff: (
    subtaskId: string,
    messagesOverride?: WorkbenchMessage[],
    fileChangesOverride?: TurnFileChangesSummary,
    runtimeTaskOverride?: RuntimeTaskAddress | null
  ) => Promise<{ diff: string; truncated: boolean }>
  revertTurnFileChanges: (
    subtaskId: string,
    messagesOverride?: WorkbenchMessage[],
    fileChangesOverride?: TurnFileChangesSummary,
    runtimeTaskOverride?: RuntimeTaskAddress | null
  ) => Promise<TurnFileChangesSummary>
}

export type WorkbenchPaneState = Pick<
  WorkbenchState,
  | 'isBootstrapping'
  | 'projects'
  | 'devices'
  | 'runtimeWork'
  | 'standaloneDeviceId'
  | 'standaloneWorkspacePath'
  | 'selectedDeviceWorkspaceId'
  | 'pendingProjectWorkspaceProjectId'
  | 'user'
  | 'error'
>

export type WorkbenchPaneContextValue = Omit<WorkbenchContextValue, 'state' | 'cloudWorkStatus'> & {
  state: WorkbenchPaneState
}

export interface WorkbenchProviderProps {
  children: ReactNode
  user: User
  services?: WorkbenchServices
  onStartupReadyChange?: (ready: boolean) => void
}
