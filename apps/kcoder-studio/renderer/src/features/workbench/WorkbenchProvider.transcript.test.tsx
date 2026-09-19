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

  test('renders streaming runtime task chunks when the socket connects after chat start', async () => {
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const transcript = deferred<RuntimeTranscriptResponse>()
    const runtimeWorkApi = createRuntimeWorkApiMock({
      createRuntimeTask: vi.fn(async request => ({
        accepted: true,
        deviceId: request.deviceId,
        taskId: request.taskId,
        workspacePath: request.workspacePath,
        runtime: 'codex',
      })),
      getRuntimeTranscript: vi.fn().mockReturnValue(transcript.promise),
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
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))

    await waitFor(() => expect(runtimeWorkApi.createRuntimeTask).toHaveBeenCalledTimes(1))
    const request = runtimeWorkApi.createRuntimeTask.mock.calls[0][0]
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        `device-1:${request.taskId}`
      )
    )
    await waitFor(() => expect(streamHandlers.onChatChunk).toBeDefined())

    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: request.taskId,
        subtaskId: '102',
        shellType: 'Codex',
        deviceId: 'device-1',
      })
      streamHandlers.onChatChunk?.({
        taskId: request.taskId,
        subtaskId: '102',
        content: 'streamed answer',
        offset: 0,
        deviceId: 'device-1',
      })
    })

    expect(screen.getByTestId('message-roles')).toHaveTextContent('user:修复 CI')
    expect(screen.getByTestId('message-roles')).not.toHaveTextContent('assistant:streamed answer')

    await act(async () => {
      transcript.resolve({
        taskId: request.taskId,
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [
          { id: 'user-1', role: 'user', content: '修复 CI' },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'streamed answer',
            subtaskId: '102',
          },
        ],
      })
      await transcript.promise
    })

    await waitFor(() =>
      expect(screen.getByTestId('message-roles')).toHaveTextContent('assistant:streamed answer')
    )
  })

  test('restores a runtime task from the URL with transcript blocks', async () => {
    window.history.pushState({}, '', '/runtime-tasks?deviceId=device-1&taskId=runtime-restored')
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      taskId: 'runtime-restored',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
      messages: [
        { id: 'user-1', role: 'user', content: '恢复的问题' },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '恢复的回答',
          subtaskId: 901,
          fileChanges: {
            version: 1,
            status: 'active',
            artifact_id: 'turn-901',
            device_id: 'device-1',
            workspace_path: '/workspace/project-alpha',
            file_count: 1,
            additions: 4,
            deletions: 2,
            files: [
              {
                path: 'src/runtime.ts',
                change_type: 'modified',
                additions: 4,
                deletions: 2,
                binary: false,
              },
            ],
            reverted_at: null,
          },
          blocks: [
            {
              id: 'thinking-901',
              type: 'thinking',
              content: '读取历史记录',
              status: 'done',
              timestamp: 1770000000,
            },
            {
              id: 'call-901',
              type: 'tool',
              tool_name: 'exec_command',
              tool_input: { cmd: 'pwd' },
              tool_output: '/workspace/project-alpha',
              status: 'done',
              timestamp: 1770000001000,
            },
            {
              id: 'text-901',
              type: 'text',
              content: '处理完成',
              status: 'done',
              timestamp: 1770000002000,
            },
          ],
        },
      ],
    } satisfies RuntimeTranscriptResponse)
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeTranscript })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-restored'
      )
    )
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('恢复的问题')
    )
    expect(screen.getByTestId('runtime-open-blocks')).toHaveTextContent(
      'thinking:读取历史记录:done'
    )
    expect(screen.getByTestId('runtime-open-blocks')).toHaveTextContent('tool:exec_command:done')
    expect(screen.getByTestId('runtime-open-blocks')).toHaveTextContent('text:处理完成:done')
    expect(screen.getByTestId('runtime-open-file-changes')).toHaveTextContent('src/runtime.ts')
    expect(getRuntimeTranscript).toHaveBeenCalledWith({
      deviceId: 'device-1',
      taskId: 'runtime-restored',
      workspacePath: '/workspace/project-alpha',
      limit: 50,
    })
  })

  test('retries a live failure with the submitted prompt when the failed subtask is reused', async () => {
    window.history.pushState({}, '', '/runtime-tasks?deviceId=device-1&taskId=runtime-restored')
    let streamHandlers: ChatStreamHandlers = {}
    const subscribe = vi.fn((handlers: ChatStreamHandlers) => {
      if (hasRuntimeStreamHandler(handlers)) streamHandlers = handlers
      return vi.fn()
    })
    const sendRuntimeMessage = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: 'runtime-restored',
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-restored',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [
          {
            id: 'user-old',
            role: 'user',
            content: '旧问题',
            status: 'done',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'assistant-old',
            role: 'assistant',
            content: '旧回答',
            status: 'done',
            subtaskId: 'reused-subtask',
            createdAt: '2026-01-01T00:00:01.000Z',
          },
        ],
      }),
      sendRuntimeMessage,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: { subscribe } as WorkbenchServices['chatStream'],
    })

    renderWorkbench(<ProjectSendProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-restored'
      )
    )
    await waitFor(() => expect(screen.getByTestId('message-roles')).toHaveTextContent('旧回答'))
    await userEvent.click(screen.getByText('set input'))
    await userEvent.click(screen.getByText('send'))
    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(1))

    await act(async () => {
      streamHandlers.onChatError?.({
        taskId: 'runtime-restored',
        subtaskId: 'reused-subtask',
        deviceId: 'device-1',
        error: 'codex app-server exited',
      })
    })
    await userEvent.click(await screen.findByTestId('assistant-error-retry'))

    await waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.queryByTestId('assistant-error-card')).not.toBeInTheDocument()
    )
    expect(sendRuntimeMessage.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        address: expect.objectContaining({ taskId: 'runtime-restored' }),
        message: '修复 CI',
      })
    )
  })

  test('uses runtime transcript server times for blocks without timestamps', async () => {
    vi.setSystemTime(new Date('2026-06-05T00:01:00.000Z'))
    window.history.pushState({}, '', '/runtime-tasks?deviceId=device-1&taskId=runtime-restored')
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      taskId: 'runtime-restored',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '恢复的回答',
          subtaskId: '901',
          createdAt: '2026-06-05T00:00:00.000Z',
          blocks: [
            {
              id: 'thinking-901',
              type: 'thinking',
              content: '读取历史记录',
              status: 'done',
              created_at: '2026-06-05T00:00:06.000Z',
            },
            {
              id: 'text-901',
              type: 'text',
              content: '处理完成',
              status: 'done',
            },
          ],
        },
      ],
    } satisfies RuntimeTranscriptResponse)
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeTranscript })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-block-times')).toHaveTextContent(
        '1780617600000|1780617606000'
      )
    )
    expect(screen.getByTestId('runtime-open-blocks')).toHaveTextContent(
      'text:处理完成:done|thinking:读取历史记录:done'
    )
  })

  test('restores runtime transcript file changes onto assistant messages', async () => {
    window.history.pushState({}, '', '/runtime-tasks?deviceId=device-1&taskId=runtime-restored')
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      taskId: 'runtime-restored',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
      messages: [
        { id: 'user-1', role: 'user', content: '修复搜索' },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '已修复',
          subtaskId: '902',
          fileChanges: createTurnFileChanges(),
        },
      ],
    } satisfies RuntimeTranscriptResponse)
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeTranscript })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-file-changes')).toHaveTextContent('1:6:4')
    )
  })

  test('restores a runtime task from the URL even when it is missing from the work list', async () => {
    window.history.pushState({}, '', '/runtime-tasks?deviceId=device-1&taskId=codex-hidden')
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      taskId: 'codex-hidden',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
      messages: [
        { id: 'user-hidden', role: 'user', content: 'hidden user message' },
        { id: 'assistant-hidden', role: 'assistant', content: 'hidden assistant message' },
      ],
    } satisfies RuntimeTranscriptResponse)
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(
        createRuntimeWork({
          projects: [],
          chats: [],
          totalTasks: 0,
        })
      ),
      getRuntimeTranscript,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:codex-hidden'
      )
    )
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent(
        'hidden user message|hidden assistant message'
      )
    )
    expect(getRuntimeTranscript).toHaveBeenCalledWith({
      deviceId: 'device-1',
      taskId: 'codex-hidden',
      limit: 50,
    })
  })

  test('loads older runtime transcript messages before the current page', async () => {
    const getRuntimeTranscript = vi.fn(request => {
      if (request.beforeCursor === 'offset:120') {
        return Promise.resolve({
          taskId: 'runtime-a',
          workspacePath: '/workspace/project-alpha',
          runtime: 'codex',
          messages: [{ id: 'runtime-a:user:o20', role: 'user', content: 'older message' }],
          hasMoreBefore: false,
          beforeCursor: null,
        } satisfies RuntimeTranscriptResponse)
      }
      return Promise.resolve({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [{ id: 'runtime-a:user:o120', role: 'user', content: 'recent message' }],
        hasMoreBefore: true,
        beforeCursor: 'offset:120',
      } satisfies RuntimeTranscriptResponse)
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeTranscript })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('recent message')
    )
    expect(screen.getByTestId('runtime-transcript-has-more')).toHaveTextContent('more')

    await userEvent.click(screen.getByText('load older'))

    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent(
        'older message|recent message'
      )
    )
    expect(getRuntimeTranscript).toHaveBeenLastCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      taskId: 'runtime-a',
      limit: 50,
      beforeCursor: 'offset:120',
    })
    expect(screen.getByTestId('runtime-transcript-has-more')).toHaveTextContent('done')
  })

  test('reloads the selected runtime transcript when switching back to a task', async () => {
    const getRuntimeTranscript = vi.fn((request: RuntimeTranscriptRequest) => {
      if (request.taskId === 'runtime-a') {
        return Promise.resolve({
          taskId: 'runtime-a',
          workspacePath: '/workspace/project-alpha',
          runtime: 'codex',
          messages: [
            { id: 'runtime-a:user:1', role: 'user', content: 'first a' },
            { id: 'runtime-a:assistant:1', role: 'assistant', content: 'answer a' },
          ],
          hasMoreBefore: false,
          beforeCursor: null,
        } satisfies RuntimeTranscriptResponse)
      }
      return Promise.resolve({
        taskId: 'runtime-b',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [{ id: 'runtime-b:user:1', role: 'user', content: 'message b' }],
        hasMoreBefore: false,
        beforeCursor: null,
      } satisfies RuntimeTranscriptResponse)
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeTranscript })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first a|answer a')
    )

    await userEvent.click(screen.getByText('open runtime b'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('message b')
    )
    expect(getRuntimeTranscript).toHaveBeenCalledTimes(2)

    await userEvent.click(screen.getByText('open runtime a'))

    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-a'
      )
    )
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first a|answer a')
    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(3))
    expect(getRuntimeTranscript).toHaveBeenLastCalledWith({
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      taskId: 'runtime-a',
      limit: 50,
    })
  })

  test('does not immediately reload a runtime transcript after the initial open', async () => {
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
    const getRuntimeTranscript = vi.fn().mockImplementation(async () => {
      return {
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'codex',
        messages: [
          { id: 'user-1', role: 'user', content: 'first message' },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'working',
            status: 'streaming',
            subtaskId: '901',
          },
        ],
      } satisfies RuntimeTranscriptResponse
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({
      listRuntimeWork: vi.fn().mockResolvedValue(runningWork),
      getRuntimeTranscript,
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('first message|working')
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(getRuntimeTranscript).toHaveBeenCalledTimes(1)
  })

  test('reviews runtime transcript file changes through device command and reverts through runtime API', async () => {
    window.history.pushState({}, '', '/runtime-tasks?deviceId=device-1&taskId=runtime-restored')
    const fileChanges = createTurnFileChanges()
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      taskId: 'runtime-restored',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
      messages: [
        { id: 'user-1', role: 'user', content: '修复搜索' },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '已修复',
          subtaskId: '902',
          fileChanges,
        },
      ],
    } satisfies RuntimeTranscriptResponse)
    const executeCommand = vi.fn().mockResolvedValueOnce({
      success: true,
      stdout: { success: true, diff: 'diff --git a/file b/file' },
      stderr: '',
    })
    const revertRuntimeFileChanges = vi.fn().mockResolvedValue({
      fileChanges: {
        ...fileChanges,
        status: 'reverted',
        reverted_at: '2026-06-05T00:00:00.000Z',
      },
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: createRuntimeWorkApiMock({
        getRuntimeTranscript,
        revertRuntimeFileChanges,
      }) as WorkbenchServices['runtimeWorkApi'],
      deviceApi: {
        executeCommand,
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-file-changes')).toHaveTextContent('1:6:4')
    )
    await userEvent.click(screen.getByText('review runtime file changes'))

    await waitFor(() =>
      expect(screen.getByTestId('runtime-file-changes-diff')).toHaveTextContent(
        'diff --git a/file b/file'
      )
    )
    expect(executeCommand).toHaveBeenCalledWith('device-1', {
      command_key: 'turn_file_changes_review',
      taskId: 'runtime-restored',
      threadId: undefined,
      path: fileChanges.workspace_path,
      args: [fileChanges.artifact_id],
      timeout_seconds: 30,
      max_output_bytes: 5 * 1024 * 1024,
    })

    await userEvent.click(screen.getByText('revert runtime file changes'))

    await waitFor(() =>
      expect(screen.getByTestId('runtime-file-changes-status')).toHaveTextContent('reverted')
    )
    expect(revertRuntimeFileChanges).toHaveBeenCalledWith({
      address: {
        deviceId: 'device-1',
        taskId: 'runtime-restored',
        workspacePath: '/workspace/project-alpha',
      },
      fileChanges: expect.objectContaining(fileChanges),
    })
    expect(screen.getByTestId('runtime-open-file-changes')).toHaveTextContent('1:6:4')
  })

  test('reviews runtime file changes from the provided summary when messages are stale', async () => {
    window.history.pushState({}, '', '/runtime-tasks?deviceId=device-1&taskId=runtime-restored')
    const fileChanges = createTurnFileChanges()
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      taskId: 'runtime-restored',
      workspacePath: '/workspace/project-alpha',
      runtime: 'codex',
      messages: [
        { id: 'user-1', role: 'user', content: '修复搜索' },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '已修复',
          subtaskId: '902',
          fileChanges,
        },
      ],
    } satisfies RuntimeTranscriptResponse)
    const executeCommand = vi.fn().mockResolvedValueOnce({
      success: true,
      stdout: { success: true, diff: 'diff --git a/stale b/stale' },
      stderr: '',
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: createRuntimeWorkApiMock({
        getRuntimeTranscript,
      }) as WorkbenchServices['runtimeWorkApi'],
      deviceApi: {
        executeCommand,
      } as Partial<WorkbenchServices['deviceApi']> as WorkbenchServices['deviceApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-file-changes')).toHaveTextContent('1:6:4')
    )
    await userEvent.click(screen.getByText('review runtime file changes from stale messages'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-file-changes-diff')).toHaveTextContent(
        'diff --git a/stale b/stale'
      )
    )

    expect(executeCommand).toHaveBeenCalledWith('device-1', {
      command_key: 'turn_file_changes_review',
      taskId: 'runtime-restored',
      threadId: undefined,
      path: fileChanges.workspace_path,
      args: [fileChanges.artifact_id],
      timeout_seconds: 30,
      max_output_bytes: 5 * 1024 * 1024,
    })
  })

  test('switches the selected runtime task before transcript loading finishes', async () => {
    const firstTranscript = deferred<RuntimeTranscriptResponse>()
    const getRuntimeTranscript = vi.fn((address: RuntimeTaskAddress) => {
      if (address.taskId === 'runtime-a') return firstTranscript.promise
      return Promise.resolve({
        taskId: 'runtime-b',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-b:user:1', role: 'user', content: 'message b' }],
      } satisfies RuntimeTranscriptResponse)
    })
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeTranscript })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
      'device-1:runtime-a'
    )
    expect(screen.getByTestId('runtime-transcript-loading')).toHaveTextContent('loading')
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('')

    await userEvent.click(screen.getByText('open runtime b'))
    await waitFor(() =>
      expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
        'device-1:runtime-b'
      )
    )
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('message b')
    expect(screen.getByTestId('runtime-transcript-loading')).toHaveTextContent('idle')

    await act(async () => {
      firstTranscript.resolve({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'message a' }],
      })
      await firstTranscript.promise
    })

    expect(screen.getByTestId('current-runtime-task-address')).toHaveTextContent(
      'device-1:runtime-b'
    )
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('message b')
    expect(screen.getByTestId('runtime-open-messages')).not.toHaveTextContent('message a')
  })

  test('does not reload the currently selected runtime task when clicked again', async () => {
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      taskId: 'runtime-a',
      workspacePath: '/workspace/project-alpha',
      runtime: 'claude_code',
      messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'message a' }],
    } satisfies RuntimeTranscriptResponse)
    const runtimeWorkApi = createRuntimeWorkApiMock({ getRuntimeTranscript })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
    })

    renderWorkbench(<RuntimeOpenProbe />, services)

    await userEvent.click(await screen.findByText('open runtime a'))
    await waitFor(() =>
      expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('message a')
    )
    expect(getRuntimeTranscript).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByText('open runtime a'))

    expect(getRuntimeTranscript).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('runtime-open-messages')).toHaveTextContent('message a')
    expect(screen.getByTestId('runtime-transcript-loading')).toHaveTextContent('idle')
  })

  test('keeps the runtime stream subscription when the same task address is rebuilt', async () => {
    const runtimeCleanup = vi.fn()
    const subscribe = vi.fn((handlers: ChatStreamHandlers) =>
      handlers.scope?.taskId === 'runtime-a' ? runtimeCleanup : vi.fn()
    )
    const runtimeWorkApi = createRuntimeWorkApiMock({
      getRuntimeTranscript: vi.fn().mockResolvedValue({
        taskId: 'runtime-a',
        workspacePath: '/workspace/project-alpha',
        runtime: 'claude_code',
        messages: [{ id: 'runtime-a:user:1', role: 'user', content: 'message a' }],
      } satisfies RuntimeTranscriptResponse),
    })
    const services = createWorkbenchServices({
      runtimeWorkApi: runtimeWorkApi as WorkbenchServices['runtimeWorkApi'],
      chatStream: {
        subscribe,
      } as unknown as WorkbenchServices['chatStream'],
    })

    render(
      <WorkbenchProvider user={{ id: 1, user_name: 'alice', email: 'a@b.c' }} services={services}>
        <RuntimePaneSessionIdentityProbe />
      </WorkbenchProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('runtime-session-messages')).toHaveTextContent('message a')
    )
    const runtimeSubscribeCount = () =>
      subscribe.mock.calls.filter(([handlers]) => handlers.scope?.taskId === 'runtime-a').length
    await waitFor(() => expect(runtimeSubscribeCount()).toBe(1))

    await userEvent.click(screen.getByText('rebuild same runtime address'))

    expect(runtimeSubscribeCount()).toBe(1)
    expect(runtimeCleanup).not.toHaveBeenCalled()
  })
})
