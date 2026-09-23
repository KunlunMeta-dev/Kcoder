/* eslint-disable react-refresh/only-export-components */
import { getDesktopWorkbenchHoistedMocks } from './DesktopWorkbenchLayout.test-mocks'
import { screen } from '@testing-library/react'
import { useMemo } from 'react'
import { beforeEach, vi } from 'vitest'
import type { ProjectChatControls } from '@/components/chat/ChatInput'
import { AuthContext } from '@/features/auth/useAuth'
import { AppearanceProvider } from '@/features/appearance'
import { WorkbenchContext, WorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import type {
  WorkbenchContextValue,
  WorkbenchPaneContextValue,
} from '@/features/workbench/workbenchContextTypes'
import { configuredWorkspacePath, executionDeviceId } from '@/lib/project-workspace'
import type { ProjectWithTasks, RuntimeWorkListResponse } from '@/types/api'
import type { RuntimeSubagentStatus, WorkbenchMessage } from '@/types/workbench'
import {
  TITLEBAR_ACTIONS_PORTAL_ID,
  TITLEBAR_CENTER_PORTAL_ID,
  TITLEBAR_RIGHT_PANEL_PORTAL_ID,
} from '@/components/topnav/TitlebarActionsPortal'
import { DesktopWorkbenchLayout as ActualDesktopWorkbenchLayout } from './DesktopWorkbenchLayout'
import {
  openExternalUrlMock,
  createDeviceApiMock,
  createProjectApiMock,
  getLocalCodexUsageDisplayMock,
  closeLocalTerminalMock,
  getLocalExecutorDeviceIdMock,
  isLocalTerminalAvailableMock,
  localPathExistsMock,
  getLocalPathKindMock,
  openLocalWorkspaceMock,
  startLocalTerminalMock,
  startTerminalSessionMock,
  startCodeServerSessionMock,
  startDeviceTerminalSessionMock,
  startDeviceCodeServerSessionMock,
  createRemoteTerminalClientMock,
  createTemporaryRuntimeTaskMock,
  subscribeRuntimeTaskStreamMock,
} from './DesktopWorkbenchLayout.test-mocks'

const {
  paneSessionMockRef: paneSessionRef,
  nativeDirectoryPickerMocks,
  automationMocks,
  tauriMenuMocks,
} = getDesktopWorkbenchHoistedMocks()

function createPaneStatus({
  messages = [],
  sending = false,
  waitingForAssistant = false,
  taskRunning = false,
}: {
  messages?: WorkbenchMessage[]
  sending?: boolean
  waitingForAssistant?: boolean
  taskRunning?: boolean
} = {}) {
  const activeAssistantMessage =
    [...messages]
      .reverse()
      .find(message => message.role === 'assistant' && message.status === 'streaming') ?? null
  const isSubmitting = Boolean(sending)
  const isAwaitingAssistant = Boolean(waitingForAssistant)
  const isAssistantStreaming = Boolean(activeAssistantMessage)
  const isResponseActive = isAwaitingAssistant || isAssistantStreaming
  const isBusy = isSubmitting || isResponseActive || taskRunning

  return {
    sendPhase: isSubmitting ? 'submitting' : isAwaitingAssistant ? 'awaiting_assistant' : 'idle',
    activeAssistantMessage,
    taskExecution: {
      known: taskRunning,
      running: taskRunning,
      continuable: true,
      status: null,
    },
    isSubmitting,
    isAwaitingAssistant,
    isAssistantStreaming,
    isResponseActive,
    isBusy,
    isWaitingForAssistantIndicator: isSubmitting || isAwaitingAssistant || taskRunning,
    canSendQueuedMessage: !isBusy,
  }
}

function createDefaultImNotificationSettings() {
  return {
    global: {
      enabled: false,
      sessionKey: null,
      session: null,
    },
    runtimeTaskSubscriptions: [],
  }
}

export function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

export function getDesktopWorkbenchMainElement() {
  const main = screen.getByTestId('desktop-workbench-content').closest('main')
  if (!main) {
    throw new Error('Desktop workbench main element was not rendered')
  }
  return main
}

export function createMockDeviceApi(overrides: Record<string, unknown> = {}) {
  return {
    getHomeDirectory: vi.fn().mockResolvedValue('/home/ubuntu'),
    getProjectWorkspaceRoot: vi.fn().mockResolvedValue('/workspace/projects'),
    listDirectories: vi.fn().mockResolvedValue([]),
    listWorkspaceEntries: vi.fn().mockResolvedValue({
      path: '/workspace/project',
      entries: [],
    }),
    readWorkspaceTextFile: vi.fn(),
    executeCommand: vi.fn(),
    getAllDevices: vi.fn().mockResolvedValue([
      {
        id: 1,
        device_id: '24a59054-4638-4744-983d-372706c30fcd',
        name: 'dev-executor-372706c30fcd',
        status: 'online',
        is_default: false,
        device_type: 'cloud',
        bind_shell: 'claudecode',
        executor_version: '1.712',
        client_ip: '203.0.113.10',
        cloud_config: {
          deviceName: 'dev-executor-372706c30fcd',
        },
        cpu_usage: 42,
        memory_usage: 68,
        disk_usage: 57,
      },
    ]),
    startTerminal: startDeviceTerminalSessionMock,
    startCodeServer: vi.fn(),
    createCloudDevice: vi.fn(),
    renameDevice: vi.fn(),
    restartCloudDevice: vi.fn(),
    deleteCloudDevice: vi.fn(),
    getMetrics: vi.fn().mockResolvedValue({
      cpu_usage: 42,
      memory_usage: 68,
      disk_usage: 57,
    }),
    getMetricsHistory: vi.fn().mockResolvedValue({
      cpu: [],
      memory: [],
      disk: [],
    }),
    ...overrides,
  }
}

function createBaseProps() {
  return {
    state: {
      user: null,
      defaultTeam: null,
      projects: [{ id: 1, name: 'github_wegent', tasks: [] }],
      devices: [],
      runtimeWork: null,
      currentProject: null,
      currentRuntimeTask: null,
      standaloneDeviceId: null,
      standaloneWorkspacePath: null,
      input: '',
      isBootstrapping: false,
      isSending: false,
      error: null,
    },
    messages: [],
    workspaceFileApi: {
      listWorkspaceEntries: vi.fn().mockResolvedValue({
        path: '/workspace/project',
        entries: [],
      }),
      readWorkspaceTextFile: vi.fn(),
    },
    onNewChat: vi.fn(),
    onStartStandaloneChat: vi.fn(),
    onOpenPlugins: vi.fn(),
    projectChat: {
      models: [],
      skills: [],
      selectedModel: null,
      selectedModelOptions: {},
      selectedSkills: [],
      attachments: [],
      uploadingFiles: new Map(),
      errors: new Map(),
      isOptionsLocked: false,
      isAttachmentReadyToSend: true,
      setSelectedModel: vi.fn(),
      setSelectedModelOption: vi.fn(),
      setSelectedSkills: vi.fn(),
      toggleSkill: vi.fn(),
      handleFileSelect: vi.fn(),
      addExistingAttachment: vi.fn(),
      removeAttachment: vi.fn(),
      resetAttachments: vi.fn(),
      listLocalSkills: vi.fn().mockResolvedValue([]),
    },
    projectWork: {
      projects: [{ id: 1, name: 'github_wegent', tasks: [] }],
      devices: [],
      currentProjectId: undefined,
      currentStandaloneDeviceId: null,
      executionMode: 'current_workspace',
      executionModeLocked: false,
      onSelectProject: vi.fn(),
      onSelectStandaloneDevice: vi.fn(),
      onExecutionModeChange: vi.fn(),
    },
    onSelectProject: vi.fn(),
    onStartNewProjectChat: vi.fn(),
    onOpenStandaloneWorkspace: vi.fn(),
    onCreateProject: vi.fn(),
    onCreateGitWorkspaceProject: vi.fn(),
    onUpdateProjectName: vi.fn(),
    onRemoveProject: vi.fn(),
    onGetDeviceHomeDirectory: vi.fn().mockResolvedValue('/home/ubuntu'),
    onGetProjectWorkspaceRoot: vi.fn().mockResolvedValue('/workspace/projects'),
    onListDeviceDirectories: vi.fn().mockResolvedValue([]),
    onCreateDeviceDirectory: vi.fn(),
    onListGitRepositories: vi.fn().mockResolvedValue([]),
    onListGitBranches: vi.fn().mockResolvedValue([]),
    onLoadEnvironmentInfo: vi.fn().mockResolvedValue({
      additions: '+173',
      deletions: '-13366',
      executionTarget: 'local' as const,
      deviceId: 'e13e1a10-5377-4a87-a3b3-634a098d0bb4',
      branchName: 'human/narwhal-20260528-073440',
      createPullRequestUrl:
        'https://github.com/wecode-ai/Wegent/compare/human%2Fnarwhal-20260528-073440?expand=1',
    }),
    onCommitEnvironmentChanges: vi.fn().mockResolvedValue(undefined),
    onListEnvironmentBranches: vi
      .fn()
      .mockResolvedValue([
        'main',
        'human/chipmunk-20260603-053420',
        'human/narwhal-20260528-073440',
      ]),
    onCheckoutEnvironmentBranch: vi.fn().mockResolvedValue(undefined),
    onCreateEnvironmentBranch: vi.fn().mockResolvedValue(undefined),
    onLoadEnvironmentDiff: vi
      .fn()
      .mockResolvedValue(
        'diff --git a/src/env.ts b/src/env.ts\n--- a/src/env.ts\n+++ b/src/env.ts\n@@ -1 +1 @@\n-old\n+new\n'
      ),
    onInputChange: vi.fn(),
    onSend: vi.fn(),
    onRequestUserInputSubmit: vi.fn().mockResolvedValue(true),
    onLogout: vi.fn(),
  }
}

export let baseProps = createBaseProps()

function createActiveProjectState() {
  return {
    ...baseProps.state,
    currentProject: {
      id: 1,
      name: 'github_wegent',
      tasks: [],
      config: {
        mode: 'workspace' as const,
        execution: {
          targetType: 'local' as const,
          deviceId: 'device-1',
        },
        workspace: {
          source: 'local_path' as const,
          localPath: '/workspace/github_wegent',
        },
      },
    },
  }
}

export let activeProjectState = createActiveProjectState()

export const activeProjectRuntimeTask = {
  deviceId: 'device-1',
  workspacePath: '/workspace/github_wegent',
  taskId: 'runtime-project-1',
}
export const activeProjectRuntimeTarget = {
  deviceId: 'device-1',
  path: '/workspace/github_wegent',
  source: 'runtime' as const,
  taskId: 'runtime-project-1',
}

export function createPendingRequestUserInputMessage(includeAdjustment = false): WorkbenchMessage {
  return {
    id: 'assistant-request',
    role: 'assistant',
    content: '',
    status: 'streaming',
    createdAt: '2026-06-30T00:00:01.000Z',
    blocks: [
      {
        id: 'request-1',
        subtaskId: '',
        type: 'tool',
        toolName: 'request_user_input',
        status: 'pending',
        createdAt: Date.parse('2026-06-30T00:00:01.000Z'),
        renderPayload: {
          kind: 'request_user_input',
          request_id: 42,
          questions: [
            {
              id: 'implement',
              question: '执行此计划?',
              options: [{ label: '是的，执行此计划' }],
            },
            ...(includeAdjustment
              ? [
                  {
                    id: 'adjustment',
                    question: '否，请告知 KCoder Studio 如何调整',
                    is_other: true,
                  },
                ]
              : []),
          ],
        },
      },
    ],
  }
}

export type LegacyDesktopWorkbenchLayoutProps = {
  state?: Record<string, unknown>
  messages?: WorkbenchMessage[]
  queuedMessages?: unknown[]
  guidanceMessages?: unknown[]
  codeCommentContexts?: unknown[]
  subagentStatuses?: RuntimeSubagentStatus[]
  workspaceFileApi?: WorkbenchContextValue['workspaceFileApi']
  lifecycleTaskRunning?: boolean
  isAwaitingAssistantStart?: boolean
  isRuntimeTranscriptLoading?: boolean
  runtimeTranscriptHasMoreBefore?: boolean
  isRuntimeTranscriptLoadingMore?: boolean
  projectChat?: Partial<ProjectChatControls>
  projectWork?: Record<string, unknown>
  onSelectProject?: (projectId: number | null) => void
  onStartStandaloneChat?: () => void
  onStartNewProjectChat?: (projectId: number) => void
  onOpenStandaloneWorkspace?: (...args: unknown[]) => Promise<void> | void
  onOpenRuntimeTask?: (...args: unknown[]) => Promise<void> | void
  onSearchRuntimeWork?: (...args: unknown[]) => Promise<unknown>
  onCancelRuntimePaneTask?: WorkbenchContextValue['cancelRuntimePaneTask']
  onForkCurrentRuntimeTask?: WorkbenchContextValue['forkCurrentRuntimeTask']
  onListImPrivateSessions?: () => Promise<unknown>
  onBindRuntimeTaskToImSessions?: (...args: unknown[]) => Promise<unknown>
  onGetImNotificationSettings?: () => Promise<unknown>
  onUpdateGlobalImNotification?: (...args: unknown[]) => Promise<unknown>
  onSubscribeRuntimeTaskNotifications?: (...args: unknown[]) => Promise<unknown>
  onUnsubscribeRuntimeTaskNotifications?: (...args: unknown[]) => Promise<unknown>
  onRefreshDevices?: () => Promise<void>
  onUpgradeDevice?: (...args: unknown[]) => Promise<void>
  onCreateProject?: (...args: unknown[]) => Promise<unknown>
  onCreateGitWorkspaceProject?: (...args: unknown[]) => Promise<unknown>
  onPrepareDeviceWorkspace?: (...args: unknown[]) => Promise<unknown>
  onDeleteDeviceWorkspace?: (...args: unknown[]) => Promise<void>
  onListGitRepositories?: () => Promise<unknown[]>
  onListGitBranches?: (...args: unknown[]) => Promise<unknown[]>
  onUpdateProjectName?: (...args: unknown[]) => Promise<void> | void
  onRemoveProject?: (...args: unknown[]) => Promise<void> | void
  onGetDeviceHomeDirectory?: (...args: unknown[]) => Promise<string>
  onGetProjectWorkspaceRoot?: (...args: unknown[]) => Promise<string>
  onListDeviceDirectories?: (...args: unknown[]) => Promise<string[]>
  onCreateDeviceDirectory?: (...args: unknown[]) => Promise<void>
  onLoadEnvironmentInfo?: (...args: unknown[]) => Promise<unknown>
  onLoadEnvironmentDiff?: (...args: unknown[]) => Promise<string>
  onCommitEnvironmentChanges?: (...args: unknown[]) => Promise<void>
  onCommitAndPushEnvironmentChanges?: (...args: unknown[]) => Promise<void>
  onPushEnvironmentChanges?: (...args: unknown[]) => Promise<void>
  onListEnvironmentBranches?: (...args: unknown[]) => Promise<string[]>
  onCheckoutEnvironmentBranch?: (...args: unknown[]) => Promise<void>
  onCreateEnvironmentBranch?: (...args: unknown[]) => Promise<void>
  onInputChange?: (input: string) => void
  onSend?: () => void | Promise<void>
  onRequestUserInputSubmit?: (...args: unknown[]) => Promise<boolean> | void
  onLogout?: () => void
}

export function DesktopWorkbenchLayout(props: LegacyDesktopWorkbenchLayoutProps) {
  const { authValue, workbenchValue, paneValue, paneSession } = createWorkbenchMocks(props)
  // eslint-disable-next-line react-hooks/immutability -- The test adapter must inject the active pane session before rendering the real component.
  paneSessionRef.current = paneSession
  const lifecycleTaskRunning =
    props.lifecycleTaskRunning ?? Boolean(workbenchValue.state.currentRuntimeTask)
  const lifecycleStore = useMemo(() => {
    const store = new RuntimeTaskLifecycleStore('desktop-workbench-layout-test')
    store.syncRuntimeWork(workbenchValue.state.runtimeWork)
    if (lifecycleTaskRunning && workbenchValue.state.currentRuntimeTask) {
      store.executorStarted(workbenchValue.state.currentRuntimeTask)
    }
    return store
  }, [
    lifecycleTaskRunning,
    workbenchValue.state.currentRuntimeTask,
    workbenchValue.state.runtimeWork,
  ])

  return (
    <RuntimeTaskLifecycleProvider store={lifecycleStore}>
      <AppearanceProvider>
        <AuthContext.Provider value={authValue}>
          <WorkbenchContext.Provider value={workbenchValue}>
            <WorkbenchPaneContext.Provider value={paneValue}>
              <ActualDesktopWorkbenchLayout />
            </WorkbenchPaneContext.Provider>
          </WorkbenchContext.Provider>
        </AuthContext.Provider>
      </AppearanceProvider>
    </RuntimeTaskLifecycleProvider>
  )
}

const derivedRuntimeWorkCache = new Map<string, RuntimeWorkListResponse>()

export function createRuntimeWorkForProject(
  project: ProjectWithTasks | null | undefined,
  selectedDeviceWorkspaceId?: unknown
): RuntimeWorkListResponse | null {
  if (!project) return null

  const deviceId = executionDeviceId(project)
  const workspacePath = configuredWorkspacePath(project)
  if (!deviceId || !workspacePath?.startsWith('/')) return null

  const workspaceId =
    typeof selectedDeviceWorkspaceId === 'number' ? selectedDeviceWorkspaceId : project.id
  const cacheKey = JSON.stringify([project.id, project.name, deviceId, workspacePath, workspaceId])
  const cached = derivedRuntimeWorkCache.get(cacheKey)
  if (cached) return cached

  const runtimeWork: RuntimeWorkListResponse = {
    projects: [
      {
        project: { key: `project:${project.id}`, id: project.id, name: project.name },
        deviceWorkspaces: [
          {
            id: workspaceId,
            projectId: project.id,
            deviceId,
            available: true,
            mapped: true,
            workspacePath,
            tasks: [],
          },
        ],
      },
    ],
    chats: [],
    totalTasks: 0,
  }
  derivedRuntimeWorkCache.set(cacheKey, runtimeWork)
  return runtimeWork
}

export function createWorkbenchMocks(props: LegacyDesktopWorkbenchLayoutProps) {
  const projectWork = props.projectWork === baseProps.projectWork ? {} : (props.projectWork ?? {})
  const rawStateProjects = (projectWork.projects ??
    props.state?.projects ??
    baseProps.state.projects) as WorkbenchContextValue['state']['projects'] | undefined
  const activeProject = (props.state?.currentProject ??
    projectWork.currentProject ??
    (projectWork.currentProjectId != null && rawStateProjects
      ? rawStateProjects.find(project => project.id === projectWork.currentProjectId)
      : null) ??
    null) as ProjectWithTasks | null
  const stateProjects =
    activeProject && rawStateProjects
      ? rawStateProjects.some(project => project.id === activeProject.id)
        ? rawStateProjects.map(project =>
            project.id === activeProject.id ? activeProject : project
          )
        : [...rawStateProjects, activeProject]
      : rawStateProjects
  const selectedDeviceWorkspaceId =
    props.state?.selectedDeviceWorkspaceId ?? projectWork.selectedDeviceWorkspaceId ?? null
  const explicitRuntimeWork = projectWork.runtimeWork ?? props.state?.runtimeWork
  const shouldDeriveRuntimeWork =
    props.projectWork == null || props.projectWork === baseProps.projectWork
  const runtimeWork =
    explicitRuntimeWork ??
    (shouldDeriveRuntimeWork
      ? createRuntimeWorkForProject(
          activeProject as ProjectWithTasks | null,
          selectedDeviceWorkspaceId
        )
      : null) ??
    baseProps.state.runtimeWork
  const state = {
    ...baseProps.state,
    standaloneWorkspacePath: null,
    ...props.state,
    projects: stateProjects,
    devices: projectWork.devices ?? props.state?.devices ?? baseProps.state.devices,
    runtimeWork,
    currentProject: activeProject,
    standaloneDeviceId:
      props.state?.standaloneDeviceId ?? projectWork.currentStandaloneDeviceId ?? null,
    selectedDeviceWorkspaceId,
    pendingProjectWorkspaceProjectId:
      props.state?.pendingProjectWorkspaceProjectId ??
      projectWork.pendingProjectWorkspaceProjectId ??
      null,
  }
  const projectChat = {
    ...baseProps.projectChat,
    isModelSelectionReady: true,
    onBlockedModelSelect: vi.fn(),
    ...props.projectChat,
  }
  const lifecycleTaskRunning = props.lifecycleTaskRunning ?? Boolean(state.currentRuntimeTask)
  const workbenchValue = {
    services: {
      attachmentApi: {
        uploadAttachment: vi.fn().mockImplementation(async (file: File) => ({
          id: 91,
          filename: file.name,
          file_size: file.size,
          mime_type: file.type,
          status: 'ready',
          file_extension: file.name.split('.').pop() ?? '',
          created_at: '2026-07-22T00:00:00Z',
        })),
        deleteAttachment: vi.fn().mockResolvedValue(undefined),
      },
      workspaceSessionApi: {
        startProjectTerminal: startTerminalSessionMock,
        startProjectCodeServer: startCodeServerSessionMock,
        startDeviceTerminal: startDeviceTerminalSessionMock,
        startDeviceCodeServer: startDeviceCodeServerSessionMock,
        createRemoteTerminalClient: createRemoteTerminalClientMock,
      },
    },
    state,
    isStartupReady: true,
    workspaceFileApi: props.workspaceFileApi ?? baseProps.workspaceFileApi,
    cloudWorkStatus: {
      availability: 'available',
      checks: { teams: 'available', devices: 'available', runtimeWork: 'available' },
      error: null,
      updatedAt: null,
    },
    projectChat,
    upgradingDevices: {},
    projectExecutionMode: projectWork.executionMode ?? 'current_workspace',
    setProjectExecutionMode: projectWork.onExecutionModeChange ?? vi.fn(),
    projectWorktreeBranch: projectWork.worktreeBranch ?? null,
    setProjectWorktreeBranch: projectWork.onWorktreeBranchChange ?? vi.fn(),
    selectProject: props.onSelectProject ?? projectWork.onSelectProject ?? vi.fn(),
    selectProjectWorkspace: projectWork.onSelectProjectWorkspace ?? vi.fn(),
    selectStandaloneDevice: projectWork.onSelectStandaloneDevice ?? vi.fn(),
    openStandaloneWorkspace: props.onOpenStandaloneWorkspace ?? baseProps.onOpenStandaloneWorkspace,
    startNewChat: baseProps.onNewChat,
    startStandaloneChat: props.onStartStandaloneChat ?? vi.fn(),
    startNewProjectChat: props.onStartNewProjectChat ?? baseProps.onStartNewProjectChat,
    openRuntimeTask: props.onOpenRuntimeTask ?? vi.fn().mockResolvedValue(undefined),
    searchRuntimeWork: props.onSearchRuntimeWork ?? vi.fn().mockResolvedValue({ items: [] }),
    loadRuntimeTranscriptForPane: vi.fn().mockResolvedValue({ messages: [] }),
    subscribeRuntimeTaskStream: subscribeRuntimeTaskStreamMock,
    renameRuntimeTask: vi.fn().mockResolvedValue(undefined),
    archiveRuntimeTask: vi.fn().mockResolvedValue(undefined),
    archiveProjectConversations: vi.fn().mockResolvedValue(undefined),
    archiveProjectsConversations: vi.fn().mockResolvedValue(undefined),
    archiveChatConversations: vi.fn().mockResolvedValue(undefined),
    forkCurrentRuntimeTask: props.onForkCurrentRuntimeTask ?? vi.fn().mockResolvedValue(undefined),
    listImPrivateSessions:
      props.onListImPrivateSessions ?? vi.fn().mockResolvedValue({ total: 0, items: [] }),
    bindRuntimeTaskToImSessions:
      props.onBindRuntimeTaskToImSessions ??
      vi.fn().mockRejectedValue(new Error('Missing bind handler')),
    getImNotificationSettings:
      props.onGetImNotificationSettings ??
      vi.fn().mockResolvedValue(createDefaultImNotificationSettings()),
    updateGlobalImNotification:
      props.onUpdateGlobalImNotification ??
      vi.fn().mockResolvedValue(createDefaultImNotificationSettings()),
    subscribeRuntimeTaskNotifications:
      props.onSubscribeRuntimeTaskNotifications ?? vi.fn().mockResolvedValue({ subscribed: true }),
    unsubscribeRuntimeTaskNotifications:
      props.onUnsubscribeRuntimeTaskNotifications ??
      vi.fn().mockResolvedValue({ subscribed: false }),
    rememberExecutionDevice: vi.fn(),
    refreshWorkLists: vi.fn().mockResolvedValue(undefined),
    refreshDevices: props.onRefreshDevices ?? vi.fn().mockResolvedValue(undefined),
    getRemoteDeviceStartupCommand: vi.fn().mockResolvedValue({ command: '' }),
    upgradeDevice: props.onUpgradeDevice ?? vi.fn().mockResolvedValue(undefined),
    createProject:
      props.onCreateProject ?? baseProps.onCreateProject ?? vi.fn().mockResolvedValue({}),
    createGitWorkspaceProject:
      props.onCreateGitWorkspaceProject ??
      baseProps.onCreateGitWorkspaceProject ??
      vi.fn().mockResolvedValue({}),
    prepareDeviceWorkspace:
      props.onPrepareDeviceWorkspace ??
      vi.fn().mockResolvedValue({ deviceWorkspaceId: 1, workspaceId: 1 }),
    deleteDeviceWorkspace: props.onDeleteDeviceWorkspace ?? vi.fn().mockResolvedValue(undefined),
    listGitRepositories: props.onListGitRepositories ?? baseProps.onListGitRepositories,
    listGitBranches: props.onListGitBranches ?? baseProps.onListGitBranches,
    updateProjectName: props.onUpdateProjectName ?? baseProps.onUpdateProjectName,
    removeProject: props.onRemoveProject ?? baseProps.onRemoveProject,
    getDeviceHomeDirectory: props.onGetDeviceHomeDirectory ?? baseProps.onGetDeviceHomeDirectory,
    getProjectWorkspaceRoot: props.onGetProjectWorkspaceRoot ?? baseProps.onGetProjectWorkspaceRoot,
    listDeviceDirectories: props.onListDeviceDirectories ?? baseProps.onListDeviceDirectories,
    createDeviceDirectory: props.onCreateDeviceDirectory ?? baseProps.onCreateDeviceDirectory,
    loadEnvironmentInfo: props.onLoadEnvironmentInfo ?? baseProps.onLoadEnvironmentInfo,
    loadEnvironmentDiff: props.onLoadEnvironmentDiff ?? baseProps.onLoadEnvironmentDiff,
    commitEnvironmentChanges:
      props.onCommitEnvironmentChanges ?? baseProps.onCommitEnvironmentChanges,
    commitAndPushEnvironmentChanges:
      props.onCommitAndPushEnvironmentChanges ?? vi.fn().mockResolvedValue(undefined),
    pushEnvironmentChanges: props.onPushEnvironmentChanges ?? vi.fn().mockResolvedValue(undefined),
    listEnvironmentBranches: props.onListEnvironmentBranches ?? baseProps.onListEnvironmentBranches,
    checkoutEnvironmentBranch:
      props.onCheckoutEnvironmentBranch ?? baseProps.onCheckoutEnvironmentBranch,
    createEnvironmentBranch: props.onCreateEnvironmentBranch ?? baseProps.onCreateEnvironmentBranch,
    sendRuntimePaneMessage: vi.fn().mockResolvedValue(true),
    cancelRuntimePaneTask: props.onCancelRuntimePaneTask ?? vi.fn().mockResolvedValue(true),
    sendCurrentInput: props.onSend ?? baseProps.onSend,
    createTemporaryRuntimeTask: createTemporaryRuntimeTaskMock,
    retryFailedMessage: vi.fn().mockResolvedValue(true),
    pauseCurrentResponse: vi.fn().mockResolvedValue(undefined),
    loadTurnFileChangesDiff: vi.fn().mockResolvedValue({ diff: '', truncated: false }),
    revertTurnFileChanges: vi.fn().mockResolvedValue({ changed_files: [] }),
  } as unknown as WorkbenchContextValue
  const paneValue = {
    ...workbenchValue,
    state: {
      isBootstrapping: state.isBootstrapping,
      projects: state.projects,
      devices: state.devices,
      runtimeWork: state.runtimeWork,
      standaloneDeviceId: state.standaloneDeviceId,
      selectedDeviceWorkspaceId: state.selectedDeviceWorkspaceId,
      pendingProjectWorkspaceProjectId: state.pendingProjectWorkspaceProjectId,
      user: state.user,
      error: state.error,
    },
  } as unknown as WorkbenchPaneContextValue
  const paneSession = {
    messages: props.messages ?? [],
    queuedMessages: props.queuedMessages ?? [],
    guidanceMessages: props.guidanceMessages ?? [],
    codeCommentContexts: props.codeCommentContexts ?? [],
    input: String(state.input ?? ''),
    setInput: props.onInputChange ?? baseProps.onInputChange,
    sending: Boolean(state.isSending),
    waitingForAssistant: Boolean(props.isAwaitingAssistantStart),
    status: createPaneStatus({
      messages: props.messages ?? [],
      sending: Boolean(state.isSending),
      waitingForAssistant: Boolean(props.isAwaitingAssistantStart),
      taskRunning: lifecycleTaskRunning,
    }),
    transcriptLoading: Boolean(props.isRuntimeTranscriptLoading),
    transcriptHasMoreBefore: Boolean(props.runtimeTranscriptHasMoreBefore),
    transcriptLoadingMoreBefore: Boolean(props.isRuntimeTranscriptLoadingMore),
    subagentStatuses: props.subagentStatuses ?? [],
    turnNavigation: [],
    loadMoreTranscriptBefore: vi.fn().mockResolvedValue(undefined),
    loadTranscriptTurnNavigationItem: vi.fn().mockResolvedValue(undefined),
    loadTranscriptGap: vi.fn().mockResolvedValue(undefined),
    send: props.onSend ?? baseProps.onSend,
    retryFailedMessage: vi.fn().mockResolvedValue(true),
    sendRequestUserInputResponse:
      props.onRequestUserInputSubmit ?? baseProps.onRequestUserInputSubmit,
    ignoreRequestUserInput: vi.fn(),
    answeredRequestUserInputIds: new Set(),
    addCodeComment: vi.fn(),
    clearCodeComments: vi.fn(),
    cancelQueuedMessage: vi.fn(),
    sendQueuedAsGuidance: vi.fn().mockResolvedValue(undefined),
    editQueuedMessage: vi.fn(),
    editLastUserMessage: vi.fn().mockResolvedValue(true),
    cancelGuidanceMessage: vi.fn(),
  }
  const authValue = {
    user: (state.user as WorkbenchContextValue['state']['user']) ?? null,
    isLoading: false,
    adminPasswordSetupRequired: false,
    adminUsername: 'admin',
    login: vi.fn().mockResolvedValue(state.user),
    logout: props.onLogout ?? baseProps.onLogout,
    refresh: vi.fn().mockResolvedValue(undefined),
    loginWithOidcToken: vi.fn().mockResolvedValue(undefined),
    setupAdminPassword: vi.fn().mockResolvedValue(state.user),
  }

  return { authValue, workbenchValue, paneValue, paneSession }
}

beforeEach(() => {
  baseProps = createBaseProps()
  activeProjectState = createActiveProjectState()
  derivedRuntimeWorkCache.clear()
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1024,
  })
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: 720,
  })
  tauriMenuMocks.getCurrentWindow.mockReturnValue({
    label: 'main',
    onDragDropEvent: vi.fn().mockResolvedValue(vi.fn()),
  })
  tauriMenuMocks.menuNew.mockResolvedValue({ popup: tauriMenuMocks.menuPopup })
  tauriMenuMocks.menuPopup.mockResolvedValue(undefined)
  document.getElementById(TITLEBAR_ACTIONS_PORTAL_ID)?.remove()
  document.getElementById(TITLEBAR_CENTER_PORTAL_ID)?.remove()
  document.getElementById(TITLEBAR_RIGHT_PANEL_PORTAL_ID)?.remove()
  screen.queryByTestId('titlebar-center')?.remove()
  screen.queryByTestId('titlebar-right-workspace-zone')?.remove()
  localStorage.clear()
  window.history.pushState({}, '', '/')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  })
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.scrollTo = vi.fn()
  isLocalTerminalAvailableMock.mockReturnValue(false)
  getLocalPathKindMock.mockResolvedValue('file')
  getLocalExecutorDeviceIdMock.mockResolvedValue(null)
  localPathExistsMock.mockResolvedValue(false)
  openLocalWorkspaceMock.mockResolvedValue(undefined)
  nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker.mockResolvedValue(null)
  automationMocks.useNativeDirectoryPicker = true
  openExternalUrlMock.mockResolvedValue(true)
  startLocalTerminalMock.mockResolvedValue('local-terminal-1')
  closeLocalTerminalMock.mockResolvedValue(undefined)
  getLocalCodexUsageDisplayMock.mockResolvedValue({
    status: 'available',
    fiveHour: { label: '5h', title: '5小时额度', value: '87%', percent: 87, resetsAt: null },
    sevenDay: { label: '7d', title: '7天额度', value: '42%', percent: 42, resetsAt: null },
    trayTitle: '5h 87%\n7d 42%',
    tooltip: '5小时额度 87%\n7天额度 42%',
  })
  createDeviceApiMock.mockReturnValue(createMockDeviceApi() as never)
  startCodeServerSessionMock.mockResolvedValue({
    url: 'http://localhost/ide',
    path: '/workspace/projects/github_wegent',
  })
  startDeviceCodeServerSessionMock.mockResolvedValue({
    url: 'http://localhost/ide',
    path: '/workspace/project',
  })
  startTerminalSessionMock.mockResolvedValue({
    session_id: 'terminal-1',
    url: '',
    transport: 'socketio',
    device_id: 'workspace-cloud-device',
    path: '/workspace/project',
  })
  startDeviceTerminalSessionMock.mockResolvedValue({
    session_id: 'terminal-1',
    url: '',
    transport: 'socketio',
    device_id: 'workspace-cloud-device',
    path: '/workspace/project',
  })
  createProjectApiMock.mockReturnValue({
    startTerminalSession: startTerminalSessionMock,
    startCodeServerSession: startCodeServerSessionMock,
  } as unknown as ReturnType<typeof createProjectApiMock>)
  createTemporaryRuntimeTaskMock.mockResolvedValue(false)
  subscribeRuntimeTaskStreamMock.mockReturnValue(vi.fn())
})
