/* eslint-disable @typescript-eslint/no-unused-vars */
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkbenchProvider, type WorkbenchServices } from './WorkbenchProvider'
import { useWorkbench } from './useWorkbench'
import { notifyRuntimeTaskUnarchived } from './runtimeArchiveEvents'
import { parseRuntimeTaskRoute } from '@/lib/navigation'
import { readLastProjectId, writeLastProjectId } from './workbenchRuntimeHelpers'
import { writeCachedRemoteRuntimeWork } from './remoteRuntimeWorkCache'
import { createResponseApiStreamState, emitResponseApiEvent } from '@/stream/responseApiStream'
import type { ChatStreamHandlers } from '@/stream/chatStream'
import {
  cacheRuntimeConversationMessages,
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationMessages,
} from './runtimeConversationCache'
import type {
  DeviceInfo,
  RuntimeTaskAddress,
  RuntimeTaskCreateResponse,
  RuntimeGuidanceResponse,
  RuntimeTranscriptResponse,
  RuntimeTranscriptRequest,
  RuntimeWorkListResponse,
  UnifiedModel,
} from '@/types/api'

const localExecutorMocks = vi.hoisted(() => ({
  connectLocalExecutorToBackend: vi.fn().mockResolvedValue({ running: true, ready: true }),
  disconnectLocalExecutorFromBackend: vi.fn().mockResolvedValue({ running: true, ready: true }),
  ensureLocalExecutorStarted: vi.fn(),
  requestLocalExecutor: vi.fn(),
  subscribeLocalExecutorEvents: vi.fn(),
}))

vi.mock('@/tauri/localExecutor', () => ({
  connectLocalExecutorToBackend: localExecutorMocks.connectLocalExecutorToBackend,
  disconnectLocalExecutorFromBackend: localExecutorMocks.disconnectLocalExecutorFromBackend,
  ensureLocalExecutorStarted: localExecutorMocks.ensureLocalExecutorStarted,
  requestLocalExecutor: localExecutorMocks.requestLocalExecutor,
  subscribeLocalExecutorEvents: localExecutorMocks.subscribeLocalExecutorEvents,
}))

import {
  ArchiveProjectConversationsProbe,
  ArchiveRemoteRuntimeTaskProbe,
  ArchiveRuntimeTaskProbe,
  BootstrapProbe,
  CloudWorkStatusProbe,
  DeviceStatusProbe,
  FollowUpProbe,
  LOCAL_IMAGE_ATTACHMENT_PATH,
  ProjectSendProbe,
  ProjectWorkPreferenceProbe,
  RemoteRuntimeCacheProbe,
  RuntimeModelCompatibilityProbe,
  RuntimeModelSelectionProbe,
  RuntimeOpenProbe,
  RuntimePaneSendProbe,
  RuntimePaneSessionIdentityProbe,
  RuntimePlanScopeProbe,
  RuntimeProjectMutationProbe,
  RuntimeRunningTasksProbe,
  RuntimeTaskSkillsProbe,
  RuntimeTopLevelStreamLifecycleProbe,
  StartSkillChatProbe,
  WorkbenchProbeSessionProvider,
  clearTauriRuntime,
  createDevice,
  createProject,
  createRuntimeGoal,
  createRuntimeWork,
  createRuntimeWorkApiMock,
  createTurnFileChanges,
  createWorkbenchServices,
  deferred,
  hasRuntimeStreamHandler,
  renderStrictWorkbench,
  renderWorkbench,
  renderWorkbenchForUser,
  renderWorkbenchWithDefaultServices,
  setTauriRuntime,
} from './WorkbenchProvider.test-support'
describe('WorkbenchProvider runtime tasks', () => {
  beforeEach(() => {
    vi.useRealTimers()
    delete window.__KCODER_STUDIO_RUNTIME_CONFIG__
    clearTauriRuntime()
    window.history.pushState({}, '', '/')
    localStorage.clear()
    sessionStorage.clear()
    vi.clearAllMocks()
    localExecutorMocks.ensureLocalExecutorStarted.mockResolvedValue({
      running: true,
      ready: true,
      deviceId: 'local-device',
    })
    localExecutorMocks.requestLocalExecutor.mockImplementation(async (method: string) => {
      if (method === 'runtime.tasks.list') {
        return { projects: [], chats: [], totalTasks: 0 }
      }
      return {}
    })
    localExecutorMocks.subscribeLocalExecutorEvents.mockResolvedValue(vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
    clearRuntimeConversationCacheForTests()
  })

  beforeEach(() => {
    clearRuntimeConversationCacheForTests()
  })

  test('opens a standalone runtime project first without refreshing the runtime list', async () => {
    const existingProject = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Existing Project' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: true,
              tasks: [],
            },
          ],
          totalTasks: 0,
        },
      ],
      totalTasks: 0,
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(existingProject),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-project-order')).toHaveTextContent('Existing Project')
    )
    await userEvent.click(screen.getByText('open labeled standalone workspace'))

    await waitFor(() =>
      expect(screen.getByTestId('runtime-project-order')).toHaveTextContent(
        'Direct Codex|Existing Project'
      )
    )
    expect(runtimeWorkApi.listRuntimeWork).toHaveBeenCalledTimes(1)
  })

  test('acknowledged unarchive restores a project task even when the archive refresh was stale', async () => {
    const address = {
      deviceId: 'device-1',
      workspacePath: 'D:/new-project',
      taskId: 'restored-task',
    }
    const work = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'New project', source: 'local_project' },
          deviceWorkspaces: [
            {
              ...address,
              id: 7,
              available: true,
              tasks: [{ ...address, title: 'Original task', runtime: 'kcoder' }],
            },
          ],
          totalTasks: 1,
        },
      ],
      totalTasks: 1,
    })
    const api = createRuntimeWorkApiMock({ listRuntimeWork: vi.fn().mockResolvedValue(work) })
    function Probe() {
      const workbench = useWorkbench()
      return (
        <>
          <span data-testid="restored-tasks">
            {workbench.state.runtimeWork?.projects
              .flatMap(project =>
                project.deviceWorkspaces.flatMap(workspace =>
                  workspace.tasks.map(task => task.taskId)
                )
              )
              .join(',') || 'none'}
          </span>
          <button onClick={() => void workbench.archiveRuntimeTask(address)}>
            archive fixture
          </button>
          <button
            onClick={() => {
              notifyRuntimeTaskUnarchived(address)
              void workbench.refreshWorkLists()
            }}
          >
            restore fixture
          </button>
        </>
      )
    }
    renderWorkbench(
      <Probe />,
      createWorkbenchServices({ runtimeWorkApi: api as WorkbenchServices['runtimeWorkApi'] })
    )
    await waitFor(() =>
      expect(screen.getByTestId('restored-tasks')).toHaveTextContent('restored-task')
    )
    await userEvent.click(screen.getByText('archive fixture'))
    await waitFor(() => expect(screen.getByTestId('restored-tasks')).toHaveTextContent('none'))
    await userEvent.click(screen.getByText('restore fixture'))
    await waitFor(() =>
      expect(screen.getByTestId('restored-tasks')).toHaveTextContent('restored-task')
    )
  })

  test('removes a standalone workspace through the local runtime when its list is stale', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(createRuntimeWork()),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await userEvent.click(screen.getByText('open standalone workspace'))
    await waitFor(() =>
      expect(screen.getByTestId('standalone-workspace-path')).toHaveTextContent(
        '/workspace/direct-codex'
      )
    )
    await userEvent.click(screen.getByText('remove standalone workspace'))

    await waitFor(() => expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenCalledWith({
      deviceId: 'device-1',
      projectKey: '/workspace/direct-codex',
      workspacePath: '/workspace/direct-codex',
      runtime: 'codex',
    })
    expect(services.projectApi.deleteProject).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.getByTestId('standalone-workspace-path')).toHaveTextContent('none')
    )
  })

  test('does not restore a removed standalone workspace from an in-flight cloud refresh', async () => {
    const cloudRuntimeWork = deferred<RuntimeWorkListResponse>()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(createRuntimeWork()),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi.fn().mockResolvedValue([createDevice()]),
        listRuntimeWork: vi.fn(() => cloudRuntimeWork.promise),
      },
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await userEvent.click(screen.getByText('open standalone workspace'))
    await waitFor(() =>
      expect(screen.getByTestId('standalone-workspace-path')).toHaveTextContent(
        '/workspace/direct-codex'
      )
    )
    await userEvent.click(screen.getByText('remove standalone workspace'))
    await waitFor(() =>
      expect(screen.getByTestId('standalone-workspace-path')).toHaveTextContent('none')
    )

    await act(async () => {
      cloudRuntimeWork.resolve(
        createRuntimeWork({
          chats: [
            {
              deviceId: 'device-1',
              deviceName: 'Local Device',
              deviceStatus: 'online',
              available: true,
              workspacePath: '/workspace/direct-codex',
              workspaceKind: 'chat',
              tasks: [],
            },
          ],
        })
      )
    })

    await waitFor(() =>
      expect(screen.getByTestId('runtime-chat-workspaces')).toHaveTextContent(/^$/)
    )
    expect(screen.getByTestId('standalone-workspace-path')).toHaveTextContent('none')

    await userEvent.click(screen.getByText('open standalone workspace'))

    await waitFor(() => expect(runtimeWorkApi.openRuntimeWorkspace).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('standalone-workspace-path')).toHaveTextContent(
      '/workspace/direct-codex'
    )
  })

  test('creates a device workspace project first without refreshing the runtime list', async () => {
    const createdProject = createProject({
      id: 88,
      name: 'New Runtime Project',
      config: { mode: 'workspace' },
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(createRuntimeWork()),
      prepareDeviceWorkspace: vi.fn().mockResolvedValue({
        preparedAction: 'selected',
        mapping: {
          id: 44,
          projectId: 88,
          deviceId: 'device-1',
          workspacePath: '/workspace/new-runtime-project',
          label: 'workspace',
        },
      }),
    })
    const services = createWorkbenchServices({
      projectApi: {
        createProject: vi.fn().mockResolvedValue(createdProject),
      } as Partial<WorkbenchServices['projectApi']> as WorkbenchServices['projectApi'],
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeProjectMutationProbe />, services)

    await waitFor(() => expect(runtimeWorkApi.listRuntimeWork).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByText('create runtime project'))
    await waitFor(() => expect(runtimeWorkApi.prepareDeviceWorkspace).toHaveBeenCalledTimes(1))

    expect(services.projectApi.createProject).toHaveBeenCalledWith({
      name: 'New Runtime Project',
      description: '',
      config: { mode: 'workspace' },
    })
    expect(runtimeWorkApi.prepareDeviceWorkspace).toHaveBeenCalledWith({
      projectId: 88,
      deviceId: 'device-1',
      workspacePath: '/workspace/new-runtime-project',
      action: 'select',
    })
    expect(screen.getByTestId('mutation-project-name')).toHaveTextContent('New Runtime Project')
    expect(screen.getByTestId('mutation-project-order')).toHaveTextContent(
      'New Runtime Project|Wegent'
    )
    expect(runtimeWorkApi.listRuntimeWork).toHaveBeenCalledTimes(1)
  })

  test('renames and removes runtime projects through runtime-work metadata APIs', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock()
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeProjectMutationProbe />, services)

    await waitFor(() => expect(screen.getByText('rename runtime project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('rename runtime project'))
    await waitFor(() => expect(runtimeWorkApi.renameRuntimeWorkspace).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.renameRuntimeWorkspace).toHaveBeenCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
      name: 'Hello project',
    })
    expect(services.projectApi.updateProject).not.toHaveBeenCalled()

    await userEvent.click(screen.getByText('remove runtime project'))
    await waitFor(() => expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
    })
    expect(services.projectApi.deleteProject).not.toHaveBeenCalled()
  })

  test('removes a multi-root local runtime project through its primary root', async () => {
    const multiRootRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: {
            id: 7,
            key: 'product',
            name: 'Product',
            source: 'local_project',
            roots: [
              { kind: 'local', path: '/workspace/web' },
              { kind: 'local', path: '/workspace/api' },
            ],
          },
          deviceWorkspaces: [
            {
              id: 11,
              deviceId: 'device-1',
              workspacePath: '/workspace/web',
              available: true,
              tasks: [],
            },
            {
              id: 12,
              deviceId: 'device-1',
              workspacePath: '/workspace/api',
              available: true,
              tasks: [],
            },
          ],
          totalTasks: 0,
        },
      ],
      totalTasks: 0,
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi
        .fn()
        .mockResolvedValueOnce(multiRootRuntimeWork)
        .mockResolvedValue(createRuntimeWork({ projects: [], totalTasks: 0 })),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeProjectMutationProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('mutation-project-order')).toHaveTextContent('Product')
    )
    await userEvent.click(screen.getByText('remove runtime project'))

    await waitFor(() => expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenCalledWith({
      deviceId: 'device-1',
      projectKey: 'product',
      workspacePath: '/workspace/web',
      runtime: 'codex',
    })
    await waitFor(() =>
      expect(screen.getByTestId('mutation-project-order')).toHaveTextContent(/^$/)
    )
  })

  test('does not restore a removed runtime project from an in-flight cloud refresh', async () => {
    const cloudRuntimeWork = deferred<RuntimeWorkListResponse>()
    const staleRuntimeWork = createRuntimeWork()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(staleRuntimeWork),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi.fn().mockResolvedValue([]),
        listRuntimeWork: vi.fn(() => cloudRuntimeWork.promise),
      },
    })

    renderWorkbench(<RuntimeProjectMutationProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('mutation-project-order')).toHaveTextContent('Wegent')
    )
    await userEvent.click(screen.getByText('remove runtime project'))
    await waitFor(() =>
      expect(screen.getByTestId('mutation-project-order')).toHaveTextContent(/^$/)
    )

    await act(async () => {
      cloudRuntimeWork.resolve({ projects: [], chats: [], totalTasks: 0 })
    })

    await waitFor(() =>
      expect(screen.getByTestId('mutation-project-order')).toHaveTextContent(/^$/)
    )
  })

  test('renames and removes unavailable runtime projects through runtime-work metadata APIs', async () => {
    const unavailableRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'offline',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: false,
              tasks: [],
            },
          ],
          totalTasks: 0,
        },
      ],
      totalTasks: 0,
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(unavailableRuntimeWork),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeProjectMutationProbe />, services)

    await waitFor(() => expect(screen.getByText('rename runtime project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('rename runtime project'))
    await waitFor(() => expect(runtimeWorkApi.renameRuntimeWorkspace).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.renameRuntimeWorkspace).toHaveBeenCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
      name: 'Hello project',
    })
    expect(services.projectApi.updateProject).not.toHaveBeenCalled()

    await userEvent.click(screen.getByText('remove runtime project'))
    await waitFor(() => expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
    })
    expect(services.projectApi.deleteProject).not.toHaveBeenCalled()
  })

  test('renames and removes remote projects from both the remote executor and local Codex index', async () => {
    const remoteRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: {
            id: 7,
            key: '/srv/project-alpha',
            sidebarStateKey: 'remote-project-id',
            name: 'Wegent',
            kind: 'remote',
            source: 'remote_project',
            stateDeviceId: 'local-device',
          },
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'remote-device',
              remoteHostId: 'remote-device',
              deviceName: 'Remote Device',
              deviceStatus: 'online',
              workspacePath: '/srv/project-alpha',
              workspaceSource: 'remote',
              mapped: true,
              available: true,
              tasks: [],
            },
          ],
          totalTasks: 0,
        },
      ],
      totalTasks: 0,
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(remoteRuntimeWork),
    })
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices: vi
          .fn()
          .mockResolvedValue([
            createDevice({ device_id: 'local-device', device_type: 'local' }),
            createDevice({ device_id: 'remote-device', device_type: 'remote', is_default: false }),
          ]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi
          .fn()
          .mockResolvedValue([
            createDevice({ device_id: 'remote-device', device_type: 'remote', is_default: false }),
          ]),
        listRuntimeWork: vi.fn().mockResolvedValue({
          projects: [],
          chats: [],
          totalTasks: 0,
        }),
      },
    })

    renderWorkbench(<RuntimeProjectMutationProbe />, services)

    await userEvent.click(await screen.findByText('rename runtime project'))
    await waitFor(() => expect(runtimeWorkApi.renameRuntimeWorkspace).toHaveBeenCalledTimes(2))
    expect(runtimeWorkApi.renameRuntimeWorkspace).toHaveBeenNthCalledWith(1, {
      deviceId: 'remote-device',
      projectKey: '/srv/project-alpha',
      workspacePath: '/srv/project-alpha',
      runtime: 'codex',
      name: 'Hello project',
    })
    expect(runtimeWorkApi.renameRuntimeWorkspace).toHaveBeenNthCalledWith(2, {
      deviceId: 'local-device',
      projectKey: 'remote-project-id',
      workspacePath: '/srv/project-alpha',
      runtime: 'codex',
      name: 'Hello project',
    })

    await userEvent.click(screen.getByText('remove runtime project'))
    await waitFor(() => expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenCalledTimes(2))
    expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenNthCalledWith(1, {
      deviceId: 'remote-device',
      projectKey: '/srv/project-alpha',
      workspacePath: '/srv/project-alpha',
      runtime: 'codex',
    })
    expect(runtimeWorkApi.removeRuntimeWorkspace).toHaveBeenNthCalledWith(2, {
      deviceId: 'local-device',
      projectKey: 'remote-project-id',
      workspacePath: '/srv/project-alpha',
      runtime: 'codex',
    })
  })

  test('keeps the transcript and reports the server reason when archive is rejected', async () => {
    const error = '任务运行中，暂时无法归档'
    const runtimeWorkApi = createRuntimeWorkApiMock({
      archiveConversation: vi.fn().mockResolvedValue({ accepted: false, error }),
    })
    const address = {
      deviceId: 'device-1',
      taskId: 'runtime-worktree',
      workspacePath: '/workspace/worktrees/9/project-alpha',
    }
    cacheRuntimeConversationMessages(address, [
      {
        id: 'retained-message',
        role: 'assistant',
        content: 'Keep this transcript',
        status: 'done',
        createdAt: '2026-09-08T00:00:00Z',
      },
    ])
    renderWorkbench(
      <ArchiveRuntimeTaskProbe />,
      createWorkbenchServices({
        runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      })
    )
    await userEvent.click(await screen.findByText('archive worktree task'))
    await waitFor(() => expect(screen.getByTestId('archive-result')).toHaveTextContent('failed'))
    expect(screen.getByTestId('workbench-error')).toHaveTextContent(error)
    expect(getRuntimeConversationMessages(address)).toHaveLength(1)
  })

  test('archives a worktree task without prompting and preserves a snapshot', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 92,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/worktrees/9/project-alpha',
                  workspaceKind: 'worktree',
                  worktreeId: '9',
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-worktree',
                      workspacePath: '/workspace/worktrees/9/project-alpha',
                      workspaceKind: 'worktree',
                      worktreeId: '9',
                      title: 'Worktree task',
                      runtime: 'codex',
                    },
                  ],
                },
              ],
              totalTasks: 1,
            },
          ],
          totalTasks: 1,
        })
      ),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })
    const archivedAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-worktree',
      workspacePath: '/workspace/worktrees/9/project-alpha',
    }
    cacheRuntimeConversationMessages(archivedAddress, [
      {
        id: 'cached-assistant',
        role: 'assistant',
        content: 'cached archived transcript',
        status: 'done',
        createdAt: '2026-07-24T00:00:00.000Z',
      },
    ])

    renderWorkbench(<ArchiveRuntimeTaskProbe />, services)

    await waitFor(() => expect(screen.getByText('archive worktree task')).toBeInTheDocument())
    await userEvent.click(screen.getByText('archive worktree task'))

    await waitFor(() => expect(screen.getByTestId('archive-result')).toHaveTextContent('archived'))
    expect(screen.getByTestId('workbench-error')).toHaveTextContent('')
    expect(runtimeWorkApi.archiveConversation).toHaveBeenCalledTimes(1)
    expect(getRuntimeConversationMessages(archivedAddress)).toEqual([])
    expect(runtimeWorkApi.deleteWorktree).not.toHaveBeenCalled()
  })

  test('keeps a newly opened task selected when a different task finishes archiving', async () => {
    const archiveRequest = deferred<{
      accepted: boolean
      taskId: string
      workspacePath: string
      runtime: 'codex'
    }>()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(createRuntimeWork()),
      archiveConversation: vi.fn().mockReturnValue(archiveRequest.promise),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ArchiveRuntimeTaskProbe />, services)

    await waitFor(() => expect(screen.getByText('archive worktree task')).toBeInTheDocument())
    await userEvent.click(screen.getByText('archive worktree task'))
    await waitFor(() => expect(runtimeWorkApi.archiveConversation).toHaveBeenCalledTimes(1))

    await userEvent.click(screen.getByText('open runtime b'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task')).toHaveTextContent('runtime-b')
    )

    await act(async () => {
      archiveRequest.resolve({
        accepted: true,
        taskId: 'runtime-worktree',
        workspacePath: '/workspace/worktrees/9/project-alpha',
        runtime: 'codex',
      })
      await archiveRequest.promise
    })

    expect(screen.getByTestId('current-runtime-task')).toHaveTextContent('runtime-b')
  })

  test('force archive also uses the snapshot-capable worktree API', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 92,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/worktrees/9/project-alpha',
                  workspaceKind: 'worktree',
                  worktreeId: '9',
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-worktree',
                      workspacePath: '/workspace/worktrees/9/project-alpha',
                      workspaceKind: 'worktree',
                      worktreeId: '9',
                      title: 'Worktree task',
                      runtime: 'codex',
                    },
                  ],
                },
              ],
              totalTasks: 1,
            },
          ],
          totalTasks: 1,
        })
      ),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ArchiveRuntimeTaskProbe />, services)

    await waitFor(() => expect(screen.getByText('force archive worktree task')).toBeInTheDocument())
    await userEvent.click(screen.getByText('force archive worktree task'))

    await waitFor(() => expect(runtimeWorkApi.archiveConversation).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.deleteWorktree).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId('archive-result')).toHaveTextContent('archived'))
  })

  test('archives a task without implicitly reclaiming its shared worktree', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 92,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/worktrees/9/project-alpha',
                  workspaceKind: 'worktree',
                  worktreeId: '9',
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-worktree',
                      workspacePath: '/workspace/worktrees/9/project-alpha',
                      workspaceKind: 'worktree',
                      worktreeId: '9',
                      title: 'Worktree task',
                      runtime: 'codex',
                    },
                  ],
                },
              ],
              totalTasks: 1,
            },
          ],
          totalTasks: 1,
        })
      ),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ArchiveRuntimeTaskProbe />, services)

    await waitFor(() => expect(screen.getByText('archive worktree task')).toBeInTheDocument())
    await userEvent.click(screen.getByText('archive worktree task'))

    await waitFor(() => expect(runtimeWorkApi.archiveConversation).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.deleteWorktree).not.toHaveBeenCalled()
  })

  test('clears the active worktree view while leaving its workspace managed separately', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 92,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/worktrees/9/project-alpha',
                  workspaceKind: 'worktree',
                  worktreeId: '9',
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-worktree',
                      workspacePath: '/workspace/worktrees/9/project-alpha',
                      workspaceKind: 'worktree',
                      worktreeId: '9',
                      title: 'Worktree task',
                      runtime: 'codex',
                    },
                  ],
                },
              ],
              totalTasks: 1,
            },
          ],
          totalTasks: 1,
        })
      ),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ArchiveRuntimeTaskProbe />, services)
    await userEvent.click(await screen.findByText('open archived worktree target'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task')).toHaveTextContent('runtime-worktree')
    )

    await userEvent.click(screen.getByText('archive worktree task'))
    await waitFor(() => expect(runtimeWorkApi.archiveConversation).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('current-runtime-task')).toHaveTextContent('')
    expect(runtimeWorkApi.deleteWorktree).not.toHaveBeenCalled()
  })

  test('archives project conversations without a dirty-worktree prompt', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, key: 'project:7', name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 92,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/worktrees/9/project-alpha',
                  workspaceKind: 'worktree',
                  worktreeId: '9',
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-worktree',
                      workspacePath: '/workspace/worktrees/9/project-alpha',
                      workspaceKind: 'worktree',
                      worktreeId: '9',
                      title: 'Worktree task',
                      runtime: 'codex',
                    },
                  ],
                },
              ],
              totalTasks: 1,
            },
            {
              project: { key: 'remote-project-key', name: 'Remote project' },
              deviceWorkspaces: [
                {
                  deviceId: 'remote-device',
                  deviceName: 'Remote device',
                  deviceStatus: 'online',
                  workspacePath: '/srv/remote-project',
                  available: true,
                  tasks: [
                    {
                      taskId: 'remote-project-task',
                      workspacePath: '/srv/remote-project',
                      title: 'Remote project task',
                      runtime: 'codex',
                    },
                  ],
                },
              ],
              totalTasks: 1,
            },
          ],
          totalTasks: 2,
        })
      ),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ArchiveProjectConversationsProbe />, services)

    await waitFor(() =>
      expect(screen.getByText('archive project conversations')).toBeInTheDocument()
    )
    await userEvent.click(screen.getByText('archive project conversations'))

    await waitFor(() => expect(runtimeWorkApi.archiveConversation).toHaveBeenCalledTimes(2))
    expect(runtimeWorkApi.archiveConversation).toHaveBeenCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/worktrees/9/project-alpha',
      taskId: 'runtime-worktree',
    })
    expect(runtimeWorkApi.archiveConversation).toHaveBeenCalledWith({
      deviceId: 'remote-device',
      workspacePath: '/srv/remote-project',
      taskId: 'remote-project-task',
    })
    expect(runtimeWorkApi.archiveProjectConversations).not.toHaveBeenCalled()
    expect(runtimeWorkApi.deleteWorktree).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId('archive-result')).toHaveTextContent('archived'))
  })

  test('does not restore an archived remote task from the previous cloud snapshot', async () => {
    const remoteRuntimeWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: { key: 'remote-project', name: 'Remote Wegent' },
          deviceWorkspaces: [
            {
              deviceId: 'remote-device',
              deviceName: '203.0.113.10',
              deviceStatus: 'online',
              available: true,
              workspacePath: '/srv/Wegent',
              workspaceSource: 'remote',
              remoteHostId: 'remote-device',
              tasks: [
                {
                  taskId: 'remote-task',
                  workspacePath: '/srv/Wegent',
                  title: 'Remote task',
                  runtime: 'codex',
                },
              ],
            },
          ],
          totalTasks: 1,
        },
      ],
      chats: [],
      totalTasks: 1,
    }
    const postArchiveCloudWork = deferred<RuntimeWorkListResponse>()
    const cloudListRuntimeWork = vi
      .fn()
      .mockResolvedValueOnce(remoteRuntimeWork)
      .mockReturnValue(postArchiveCloudWork.promise)
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue({ projects: [], chats: [], totalTasks: 0 }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi.fn().mockResolvedValue([
          createDevice({
            id: 2,
            device_id: 'remote-device',
            name: '203.0.113.10',
            status: 'online',
            is_default: false,
            device_type: 'remote',
          }),
        ]),
        listRuntimeWork: cloudListRuntimeWork,
      },
    })

    renderWorkbench(<ArchiveRemoteRuntimeTaskProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('archive-remote-task-titles')).toHaveTextContent('Remote task')
    )
    await userEvent.click(screen.getByText('archive remote task'))

    await waitFor(() => expect(runtimeWorkApi.archiveConversation).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(cloudListRuntimeWork).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('archive-remote-task-titles')).toHaveTextContent('')

    postArchiveCloudWork.resolve({ projects: [], chats: [], totalTasks: 0 })
    await waitFor(() =>
      expect(screen.getByTestId('archive-remote-task-titles')).toHaveTextContent('')
    )
  })

  test('restores project execution mode and worktree branch per project preference', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, key: 'project:7', name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [],
                },
              ],
            },
            {
              project: { id: 8, key: 'project:8', name: 'Docs' },
              deviceWorkspaces: [
                {
                  id: 33,
                  projectId: 8,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-beta',
                  mapped: true,
                  available: true,
                  tasks: [],
                },
              ],
            },
          ],
          totalTasks: 0,
        })
      ),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })
    const user: User = {
      id: 1,
      user_name: 'alice',
      email: 'a@b.c',
      preferences: {
        wework_project_work_preferences: {
          'project:7': {
            executionMode: 'git_worktree',
            worktreeBranch: 'feature/alpha',
          },
          'project:8': {
            executionMode: 'current_workspace',
            worktreeBranch: 'feature/beta',
          },
        },
      },
    }

    renderWorkbenchForUser(<ProjectWorkPreferenceProbe />, user, services)

    await waitFor(() => expect(screen.getByText('select project 7')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project 7'))

    await waitFor(() => expect(screen.getByTestId('current-project-id')).toHaveTextContent('7'))
    await waitFor(() =>
      expect(screen.getByTestId('project-execution-mode')).toHaveTextContent('git_worktree')
    )
    expect(screen.getByTestId('project-worktree-branch')).toHaveTextContent('feature/alpha')

    await userEvent.click(screen.getByText('select project 8'))

    await waitFor(() => expect(screen.getByTestId('current-project-id')).toHaveTextContent('8'))
    await waitFor(() =>
      expect(screen.getByTestId('project-execution-mode')).toHaveTextContent('current_workspace')
    )
    expect(screen.getByTestId('project-worktree-branch')).toHaveTextContent('feature/beta')
  })

  test('keeps newly selected project execution preferences isolated by project', async () => {
    const updateCurrentUser = vi.fn().mockResolvedValue({})
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, key: 'project:7', name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [],
                },
              ],
            },
            {
              project: { id: 8, key: 'project:8', name: 'Docs' },
              deviceWorkspaces: [
                {
                  id: 33,
                  projectId: 8,
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-beta',
                  mapped: true,
                  available: true,
                  tasks: [],
                },
              ],
            },
          ],
          totalTasks: 0,
        })
      ),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      userApi: {
        updateCurrentUser,
      } as Partial<WorkbenchServices['userApi']> as WorkbenchServices['userApi'],
    })

    renderWorkbench(<ProjectWorkPreferenceProbe />, services)

    await waitFor(() => expect(screen.getByText('select project 7')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project 7'))
    await waitFor(() => expect(screen.getByTestId('current-project-id')).toHaveTextContent('7'))
    await userEvent.click(screen.getByText('use worktree'))
    await userEvent.click(screen.getByText('select alpha'))

    await waitFor(() =>
      expect(updateCurrentUser).toHaveBeenLastCalledWith({
        preferences: expect.objectContaining({
          wework_project_work_preferences: expect.objectContaining({
            'project:7': {
              executionMode: 'git_worktree',
              worktreeBranch: 'feature/alpha',
            },
          }),
        }),
      })
    )

    await userEvent.click(screen.getByText('select project 8'))

    await waitFor(() => expect(screen.getByTestId('current-project-id')).toHaveTextContent('8'))
    await waitFor(() =>
      expect(screen.getByTestId('project-execution-mode')).toHaveTextContent('current_workspace')
    )
    expect(screen.getByTestId('project-worktree-branch')).toHaveTextContent('')

    await userEvent.click(screen.getByText('use worktree'))
    await userEvent.click(screen.getByText('select beta'))
    await userEvent.click(screen.getByText('select project 7'))

    await waitFor(() => expect(screen.getByTestId('current-project-id')).toHaveTextContent('7'))
    await waitFor(() =>
      expect(screen.getByTestId('project-execution-mode')).toHaveTextContent('git_worktree')
    )
    expect(screen.getByTestId('project-worktree-branch')).toHaveTextContent('feature/alpha')

    await userEvent.click(screen.getByText('select project 8'))

    await waitFor(() => expect(screen.getByTestId('current-project-id')).toHaveTextContent('8'))
    await waitFor(() =>
      expect(screen.getByTestId('project-execution-mode')).toHaveTextContent('git_worktree')
    )
    expect(screen.getByTestId('project-worktree-branch')).toHaveTextContent('feature/beta')
  })
})
