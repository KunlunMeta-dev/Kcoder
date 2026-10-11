/* eslint-disable @typescript-eslint/no-unused-vars */
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkbenchProvider, type WorkbenchServices } from './WorkbenchProvider'
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

  test('bootstraps with local app services in local-first runtime mode', async () => {
    setTauriRuntime()
    window.__KCODER_STUDIO_RUNTIME_CONFIG__ = {
      runtimeMode: 'local-first',
    }

    renderWorkbenchWithDefaultServices(<BootstrapProbe />)

    await waitFor(() => expect(screen.getByTestId('boot-state')).toHaveTextContent('local'))
    await waitFor(() => expect(screen.getByTestId('startup-ready')).toHaveTextContent('ready'), {
      timeout: 3000,
    })
    expect(screen.getByTestId('project-count')).toHaveTextContent('0')
    expect(screen.getByTestId('runtime-total')).toHaveTextContent('0')
    expect(localExecutorMocks.ensureLocalExecutorStarted).toHaveBeenCalled()
    expect(localExecutorMocks.requestLocalExecutor).toHaveBeenCalledWith('runtime.tasks.list', {})
  })

  test('bootstraps projects and runtime work without DB task APIs', async () => {
    const services = createWorkbenchServices()

    renderWorkbench(<BootstrapProbe />, services)

    await waitFor(() => expect(screen.getByTestId('boot-state')).toHaveTextContent('alice'))
    await waitFor(() => expect(screen.getByTestId('startup-ready')).toHaveTextContent('ready'))
    expect(screen.getByTestId('project-count')).toHaveTextContent('0')
    expect(screen.getByTestId('runtime-total')).toHaveTextContent('3')
    expect(services.projectApi.listProjects).not.toHaveBeenCalled()
    expect(services.runtimeWorkApi?.listRuntimeWork).toHaveBeenCalledTimes(1)
  })

  test('keeps the terminal snapshot when an older background refresh arrives late', async () => {
    let backgroundStreamHandlers: ChatStreamHandlers | null = null
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (handlers.scope?.taskId === 'runtime-a') {
        backgroundStreamHandlers = handlers
      }
      return vi.fn()
    })
    const runningRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
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
              tasks: [
                {
                  taskId: 'runtime-a',
                  workspacePath: '/workspace/project-alpha',
                  title: 'Runtime A',
                  runtime: 'codex',
                  running: true,
                },
              ],
            },
          ],
          totalTasks: 1,
        },
      ],
      totalTasks: 1,
    })
    const settledRuntimeWork = structuredClone(runningRuntimeWork)
    settledRuntimeWork.projects[0].deviceWorkspaces[0].tasks[0].running = false
    const preTerminalRefresh = deferred<RuntimeWorkListResponse>()
    const listRuntimeWork = vi
      .fn()
      .mockResolvedValue(settledRuntimeWork)
      .mockResolvedValueOnce(runningRuntimeWork)
      .mockImplementationOnce(() => preTerminalRefresh.promise)
    const runtimeWorkApi = createRuntimeWorkApiMock({ listRuntimeWork })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<RuntimeRunningTasksProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-running-task-ids')).toHaveTextContent('runtime-a')
    )
    await waitFor(() => expect(backgroundStreamHandlers?.onChatDone).toBeDefined())

    await userEvent.click(screen.getByText('refresh work lists'))
    await waitFor(() => expect(listRuntimeWork).toHaveBeenCalledTimes(2))
    await act(async () => {
      backgroundStreamHandlers?.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: 'goal-final',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })

    // The new post-terminal read is authoritative; the earlier manual read
    // remains pending and must not overwrite it when it finally returns.
    await waitFor(() => expect(listRuntimeWork).toHaveBeenCalledTimes(3))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-running-task-ids')).toHaveTextContent('none')
    )
    await act(async () => {
      preTerminalRefresh.resolve(runningRuntimeWork)
      await preTerminalRefresh.promise
    })
    await waitFor(() =>
      expect(screen.getByTestId('runtime-running-task-ids')).toHaveTextContent('none')
    )
  })

  test('starts a fresh blank chat with a requested loaded skill selected', async () => {
    const services = createWorkbenchServices({
      skillApi: {
        listSkills: vi.fn().mockResolvedValue([
          {
            id: 101,
            name: 'sites-building',
            namespace: 'sites',
            description: 'Build websites with Sites',
            is_active: true,
            is_public: false,
            user_id: 1,
          },
        ]),
        getTeamSkills: vi.fn().mockResolvedValue({ skills: [], preload_skills: [] }),
      },
    })
    renderWorkbench(<StartSkillChatProbe />, services)
    await waitFor(() =>
      expect(screen.getByTestId('available-skill-names')).toHaveTextContent('sites-building')
    )

    await userEvent.click(screen.getByRole('button', { name: 'start sites chat' }))

    expect(screen.getByTestId('skill-chat-start-result')).toHaveTextContent('started')
    expect(screen.getByTestId('skill-chat-key')).toHaveTextContent('1')
    expect(screen.getByTestId('selected-skill-refs')).toHaveTextContent(
      'sites:sites-building:false'
    )
    expect(screen.getByTestId('skill-chat-input')).toHaveTextContent('')
  })

  test('starts a fresh blank chat with a requested local skill mentioned', async () => {
    setTauriRuntime()
    localExecutorMocks.requestLocalExecutor.mockImplementation(
      async (method: string, params?: unknown) => {
        if (method === 'runtime.tasks.list') {
          return { projects: [], chats: [], totalTasks: 0 }
        }
        if (
          method === 'codex.app_server_request' &&
          params &&
          typeof params === 'object' &&
          (params as { method?: unknown }).method === 'skills/list'
        ) {
          return {
            data: [
              {
                cwd: '',
                skills: [
                  {
                    name: 'sites:sites-building',
                    description: 'Build websites with Sites',
                    path: '/Users/alice/.codex/plugins/sites/skills/sites-building/SKILL.md',
                    scope: 'user',
                    source: 'codex-plugin',
                    enabled: true,
                  },
                ],
                errors: [],
              },
            ],
          }
        }
        return {}
      }
    )

    renderWorkbench(<StartSkillChatProbe />)

    await userEvent.click(screen.getByRole('button', { name: 'start sites chat' }))

    await waitFor(() =>
      expect(screen.getByTestId('skill-chat-start-result')).toHaveTextContent('started')
    )
    expect(screen.getByTestId('skill-chat-key')).toHaveTextContent('1')
    expect(screen.getByTestId('selected-skill-refs')).toHaveTextContent('')
    expect(screen.getByTestId('skill-chat-input')).toHaveTextContent(
      '[$sites](/Users/alice/.codex/plugins/sites/skills/sites-building/SKILL.md)'
    )
    expect(localExecutorMocks.requestLocalExecutor).toHaveBeenCalledWith(
      'codex.app_server_request',
      {
        method: 'skills/list',
        params: { cwds: [], forceReload: true },
      }
    )
  })

  test('does not resolve local skills for a Backend-only skill chat', async () => {
    setTauriRuntime()
    localExecutorMocks.requestLocalExecutor.mockImplementation(
      async (method: string, params?: unknown) => {
        if (method === 'runtime.tasks.list') {
          return { projects: [], chats: [], totalTasks: 0 }
        }
        if (
          method === 'codex.app_server_request' &&
          params &&
          typeof params === 'object' &&
          (params as { method?: unknown }).method === 'skills/list'
        ) {
          return {
            data: [
              {
                cwd: '',
                skills: [
                  {
                    name: 'sites:sites-building',
                    description: 'Build websites with Sites',
                    path: '/Users/alice/.codex/plugins/sites/skills/sites-building/SKILL.md',
                    scope: 'user',
                    enabled: true,
                  },
                ],
                errors: [],
              },
            ],
          }
        }
        return {}
      }
    )

    renderWorkbench(<StartSkillChatProbe />)

    await userEvent.click(screen.getByRole('button', { name: 'start backend sites chat' }))

    await waitFor(() =>
      expect(screen.getByTestId('skill-chat-start-result')).toHaveTextContent('missing')
    )
    expect(localExecutorMocks.requestLocalExecutor).not.toHaveBeenCalledWith(
      'codex.app_server_request',
      expect.objectContaining({ method: 'skills/list' })
    )
  })

  test('does not leave the current view when a requested skill is unavailable', async () => {
    renderWorkbench(<StartSkillChatProbe />)
    window.history.pushState({}, '', '/sites')

    await userEvent.click(screen.getByRole('button', { name: 'start sites chat' }))

    await waitFor(() =>
      expect(screen.getByTestId('skill-chat-start-result')).toHaveTextContent('missing')
    )
    expect(screen.getByTestId('skill-chat-key')).toHaveTextContent('0')
    expect(window.location.pathname).toBe('/sites')
  })

  test('does not poll runtime work after bootstrap', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const emptyRuntimeWork = createRuntimeWork({
        projects: [],
        chats: [],
        totalTasks: 0,
      })
      const refreshedRuntimeWork = createRuntimeWork({
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
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
                tasks: [
                  {
                    taskId: 'runtime-created-elsewhere',
                    workspacePath: '/workspace/project-alpha',
                    title: 'Created elsewhere',
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
      })
      const listRuntimeWork = vi
        .fn()
        .mockResolvedValueOnce(emptyRuntimeWork)
        .mockResolvedValue(refreshedRuntimeWork)
      const services = createWorkbenchServices({
        runtimeWorkApi: createRuntimeWorkApiMock({ listRuntimeWork }),
      })

      renderWorkbench(<BootstrapProbe />, services)

      await waitFor(() => expect(screen.getByTestId('runtime-total')).toHaveTextContent('0'))
      expect(listRuntimeWork).toHaveBeenCalledTimes(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })

      expect(listRuntimeWork).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('runtime-total')).toHaveTextContent('0')
    } finally {
      vi.useRealTimers()
    }
  })

  test('marks successful empty cloud devices as empty instead of unavailable', async () => {
    const services = createWorkbenchServices({
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi.fn().mockResolvedValue([]),
        listRuntimeWork: vi.fn().mockResolvedValue({ projects: [], chats: [], totalTasks: 0 }),
      },
    })

    renderWorkbench(<CloudWorkStatusProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('cloud-work-availability')).toHaveTextContent('empty')
    )
    expect(screen.getByTestId('cloud-work-devices-check')).toHaveTextContent('empty')
    expect(screen.getByTestId('cloud-work-error')).toHaveTextContent('')
  })

  test('publishes cloud devices before a slow runtime-work refresh completes', async () => {
    const runtimeWork = deferred<RuntimeWorkListResponse>()
    let runtimeWorkResolved = false
    void runtimeWork.promise.then(() => {
      runtimeWorkResolved = true
    })
    const services = createWorkbenchServices({
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi
          .fn()
          .mockResolvedValue([
            createDevice({ device_id: 'remote-device', device_type: 'remote', is_default: false }),
          ]),
        listRuntimeWork: vi.fn(() => runtimeWork.promise),
      },
    })

    renderWorkbench(<BootstrapProbe />, services)

    await waitFor(() => expect(screen.getByTestId('device-ids')).toHaveTextContent('remote-device'))
    expect(runtimeWorkResolved).toBe(false)

    await act(async () => {
      runtimeWork.resolve({ projects: [], chats: [], totalTasks: 0 })
    })
  })

  test('does not let a stale cloud refresh remove a newer local runtime task', async () => {
    const cloudRuntimeWork = deferred<RuntimeWorkListResponse>()
    const emptyRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
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
    const refreshedRuntimeWork = createRuntimeWork({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
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
              tasks: [
                {
                  taskId: 'runtime-new-local',
                  workspacePath: '/workspace/project-alpha',
                  title: 'New local task',
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
    const listRuntimeWork = vi
      .fn()
      .mockResolvedValueOnce(emptyRuntimeWork)
      .mockResolvedValue(refreshedRuntimeWork)
    const services = createWorkbenchServices({
      runtimeWorkApi: createRuntimeWorkApiMock({ listRuntimeWork }),
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi.fn().mockResolvedValue([]),
        listRuntimeWork: vi.fn(() => cloudRuntimeWork.promise),
      },
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(listRuntimeWork).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByText('refresh work lists'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-task-titles')).toHaveTextContent('New local task')
    )

    await act(async () => {
      cloudRuntimeWork.resolve({ projects: [], chats: [], totalTasks: 0 })
    })

    await waitFor(() =>
      expect(screen.getByTestId('runtime-task-titles')).toHaveTextContent('New local task')
    )
  })

  test('ignores a manual device refresh after its cloud sync revision is replaced', async () => {
    const runtimeWork = deferred<RuntimeWorkListResponse>()
    const manualDevices = deferred<DeviceInfo[]>()
    const listDevices = vi
      .fn()
      .mockResolvedValueOnce([
        createDevice({ device_id: 'current-device', device_type: 'remote', is_default: false }),
      ])
      .mockImplementationOnce(() => manualDevices.promise)
    const services = createWorkbenchServices({
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices,
        listRuntimeWork: vi.fn(() => runtimeWork.promise),
      },
    })

    renderWorkbench(<BootstrapProbe />, services)
    await waitFor(() =>
      expect(screen.getByTestId('device-ids')).toHaveTextContent('current-device')
    )

    await userEvent.click(screen.getByRole('button', { name: 'Refresh devices' }))
    await waitFor(() => expect(listDevices).toHaveBeenCalledTimes(2))
    await act(async () => {
      runtimeWork.resolve({ projects: [], chats: [], totalTasks: 0 })
      await Promise.resolve()
      manualDevices.resolve([
        createDevice({ device_id: 'stale-device', device_type: 'remote', is_default: false }),
      ])
    })

    await waitFor(() =>
      expect(screen.getByTestId('device-ids')).not.toHaveTextContent('stale-device')
    )
  })

  test('does not restore cached remote work without an account scope', async () => {
    writeCachedRemoteRuntimeWork(
      { targetId: 'target-1', principalId: 'principal-1' },
      {
        projects: [
          {
            project: { key: '/srv/Wegent', name: 'Remote Wegent' },
            deviceWorkspaces: [
              {
                deviceId: 'remote-device',
                deviceName: '203.0.113.10',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/srv/Wegent',
                tasks: [
                  {
                    taskId: 'remote-cached-task',
                    workspacePath: '/srv/Wegent',
                    title: 'Cached remote task',
                    runtime: 'codex',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 1,
      }
    )
    const services = createWorkbenchServices({
      runtimeWorkApi: createRuntimeWorkApiMock({
        listRuntimeWork: vi.fn().mockResolvedValue({
          projects: [
            {
              project: {
                key: 'remote-project-id',
                sidebarStateKey: 'remote-project-id',
                name: 'Remote Wegent',
                kind: 'remote',
                source: 'remote_project',
                stateDeviceId: 'local-device',
              },
              deviceWorkspaces: [
                {
                  deviceId: 'remote-device',
                  deviceName: '127.0.0.1',
                  deviceStatus: 'offline',
                  available: false,
                  workspacePath: '/srv/Wegent',
                  workspaceSource: 'remote',
                  remoteHostId: 'remote-device',
                  mapped: true,
                  tasks: [],
                },
              ],
            },
          ],
          chats: [],
          totalTasks: 0,
        }),
      }),
      cloudBackgroundApi: {
        listTeams: vi.fn().mockResolvedValue([]),
        listDevices: vi.fn().mockResolvedValue([
          createDevice({
            id: 2,
            device_id: 'remote-device',
            name: '203.0.113.10',
            status: 'offline',
            is_default: false,
            device_type: 'remote',
          }),
        ]),
        listRuntimeWork: vi.fn().mockResolvedValue({
          projects: [],
          chats: [],
          totalTasks: 0,
        }),
      },
    })

    renderWorkbench(<RemoteRuntimeCacheProbe />, services)

    // Without an account scope the provider neither reads nor writes the
    // persistent remote work cache, so the seeded task stays hidden.
    expect(screen.getByTestId('cached-runtime-task-titles')).toHaveTextContent('')
    expect(screen.getByTestId('cached-runtime-device-names')).not.toHaveTextContent('203.0.113.10')
  })

  test('keeps remote work hidden on disconnect without an account-scoped cache', async () => {
    writeCachedRemoteRuntimeWork(
      { targetId: 'target-1', principalId: 'principal-1' },
      {
        projects: [
          {
            project: { key: '/srv/Wegent', name: 'Remote Wegent' },
            deviceWorkspaces: [
              {
                deviceId: 'remote-device',
                deviceName: '203.0.113.10',
                deviceStatus: 'offline',
                available: false,
                workspacePath: '/srv/Wegent',
                workspaceSource: 'remote',
                remoteHostId: 'remote-device',
                tasks: [
                  {
                    taskId: 'remote-cached-task',
                    workspacePath: '/srv/Wegent',
                    title: 'Cached remote task',
                    runtime: 'codex',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 1,
      }
    )
    const localRuntimeWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: {
            key: 'remote-project-id',
            sidebarStateKey: 'remote-project-id',
            name: 'Remote Wegent',
            kind: 'remote',
            source: 'remote_project',
            stateDeviceId: 'local-device',
          },
          deviceWorkspaces: [
            {
              deviceId: 'remote-device',
              deviceName: '127.0.0.1',
              deviceStatus: 'offline',
              available: false,
              workspacePath: '/srv/Wegent',
              workspaceSource: 'remote',
              remoteHostId: 'remote-device',
              mapped: true,
              tasks: [],
            },
          ],
          totalTasks: 0,
        },
        {
          project: { key: 'local-project-id', name: 'Local Wegent' },
          deviceWorkspaces: [
            {
              deviceId: 'local-device',
              deviceName: 'Local Mac',
              deviceStatus: 'online',
              available: true,
              workspacePath: '/Users/alice/Wegent',
              workspaceSource: 'local',
              mapped: true,
              tasks: [
                {
                  taskId: 'local-task',
                  workspacePath: '/Users/alice/Wegent',
                  title: 'Local task',
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
    const createServices = (connected: boolean) =>
      createWorkbenchServices({
        deviceApi: {
          listDevices: vi.fn().mockResolvedValue([
            createDevice({
              device_id: 'local-device',
              name: 'Local Mac',
              device_type: 'local',
            }),
          ]),
        } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
        runtimeWorkApi: createRuntimeWorkApiMock({
          listRuntimeWork: vi.fn().mockResolvedValue(localRuntimeWork),
        }),
        cloudBackgroundApi: connected
          ? {
              listTeams: vi.fn().mockResolvedValue([]),
              listDevices: vi.fn().mockResolvedValue([
                createDevice({
                  id: 2,
                  device_id: 'remote-device',
                  name: '203.0.113.10',
                  status: 'offline',
                  is_default: false,
                  device_type: 'remote',
                }),
              ]),
              listRuntimeWork: vi.fn().mockResolvedValue({
                projects: [],
                chats: [],
                totalTasks: 0,
              }),
            }
          : undefined,
      })
    const renderTree = (services: WorkbenchServices) => (
      <WorkbenchProvider user={{ id: 1, user_name: 'alice', email: 'a@b.c' }} services={services}>
        <WorkbenchProbeSessionProvider>
          <RemoteRuntimeCacheProbe />
        </WorkbenchProbeSessionProvider>
      </WorkbenchProvider>
    )
    const disconnectedServices = createServices(false)
    const connectedServices = createServices(true)
    const rendered = render(renderTree(disconnectedServices))

    await waitFor(() =>
      expect(screen.getByTestId('cached-runtime-project-names')).toHaveTextContent('Local Wegent')
    )
    expect(screen.getByTestId('cached-runtime-project-names')).not.toHaveTextContent(
      'Remote Wegent'
    )
    expect(screen.getByTestId('cached-runtime-task-titles')).toHaveTextContent('Local task')
    expect(screen.getByTestId('cached-runtime-task-titles')).not.toHaveTextContent(
      'Cached remote task'
    )

    rendered.rerender(renderTree(connectedServices))

    // The remote device registers through the live cloud connection, but the
    // unscoped persistent cache is neither read nor written, so the seeded
    // cached task never reappears.
    await waitFor(() =>
      expect(screen.getByTestId('cached-runtime-project-names')).toHaveTextContent('Remote Wegent')
    )
    expect(screen.getByTestId('cached-runtime-task-titles')).not.toHaveTextContent(
      'Cached remote task'
    )
    expect(screen.getByTestId('cached-runtime-device-names')).toHaveTextContent('203.0.113.10')

    rendered.rerender(renderTree(disconnectedServices))

    await waitFor(() => {
      expect(screen.getByTestId('cached-runtime-project-names')).not.toHaveTextContent(
        'Remote Wegent'
      )
      expect(screen.getByTestId('cached-runtime-task-titles')).not.toHaveTextContent(
        'Cached remote task'
      )
    })

    rendered.rerender(renderTree(connectedServices))

    await waitFor(() =>
      expect(screen.getByTestId('cached-runtime-task-titles')).toHaveTextContent('Local task')
    )
    expect(screen.getByTestId('cached-runtime-task-titles')).not.toHaveTextContent(
      'Cached remote task'
    )
  })

  test('applies device online events immediately when refresh falls back would be stale', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      streamHandlers = handlers
      return vi.fn()
    })
    const listDevices = vi
      .fn()
      .mockResolvedValueOnce([createDevice({ status: 'offline' })])
      .mockRejectedValue(new Error('network unavailable'))
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices,
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<DeviceStatusProbe />, services)

    await waitFor(() => expect(screen.getByTestId('device-status')).toHaveTextContent('offline'))

    await act(async () => {
      streamHandlers.onDeviceOnline?.({
        device_id: 'device-1',
        name: 'Project Device',
      })
    })

    expect(screen.getByTestId('device-status')).toHaveTextContent('online')
  })

  test('ensures the chat socket is connected while mounted', async () => {
    const socketClient = {
      ensureConnected: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    }
    const services = createWorkbenchServices({
      socketClient,
    } as Partial<WorkbenchServices>)

    const { unmount } = renderWorkbench(<BootstrapProbe />, services)

    await waitFor(() => expect(socketClient.ensureConnected).toHaveBeenCalledTimes(1))
    expect(socketClient.dispose).not.toHaveBeenCalled()

    unmount()

    expect(socketClient.dispose).toHaveBeenCalledTimes(1)
  })
})
