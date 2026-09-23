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

  test('clears the task plan progress when starting a new chat', async () => {
    renderWorkbench(<RuntimePlanScopeProbe />)

    await userEvent.click(await screen.findByText('open runtime plan scope'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-plan-scope-task')).toHaveTextContent('runtime-plan-scope')
    )

    await act(async () => {
      emitResponseApiEvent(
        {},
        'runtime.plan.updated',
        {
          taskId: 'runtime-plan-scope',
          deviceId: 'device-1',
          data: {
            plan: [{ step: 'Implement the fix', status: 'inProgress' }],
          },
        },
        createResponseApiStreamState()
      )
      globalThis.dispatchEvent(new Event('wework-runtime-plan-updated'))
    })

    await waitFor(() =>
      expect(screen.getByTestId('runtime-plan-progress-button')).toBeInTheDocument()
    )

    await userEvent.click(screen.getByText('start new plan scope chat'))

    await waitFor(() => {
      expect(screen.getByTestId('runtime-plan-scope-task')).toHaveTextContent('none')
      expect(screen.queryByTestId('runtime-plan-progress-button')).not.toBeInTheDocument()
    })
  })

  test('reuses the current runtime task address for follow-up messages', async () => {
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(sendRuntimeMessage).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      clientMessageId: expect.any(String),
      message: '继续修',
      modelOptions: { collaborationMode: 'default' },
    })
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('继续修')
  })

  test('marks an existing runtime task running while a follow-up send is pending', async () => {
    const sendResponse = deferred<{ accepted: boolean; taskId: string }>()
    const sendRuntimeMessage = vi.fn().mockReturnValue(sendResponse.promise)
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    expect(screen.getByTestId('current-runtime-task-running')).toHaveTextContent('idle')

    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('current-runtime-task-running')).toHaveTextContent('running')

    await act(async () => {
      sendResponse.resolve({ accepted: true, taskId: 'runtime-a' })
      await sendResponse.promise
    })
  })

  test('keeps project chat composer state scoped to each runtime pane', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockImplementation(({ taskId }) =>
        Promise.resolve({
          taskId,
          workspacePath: '/workspace/project-alpha',
          runtime: 'claude_code',
          messages: [{ id: `${taskId}:user:1`, role: 'user', content: `message ${taskId}` }],
        })
      ),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<FollowUpProbe />, services)

    await userEvent.click(await screen.findByText('open follow-up runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('follow-up-collaboration-mode')).toHaveTextContent('default')
    )
    expect(screen.getByTestId('runtime-attachment-count')).toHaveTextContent('0')

    await userEvent.click(screen.getByText('enable follow-up plan mode'))
    await userEvent.click(screen.getByText('add image attachment'))
    expect(screen.getByTestId('follow-up-collaboration-mode')).toHaveTextContent('plan')
    expect(screen.getByTestId('runtime-attachment-count')).toHaveTextContent('1')

    await userEvent.click(screen.getByText('open follow-up runtime b'))
    await waitFor(() =>
      expect(screen.getByTestId('follow-up-collaboration-mode')).toHaveTextContent('default')
    )
    expect(screen.getByTestId('runtime-attachment-count')).toHaveTextContent('0')

    await userEvent.click(screen.getByText('open follow-up runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('follow-up-collaboration-mode')).toHaveTextContent('plan')
    )
    expect(screen.getByTestId('runtime-attachment-count')).toHaveTextContent('1')
  })

  test('keeps blank chat draft when using sidebar new chat from a runtime task', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      taskId: 'runtime-a',
      workspacePath: '/workspace/project-alpha',
      runtime: 'claude_code',
      messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'message runtime-a' }],
    })
    const runtimeWork = createRuntimeWork({
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
                  runtime: 'claude_code',
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
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(runtimeWork),
      getRuntimeTranscript,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<FollowUpProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('follow-up-collaboration-mode')).toHaveTextContent('default')
    )
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('add image attachment'))
    expect(screen.getByTestId('composer-input')).toHaveTextContent('继续修')
    expect(screen.getByTestId('runtime-attachment-count')).toHaveTextContent('1')

    await userEvent.click(screen.getByText('open follow-up runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-attachment-count')).toHaveTextContent('0')
    )
    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('follow-up-messages')).toHaveTextContent('user:message runtime-a')

    await userEvent.click(screen.getByText('sidebar new follow-up chat'))
    await waitFor(() =>
      expect(screen.getByTestId('follow-up-current-runtime-task')).toHaveTextContent('none')
    )
    expect(screen.getByTestId('composer-input')).toHaveTextContent('继续修')
    expect(screen.getByTestId('follow-up-messages')).toBeEmptyDOMElement()
    await waitFor(() =>
      expect(screen.getByTestId('runtime-attachment-count')).toHaveTextContent('1')
    )

    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Codex',
        deviceId: 'device-1',
      })
      streamHandlers.onChatChunk?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        offset: 0,
        content: 'retained stream output',
        deviceId: 'device-1',
      })
    })

    expect(screen.getByTestId('follow-up-current-runtime-task')).toHaveTextContent('none')
    expect(screen.getByTestId('follow-up-pane-busy')).toHaveTextContent('idle')
    expect(screen.getByTestId('follow-up-messages')).toBeEmptyDOMElement()

    await userEvent.click(screen.getByText('open follow-up runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('follow-up-current-runtime-task')).toHaveTextContent(
        'device-1:runtime-a'
      )
    )
    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('follow-up-messages')).toHaveTextContent('retained stream output')
  })

  test('keeps blank chat draft when selecting a project chat context', async () => {
    renderWorkbench(<ProjectSendProbe />)

    await waitFor(() => expect(screen.getByText('select project')).toBeInTheDocument())
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('add image attachment'))
    expect(screen.getByTestId('composer-input')).toHaveTextContent('修复 CI')
    expect(screen.getByTestId('project-attachment-count')).toHaveTextContent('1')
    expect(screen.getByTestId('current-project-name')).toHaveTextContent('none')

    await userEvent.click(screen.getByText('select project'))

    expect(screen.getByTestId('current-project-name')).toHaveTextContent('Wegent')
    expect(screen.getByTestId('composer-input')).toHaveTextContent('修复 CI')
    expect(screen.getByTestId('project-attachment-count')).toHaveTextContent('1')
  })

  test('keeps blank chat draft when starting a project chat from a runtime task', async () => {
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'message runtime-a' }],
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await userEvent.click(await screen.findByText('select project'))
    await userEvent.click(screen.getByText('set input'))
    expect(screen.getByTestId('composer-input')).toHaveTextContent('修复 CI')
    const blankChatKey = screen.getByTestId('standalone-chat-key').textContent

    await userEvent.click(screen.getByText('open project runtime task'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-a'
      )
    )
    await userEvent.click(screen.getByText('start new project chat'))

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent('none')
    )
    expect(screen.getByTestId('standalone-chat-key')).toHaveTextContent(blankChatKey ?? '')
    expect(screen.getByTestId('composer-input')).toHaveTextContent('修复 CI')
  })

  test('starts standalone chat with a fresh blank draft scope', async () => {
    renderWorkbench(<ProjectSendProbe />)

    await waitFor(() => expect(screen.getByText('start standalone chat')).toBeInTheDocument())
    await userEvent.click(screen.getByText('set input'))
    expect(screen.getByTestId('composer-input')).toHaveTextContent('修复 CI')
    expect(screen.getByTestId('standalone-chat-key')).toHaveTextContent('0')

    await userEvent.click(screen.getByText('start standalone chat'))

    await waitFor(() => expect(screen.getByTestId('standalone-chat-key')).toHaveTextContent('1'))
    expect(screen.getByTestId('composer-input')).toHaveTextContent('')
  })

  test('hydrates queued plugin trial input into a fresh standalone chat', async () => {
    sessionStorage.setItem(
      'wework:pending-plugin-trial',
      JSON.stringify({
        input: '[$Documents](plugin://documents@OpenAI Bundled) ',
        pluginName: 'Documents',
      })
    )

    renderWorkbench(<ProjectSendProbe />)

    await waitFor(() => expect(screen.getByTestId('standalone-chat-key')).toHaveTextContent('1'))
    expect(screen.getByTestId('composer-input')).toHaveTextContent('Documents')
    expect(sessionStorage.getItem('wework:pending-plugin-trial')).toBeNull()
  })

  test('sends a follow-up message after setting a goal in an existing runtime task', async () => {
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const setRuntimeGoal = vi.fn().mockImplementation(request =>
      Promise.resolve({
        accepted: true,
        goal: createRuntimeGoal({
          objective: request.objective ?? '现有目标',
          status: request.status ?? 'active',
        }),
      })
    )
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
      setRuntimeGoal,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await userEvent.click(screen.getByText('set follow-up goal'))
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    await waitFor(() => expect(setRuntimeGoal).toHaveBeenCalledTimes(1))
    expect(setRuntimeGoal).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      mode: 'standard',
      objective: '继续修',
      status: 'active',
    })
    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(sendRuntimeMessage).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      clientMessageId: expect.any(String),
      message: '继续修',
      modelOptions: { collaborationMode: 'default' },
    })
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('继续修')
    expect(screen.getByTestId('runtime-open-goal-flags')).toHaveTextContent('goal:继续修')
  })

  test('sends the currently selected model with runtime follow-up messages', async () => {
    const models: UnifiedModel[] = [
      {
        name: 'codex-gpt-5.5',
        type: 'runtime',
        modelId: 'gpt-5.5',
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
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
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
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: models }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await waitFor(() =>
      expect(screen.getByTestId('follow-up-model-statuses')).toHaveTextContent(
        'gpt-5-2025-08-07:enabled'
      )
    )
    await userEvent.click(screen.getByText('select gpt model'))
    await waitFor(() =>
      expect(screen.getByTestId('follow-up-selected-model')).toHaveTextContent('gpt-5-2025-08-07')
    )
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '继续修',
        modelId: 'gpt-5-2025-08-07',
        modelType: 'public',
      })
    )
  })

  test('sends default model options with runtime follow-up messages', async () => {
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
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
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: [] }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await userEvent.click(screen.getByText('enable follow-up plan mode'))
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '继续修',
        modelOptions: { collaborationMode: 'plan' },
      })
    )
  })

  test('sends default collaboration mode when follow-up plan mode is disabled', async () => {
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
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
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: [] }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message')
    )
    await userEvent.click(screen.getByText('enable follow-up plan mode'))
    await userEvent.click(screen.getByText('disable follow-up plan mode'))
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '继续修',
        modelOptions: { collaborationMode: 'default' },
      })
    )
  })

  test('sends runtime model fields with implementation plan confirmations', async () => {
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
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
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [{ id: 'runtime-a:assistant:1', role: 'assistant', content: 'plan' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      modelApi: {
        listModels: vi.fn().mockResolvedValue({ data: [] }),
      },
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    } as Partial<WorkbenchServices>)

    renderWorkbench(
      <>
        <RuntimeOpenProbe />
        <FollowUpProbe />
      </>,
      services
    )

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('plan')
    )
    await userEvent.click(screen.getByText('enable follow-up plan mode'))
    expect(screen.getByTestId('follow-up-collaboration-mode')).toHaveTextContent('plan')
    await userEvent.click(screen.getByText('submit implementation confirmation'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('follow-up-collaboration-mode')).toHaveTextContent('default')
    expect(sendRuntimeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '是的，执行此计划',
        modelOptions: { collaborationMode: 'default' },
      })
    )
    expect(sendRuntimeMessage).toHaveBeenCalledWith(
      expect.not.objectContaining({
        requestUserInputResponse: expect.anything(),
      })
    )
  })
})
