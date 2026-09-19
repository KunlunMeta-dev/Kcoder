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

  test('keeps executor-backed model choices selectable inside existing runtime tasks', async () => {
    const models: UnifiedModel[] = [
      {
        name: 'wecode-claude-sonnet-4-5',
        type: 'public',
        runtime: { family: 'claude.claude' },
      },
      {
        name: 'kimi-k2.5',
        type: 'public',
        runtime: { family: 'claude.claude' },
      },
      {
        name: 'codex-gpt-5.5',
        type: 'runtime',
        runtime: { family: 'openai.openai-responses' },
      },
      {
        name: 'gpt-5-2025-08-07',
        type: 'public',
        displayName: '海外:gpt-5-2025-08-07',
        provider: 'openai',
        runtime: { family: 'openai', provider: 'openai' },
      },
    ]
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: models }),
      },
    } as Partial<WorkbenchServices>)

    renderWorkbench(<RuntimeModelCompatibilityProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))

    await waitFor(() =>
      expect(screen.getByTestId('runtime-model-compatibility')).toHaveTextContent(
        [
          'wecode-claude-sonnet-4-5:enabled',
          'kimi-k2.5:enabled',
          'codex-gpt-5.5:enabled',
          'gpt-5-2025-08-07:enabled',
        ].join('|')
      )
    )
  })

  test('keeps all executor-backed catalog models selectable inside existing Codex runtime tasks', async () => {
    const models: UnifiedModel[] = [
      {
        name: 'codex-gpt-5.5',
        type: 'runtime',
        runtime: { family: 'openai.openai-responses' },
      },
      {
        name: 'gpt-5-2025-08-07',
        type: 'public',
        displayName: '海外:gpt-5-2025-08-07',
        provider: 'openai',
        runtime: { family: 'openai', provider: 'openai' },
      },
      {
        name: 'wecode-claude-sonnet-4-5',
        type: 'public',
        runtime: { family: 'claude.claude' },
      },
    ]
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
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
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
    })
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: models }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(<RuntimeModelCompatibilityProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))

    await waitFor(() =>
      expect(screen.getByTestId('runtime-model-compatibility')).toHaveTextContent(
        [
          'codex-gpt-5.5:enabled',
          'gpt-5-2025-08-07:enabled',
          'wecode-claude-sonnet-4-5:enabled',
        ].join('|')
      )
    )
  })

  test('disables third-party models inside an existing official Codex conversation', async () => {
    const models: UnifiedModel[] = [
      {
        name: 'gpt-5.6-sol',
        type: 'runtime',
        provider: 'local',
        config: {
          weworkModelKind: 'codex-official',
          ui: { family: 'codex-official' },
        },
      },
      {
        name: 'gpt-5.5',
        type: 'runtime',
        provider: 'local',
        config: {
          weworkModelKind: 'codex-official',
          ui: { family: 'codex-official' },
        },
      },
      {
        name: 'kimi-k2.5',
        type: 'runtime',
        provider: 'local',
        config: {
          weworkModelKind: 'codex-provider',
          ui: { family: 'codex-provider' },
        },
      },
      {
        name: 'cloud-model',
        type: 'public',
        provider: 'cloud',
        config: {
          ui: { family: 'gpt' },
        },
      },
    ]
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
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
                      modelSelection: {
                        modelName: 'gpt-5.6-sol',
                        modelType: 'runtime',
                        options: {},
                      },
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
    })
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: models }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(<RuntimeModelCompatibilityProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-model-compatibility')).toHaveTextContent(
        ['gpt-5.6-sol:enabled', 'gpt-5.5:enabled', 'kimi-k2.5:enabled', 'cloud-model:enabled'].join(
          '|'
        )
      )
    )

    await userEvent.click(await screen.findByText('open runtime a'))

    await waitFor(() =>
      expect(screen.getByTestId('runtime-model-compatibility')).toHaveTextContent(
        [
          'gpt-5.6-sol:enabled',
          'gpt-5.5:enabled',
          'kimi-k2.5:provider_boundary_mismatch',
          'cloud-model:provider_boundary_mismatch',
        ].join('|')
      )
    )
  })

  test('persists blank new chat model selection for backend users', async () => {
    window.__KCODER_STUDIO_RUNTIME_CONFIG__ = { runtimeMode: 'backend' }
    const models: UnifiedModel[] = [
      {
        name: 'gpt-5.5',
        type: 'runtime',
        provider: 'local',
        config: {
          weworkModelKind: 'codex-provider',
          ui: { family: 'codex-provider', controls: ['collaborationMode'] },
        },
        runtime: { family: 'openai.openai-responses' },
      },
      {
        name: 'local-model:mimo',
        type: 'runtime',
        provider: 'local',
        config: {
          weworkModelKind: 'model-interface',
          ui: { family: 'model-interface', controls: ['collaborationMode'] },
        },
        runtime: { family: 'openai.openai-responses' },
      },
    ]
    const updateCurrentUser = vi.fn().mockResolvedValue({})
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices: vi.fn().mockResolvedValue([createDevice({ device_type: 'local' })]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: models }),
      },
      userApi: {
        updateCurrentUser,
      } as Partial<WorkbenchServices['userApi']> as WorkbenchServices['userApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(<RuntimeModelSelectionProbe />, services)

    await waitFor(() => expect(screen.getByTestId('selected-model')).toHaveTextContent('gpt-5.5'))
    await userEvent.click(screen.getByText('select mimo'))

    await waitFor(() =>
      expect(updateCurrentUser).toHaveBeenCalledWith({
        preferences: expect.objectContaining({
          new_chat_model_selection: expect.objectContaining({
            modelName: 'local-model:mimo',
            modelType: 'runtime',
          }),
        }),
      })
    )
  })

  test('keeps local-first new chat model switches scoped to the current draft', async () => {
    window.__KCODER_STUDIO_RUNTIME_CONFIG__ = { runtimeMode: 'local-first' }
    const models: UnifiedModel[] = [
      {
        name: 'gpt-5.5',
        type: 'runtime',
        provider: 'local',
        config: {
          weworkModelKind: 'codex-provider',
          codexProviderCurrent: true,
          ui: { family: 'codex-provider', controls: ['collaborationMode'] },
        },
        runtime: { family: 'openai.openai-responses' },
      },
      {
        name: 'local-model:mimo',
        type: 'runtime',
        provider: 'local',
        config: {
          weworkModelKind: 'model-interface',
          ui: { family: 'model-interface', controls: ['collaborationMode'] },
        },
        runtime: { family: 'openai.openai-responses' },
      },
    ]
    const updateCurrentUser = vi.fn().mockResolvedValue({})
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices: vi.fn().mockResolvedValue([createDevice({ device_type: 'local' })]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: models }),
      },
      userApi: {
        updateCurrentUser,
      } as Partial<WorkbenchServices['userApi']> as WorkbenchServices['userApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(<RuntimeModelSelectionProbe />, services)

    await waitFor(() => expect(screen.getByTestId('selected-model')).toHaveTextContent('gpt-5.5'))
    await userEvent.click(screen.getByText('select mimo'))

    expect(screen.getByTestId('selected-model')).toHaveTextContent('local-model:mimo')
    expect(updateCurrentUser).not.toHaveBeenCalled()
  })

  test('does not restore a local model for a cloud runtime task', async () => {
    const models: UnifiedModel[] = [
      {
        name: 'gpt-5.5',
        type: 'runtime',
        provider: 'local',
        config: {
          weworkModelKind: 'codex-provider',
          ui: { family: 'codex-provider', controls: ['collaborationMode'] },
        },
        runtime: { family: 'openai.openai-responses' },
      },
      {
        name: 'local-model:mimo',
        type: 'runtime',
        provider: 'local',
        config: {
          weworkModelKind: 'model-interface',
          ui: { family: 'model-interface', controls: ['collaborationMode'] },
        },
        runtime: { family: 'openai.openai-responses' },
      },
    ]
    const updateCurrentUser = vi.fn().mockResolvedValue({})
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
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
                      modelSelection: {
                        modelName: 'local-model:mimo',
                        modelType: 'runtime',
                        options: { collaborationMode: 'plan' },
                      },
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
    })
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: models }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      userApi: {
        updateCurrentUser,
      } as Partial<WorkbenchServices['userApi']> as WorkbenchServices['userApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(<RuntimeModelSelectionProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))

    await waitFor(() => expect(screen.getByTestId('selected-model')).toHaveTextContent('gpt-5.5'))
    expect(screen.getByTestId('selected-mode')).toHaveTextContent('default')
    await userEvent.click(screen.getByText('select mimo'))
    expect(updateCurrentUser).not.toHaveBeenCalled()
  })

  test('only exposes an active model while a runtime task owns the conversation', async () => {
    const models: UnifiedModel[] = [
      {
        name: 'gpt-5.5',
        type: 'runtime',
        provider: 'local',
        config: {
          weworkModelKind: 'codex-provider',
          ui: { family: 'codex-provider', controls: ['collaborationMode'] },
        },
        runtime: { family: 'openai.openai-responses' },
      },
      {
        name: 'local-model:mimo',
        type: 'runtime',
        provider: 'local',
        config: {
          weworkModelKind: 'model-interface',
          ui: { family: 'model-interface', controls: ['collaborationMode'] },
        },
        runtime: { family: 'openai.openai-responses' },
      },
    ]
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
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
                      modelSelection: {
                        modelName: 'local-model:mimo',
                        modelType: 'runtime',
                      },
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
    })
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices: vi.fn().mockResolvedValue([createDevice({ device_type: 'local' })]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: models }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(<RuntimeModelSelectionProbe />, services)

    // A new chat has no conversation context, so no model owns it yet. The
    // model selector must not treat the persisted new-chat preference as an
    // active model, otherwise switching models would warn unnecessarily.
    await waitFor(() => expect(screen.getByTestId('selected-model')).toHaveTextContent('gpt-5.5'))
    expect(screen.getByTestId('active-model')).toHaveTextContent(/^$/)
    await userEvent.click(screen.getByText('select mimo'))
    await waitFor(() =>
      expect(screen.getByTestId('selected-model')).toHaveTextContent('local-model:mimo')
    )
    expect(screen.getByTestId('active-model')).toHaveTextContent(/^$/)

    await userEvent.click(screen.getByText('open runtime a'))

    await waitFor(() =>
      expect(screen.getByTestId('active-model')).toHaveTextContent('local-model:mimo')
    )
  })

  test('creates a runtime task for a new project message', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
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
          ],
          totalTasks: 0,
        })
      ),
      createRuntimeTask: vi.fn(async request => ({
        accepted: true,
        deviceId: request.deviceId,
        taskId: request.taskId,
        workspacePath: request.workspacePath,
        runtime: 'claude_code',
      })),
      getRuntimeTranscript: vi.fn(async (address: RuntimeTranscriptRequest) => ({
        taskId: address.taskId,
        workspacePath: address.workspacePath,
        runtime: 'claude_code',
        messages: [],
      })),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        teamId: 2,
        message: '修复 CI',
      })
    )
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty('projectId')
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty(
      'deviceWorkspaceId'
    )
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty('task_id')
    const request = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        `device-1:${request.taskId}`
      )
    )
    // The optimistic user message stays in place while the empty new-task
    // transcript loads.
    expect(screen.getByTestId('message-roles')).toHaveTextContent('user:修复 CI')
    expect(runtimeWorkApi.getRuntimeTranscript).toHaveBeenCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      taskId: request.taskId,
      limit: 50,
    })
    expect(parseRuntimeTaskRoute(window.location.pathname, window.location.search)).toEqual({
      deviceId: 'device-1',
      taskId: request.taskId,
    })
  })

  test('restores and records the active project from Codex global state metadata', async () => {
    const activateRuntimeProject = vi.fn().mockResolvedValue({
      accepted: true,
      deviceId: 'device-1',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { key: '/workspace/project-alpha', id: 7, name: 'Wegent', active: true },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'device-1',
                  deviceName: 'Local Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
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
      activateRuntimeProject,
    })
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices: vi.fn().mockResolvedValue([createDevice({ device_type: 'local' })]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('current-project-name')).toHaveTextContent('Wegent')
    )
    await waitFor(() =>
      expect(activateRuntimeProject).toHaveBeenCalledWith({
        deviceId: 'device-1',
        projectKey: '/workspace/project-alpha',
        workspacePath: '/workspace/project-alpha',
      })
    )
  })

  test('restores the last used project before starting a new task', async () => {
    writeLastProjectId(1, 7)
    renderWorkbench(<ProjectSendProbe />)

    await waitFor(() =>
      expect(screen.getByTestId('current-project-name')).toHaveTextContent('Wegent')
    )

    await userEvent.click(screen.getByText('start new chat'))

    expect(screen.getByTestId('current-project-name')).toHaveTextContent('Wegent')
    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent('none')
  })

  test('starts a new task in the project of the last opened task', async () => {
    renderWorkbench(<ProjectSendProbe />)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-project-order')).toHaveTextContent('Wegent')
    )
    await userEvent.click(screen.getByText('open project runtime task'))
    expect(screen.getByTestId('current-project-name')).toHaveTextContent('Wegent')
    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
      'device-1:runtime-a'
    )

    await userEvent.click(screen.getByText('start new chat'))
    expect(screen.getByTestId('current-project-name')).toHaveTextContent('Wegent')
    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent('none')
  })

  test('keeps a standalone new task unassigned when starting another new task', async () => {
    renderWorkbench(<ProjectSendProbe />)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-project-order')).toHaveTextContent('Wegent')
    )
    await userEvent.click(screen.getByText('select project'))
    expect(screen.getByTestId('current-project-name')).toHaveTextContent('Wegent')

    await userEvent.click(screen.getByText('start standalone chat'))
    expect(screen.getByTestId('current-project-name')).toHaveTextContent('none')
    expect(readLastProjectId(1)).toBeNull()

    await userEvent.click(screen.getByText('start new chat'))
    expect(screen.getByTestId('current-project-name')).toHaveTextContent('none')
    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent('none')
  })

  test('falls back to a standalone new task when the last project no longer exists', async () => {
    renderWorkbench(<ProjectSendProbe />)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-project-order')).toHaveTextContent('Wegent')
    )
    writeLastProjectId(1, 999)

    await userEvent.click(screen.getByText('start new chat'))

    expect(screen.getByTestId('current-project-name')).toHaveTextContent('none')
    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent('none')
  })

  test('does not reopen a newly created task after the user switches tasks', async () => {
    const createResponse = deferred<RuntimeTaskCreateResponse>()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  deviceId: 'device-1',
                  deviceName: 'Project Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  mapped: true,
                  available: true,
                  tasks: [
                    {
                      taskId: 'runtime-b',
                      workspacePath: '/workspace/project-alpha',
                      title: 'Runtime B',
                      runtime: 'codex',
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
      createRuntimeTask: vi.fn(() => createResponse.promise),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await userEvent.click(await screen.findByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))
    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    const optimisticRequest = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]

    await userEvent.click(screen.getByText('open runtime b'))
    const chatKeyBeforeAcknowledgement = screen.getByTestId('standalone-chat-key').textContent
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-b'
      )
    )

    await act(async () => {
      createResponse.resolve({
        accepted: true,
        deviceId: 'device-1',
        taskId: optimisticRequest.taskId,
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
      })
      await createResponse.promise
    })

    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
      'device-1:runtime-b'
    )
    expect(parseRuntimeTaskRoute(window.location.pathname, window.location.search)).toEqual({
      deviceId: 'device-1',
      taskId: 'runtime-b',
    })
    expect(screen.getByTestId('standalone-chat-key').textContent).toBe(chatKeyBeforeAcknowledgement)
  })

  test('keeps a newly created task running across a stale accepted-task refresh', async () => {
    let createdTaskId = ''
    const initialRuntimeWork = createRuntimeWork({
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
    const listRuntimeWork = vi.fn().mockImplementation(() => {
      if (!createdTaskId) return Promise.resolve(initialRuntimeWork)
      return Promise.resolve(
        createRuntimeWork({
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
                      taskId: createdTaskId,
                      workspacePath: '/workspace/project-alpha',
                      title: '修复 CI',
                      runtime: 'codex',
                      status: 'active',
                      running: false,
                    },
                  ],
                },
              ],
              totalTasks: 1,
            },
          ],
          totalTasks: 1,
        })
      )
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork,
      createRuntimeTask: vi.fn(async request => {
        createdTaskId = request.taskId
        return {
          accepted: true,
          deviceId: 'device-1',
          taskId: request.taskId,
          workspacePath: '/workspace/project-alpha',
          runtime: 'codex',
        }
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await userEvent.click(await screen.findByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(listRuntimeWork.mock.calls.length).toBeGreaterThan(1))
    expect(screen.getByTestId('current-created-runtime-task-running')).toHaveTextContent('running')
  })

  test('keeps a failed record but releases the missing thread so another send creates a new task', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
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
          ],
          totalTasks: 0,
        })
      ),
      createRuntimeTask: vi.fn(async request => ({
        accepted: false,
        deviceId: request.deviceId,
        taskId: request.taskId,
        workspacePath: request.workspacePath,
        runtime: 'claude_code',
        error: 'executor-not-found:device-1',
      })),
      getRuntimeTranscript: vi.fn(async (address: RuntimeTranscriptRequest) => ({
        taskId: address.taskId,
        workspacePath: address.workspacePath,
        runtime: 'claude_code',
        messages: [],
      })),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    const request = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent('none')
    )
    expect(screen.getByTestId('runtime-task-titles')).toHaveTextContent('修复 CI')
    expect(screen.getByTestId('runtime-task-statuses')).toHaveTextContent('failed')
    expect(screen.getByTestId('runtime-task-errors')).toHaveTextContent(
      'executor-not-found:device-1'
    )
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))
    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(2))
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[1][0].taskId).not.toBe(request.taskId)
  })

  test('keeps new runtime task model selection for context usage window resolution', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const models: UnifiedModel[] = [
      {
        name: 'local-model:mimo',
        type: 'runtime',
        provider: 'local',
        config: {
          weworkModelKind: 'model-interface',
          model_context_window: 1_000_000,
          ui: { family: 'model-interface', controls: ['collaborationMode'] },
        },
        runtime: { family: 'openai.openai-responses' },
      },
    ]
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  deviceId: 'device-1',
                  deviceName: 'Local Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
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
      createRuntimeTask: vi.fn(async request => ({
        accepted: true,
        deviceId: request.deviceId,
        taskId: request.taskId,
        workspacePath: request.workspacePath,
        runtime: 'codex',
      })),
      getRuntimeTranscript: vi.fn(async (address: RuntimeTranscriptRequest) => ({
        taskId: address.taskId,
        workspacePath: address.workspacePath,
        runtime: 'codex',
        messages: [],
      })),
    })
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices: vi.fn().mockResolvedValue([createDevice({ device_type: 'local' })]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: models }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    const request = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        `device-1:${request.taskId}`
      )
    )
    await waitFor(() =>
      expect(screen.getByTestId('runtime-task-model-selection')).toHaveTextContent(
        'local-model:mimo:runtime:'
      )
    )
    await waitFor(() => expect(streamHandlers.onChatDone).toBeDefined())

    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: request.taskId,
        subtaskId: '102',
        result: {
          value: 'done',
          contextUsage: {
            total: {
              totalTokens: 43_300,
              inputTokens: 43_000,
              cachedInputTokens: 0,
              outputTokens: 300,
              reasoningOutputTokens: 0,
            },
            last: {
              totalTokens: 43_300,
              inputTokens: 43_000,
              cachedInputTokens: 0,
              outputTokens: 300,
              reasoningOutputTokens: 0,
            },
            modelContextWindow: 258_400,
          },
        },
        deviceId: 'device-1',
      })
    })

    await waitFor(() =>
      expect(screen.getByTestId('runtime-context-window')).toHaveTextContent('1000000')
    )
  })

  test('creates a goal-first runtime task for a new project message', async () => {
    const createRuntimeTask =
      deferred<
        Awaited<ReturnType<NonNullable<WorkbenchServices['runtimeWorkApi']>['createRuntimeTask']>>
      >()
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 11,
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
          ],
          totalTasks: 0,
        })
      ),
      createRuntimeTask: vi.fn().mockReturnValue(createRuntimeTask.promise),
      getRuntimeTranscript: vi.fn(async (address: RuntimeTranscriptRequest) => ({
        taskId: address.taskId,
        workspacePath: address.workspacePath,
        runtime: 'codex',
        messages: [],
      })),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set goal'))
    expect(screen.getByTestId('goal-draft-active')).toHaveTextContent('active')
    await userEvent.click(screen.getByText('set input'))

    expect(screen.getByTestId('goal-objective')).toHaveTextContent('none')

    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        clientMessageId: expect.stringMatching(/^runtime-local-pane-/),
      })
    )
    await waitFor(() =>
      expect(screen.getByTestId('goal-draft-active')).toHaveTextContent('inactive')
    )
    expect(screen.getByTestId('goal-objective')).toHaveTextContent('修复 CI')
    expect(screen.getByTestId('message-goal-flags')).toHaveTextContent('goal:修复 CI')
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 7,
        deviceWorkspaceId: 11,
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        teamId: 2,
        message: '修复 CI',
        initialGoal: {
          mode: 'standard',
          objective: '修复 CI',
          status: 'active',
          tokenBudget: null,
        },
      })
    )
    const request = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]
    await waitFor(() => expect(streamHandlers.onChatStart).toBeDefined())
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: request.taskId,
        subtaskId: 'goal-turn',
        shellType: 'Codex',
        deviceId: 'device-1',
      })
      streamHandlers.onChatDone?.({
        taskId: request.taskId,
        subtaskId: 'goal-turn',
        deviceId: 'device-1',
        result: { value: 'initial turn settled before goal lookup' },
      })
    })
    await waitFor(() =>
      expect(screen.getByTestId('current-created-runtime-task-running')).toHaveTextContent(
        'running'
      )
    )
    expect(screen.getByTestId('pane-busy')).toHaveTextContent('busy')

    await act(async () => {
      createRuntimeTask.resolve({
        accepted: true,
        deviceId: 'device-1',
        taskId: request.taskId,
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
      })
      await createRuntimeTask.promise
    })
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        `device-1:${request.taskId}`
      )
    )
    expect(screen.getByTestId('goal-objective')).toHaveTextContent('修复 CI')
    expect(screen.getByTestId('message-roles')).toHaveTextContent('user:修复 CI')
    expect(screen.getByTestId('message-goal-flags')).toHaveTextContent('goal:修复 CI')

    await userEvent.click(screen.getByText('start new chat'))

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent('none')
    )
    expect(screen.getByTestId('current-project-name')).toHaveTextContent('Wegent')
    expect(screen.getByTestId('goal-objective')).toHaveTextContent('none')
  })

  test('starts and sends a multi-root local project chat from its primary root', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: {
                id: 7,
                key: 'product',
                name: 'Product',
                source: 'local_project',
                roots: [
                  { kind: 'local', path: '/workspace/web/' },
                  { kind: 'local', path: '/workspace/web' },
                  { kind: 'local', path: '/workspace/api/' },
                ],
              },
              deviceWorkspaces: [
                {
                  id: 11,
                  deviceId: 'device-1',
                  deviceName: 'Local Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/web',
                  workspaceSource: 'local',
                  mapped: true,
                  available: true,
                  tasks: [],
                },
                {
                  id: 12,
                  deviceId: 'device-1',
                  deviceName: 'Local Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/api',
                  workspaceSource: 'local',
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
      createRuntimeTask: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'device-1',
        taskId: 'multi-root-task',
        workspacePath: '/workspace/web',
        runtime: 'codex',
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await userEvent.click(await screen.findByText('start new project chat'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        workspacePath: '/workspace/web',
        runtimeProjectKey: 'product',
        runtimeProjectName: 'Product',
        runtimeWorkspaceRoots: ['/workspace/web', '/workspace/api'],
      })
    )
    expect(screen.getByTestId('workbench-error')).toHaveTextContent('')
  })

  test('enters goal draft mode when setting a goal without input', async () => {
    const services = createWorkbenchServices({
      runtimeWorkApi: createRuntimeWorkApiMock({
        listRuntimeWork: vi.fn().mockResolvedValue(
          createRuntimeWork({
            projects: [
              {
                project: { id: 7, name: 'Wegent' },
                deviceWorkspaces: [
                  {
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
            ],
            totalTasks: 0,
          })
        ),
      }) as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('enable plan mode'))
    expect(screen.getByTestId('project-collaboration-mode')).toHaveTextContent('plan')
    await userEvent.click(screen.getByText('set goal'))

    expect(screen.getByTestId('goal-draft-active')).toHaveTextContent('active')
    expect(screen.getByTestId('project-collaboration-mode')).toHaveTextContent('default')
    expect(screen.getByTestId('workbench-error')).toHaveTextContent('')
    expect(screen.getByTestId('goal-objective')).toHaveTextContent('none')
  })

  test('reports a visible error when submitting an empty goal draft', async () => {
    const services = createWorkbenchServices({
      runtimeWorkApi: createRuntimeWorkApiMock({
        listRuntimeWork: vi.fn().mockResolvedValue(
          createRuntimeWork({
            projects: [
              {
                project: { id: 7, name: 'Wegent' },
                deviceWorkspaces: [
                  {
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
            ],
            totalTasks: 0,
          })
        ),
      }) as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set goal'))
    await userEvent.click(screen.getByText('send'))

    expect(screen.getByTestId('pane-session-error')).toHaveTextContent('请输入目标内容')
    expect(screen.getByTestId('workbench-error')).toHaveTextContent('')
  })

  test('shows waiting status while creating a new runtime task from a fresh message', async () => {
    const createResponse = deferred<{
      accepted: boolean
      deviceId: string
      taskId: string
      workspacePath: string
      runtime: string
    }>()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
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
          ],
          totalTasks: 0,
        })
      ),
      createRuntimeTask: vi.fn().mockReturnValue(createResponse.promise),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [],
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('pane-busy')).toHaveTextContent('busy')
    expect(screen.getByTestId('pane-waiting')).toHaveTextContent('waiting')

    await act(async () => {
      createResponse.resolve({
        accepted: true,
        deviceId: 'device-1',
        taskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
      })
      await createResponse.promise
    })
  })

  test('keeps default model options when creating a runtime task', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
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
          ],
          totalTasks: 0,
        })
      ),
      createRuntimeTask: vi.fn(async request => ({
        accepted: true,
        deviceId: request.deviceId,
        taskId: request.taskId,
        workspacePath: request.workspacePath,
        runtime: 'codex',
      })),
      getRuntimeTranscript: vi.fn(async (address: RuntimeTranscriptRequest) => ({
        taskId: address.taskId,
        workspacePath: address.workspacePath,
        runtime: 'codex',
        messages: [],
      })),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('enable plan mode'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        modelOptions: { collaborationMode: 'plan' },
      })
    )
  })

  test('stores one canonical model identity for selection and execution', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      createRuntimeTask: vi.fn(async request => ({
        accepted: true,
        deviceId: request.deviceId,
        taskId: request.taskId,
        workspacePath: request.workspacePath,
        runtime: 'codex',
      })),
    })
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({
          data: [
            {
              name: 'shared-model',
              type: 'user',
              provider: 'cloud',
              config: {
                weworkModelKind: 'model-interface',
                ui: { family: 'model-interface', controls: ['collaborationMode'] },
              },
              runtime: { family: 'openai.openai-responses' },
            },
          ],
        }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(<ProjectSendProbe />, services)

    await userEvent.click(await screen.findByText('select project'))
    await userEvent.click(screen.getByText('enable plan mode'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'shared-model',
        modelType: 'user',
        modelSelection: {
          modelName: 'shared-model',
          modelType: 'user',
          options: {
            collaborationMode: 'plan',
          },
        },
      })
    )
  })

  test('uses the latest default model options when plan mode and send happen together', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
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
          ],
          totalTasks: 0,
        })
      ),
      createRuntimeTask: vi.fn(async request => ({
        accepted: true,
        deviceId: request.deviceId,
        taskId: request.taskId,
        workspacePath: request.workspacePath,
        runtime: 'codex',
      })),
      getRuntimeTranscript: vi.fn(async (address: RuntimeTranscriptRequest) => ({
        taskId: address.taskId,
        workspacePath: address.workspacePath,
        runtime: 'codex',
        messages: [],
      })),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('enable plan and send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        modelOptions: { collaborationMode: 'plan' },
      })
    )
  })

  test('keeps the sent user message and new task visible when the resolved address adds a workspace path', async () => {
    const initialRuntimeWork = createRuntimeWork({
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
      chats: [],
      totalTasks: 0,
    })
    const staleRuntimeWork = createRuntimeWork({
      projects: [],
      chats: [],
      totalTasks: 0,
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi
        .fn()
        .mockResolvedValueOnce(initialRuntimeWork)
        .mockResolvedValue(staleRuntimeWork),
      createRuntimeTask: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'device-1',
        taskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
      }),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [],
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimePaneSendProbe />, services)

    await waitFor(() => expect(screen.getByTestId('runtime-project-count')).toHaveTextContent('1'))
    await userEvent.click(await screen.findByText('select mapped project workspace'))
    await userEvent.click(screen.getByText('set pane input'))
    await userEvent.click(screen.getByText('send pane input'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-created:/workspace/project-alpha'
      )
    )
    expect(screen.getByTestId('pane-message-roles')).toHaveTextContent('user:修复 CI')
    expect(screen.getByTestId('runtime-local-task-count')).toHaveTextContent('1')
    expect(screen.getByTestId('runtime-local-task-titles')).toHaveTextContent('修复 CI')
  })

  test('shows a goal-first pending goal in the newly opened runtime pane', async () => {
    const createRuntimeTask =
      deferred<
        Awaited<ReturnType<NonNullable<WorkbenchServices['runtimeWorkApi']>['createRuntimeTask']>>
      >()
    const initialRuntimeWork = createRuntimeWork({
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
      chats: [],
      totalTasks: 0,
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(initialRuntimeWork),
      createRuntimeTask: vi.fn().mockReturnValue(createRuntimeTask.promise),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [],
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderStrictWorkbench(<RuntimePaneSendProbe />, services)

    await waitFor(() => expect(screen.getByTestId('runtime-project-count')).toHaveTextContent('1'))
    await userEvent.click(await screen.findByText('select mapped project workspace'))
    await userEvent.click(screen.getByText('set pane goal'))
    expect(screen.getByTestId('pane-goal-draft-active')).toHaveTextContent('active')
    await userEvent.click(screen.getByText('set pane input'))
    await userEvent.click(screen.getByText('send pane input'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('pane-goal-objective')).toHaveTextContent('修复 CI')

    const request = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]
    await act(async () => {
      createRuntimeTask.resolve({
        accepted: true,
        deviceId: 'device-1',
        taskId: request.taskId,
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
      })
      await createRuntimeTask.promise
    })

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        `device-1:${request.taskId}:/workspace/project-alpha`
      )
    )
    expect(screen.getByTestId('pane-goal-objective')).toHaveTextContent('修复 CI')
  })

  test('keeps the optimistic first message when Strict Mode reloads an empty transcript', async () => {
    const initialRuntimeWork = createRuntimeWork({
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
      chats: [],
      totalTasks: 0,
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(initialRuntimeWork),
      createRuntimeTask: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'device-1',
        taskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
      }),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [],
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderStrictWorkbench(<RuntimePaneSendProbe />, services)

    await waitFor(() => expect(screen.getByTestId('runtime-project-count')).toHaveTextContent('1'))
    await userEvent.click(await screen.findByText('select mapped project workspace'))
    await userEvent.click(screen.getByText('set pane input'))
    await userEvent.click(screen.getByText('send pane input'))

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-created:/workspace/project-alpha'
      )
    )
    expect(screen.getByTestId('pane-message-roles')).toHaveTextContent('user:修复 CI')
  })

  test('returns to the committed project pane after creating a runtime task', async () => {
    const initialRuntimeWork = createRuntimeWork({
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
      chats: [],
      totalTasks: 0,
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(initialRuntimeWork),
      createRuntimeTask: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'device-1',
        taskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
      }),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [],
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimePaneSendProbe />, services)

    await waitFor(() => expect(screen.getByTestId('runtime-project-count')).toHaveTextContent('1'))
    await userEvent.click(await screen.findByText('select mapped project workspace'))
    await userEvent.click(screen.getByText('set pane input'))
    await userEvent.click(screen.getByText('send pane input'))

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-created:/workspace/project-alpha'
      )
    )
    expect(screen.getByTestId('pane-message-roles')).toHaveTextContent('user:修复 CI')

    const focusRequest = vi.fn()
    window.addEventListener('wework:focus-new-chat-composer', focusRequest, { once: true })
    const previousBlankChatKey = Number(
      screen.getByTestId('runtime-pane-standalone-chat-key').textContent
    )
    await userEvent.click(screen.getByText('start new project task'))

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent('none')
    )
    await waitFor(() => expect(focusRequest).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('active-pane-key')).toHaveTextContent('project:7')
    expect(screen.getByTestId('pane-message-roles')).toHaveTextContent('')
    expect(screen.getByTestId('pane-goal-draft-active')).toHaveTextContent('inactive')
    expect(screen.getByTestId('runtime-pane-standalone-chat-key')).toHaveTextContent(
      String(previousBlankChatKey)
    )
  })

  test('sends through the selected project immediately after the project pane commits', async () => {
    const initialRuntimeWork = createRuntimeWork({
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
      chats: [],
      totalTasks: 0,
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(initialRuntimeWork),
    })
    const services = createWorkbenchServices({
      deviceApi: {
        getHomeDirectory: vi.fn().mockRejectedValue(new Error('remote mkdir is unavailable')),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimePaneSendProbe />, services)

    await waitFor(() => expect(screen.getByTestId('runtime-project-count')).toHaveTextContent('1'))
    flushSync(() => screen.getByText('start new project task').click())
    flushSync(() => screen.getByText('set pane input').click())
    screen.getByText('send pane input').click()

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 7,
        deviceWorkspaceId: 22,
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        message: '修复 CI',
      })
    )
    expect(services.deviceApi.getHomeDirectory).not.toHaveBeenCalled()
  })

  test('sends remote project tasks directly to the device in local-first mode', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
                  id: 22,
                  projectId: 7,
                  deviceId: 'remote-device',
                  deviceName: 'Remote Device',
                  deviceStatus: 'online',
                  workspacePath: '/workspace/project-alpha',
                  workspaceSource: 'remote',
                  mapped: true,
                  available: true,
                  tasks: [],
                },
              ],
              totalTasks: 0,
            },
          ],
          chats: [],
          totalTasks: 0,
        })
      ),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      cloudBackgroundApi: {},
      deviceApi: {
        listDevices: vi.fn().mockResolvedValue([
          createDevice(),
          createDevice({
            id: 2,
            device_id: 'remote-device',
            name: 'Remote Device',
            device_type: 'remote',
            is_default: false,
          }),
        ]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
    })

    renderWorkbench(<RuntimePaneSendProbe />, services)

    await waitFor(() => expect(screen.getByTestId('runtime-project-count')).toHaveTextContent('1'))
    flushSync(() => screen.getByText('start new project task').click())
    flushSync(() => screen.getByText('set pane input').click())
    screen.getByText('send pane input').click()

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'remote-device',
        workspacePath: '/workspace/project-alpha',
        message: '修复 CI',
      })
    )
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty('projectId')
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty(
      'deviceWorkspaceId'
    )
  })

  test('keeps streamed assistant content when the resolved address adds a workspace path', async () => {
    const streamHandlers: ChatStreamHandlers[] = []
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      streamHandlers.push(handlers)
      return vi.fn(() => {
        const index = streamHandlers.indexOf(handlers)
        if (index >= 0) streamHandlers.splice(index, 1)
      })
    })
    const createRuntimeTask =
      deferred<
        Awaited<ReturnType<NonNullable<WorkbenchServices['runtimeWorkApi']>['createRuntimeTask']>>
      >()
    const initialRuntimeWork = createRuntimeWork({
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
      chats: [],
      totalTasks: 0,
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(initialRuntimeWork),
      createRuntimeTask: vi.fn().mockReturnValue(createRuntimeTask.promise),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-created',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [],
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<RuntimePaneSendProbe />, services)

    await waitFor(() => expect(screen.getByTestId('runtime-project-count')).toHaveTextContent('1'))
    await userEvent.click(await screen.findByText('select mapped project workspace'))
    await userEvent.click(screen.getByText('set pane input'))
    await userEvent.click(screen.getByText('send pane input'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    const request = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]
    await waitFor(() => expect(streamHandlers.some(handler => handler.onChatChunk)).toBe(true))
    await act(async () => {
      const startPayload = {
        taskId: request.taskId,
        subtaskId: '102',
        deviceId: 'device-1',
      }
      const chunkPayload = {
        taskId: request.taskId,
        subtaskId: '102',
        content: 'streamed answer',
        offset: 0,
        deviceId: 'device-1',
      }
      streamHandlers.forEach(handler => {
        handler.onChatStart?.(startPayload)
        handler.onChatChunk?.(chunkPayload)
      })
    })
    await waitFor(() =>
      expect(screen.getByTestId('pane-message-roles')).toHaveTextContent(
        'assistant:streamed answer'
      )
    )

    await act(async () => {
      createRuntimeTask.resolve({
        accepted: true,
        deviceId: 'device-1',
        taskId: request.taskId,
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
      })
      await createRuntimeTask.promise
    })

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        `device-1:${request.taskId}:/workspace/project-alpha`
      )
    )
    expect(screen.getByTestId('pane-message-roles')).toHaveTextContent('user:修复 CI')
    expect(screen.getByTestId('pane-message-roles')).toHaveTextContent('assistant:streamed answer')
  })

  test('opens the runtime route and shows waiting while runtime task creation is pending', async () => {
    const createRuntimeTask =
      deferred<
        Awaited<ReturnType<NonNullable<WorkbenchServices['runtimeWorkApi']>['createRuntimeTask']>>
      >()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              deviceWorkspaces: [
                {
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
          ],
          totalTasks: 0,
        })
      ),
      createRuntimeTask: vi.fn().mockReturnValue(createRuntimeTask.promise),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    const request = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]
    expect(request.taskId).toMatch(/^runtime-/)
    expect(parseRuntimeTaskRoute(window.location.pathname, window.location.search)).toEqual({
      deviceId: 'device-1',
      taskId: request.taskId,
    })
    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
      `device-1:${request.taskId}`
    )
    expect(screen.getByTestId('thinking-indicator')).toHaveTextContent('等待响应')

    await act(async () => {
      createRuntimeTask.resolve({
        accepted: true,
        deviceId: 'device-1',
        taskId: request.taskId,
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
      })
    })
    await waitFor(() => expect(screen.getByTestId('sending-state')).toHaveTextContent('idle'))
    expect(screen.getByTestId('thinking-indicator')).toHaveTextContent('等待响应')
  })

  test('keeps a completed response idle after a refreshed task snapshot and late create acknowledgement', async () => {
    const creation = deferred<RuntimeTaskCreateResponse>()
    const streamHandlers = new Set<ChatStreamHandlers>()
    let createdTaskId: string | undefined
    let completed = false
    const listRuntimeWork = vi.fn(async () =>
      createRuntimeWork({
        projects: [
          {
            project: { id: 7, name: 'KCoder' },
            deviceWorkspaces: [
              {
                deviceId: 'device-1',
                workspacePath: '/workspace/project-alpha',
                available: true,
                tasks: createdTaskId
                  ? [
                      {
                        taskId: createdTaskId,
                        workspacePath: '/workspace/project-alpha',
                        title: 'Task',
                        runtime: 'kcoder',
                        running: !completed,
                      },
                    ]
                  : [],
              },
            ],
          },
        ],
        totalTasks: createdTaskId ? 1 : 0,
      })
    )
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork,
      createRuntimeTask: vi.fn(request => {
        createdTaskId = request.taskId
        return creation.promise
      }),
      getRuntimeTranscript: vi.fn(async (taskAddress: RuntimeTranscriptRequest) => ({
        taskId: taskAddress.taskId,
        runtime: 'kcoder',
        messages: [],
      })),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe: (handlers: ChatStreamHandlers) => {
          streamHandlers.add(handlers)
          return () => streamHandlers.delete(handlers)
        },
      } as unknown as WorkbenchServices['chatStream'],
    })
    renderWorkbench(<ProjectSendProbe />, services)
    await userEvent.click(await screen.findByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))
    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledOnce())
    const payload = { taskId: createdTaskId!, subtaskId: 'completed-turn', deviceId: 'device-1' }
    await act(async () => {
      streamHandlers.forEach(handlers => {
        handlers.onChatStart?.(payload)
        handlers.onChatChunk?.({ ...payload, content: 'The full response is complete.', offset: 0 })
      })
    })
    expect(screen.getByTestId('pane-busy')).toHaveTextContent('busy')
    const refreshCount = listRuntimeWork.mock.calls.length
    await act(async () => {
      completed = true
      streamHandlers.forEach(handlers =>
        handlers.onChatDone?.({
          ...payload,
          result: { value: 'The full response is complete.' },
        })
      )
    })
    expect(listRuntimeWork).toHaveBeenCalledTimes(refreshCount)
    await userEvent.click(screen.getByText('refresh work lists'))
    await waitFor(() => expect(listRuntimeWork.mock.calls.length).toBeGreaterThan(refreshCount))
    await waitFor(() => expect(screen.getByTestId('pane-waiting')).toHaveTextContent('idle'))
    await act(async () => {
      creation.resolve({
        accepted: true,
        ...payload,
        workspacePath: '/workspace/project-alpha',
        runtime: 'kcoder',
      })
      await creation.promise
    })
    await waitFor(() => expect(screen.getByTestId('sending-state')).toHaveTextContent('idle'))
    expect(screen.getByTestId('message-roles')).toHaveTextContent(
      'assistant:The full response is complete.'
    )
    expect(screen.getByTestId('pane-busy')).toHaveTextContent('idle')
    expect(screen.getByTestId('pane-waiting')).toHaveTextContent('idle')
    expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument()
  })

  test('clears thinking when a created runtime task transcript is already complete', async () => {
    let createdClientMessageId: string | undefined
    const runtimeWorkApi = createRuntimeWorkApiMock({
      createRuntimeTask: vi.fn(async request => {
        createdClientMessageId = request.clientMessageId
        return {
          accepted: true,
          deviceId: 'device-1',
          taskId: request.taskId,
          workspacePath: '/workspace/project-alpha',
          runtime: 'claude_code',
        }
      }),
      getRuntimeTranscript: vi.fn(async (address: RuntimeTaskAddress) => ({
        taskId: address.taskId,
        workspacePath: address.workspacePath ?? '/workspace/project-alpha',
        runtime: 'claude_code',
        running: false,
        messages: [
          {
            id: `${address.taskId}:user:1`,
            role: 'user',
            content: '修复 CI',
            status: 'done',
            clientMessageId: createdClientMessageId,
          },
          {
            id: `${address.taskId}:assistant:1`,
            role: 'assistant',
            content: 'done answer',
            status: 'done',
          },
        ],
      })),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('message-roles')).toHaveTextContent('assistant'))
    expect(screen.getByTestId('message-roles')).toHaveTextContent('assistant:done answer')
    await waitFor(() => expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument())
  })

  test('renders image attachments immediately when creating a runtime task', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:runtime-message-image-preview')
    URL.revokeObjectURL = vi.fn()
    localStorage.setItem('auth_token', 'token-1')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' })),
      })
    )
    const transcript = deferred<RuntimeTranscriptResponse>()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      createRuntimeTask: vi.fn(async request => ({
        accepted: true,
        deviceId: request.deviceId,
        taskId: request.taskId,
        workspacePath: request.workspacePath,
        runtime: 'claude_code',
      })),
      getRuntimeTranscript: vi.fn().mockReturnValue(transcript.promise),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('add image attachment'))
    expect(screen.getByTestId('project-attachment-count')).toHaveTextContent('1')
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('project-attachment-count')).toHaveTextContent('0')
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentIds: [45],
      })
    )
    const previews = await screen.findAllByTestId('message-image-preview')
    expect(
      previews.some(preview => preview.getAttribute('src') === 'blob:runtime-message-image-preview')
    ).toBe(true)
  })

  test('sends local image attachments as runtime attachments when creating a runtime task', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      createRuntimeTask: vi.fn(async request => ({
        accepted: true,
        deviceId: request.deviceId,
        taskId: request.taskId,
        workspacePath: request.workspacePath,
        runtime: 'claude_code',
      })),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('add local image attachment'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    const request = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]
    expect(request.attachmentIds).toEqual([])
    expect(request.attachments).toEqual([
      expect.objectContaining({
        id: -45,
        filename: 'photo.png',
        local_path: LOCAL_IMAGE_ATTACHMENT_PATH,
        local_preview_url: LOCAL_IMAGE_ATTACHMENT_PATH,
      }),
    ])
  })

  test('creates a runtime task from an explicitly opened standalone workspace', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(createRuntimeWork({ projects: [] })),
      createRuntimeTask: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'device-1',
        taskId: 'standalone-created',
        workspacePath: '/workspace/direct-codex',
        runtime: 'codex',
      }),
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'standalone-created',
        workspacePath: '/workspace/direct-codex',
        runtime: 'codex',
        messages: [{ id: 'assistant-1', role: 'assistant', content: 'started' }],
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('open standalone workspace')).toBeInTheDocument())
    await userEvent.click(screen.getByText('open standalone workspace'))
    await waitFor(() => expect(runtimeWorkApi.openRuntimeWorkspace).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.openRuntimeWorkspace).toHaveBeenCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/direct-codex',
      runtime: 'codex',
    })
    expect(`${window.location.pathname}${window.location.search}`).toBe('/')
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        workspacePath: '/workspace/direct-codex',
        teamId: 2,
        message: '修复 CI',
      })
    )
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty('projectId')
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty(
      'deviceWorkspaceId'
    )
  })

  test('registers multiple selected local folders as one Codex project', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi
        .fn()
        .mockResolvedValueOnce(createRuntimeWork({ projects: [] }))
        .mockResolvedValue(
          createRuntimeWork({
            projects: [
              {
                project: {
                  key: 'multi-project',
                  stateDeviceId: 'device-1',
                  name: 'web',
                },
                deviceWorkspaces: ['/workspace/web', '/workspace/api'].map(
                  (workspacePath, index) => ({
                    id: 101 + index,
                    deviceId: 'device-1',
                    deviceName: 'Local Device',
                    deviceStatus: 'online',
                    workspacePath,
                    workspaceKind: 'workspace',
                    workspaceSource: 'local',
                    mapped: true,
                    available: true,
                    tasks: [],
                  })
                ),
                totalTasks: 0,
              },
            ],
          })
        ),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)
    await userEvent.click(await screen.findByText('open multi-root workspace'))

    await waitFor(() => expect(runtimeWorkApi.upsertLocalRuntimeProject).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.upsertLocalRuntimeProject).toHaveBeenCalledWith({
      deviceId: 'device-1',
      projectKey: expect.any(String),
      name: 'web',
      roots: ['/workspace/web', '/workspace/api'],
      runtime: 'codex',
    })
    expect(runtimeWorkApi.openRuntimeWorkspace).not.toHaveBeenCalled()
    await waitFor(() => expect(runtimeWorkApi.listRuntimeWork).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('current-project-name')).toHaveTextContent('web')

    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))
    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        workspacePath: '/workspace/web',
      })
    )
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty('projectId')
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty(
      'deviceWorkspaceId'
    )
  })

  test('registers a named single-folder project through the local project flow', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi
        .fn()
        .mockResolvedValueOnce(createRuntimeWork({ projects: [] }))
        .mockResolvedValue(
          createRuntimeWork({
            projects: [
              {
                project: {
                  key: 'multi-project',
                  stateDeviceId: 'device-1',
                  name: 'Product',
                },
                deviceWorkspaces: [
                  {
                    id: 201,
                    deviceId: 'device-1',
                    deviceName: 'Local Device',
                    deviceStatus: 'online',
                    workspacePath: '/workspace/product',
                    workspaceKind: 'workspace',
                    workspaceSource: 'local',
                    mapped: true,
                    available: true,
                    tasks: [],
                  },
                ],
                totalTasks: 0,
              },
            ],
          })
        ),
      upsertLocalRuntimeProject: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'device-1',
        projectKey: 'multi-project',
        name: 'Product',
        roots: ['/workspace/product'],
        runtime: 'codex',
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)
    await userEvent.click(await screen.findByText('create named local project'))

    await waitFor(() => expect(runtimeWorkApi.upsertLocalRuntimeProject).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.upsertLocalRuntimeProject).toHaveBeenCalledWith({
      deviceId: 'device-1',
      projectKey: expect.any(String),
      name: 'Product',
      roots: ['/workspace/product'],
      runtime: 'codex',
    })
    expect(runtimeWorkApi.openRuntimeWorkspace).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.getByTestId('current-project-name')).toHaveTextContent('Product')
    )
  })

  test('creates a conversation workspace when sending without a selected project', async () => {
    vi.setSystemTime(new Date('2026-06-25T09:30:00.000Z'))
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(createRuntimeWork({ projects: [], chats: [] })),
      createRuntimeTask: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'device-1',
        taskId: 'conversation-created',
        workspacePath: '/Users/alice/Documents/KCoder/2026-06-25/ci',
        runtime: 'codex',
      }),
    })
    const services = createWorkbenchServices({
      deviceApi: {
        getHomeDirectory: vi.fn().mockResolvedValue('/Users/alice'),
        createDirectory: vi.fn().mockResolvedValue(undefined),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() => expect(screen.getByText('set input')).toBeInTheDocument())
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(services.deviceApi.getHomeDirectory).toHaveBeenCalledWith('device-1')
    const createdWorkspacePath = vi.mocked(services.deviceApi.createDirectory).mock.calls[0]?.[1]
    expect(createdWorkspacePath).toMatch(
      /^\/Users\/alice\/Documents\/KCoder\/2026-06-25\/ci-[a-z0-9]{8}$/
    )
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        workspacePath: createdWorkspacePath,
        teamId: 2,
        message: '修复 CI',
      })
    )
    expect(runtimeWorkApi.createRuntimeTask.mock.calls[0][0]).not.toHaveProperty('projectId')
    expect(screen.getByTestId('workbench-error')).not.toHaveTextContent(
      '请选择项目或打开设备工作区后再发送'
    )
  })

  test('registers a standalone Codex workspace with an optional label', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(createRuntimeWork({ projects: [] })),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() =>
      expect(screen.getByText('open labeled standalone workspace')).toBeInTheDocument()
    )
    await userEvent.click(screen.getByText('open labeled standalone workspace'))
    await waitFor(() => expect(runtimeWorkApi.openRuntimeWorkspace).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.openRuntimeWorkspace).toHaveBeenCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/direct-codex',
      runtime: 'codex',
      label: 'Direct Codex',
    })
    await waitFor(() =>
      expect(screen.getByTestId('current-project-name')).toHaveTextContent('Direct Codex')
    )
    expect(screen.getByTestId('standalone-workspace-path')).toHaveTextContent(
      '/workspace/direct-codex'
    )
    expect(screen.getByTestId('standalone-chat-key')).toHaveTextContent('1')
    expect(runtimeWorkApi.listRuntimeWork).toHaveBeenCalledTimes(1)
  })

  test('resolves the local-device CLI alias to the real local executor device', async () => {
    const localDevice = createDevice({
      device_id: 'device-real-local',
      name: 'This Mac',
      device_type: 'local',
      status: 'online',
      is_default: true,
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(createRuntimeWork({ projects: [] })),
      openRuntimeWorkspace: vi.fn().mockResolvedValue({
        accepted: true,
        workspacePath: '/workspace/cli-codex',
        runtime: 'codex',
      }),
      createRuntimeTask: vi.fn().mockResolvedValue({
        accepted: true,
        deviceId: 'device-real-local',
        taskId: 'cli-created',
        workspacePath: '/workspace/cli-codex',
        runtime: 'codex',
      }),
    })
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices: vi.fn().mockResolvedValue([localDevice]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() =>
      expect(screen.getByText('open cli local-device workspace')).toBeInTheDocument()
    )
    await userEvent.click(screen.getByText('open cli local-device workspace'))

    await waitFor(() => expect(runtimeWorkApi.openRuntimeWorkspace).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.openRuntimeWorkspace).toHaveBeenCalledWith({
      deviceId: 'local-device',
      workspacePath: '/workspace/cli-codex',
      runtime: 'codex',
      label: 'CLI Project',
    })
    await waitFor(() =>
      expect(screen.getByTestId('current-project-name')).toHaveTextContent('CLI Project')
    )
    expect(screen.getByTestId('standalone-device-id')).toHaveTextContent('device-real-local')
    expect(screen.getByTestId('current-project-device-id')).toHaveTextContent('device-real-local')
    expect(screen.getByTestId('standalone-workspace-path')).toHaveTextContent(
      '/workspace/cli-codex'
    )

    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-real-local',
        workspacePath: '/workspace/cli-codex',
        message: '修复 CI',
      })
    )
  })
})
