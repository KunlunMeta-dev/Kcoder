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

  test('queues runtime messages while current response is running', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
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
                      runtime: 'claude_code',
                      running: true,
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
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
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
    await waitFor(() => expect(streamHandlers.onChatStart).toBeDefined())
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')
    expect(screen.getByTestId('composer-input')).toHaveTextContent('')
    expect(screen.getByTestId('runtime-open-messages')).not.toHaveTextContent('继续修')
    expect(screen.getByTestId('runtime-open-error')).toHaveTextContent('')
  })

  test('queues runtime messages while an assistant stream is active before runtime status refreshes', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
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
      listRuntimeWork: vi.fn().mockResolvedValue(runningRuntimeWork),
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
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
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
    await waitFor(() => expect(streamHandlers.onChatStart).toBeDefined())
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')
    expect(screen.getByTestId('composer-input')).toHaveTextContent('')
  })

  test('restores queued follow-ups after switching away from a streaming task', async () => {
    const streamHandlersByTask = new Map<string, ChatStreamHandlers>()
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers) && handlers.scope?.taskId) {
        streamHandlersByTask.set(handlers.scope.taskId, handlers)
      }
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockImplementation((address: RuntimeTaskAddress) =>
        Promise.resolve({
          taskId: address.taskId,
          workspacePath: '/workspace/project-alpha',
          runtime: 'claude_code',
          messages: [
            {
              id: `${address.taskId}:user:1`,
              role: 'user',
              content: `message ${address.taskId}`,
            },
          ],
        })
      ),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<FollowUpProbe />, services)

    await userEvent.click(await screen.findByText('open follow-up runtime a'))
    await waitFor(() => expect(streamHandlersByTask.get('runtime-a')).toBeDefined())
    act(() => {
      streamHandlersByTask.get('runtime-a')?.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')
    expect(sendRuntimeMessage).not.toHaveBeenCalled()

    await userEvent.click(screen.getByText('open follow-up runtime b'))
    await waitFor(() =>
      expect(screen.getByTestId('follow-up-current-runtime-task')).toHaveTextContent(
        'device-1:runtime-b'
      )
    )
    expect(screen.getByTestId('queued-messages')).toBeEmptyDOMElement()
    await act(async () => {
      await Promise.resolve()
    })
    expect(sendRuntimeMessage).not.toHaveBeenCalled()

    await userEvent.click(screen.getByText('open follow-up runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('follow-up-current-runtime-task')).toHaveTextContent(
        'device-1:runtime-a'
      )
    )
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')
    expect(sendRuntimeMessage).not.toHaveBeenCalled()
  })

  test('updates the current streaming task without refreshing the work list', async () => {
    let streamHandlers: Parameters<WorkbenchServices['chatStream']['subscribe']>[0] | null = null
    const subscribe = vi.fn(handlers => {
      streamHandlers = handlers
      return vi.fn()
    })
    const listRuntimeWork = vi.fn().mockResolvedValue(createRuntimeWork())
    const runtimeWorkApi = createRuntimeWorkApiMock({ listRuntimeWork })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-a'
      )
    )
    const callsBeforeStart = listRuntimeWork.mock.calls.length

    await act(async () => {
      streamHandlers?.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })

    await waitFor(() => expect(screen.getByTestId('current-runtime-task-running')).toHaveTextContent('running'))
    expect(listRuntimeWork).toHaveBeenCalledTimes(callsBeforeStart)
  })

  test('hides the runtime goal when the settled task reports the goal complete', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const getRuntimeGoal = vi
      .fn()
      .mockResolvedValueOnce({
        accepted: true,
        goal: createRuntimeGoal({ objective: '实现目标', status: 'active' }),
      })
      .mockResolvedValueOnce({
        accepted: true,
        goal: createRuntimeGoal({ objective: '实现目标', status: 'complete' }),
      })
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeGoal })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-goal-objective')).toHaveTextContent('实现目标')
    )

    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })

    await waitFor(() =>
      expect(screen.getByTestId('runtime-goal-objective')).toHaveTextContent('none')
    )
  })

  test('reports goal deletion failures and permits a successful retry without hiding a failed deletion', async () => {
    const clearRuntimeGoal = vi
      .fn()
      .mockRejectedValueOnce(new Error('Goal connection unavailable'))
      .mockResolvedValue({ accepted: true, cleared: true })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      clearRuntimeGoal,
      getRuntimeGoal: vi
        .fn()
        .mockResolvedValue({ accepted: true, goal: createRuntimeGoal({ status: 'active' }) }),
    })
    renderWorkbench(
      <RuntimeOpenProbe />,
      createWorkbenchServices({
        runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      })
    )
    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-goal-status')).toHaveTextContent('active')
    )
    await userEvent.click(screen.getByText('clear runtime goal'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-goal-error')).toHaveTextContent(
        'Goal connection unavailable'
      )
    )
    expect(screen.getByTestId('runtime-goal-status')).toHaveTextContent('active')
    await userEvent.click(screen.getByText('clear runtime goal'))
    await waitFor(() => expect(screen.getByTestId('runtime-goal-status')).toHaveTextContent('none'))
    expect(screen.getByTestId('runtime-goal-error')).toHaveTextContent('none')
  })

  test('ignores a settled Goal refresh failure after switching away from its runtime task', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const staleRefresh = deferred<{ accepted: boolean; goal: null }>()
    void staleRefresh.promise.catch(() => undefined)
    let returnStaleRefresh = false
    const getRuntimeGoal = vi.fn((address: RuntimeTaskAddress) => {
      if (address.taskId === 'runtime-a' && returnStaleRefresh) {
        returnStaleRefresh = false
        return staleRefresh.promise
      }
      return Promise.resolve({ accepted: false, goal: null })
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeGoal })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      renderWorkbench(<RuntimeOpenProbe />, services)

      await userEvent.click(await screen.findByText('open runtime a'))
      await waitFor(() => expect(getRuntimeGoal).toHaveBeenCalled())
      const callsBeforeSettled = getRuntimeGoal.mock.calls.length
      returnStaleRefresh = true

      await act(async () => {
        streamHandlers.onChatDone?.({
          taskId: 'runtime-a',
          subtaskId: '101',
          deviceId: 'device-1',
          result: { value: 'done' },
        })
      })
      await waitFor(() =>
        expect(getRuntimeGoal.mock.calls.length).toBeGreaterThan(callsBeforeSettled)
      )

      await userEvent.click(screen.getByText('open runtime b'))
      await waitFor(() =>
        expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
          'device-1:runtime-b'
        )
      )
      await act(async () => {
        staleRefresh.reject(new Error('KCoder app-server 连接已断开'))
        await Promise.resolve()
      })

      expect(consoleError).not.toHaveBeenCalledWith(
        '[KCoder Studio] Runtime goal refresh failed',
        expect.anything()
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  test('ignores a settled Goal refresh failure while the page is navigating away', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const staleRefresh = deferred<{ accepted: boolean; goal: null }>()
    void staleRefresh.promise.catch(() => undefined)
    let returnStaleRefresh = false
    const getRuntimeGoal = vi.fn((address: RuntimeTaskAddress) => {
      if (address.taskId === 'runtime-a' && returnStaleRefresh) {
        returnStaleRefresh = false
        return staleRefresh.promise
      }
      return Promise.resolve({ accepted: false, goal: null })
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeGoal })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      renderWorkbench(<RuntimeOpenProbe />, services)

      await userEvent.click(await screen.findByText('open runtime a'))
      await waitFor(() => expect(getRuntimeGoal).toHaveBeenCalled())
      const callsBeforeSettled = getRuntimeGoal.mock.calls.length
      returnStaleRefresh = true

      await act(async () => {
        streamHandlers.onChatDone?.({
          taskId: 'runtime-a',
          subtaskId: '101',
          deviceId: 'device-1',
          result: { value: 'done' },
        })
      })
      await waitFor(() =>
        expect(getRuntimeGoal.mock.calls.length).toBeGreaterThan(callsBeforeSettled)
      )

      window.dispatchEvent(new Event('pagehide'))
      await act(async () => {
        staleRefresh.reject(new Error('KCoder app-server 连接已断开'))
        await Promise.resolve()
      })

      expect(consoleError).not.toHaveBeenCalledWith(
        '[KCoder Studio] Runtime goal refresh failed',
        expect.anything()
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  test('keeps an active runtime goal active while the task list is between automatic turns', async () => {
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
                      running: false,
                      status: 'idle',
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
      getRuntimeGoal: vi.fn().mockResolvedValue({
        accepted: true,
        goal: createRuntimeGoal({ status: 'active' }),
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-running')).toHaveTextContent('idle')
    )
    expect(screen.getByTestId('runtime-goal-status')).toHaveTextContent('active')
  })

  test('restores a goal task as running when reopened with a streaming transcript', async () => {
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
                      running: false,
                      status: 'active',
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
        running: true,
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: '继续实现目标' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: '正在输出',
            status: 'streaming',
            subtaskId: '101',
          },
        ],
      }),
      getRuntimeGoal: vi.fn().mockResolvedValue({
        accepted: true,
        goal: createRuntimeGoal({ status: 'active' }),
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))

    await waitFor(() =>
      expect(screen.getByTestId('runtime-message-statuses')).toHaveTextContent(
        'assistant:streaming'
      )
    )
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-running')).toHaveTextContent('running')
    )
    expect(screen.getByTestId('runtime-goal-status')).toHaveTextContent('active')
  })

  test('does not poll transcript history while the live stream owns a running task', async () => {
    const runningWork = createRuntimeWork({
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
        },
      ],
      totalTasks: 1,
    })
    const getRuntimeTranscript = vi
      .fn()
      .mockResolvedValueOnce({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        running: true,
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: '继续后台任务' }],
      })
      .mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        running: false,
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: '继续后台任务' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: '后台任务已完成',
            status: 'done',
            subtaskId: '101',
          },
        ],
      })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(runningWork),
      getRuntimeTranscript,
    })
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices: vi.fn().mockResolvedValue([createDevice({ device_type: 'local' })]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-running')).toHaveTextContent('running')
    )
    await new Promise(resolve => window.setTimeout(resolve, 2_100))
    expect(getRuntimeTranscript).toHaveBeenCalledTimes(1)
    expect(getRuntimeTranscript).toHaveBeenCalledWith({
      deviceId: 'device-1',
      taskId: 'runtime-a',
      workspacePath: '/workspace/project-alpha',
      limit: 50,
    })
    expect(screen.queryByText('后台任务已完成')).not.toBeInTheDocument()
    expect(screen.getByTestId('current-runtime-task-running')).toHaveTextContent('running')
  })

  test('restores partial output only after the local runtime transport is replaced', async () => {
    const runningWork = createRuntimeWork({
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
    const getRuntimeTranscript = vi
      .fn()
      .mockResolvedValueOnce({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        running: true,
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: '执行命令' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: '已经输出的中间内容',
            status: 'streaming',
            subtaskId: '101',
          },
        ],
      })
      .mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        running: false,
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: '执行命令' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: '已经输出的中间内容',
            status: 'streaming',
            subtaskId: '101',
          },
        ],
      })
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(runningWork),
      getRuntimeTranscript,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: { subscribe } as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-message-statuses')).toHaveTextContent(
        'assistant:streaming'
      )
    )
    expect(getRuntimeTranscript).toHaveBeenCalledTimes(1)

    await act(async () => {
      streamHandlers.onRuntimeTransportReplaced?.({
        previousRuntimeInstanceId: 'runtime-instance-a',
        runtimeInstanceId: 'runtime-instance-b',
      })
    })

    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(2))
    expect(getRuntimeTranscript).toHaveBeenLastCalledWith({
      deviceId: 'device-1',
      taskId: 'runtime-a',
      workspacePath: '/workspace/project-alpha',
      limit: 50,
      refresh: true,
    })
    await waitFor(() =>
      expect(screen.getByTestId('runtime-message-statuses')).toHaveTextContent('assistant:done')
    )
    expect(screen.getByText('已经输出的中间内容')).toBeInTheDocument()
    expect(screen.getByTestId('current-runtime-task-running')).toHaveTextContent('idle')
  })

  test('resumes a paused runtime goal when editing and sending its objective', async () => {
    const setRuntimeGoal = vi.fn().mockResolvedValue({
      accepted: true,
      goal: createRuntimeGoal({ objective: '更新后的目标', status: 'active' }),
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
                      running: false,
                    },
                  ],
                },
              ],
            },
          ],
          totalTasks: 1,
        })
      ),
      getRuntimeGoal: vi.fn().mockResolvedValue({
        accepted: true,
        goal: createRuntimeGoal({ status: 'paused' }),
      }),
      setRuntimeGoal,
      sendRuntimeMessage: vi.fn().mockResolvedValue({ accepted: true, taskId: 'runtime-a' }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-goal-status')).toHaveTextContent('paused')
    )
    await userEvent.click(screen.getByText('edit runtime goal'))
    await userEvent.click(screen.getByText('set edited runtime goal'))
    await userEvent.click(screen.getByText('send runtime goal'))

    await waitFor(() =>
      expect(setRuntimeGoal).toHaveBeenCalledWith({
        address: {
          deviceId: 'device-1',
          workspacePath: '/workspace/project-alpha',
          taskId: 'runtime-a',
        },
        objective: '更新后的目标',
        status: 'active',
      })
    )
    expect(screen.getByTestId('runtime-goal-status')).toHaveTextContent('active')
  })

  test('accepts current runtime stream blocks when device id is omitted', async () => {
    let streamHandlers: Parameters<WorkbenchServices['chatStream']['subscribe']>[0] | null = null
    const subscribe = vi.fn(handlers => {
      if (handlers.onBlockCreated) streamHandlers = handlers
      return vi.fn()
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [],
      }),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-a'
      )
    )
    await waitFor(() => expect(streamHandlers?.onChatStart).toBeDefined())
    await waitFor(() => expect(streamHandlers?.onBlockCreated).toBeDefined())

    await act(async () => {
      streamHandlers?.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Codex',
      })
    })

    // Starting the transport turn does not imply that reasoning content has arrived.
    expect(screen.getByTestId('thinking-indicator')).toHaveTextContent('等待响应')

    await act(async () => {
      streamHandlers?.onBlockCreated?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        block: {
          id: 'tool-1',
          type: 'tool',
          tool_name: 'exec_command',
          status: 'pending',
        },
      })
    })

    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-blocks')).toHaveTextContent(
        'tool:exec_command:pending'
      )
    )
    await act(async () => {
      streamHandlers?.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        result: { value: 'Tool execution completed.' },
      })
    })
    await waitFor(() => expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument())
  })

  test('routes top-level runtime stream lifecycle events through the shared store', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (handlers.onChatStart) streamHandlers = handlers
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
                      running: false,
                      status: 'done',
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
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<RuntimeTopLevelStreamLifecycleProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('top-level-runtime-stream-lifecycle')).toHaveTextContent(
        'idle:idle'
      )
    )
    await waitFor(() => expect(streamHandlers.onChatStart).toBeDefined())

    act(() => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Codex',
        deviceId: 'device-1',
      })
    })
    expect(screen.getByTestId('top-level-runtime-stream-lifecycle')).toHaveTextContent(
      'running:streaming'
    )

    act(() => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })
    await waitFor(() =>
      expect(screen.getByTestId('top-level-runtime-stream-lifecycle')).toHaveTextContent(
        'idle:idle'
      )
    )
  })

  test('sends queued runtime messages when the task becomes idle', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
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
                  runtime: 'claude_code',
                  running: true,
                },
              ],
            },
          ],
        },
      ],
      totalTasks: 1,
    })
    const idleRuntimeWork = createRuntimeWork({
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
                  running: false,
                },
              ],
            },
          ],
        },
      ],
      totalTasks: 1,
    })
    let runtimeRunning = true
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(runtimeRunning ? runningRuntimeWork : idleRuntimeWork)
        ),
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
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
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
    await waitFor(() => expect(streamHandlers.onChatStart).toBeDefined())
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')

    runtimeRunning = false
    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
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
    await waitFor(() => expect(screen.getByTestId('queued-messages')).toHaveTextContent(''))
  })

  test('waits for the sent queued runtime message to start before sending the next queued item', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
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
                  runtime: 'claude_code',
                  running: true,
                },
              ],
            },
          ],
        },
      ],
      totalTasks: 1,
    })
    const idleRuntimeWork = createRuntimeWork({
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
                  running: false,
                },
              ],
            },
          ],
        },
      ],
      totalTasks: 1,
    })
    let runtimeRunning = true
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(runtimeRunning ? runningRuntimeWork : idleRuntimeWork)
        ),
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
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
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
    await waitFor(() => expect(streamHandlers.onChatStart).toBeDefined())
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    await userEvent.click(screen.getByText('set ls follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))

    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修|queued:执行ls')

    runtimeRunning = false
    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
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
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:执行ls')
  })

  test('edits queued runtime messages back into the composer', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
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
                      runtime: 'claude_code',
                      running: true,
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
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
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
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    await userEvent.click(screen.getByText('edit first queued'))

    expect(screen.getByTestId('composer-input')).toHaveTextContent('继续修')
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('')
  })

  test('sends queued guidance through native runtime guidance without cancelling the turn', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const guidanceResult = deferred<RuntimeGuidanceResponse>()
    const guideRuntimeTask = vi.fn().mockReturnValue(guidanceResult.promise)
    const cancelRuntimeTask = vi.fn().mockResolvedValue({
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
                      runtime: 'claude_code',
                      running: true,
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
        runtime: 'claude_code',
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: 'first message' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: 'working',
            status: 'streaming',
          },
        ],
      }),
      sendRuntimeMessage,
      guideRuntimeTask,
      cancelRuntimeTask,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
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
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
      streamHandlers.onChatChunk?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        content: 'before ',
        offset: 0,
        deviceId: 'device-1',
      })
    })
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages').textContent).toBe(
        'first message|working|before '
      )
    )
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    const queuedMessageId = screen.getByTestId('queued-message-ids').textContent
    await userEvent.click(screen.getByText('guide first queued'))

    await waitFor(() => expect(guideRuntimeTask).toHaveBeenCalledTimes(1))
    expect(guideRuntimeTask).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      message: '继续修',
      clientGuidanceId: expect.stringMatching(/^queued-runtime-pane-/),
    })
    expect(cancelRuntimeTask).not.toHaveBeenCalled()
    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('sending:继续修')
    expect(screen.getByTestId('runtime-open-messages').textContent).toBe(
      'first message|working|before '
    )
    expect(screen.getByTestId('runtime-open-blocks')).not.toHaveTextContent(
      'tool:conversation_guidance:done'
    )
    expect(screen.getByTestId('guidance-messages')).toHaveTextContent('')

    await act(async () => {
      guidanceResult.resolve({
        accepted: true,
        success: true,
        taskId: 'runtime-a',
        guidanceId: 'queued-runtime-guidance',
        turnId: '019f4c02-df59-71c3-ac19-f1e7cec46069',
      })
    })
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('sending:继续修')
    expect(screen.getByTestId('runtime-open-blocks')).not.toHaveTextContent(
      'tool:conversation_guidance:done'
    )

    await act(async () => {
      streamHandlers.onGuidanceApplied?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        guidanceId: 'raw-guidance-item',
        message: '继续修',
        appliedAtMs: Date.now(),
      })
    })
    await waitFor(() => expect(screen.getByTestId('queued-messages')).toHaveTextContent(''))
    expect(screen.getByTestId('runtime-open-messages').textContent).toBe(
      'first message|working|before |继续修|'
    )
    expect(screen.getByTestId('runtime-open-blocks')).toHaveTextContent(
      'tool:conversation_guidance:done'
    )
    expect(screen.getByTestId('runtime-open-message-ids')).toHaveTextContent(queuedMessageId ?? '')

    await act(async () => {
      streamHandlers.onChatChunk?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        content: 'after',
        offset: 0,
        deviceId: 'device-1',
      })
    })
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages').textContent).toBe(
        'first message|working|before |继续修|after'
      )
    )
    expect(screen.getByTestId('runtime-open-blocks')).toHaveTextContent(
      'tool:conversation_guidance:done'
    )
    await act(async () => {
      streamHandlers.onChatChunk?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        content: ' more',
        offset: 5,
        deviceId: 'device-1',
      })
    })
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('after more')
    )
    expect(screen.getByTestId('runtime-content-truncation')).not.toHaveTextContent('truncated')

    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        result: { value: 'before after more' },
      })
    })

    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages').textContent).toBe(
        'first message|working|before |继续修|after more'
      )
    )
    expect(screen.getByTestId('runtime-open-blocks')).toHaveTextContent(
      'tool:conversation_guidance:done'
    )
  })

  test('sends a busy goal message as guidance when requested by submit options', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const guideRuntimeTask = vi.fn().mockResolvedValue({
      accepted: true,
      success: true,
      taskId: 'runtime-a',
      guidanceId: 'shortcut-runtime-guidance',
    })
    const setRuntimeGoal = vi.fn().mockResolvedValue({
      accepted: true,
      goal: createRuntimeGoal({ objective: '继续修', status: 'active' }),
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
                      runtime: 'claude_code',
                      running: true,
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
        runtime: 'claude_code',
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: 'first message' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: 'working',
            status: 'streaming',
          },
        ],
      }),
      sendRuntimeMessage,
      guideRuntimeTask,
      setRuntimeGoal,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
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
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('set follow-up goal'))
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('add local image attachment'))
    await userEvent.click(screen.getByText('send follow-up as guidance'))

    await waitFor(() => expect(guideRuntimeTask).toHaveBeenCalledTimes(1))
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
    await act(async () => {
      streamHandlers.onGuidanceApplied?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        guidanceId: 'raw-guidance-item',
        message: '继续修',
        appliedAtMs: Date.now(),
      })
    })
    expect(guideRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '继续修',
        attachments: [
          expect.objectContaining({
            local_path: LOCAL_IMAGE_ATTACHMENT_PATH,
            mime_type: 'image/png',
          }),
        ],
      })
    )
    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('')
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('继续修')
    expect(screen.getByTestId('runtime-open-goal-flags')).toHaveTextContent('goal:继续修')
    expect(screen.getByTestId('runtime-open-message-ids')).toHaveTextContent('queued-runtime-pane-')
  })

  test('suppresses an in-flight guidance after interrupt-and-send replaces it', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const guidanceResult = deferred<RuntimeGuidanceResponse>()
    const guideRuntimeTask = vi.fn().mockReturnValue(guidanceResult.promise)
    const sendRuntimeMessage = vi.fn().mockResolvedValue({ accepted: true, taskId: 'runtime-a' })
    const interruptResult = deferred<{ accepted: boolean; taskId: string }>()
    const interruptAndSendRuntimeMessage = vi.fn().mockReturnValue(interruptResult.promise)
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
                      runtime: 'claude_code',
                      running: true,
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
        runtime: 'claude_code',
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: 'first message' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: 'working',
            status: 'streaming',
          },
        ],
      }),
      sendRuntimeMessage,
      guideRuntimeTask,
      interruptAndSendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: { subscribe } as unknown as WorkbenchServices['chatStream'],
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
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    await userEvent.click(screen.getByText('guide first queued'))
    await waitFor(() => expect(guideRuntimeTask).toHaveBeenCalledTimes(1))

    await userEvent.click(screen.getByTestId('queued-interrupt-and-send-first'))
    await waitFor(() => expect(interruptAndSendRuntimeMessage).toHaveBeenCalledTimes(1))

    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '102',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
      streamHandlers.onChatChunk?.({
        taskId: 'runtime-a',
        subtaskId: '102',
        content: 'replacement',
        offset: 0,
        deviceId: 'device-1',
      })
    })
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages').textContent).toBe(
        'first message|working||继续修|replacement'
      )
    )

    await act(async () => {
      interruptResult.resolve({ accepted: true, taskId: 'runtime-a' })
    })
    await waitFor(() => expect(screen.getByTestId('queued-messages')).toHaveTextContent(''))

    await act(async () => {
      guidanceResult.resolve({
        accepted: false,
        success: false,
        taskId: 'runtime-a',
        error: 'no active turn to guide',
        code: 'no_active_turn',
      })
    })

    await waitFor(() => expect(screen.getByTestId('queued-messages')).toHaveTextContent(''))
    expect(sendRuntimeMessage).not.toHaveBeenCalled()
  })

  test('restores code comments when interrupt-and-send fails', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const interruptAndSendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: false,
      success: false,
      error: 'interrupt failed',
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
                      runtime: 'claude_code',
                      running: true,
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
        runtime: 'claude_code',
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: 'first message' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: 'working',
            status: 'streaming',
          },
        ],
      }),
      interruptAndSendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: { subscribe } as unknown as WorkbenchServices['chatStream'],
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
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByTestId('follow-up-add-code-comment'))
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    expect(screen.getByTestId('code-comment-context-count')).toHaveTextContent('0')

    await userEvent.click(screen.getByTestId('queued-interrupt-and-send-first'))

    await waitFor(() => expect(interruptAndSendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('composer-input')).toHaveTextContent('继续修')
    expect(screen.getByTestId('code-comment-context-count')).toHaveTextContent('1')
  })

  test('marks queued guidance failed when native runtime guidance fails', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const guideRuntimeTask = vi.fn().mockResolvedValue({
      accepted: false,
      success: false,
      error: 'no active turn to guide',
    })
    const cancelRuntimeTask = vi.fn().mockResolvedValue({
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
                      runtime: 'claude_code',
                      running: true,
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
        runtime: 'claude_code',
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: 'first message' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: 'working',
            status: 'streaming',
          },
        ],
      }),
      sendRuntimeMessage,
      guideRuntimeTask,
      cancelRuntimeTask,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
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
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    await userEvent.click(screen.getByText('guide first queued'))

    await waitFor(() => expect(guideRuntimeTask).toHaveBeenCalledTimes(1))
    expect(cancelRuntimeTask).not.toHaveBeenCalled()
    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.getByTestId('queued-messages')).toHaveTextContent('failed:继续修')
    )
    expect(screen.getByTestId('queued-errors')).toHaveTextContent('引导发送失败')
    expect(screen.getByTestId('queued-notices')).not.toHaveTextContent('正在引导当前对话')
  })

  test('sends failed queued work directly when the active turn is unavailable', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValueOnce(false).mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const guideRuntimeTask = vi.fn().mockResolvedValue({
      accepted: false,
      success: false,
      taskId: 'runtime-a',
      error: 'no active turn to guide',
      code: 'no_active_turn',
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
                      runtime: 'claude_code',
                      running: true,
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
        runtime: 'claude_code',
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: 'first message' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: 'working',
            status: 'streaming',
          },
        ],
      }),
      sendRuntimeMessage,
      guideRuntimeTask,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
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
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Codex',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('set follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('queued:继续修')

    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        result: { value: 'done' },
      })
    })
    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByTestId('queued-messages')).toHaveTextContent('failed:继续修')
    )
    expect(screen.getByTestId('current-runtime-task-running')).toHaveTextContent('idle')

    await userEvent.click(screen.getByText('guide first queued'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(2))
    expect(guideRuntimeTask).not.toHaveBeenCalled()
    expect(sendRuntimeMessage).toHaveBeenLastCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      clientMessageId: expect.any(String),
      message: '继续修',
      modelOptions: { collaborationMode: 'default' },
    })
    await waitFor(() => expect(screen.getByTestId('queued-messages')).toHaveTextContent(''))
  })

  test('pauses an active task goal before cancelling while goal details are loading', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
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
                  goalStatus: 'active',
                },
              ],
            },
          ],
        },
      ],
      totalTasks: 1,
    })
    const idleRuntimeWork = createRuntimeWork({
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
                  running: false,
                  status: 'cancelled',
                },
              ],
            },
          ],
        },
      ],
      totalTasks: 1,
    })
    let runtimeRunning = true
    const listRuntimeWork = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(runtimeRunning ? runningRuntimeWork : idleRuntimeWork)
      )
    const cancelRuntimeTask = vi.fn().mockImplementation(() => {
      expect(setRuntimeGoal).toHaveBeenCalledWith({
        address: {
          deviceId: 'device-1',
          workspacePath: '/workspace/project-alpha',
          taskId: 'runtime-a',
        },
        status: 'paused',
      })
      runtimeRunning = false
      return Promise.resolve({
        accepted: true,
        taskId: 'runtime-a',
      })
    })
    const setRuntimeGoal = vi.fn().mockResolvedValue({
      accepted: true,
      goal: createRuntimeGoal({ status: 'paused' }),
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork,
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [
          { id: 'runtime-a:user:1', role: 'user', content: 'first message' },
          {
            id: 'runtime-a:assistant:1',
            role: 'assistant',
            content: 'working',
            status: 'streaming',
          },
        ],
      }),
      cancelRuntimeTask,
      getRuntimeGoal: vi.fn().mockReturnValue(new Promise(() => undefined)),
      setRuntimeGoal,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
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
      expect(screen.getByTestId('current-runtime-task-running')).toHaveTextContent('running')
    )
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Chat',
        deviceId: 'device-1',
      })
    })
    await waitFor(() => expect(runtimeWorkApi.getRuntimeGoal).toHaveBeenCalledTimes(1))
    const listCallsBeforeCancel = listRuntimeWork.mock.calls.length
    await userEvent.click(screen.getByText('stop current response'))

    await waitFor(() => expect(cancelRuntimeTask).toHaveBeenCalledTimes(1))
    expect(cancelRuntimeTask).toHaveBeenCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      taskId: 'runtime-a',
    })
    await waitFor(() =>
      expect(setRuntimeGoal).toHaveBeenCalledWith({
        address: {
          deviceId: 'device-1',
          workspacePath: '/workspace/project-alpha',
          taskId: 'runtime-a',
        },
        status: 'paused',
      })
    )
    await waitFor(() =>
      expect(listRuntimeWork.mock.calls.length).toBeGreaterThan(listCallsBeforeCancel)
    )
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-running')).toHaveTextContent('idle')
    )
    await waitFor(() =>
      expect(screen.getByTestId('runtime-message-statuses')).not.toHaveTextContent(
        'assistant:streaming'
      )
    )
  })

  test('sends queued guidance through native runtime guidance without DB task context', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-a',
    })
    const guideRuntimeTask = vi.fn().mockResolvedValue({
      accepted: true,
      success: true,
      taskId: 'runtime-a',
      guidanceId: 'queued-runtime-guidance',
    })
    const cancelRuntimeTask = vi.fn().mockResolvedValue({
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
                      runtime: 'claude_code',
                      running: true,
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
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'first message' }],
      }),
      sendRuntimeMessage,
      guideRuntimeTask,
      cancelRuntimeTask,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
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
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Codex',
        deviceId: 'device-1',
      })
    })
    await userEvent.click(screen.getByText('set ls follow-up'))
    await userEvent.click(screen.getByText('send follow-up'))
    await userEvent.click(screen.getByText('guide first queued'))

    await waitFor(() => expect(guideRuntimeTask).toHaveBeenCalledTimes(1))
    expect(guideRuntimeTask).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      message: '执行ls',
      clientGuidanceId: expect.stringMatching(/^queued-runtime-pane-/),
    })
    await act(async () => {
      streamHandlers.onGuidanceApplied?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        deviceId: 'device-1',
        guidanceId: 'raw-guidance-item',
        message: '执行ls',
        appliedAtMs: Date.now(),
      })
    })
    expect(cancelRuntimeTask).not.toHaveBeenCalled()
    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('queued-messages')).toHaveTextContent('')
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('执行ls')
    expect(screen.getByTestId('queued-errors')).not.toHaveTextContent('当前回复缺少引导上下文')
    expect(screen.getByTestId('guidance-messages')).toHaveTextContent('')
  })

  test('sends image attachments with current runtime task follow-up messages', async () => {
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
    await userEvent.click(screen.getByText('add image attachment'))
    expect(screen.getByTestId('runtime-attachment-count')).toHaveTextContent('1')
    await userEvent.click(screen.getByText('send follow-up'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('runtime-attachment-count')).toHaveTextContent('0')
    expect(sendRuntimeMessage).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'runtime-a',
      },
      clientMessageId: expect.any(String),
      message: '继续修',
      modelOptions: { collaborationMode: 'default' },
      attachmentIds: [45],
    })
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('继续修')
    expect(screen.getByTestId('runtime-open-error')).toHaveTextContent('')
  })

  test('sends local image attachments with current runtime task follow-up messages', async () => {
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
    await userEvent.click(screen.getByText('add local image attachment'))
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
      attachments: [
        expect.objectContaining({
          id: -45,
          filename: 'photo.png',
          local_path: LOCAL_IMAGE_ATTACHMENT_PATH,
          local_preview_url: LOCAL_IMAGE_ATTACHMENT_PATH,
        }),
      ],
    })
  })

  test('loads local skills and apps from Codex app-server', async () => {
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
                cwd: '/workspace/runtime-device',
                skills: [
                  {
                    name: 'env-context',
                    description: 'Environment facts',
                    path: '/Users/dev/.codex/skills/env-context/SKILL.md',
                    scope: 'user',
                    enabled: true,
                  },
                ],
                errors: [],
              },
            ],
          }
        }
        if (
          method === 'codex.app_server_request' &&
          params &&
          typeof params === 'object' &&
          (params as { method?: unknown }).method === 'app/list'
        ) {
          return {
            data: [
              {
                id: 'google-calendar',
                name: 'Google Calendar',
                description: 'Manage calendar events',
                isAccessible: true,
                isEnabled: true,
              },
            ],
            nextCursor: null,
          }
        }
        return {}
      }
    )
    const services = createWorkbenchServices({
      deviceApi: {
        listDevices: vi
          .fn()
          .mockResolvedValue([
            createDevice({ device_id: 'device-1', name: 'Default Device' }),
            createDevice({ id: 2, device_id: 'runtime-device', name: 'Runtime Device' }),
          ]),
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
      runtimeWorkApi: createRuntimeWorkApiMock({
        getRuntimeTranscript: vi.fn(async (address: RuntimeTaskAddress) => ({
          taskId: address.taskId,
          workspacePath: address.workspacePath,
          runtime: 'codex',
          messages: [],
        })),
      }) as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeTaskSkillsProbe />, services)

    await userEvent.click(screen.getByText('open runtime skill task'))
    await waitFor(() =>
      expect(services.runtimeWorkApi?.getRuntimeTranscript).toHaveBeenCalledWith({
        deviceId: 'runtime-device',
        workspacePath: '/workspace/runtime-device',
        taskId: 'runtime-skill-task',
        limit: 50,
      })
    )

    await userEvent.click(screen.getByText('list local skills'))

    await waitFor(() => {
      expect(localExecutorMocks.requestLocalExecutor).toHaveBeenCalledWith(
        'codex.app_server_request',
        {
          method: 'skills/list',
          params: {
            cwds: ['/workspace/runtime-device'],
            forceReload: false,
          },
        }
      )
    })

    await userEvent.click(screen.getByText('list local apps'))

    await waitFor(() => {
      expect(localExecutorMocks.requestLocalExecutor).toHaveBeenCalledWith(
        'codex.app_server_request',
        {
          method: 'app/list',
          params: {
            cursor: null,
            limit: 100,
            forceRefetch: false,
          },
        }
      )
    })
  })

  test('ignores stream events from a previously selected runtime task', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-b',
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

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime b'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-b'
      )
    )

    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        shellType: 'Codex',
        deviceId: 'device-1',
      })
      streamHandlers.onChatDone?.({
        taskId: 'runtime-a',
        subtaskId: '101',
        offset: 0,
        result: { value: 'stale runtime a output' },
        deviceId: 'device-1',
      })
      streamHandlers.onChatStart?.({
        taskId: 'runtime-b',
        subtaskId: '102',
        shellType: 'Codex',
        deviceId: 'device-1',
      })
      streamHandlers.onChatDone?.({
        taskId: 'runtime-b',
        subtaskId: '102',
        offset: 0,
        result: { value: 'current runtime b output' },
        deviceId: 'device-1',
      })
    })

    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent(
      'current runtime b output'
    )
    expect(screen.getByTestId('runtime-open-messages')).not.toHaveTextContent(
      'stale runtime a output'
    )
  })
})
