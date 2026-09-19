import { getDesktopWorkbenchHoistedMocks } from './DesktopWorkbenchLayout.test-mocks'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import {
  DesktopWorkbenchLayout,
  activeProjectRuntimeTask,
  baseProps,
  createDeferred,
  createPendingRequestUserInputMessage,
} from './DesktopWorkbenchLayout.test-harness'
import { mockDesktopWorkbenchMainWidth } from './DesktopWorkbenchMain.workspace.test-support'

const { experimentalFeatures, paneSessionMockRef } = getDesktopWorkbenchHoistedMocks()

describe('DesktopWorkbenchLayout', () => {
  test('opens the local-capable board route while cloud is disconnected', () => {
    window.history.pushState({}, '', '/todo')

    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.getByTestId('cloud-board-loading')).toBeInTheDocument()
    expect(
      screen.getByTestId('desktop-workbench-content').closest('[aria-hidden="true"]')
    ).toHaveStyle({ display: 'none' })
  })

  test('submits implementation plan confirmation as a user message response', async () => {
    const onRequestUserInputSubmit = vi.fn().mockResolvedValue(true)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-plan',
          },
        }}
        messages={[createPendingRequestUserInputMessage()]}
        onRequestUserInputSubmit={onRequestUserInputSubmit}
      />
    )

    await userEvent.click(screen.getByTestId('request-user-input-submit-button'))

    expect(onRequestUserInputSubmit).toHaveBeenCalledWith(
      {
        requestId: 42,
        itemId: undefined,
        answers: {
          implement: { answers: ['是的，执行此计划'] },
        },
      },
      { appendUserMessage: true, forceDefaultCollaborationMode: true }
    )
  })

  test('keeps plan mode when submitting implementation plan adjustments', async () => {
    const onRequestUserInputSubmit = vi.fn().mockResolvedValue(true)
    const user = userEvent.setup()

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-plan',
          },
        }}
        messages={[createPendingRequestUserInputMessage(true)]}
        onRequestUserInputSubmit={onRequestUserInputSubmit}
      />
    )

    await user.type(screen.getByTestId('request-user-input-custom-adjustment'), '先缩小范围')
    await user.click(screen.getByTestId('request-user-input-submit-button'))

    expect(onRequestUserInputSubmit).toHaveBeenCalledWith(
      {
        requestId: 42,
        itemId: undefined,
        answers: {
          adjustment: { answers: ['先缩小范围'] },
        },
      },
      { appendUserMessage: true, forceDefaultCollaborationMode: false }
    )
  })

  test('ignores the implementation plan confirmation through the pane session', async () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-plan',
          },
        }}
        messages={[createPendingRequestUserInputMessage()]}
      />
    )

    const ignoreRequestUserInput = (
      paneSessionMockRef.current as {
        ignoreRequestUserInput: ReturnType<typeof vi.fn>
      }
    ).ignoreRequestUserInput

    await userEvent.click(screen.getByTestId('request-user-input-ignore-button'))

    expect(ignoreRequestUserInput).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: 42,
      })
    )
  })

  test('does not open assistant markdown as a plan in the right workspace panel', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        messages={[
          {
            id: 'assistant-plan',
            role: 'assistant',
            content: [
              '# Wegent 体验计划',
              '',
              '## Summary',
              '- 优先修复流式展示。',
              '',
              '## Test Plan',
              '- 运行相关前端测试。',
            ].join('\n'),
            status: 'done',
            createdAt: '2026-06-30T00:00:01.000Z',
          },
        ]}
      />
    )

    expect(screen.queryByTestId('assistant-plan-expand-button')).not.toBeInTheDocument()
    expect(screen.getByText('Wegent 体验计划')).toBeInTheDocument()
  })

  test('opens explicit assistant plan blocks in the right workspace panel', async () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        messages={[
          {
            id: 'assistant-plan-block',
            role: 'assistant',
            content: '',
            status: 'done',
            createdAt: '2026-06-30T00:00:01.000Z',
            blocks: [
              {
                id: 'plan-1',
                subtaskId: 1,
                type: 'plan',
                content: [
                  '# Wegent 体验计划',
                  '',
                  '## Summary',
                  '- 优先修复流式展示。',
                  '',
                  '## Test Plan',
                  '- 运行相关前端测试。',
                ].join('\n'),
                status: 'done',
                createdAt: Date.parse('2026-06-30T00:00:01.000Z'),
              },
            ],
          },
        ]}
      />
    )

    expect(screen.getByTestId('assistant-plan-card')).toHaveTextContent('Wegent 体验计划')

    await userEvent.click(screen.getByTestId('assistant-plan-expand-button'))

    expect(screen.getByTestId('workspace-plan-panel')).toHaveTextContent('Wegent 体验计划')
    expect(screen.getByTestId('workspace-plan-panel')).toHaveTextContent('运行相关前端测试')
  })

  test('keeps the right workspace plan panel synced with the opened streaming plan block', async () => {
    const initialMessages: WorkbenchMessage[] = [
      {
        id: 'assistant-plan-block',
        role: 'assistant',
        content: '',
        status: 'streaming',
        createdAt: '2026-06-30T00:00:01.000Z',
        blocks: [
          {
            id: 'plan-1',
            subtaskId: '1',
            type: 'plan',
            content: '# Wegent 体验计划\n\n## Summary\n- 正在生成第一步。',
            status: 'streaming',
            createdAt: Date.parse('2026-06-30T00:00:01.000Z'),
          },
        ],
      },
    ]
    const { rerender } = render(
      <DesktopWorkbenchLayout {...baseProps} messages={initialMessages} />
    )

    await userEvent.click(screen.getByTestId('assistant-plan-expand-button'))

    expect(screen.getByTestId('workspace-plan-panel')).toHaveTextContent('正在生成第一步')

    rerender(
      <DesktopWorkbenchLayout
        {...baseProps}
        messages={[
          {
            ...initialMessages[0],
            blocks: [
              {
                ...initialMessages[0].blocks![0],
                content:
                  '# Wegent 体验计划\n\n## Summary\n- 正在生成第一步。\n- 已流式补充第二步。',
              },
            ],
          },
        ]}
      />
    )

    expect(screen.getByTestId('workspace-plan-panel')).toHaveTextContent('已流式补充第二步')
  })

  test('does not replace the opened right workspace plan when a newer plan block appears', async () => {
    const openedPlanMessage: WorkbenchMessage = {
      id: 'assistant-plan-block',
      role: 'assistant',
      content: '',
      status: 'done',
      createdAt: '2026-06-30T00:00:01.000Z',
      blocks: [
        {
          id: 'plan-1',
          subtaskId: '1',
          type: 'plan',
          content: '# 已打开的计划\n\n- 保持当前内容。',
          status: 'done',
          createdAt: Date.parse('2026-06-30T00:00:01.000Z'),
        },
      ],
    }
    const { rerender } = render(
      <DesktopWorkbenchLayout {...baseProps} messages={[openedPlanMessage]} />
    )

    await userEvent.click(screen.getByTestId('assistant-plan-expand-button'))

    rerender(
      <DesktopWorkbenchLayout
        {...baseProps}
        messages={[
          openedPlanMessage,
          {
            id: 'assistant-newer-plan-block',
            role: 'assistant',
            content: '',
            status: 'streaming',
            createdAt: '2026-06-30T00:01:01.000Z',
            blocks: [
              {
                id: 'plan-2',
                subtaskId: '2',
                type: 'plan',
                content: '# 新生成的计划\n\n- 不应抢占右侧面板。',
                status: 'streaming',
                createdAt: Date.parse('2026-06-30T00:01:01.000Z'),
              },
            ],
          },
        ]}
      />
    )

    expect(screen.getByTestId('workspace-plan-panel')).toHaveTextContent('已打开的计划')
    expect(screen.getByTestId('workspace-plan-panel')).not.toHaveTextContent('新生成的计划')
  })

  test('renders a project-specific empty prompt that opens the project chooser', async () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentProject: { id: 1, name: 'gitlab-wegent', tasks: [] },
        }}
      />
    )

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      '我们应该在 gitlab-wegent 中做些什么？'
    )
    expect(screen.getByTestId('empty-project-title-button')).toHaveAttribute('title', '更改项目')

    await userEvent.click(screen.getByTestId('empty-project-title-button'))

    expect(screen.getByTestId('project-work-menu')).toBeInTheDocument()
  })

  test('keeps the empty composer at the intended desktop proportion', () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.getByTestId('desktop-empty-composer-frame')).toHaveClass(
      'flex',
      'min-h-0',
      'flex-1',
      'flex-col'
    )
    expect(screen.getByTestId('desktop-empty-composer-dock')).toHaveClass(
      'w-[min(46rem,calc(100%_-_2rem))]',
      'min-w-0',
      'shrink-0'
    )
  })

  test('renders the conversation composer as a sticky scroll footer', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
        ]}
      />
    )

    const desktopContent = screen.getByTestId('desktop-workbench-content')
    expect(desktopContent).toHaveClass('h-full', 'overflow-x-hidden', 'overflow-y-auto', 'pt-11')
    expect(desktopContent.style.getPropertyValue('--desktop-floating-composer-clearance')).toBe('')
    expect(screen.getByTestId('desktop-chat-scroll')).toHaveClass(
      'h-full',
      'overflow-visible',
      'scrollbar-none',
      'flex',
      'flex-col'
    )
    expect(screen.getByTestId('desktop-chat-scroll')).not.toHaveClass(
      'pb-[var(--desktop-floating-composer-clearance)]'
    )
    expect(screen.getByTestId('desktop-chat-scroll')).not.toHaveClass(
      'overflow-x-hidden',
      'overflow-x-clip'
    )
    expect(screen.getByTestId('desktop-chat-scroll-content')).toHaveClass('flex-1', 'shrink-0')
    expect(screen.getByTestId('desktop-chat-scroll-content')).not.toHaveClass('justify-end')
    expect(screen.getByTestId('desktop-chat-scroll-content').firstElementChild).toHaveClass(
      'w-[min(46rem,calc(100%_-_6rem))]',
      'min-w-0',
      'max-w-[calc(100%_-_6rem)]',
      'px-0'
    )
    expect(screen.getByTestId('desktop-chat-scroll-sticky-footer')).toHaveClass(
      'sticky',
      'bottom-0',
      'z-10',
      'from-background'
    )
    expect(screen.getByTestId('desktop-floating-composer-backdrop')).toHaveClass(
      'pointer-events-none',
      'absolute',
      'inset-x-0',
      'bottom-0',
      'from-background'
    )
    expect(screen.getByTestId('desktop-floating-composer-layer')).toHaveClass(
      'relative',
      'w-[min(46rem,calc(100%_-_2rem))]',
      'min-w-0',
      'max-w-[calc(100%_-_2rem)]'
    )
    expect(screen.getByTestId('desktop-floating-composer-card')).toHaveClass('pointer-events-auto')
    expect(screen.queryByTestId('project-work-button')).not.toBeInTheDocument()
  })

  test.each([1024, 700])('renders subagent status below the top bar without shifting messages at width %i', width => {
    mockDesktopWorkbenchMainWidth(width)
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{ ...baseProps.state, currentRuntimeTask: activeProjectRuntimeTask }}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
        ]}
        subagentStatuses={[
          {
            id: 'subagent-1',
            agentId: 'thread:019f17ae-8295-7072-84e0-94ca0ffa96e5',
            agentPath: 'thread:019f17ae-8295-7072-84e0-94ca0ffa96e5',
            agentName: 'worker',
            status: 'running',
            updatedAtMs: 12345,
          },
        ]}
      />
    )

    expect(screen.queryByTestId('workbench-topbar-right-actions')).not.toBeInTheDocument()
    const statusRow = screen.getByTestId('workbench-subagent-status-row')
    expect(statusRow).toContainElement(screen.getByTestId('subagent-status-toggle-button'))
    expect(statusRow).toHaveClass('absolute', 'right-3', 'top-3', 'w-max')
    expect(screen.getByTestId('environment-info-panel-container')).toHaveClass('overflow-visible')
    expect(screen.getByTestId('desktop-workbench-content')).toHaveClass('pt-11')
  })

  test('treats a selected runtime task with an empty transcript as a conversation', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          runtimeWork: {
            projects: [],
            chats: [
              {
                deviceId: 'device-1',
                deviceName: 'Runtime Device',
                workspacePath: '/workspace/project-alpha',
                workspaceKind: 'workspace',
                tasks: [
                  {
                    taskId: 'runtime-empty',
                    workspacePath: '/workspace/project-alpha',
                    title: 'Fix pane title',
                    runtime: 'codex',
                    createdAt: '2026-06-20T00:00:00.000Z',
                    updatedAt: '2026-06-20T00:00:00.000Z',
                    running: true,
                  },
                ],
              },
            ],
            totalTasks: 1,
          },
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-empty',
          },
        }}
        messages={[]}
      />
    )

    expect(screen.getByTestId('desktop-floating-composer-layer')).toBeInTheDocument()
    expect(screen.queryByTestId('desktop-empty-composer-frame')).not.toBeInTheDocument()
    const paneTitle = screen.getByTestId('workbench-pane-task-title')
    expect(paneTitle).toHaveTextContent('Fix pane title')
    expect(paneTitle).toHaveClass('truncate', 'text-sm', 'text-text-primary')
    expect(screen.getByTestId('workbench-topbar')).toHaveClass(
      'h-11',
      'border-b',
      'border-border/50',
      'bg-background/95'
    )
  })

  test('opens continue-in-im dialog from the active runtime task topbar button', async () => {
    const onListImPrivateSessions = vi.fn().mockResolvedValue({
      total: 1,
      items: [
        {
          session_key: 'session-1',
          channel_type: 'wecom',
          channel_label: 'WeCom',
          channel_id: 101,
          conversation_id: 'conversation-1',
          sender_id: 'sender-1',
          display_name: 'Alice',
          mode: 'chat',
          state: 'idle',
          active_task_id: null,
          last_seen_at: '2026-06-20T00:00:00.000Z',
        },
      ],
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-1',
          },
        }}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-06-20T00:00:00.000Z',
          },
        ]}
        onListImPrivateSessions={onListImPrivateSessions}
      />
    )

    await userEvent.click(screen.getByTestId('continue-in-im-button'))

    expect(onListImPrivateSessions).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(await screen.findByTestId('continue-im-session-session-1')).toHaveTextContent('Alice')
  })

  test('hides task fork and IM actions while experimental features are disabled', () => {
    experimentalFeatures.enabled = false

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-1',
          },
        }}
      />
    )

    expect(screen.queryByTestId('fork-runtime-task-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('continue-in-im-button')).not.toBeInTheDocument()
  })

  test('forks an earlier completed turn without stopping the running follow-up', async () => {
    const currentRuntimeTask = {
      deviceId: 'device-1',
      workspacePath: '/workspace/project-alpha',
      taskId: 'runtime-1',
    }
    const onCancelRuntimePaneTask = vi.fn().mockResolvedValue(true)
    const onForkCurrentRuntimeTask = vi.fn().mockResolvedValue(undefined)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentRuntimeTask,
        }}
        lifecycleTaskRunning
        messages={[
          {
            id: 'assistant-turn-1',
            role: 'assistant',
            content: 'First turn complete',
            status: 'done',
            turnId: 'turn-1',
            createdAt: '2026-07-25T12:00:00.000Z',
          },
          {
            id: 'assistant-turn-2',
            role: 'assistant',
            content: 'Follow-up is streaming',
            status: 'streaming',
            turnId: 'turn-2',
            createdAt: '2026-07-25T12:01:00.000Z',
          },
        ]}
        onCancelRuntimePaneTask={onCancelRuntimePaneTask}
        onForkCurrentRuntimeTask={onForkCurrentRuntimeTask}
      />
    )

    await userEvent.click(screen.getByTestId('fork-message-button'))

    expect(onCancelRuntimePaneTask).not.toHaveBeenCalled()
    expect(onForkCurrentRuntimeTask).toHaveBeenCalledWith(
      {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
      },
      { lastTurnId: 'turn-1' }
    )
  })

  test('shows last-message edit for a KCoder gateway task without a WeWork device record', () => {
    const currentRuntimeTask = {
      deviceId: 'local',
      workspacePath: '/workspace/project-alpha',
      taskId: 'runtime-kcoder-edit',
    }

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        lifecycleTaskRunning={false}
        state={{
          ...baseProps.state,
          runtimeWork: {
            projects: [],
            chats: [
              {
                deviceId: 'local',
                deviceName: 'KCoder Local',
                workspacePath: '/workspace/project-alpha',
                workspaceKind: 'workspace',
                tasks: [
                  {
                    taskId: 'runtime-kcoder-edit',
                    workspacePath: '/workspace/project-alpha',
                    title: 'Gateway task',
                    runtime: 'kcoder',
                    running: false,
                  },
                ],
              },
            ],
            totalTasks: 1,
          },
          currentRuntimeTask,
        }}
        messages={[
          {
            id: 'user-turn-1',
            role: 'user',
            content: 'Original prompt',
            status: 'done',
            createdAt: '2026-07-25T12:00:00.000Z',
          },
          {
            id: 'assistant-turn-1',
            role: 'assistant',
            content: 'Completed answer',
            status: 'done',
            turnId: 'turn-1',
            createdAt: '2026-07-25T12:00:01.000Z',
          },
        ]}
      />
    )

    expect(screen.getByTestId('edit-message-button')).toBeInTheDocument()
  })

  test('keeps continue-in-im action with workspace panel actions on web', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-1',
          },
        }}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-06-20T00:00:00.000Z',
          },
        ]}
      />
    )

    const floatingActions = screen.getByTestId('workspace-panel-floating-actions')
    expect(floatingActions).toContainElement(screen.getByTestId('continue-in-im-button'))
    expect(floatingActions).toContainElement(
      screen.getByTestId('toggle-right-workspace-panel-button')
    )
    expect(screen.queryByTestId('workbench-topbar-right-actions')).not.toBeInTheDocument()
  })

  test('keeps continue-in-im action with titlebar actions in Tauri', () => {
    const previousTauriInternals = (window as typeof window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    try {
      render(
        <DesktopWorkbenchLayout
          {...baseProps}
          state={{
            ...baseProps.state,
            currentRuntimeTask: {
              deviceId: 'device-1',
              workspacePath: '/workspace/project-alpha',
              taskId: 'runtime-1',
            },
          }}
          messages={[
            {
              id: 'message-1',
              role: 'assistant',
              content: 'Ready',
              status: 'done',
              createdAt: '2026-06-20T00:00:00.000Z',
            },
          ]}
        />
      )

      const titlebarMainActions = screen.getByTestId('titlebar-main-actions')
      const titlebarActions = screen.getByTestId('titlebar-actions')
      expect(titlebarMainActions).toContainElement(screen.getByTestId('continue-in-im-button'))
      expect(titlebarMainActions).toContainElement(screen.getByTestId('fork-runtime-task-button'))
      expect(titlebarActions).not.toContainElement(screen.getByTestId('continue-in-im-button'))
      expect(titlebarActions).not.toContainElement(screen.getByTestId('fork-runtime-task-button'))
      expect(titlebarActions).toContainElement(
        screen.getByTestId('toggle-right-workspace-panel-button')
      )
      expect(screen.queryByTestId('workbench-topbar-right-actions')).not.toBeInTheDocument()
    } finally {
      if (previousTauriInternals === undefined) {
        delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
      } else {
        Object.defineProperty(window, '__TAURI_INTERNALS__', {
          configurable: true,
          value: previousTauriInternals,
        })
      }
    }
  })

  test('hides continue-in-im action without a runtime task', () => {
    const onListImPrivateSessions = vi.fn().mockResolvedValue({ total: 0, items: [] })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={baseProps.state}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-06-20T00:00:00.000Z',
          },
        ]}
        onListImPrivateSessions={onListImPrivateSessions}
      />
    )

    expect(screen.queryByTestId('continue-in-im-button')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onListImPrivateSessions).not.toHaveBeenCalled()
  })

  test('ignores stale private session responses when reopening the dialog', async () => {
    type PrivateSessionResponse = {
      total: number
      items: Array<{
        session_key: string
        channel_type: string
        channel_label: string
        channel_id: number
        conversation_id: string
        sender_id: string
        display_name: string
        mode: 'chat' | 'task'
        state: 'idle'
        active_task_id: null
        last_seen_at: string
      }>
    }
    const firstRequest = createDeferred<PrivateSessionResponse>()
    const secondRequest = createDeferred<PrivateSessionResponse>()
    const onListImPrivateSessions = vi
      .fn()
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-1',
          },
        }}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-06-20T00:00:00.000Z',
          },
        ]}
        onListImPrivateSessions={onListImPrivateSessions}
      />
    )

    await userEvent.click(screen.getByTestId('continue-in-im-button'))
    await userEvent.click(screen.getByTestId('continue-im-cancel-button'))
    await userEvent.click(screen.getByTestId('continue-in-im-button'))

    secondRequest.resolve({
      total: 1,
      items: [
        {
          session_key: 'session-2',
          channel_type: 'wecom',
          channel_label: 'WeCom',
          channel_id: 102,
          conversation_id: 'conversation-2',
          sender_id: 'sender-2',
          display_name: 'Fresh session',
          mode: 'task',
          state: 'idle',
          active_task_id: null,
          last_seen_at: '2026-06-20T00:00:00.000Z',
        },
      ],
    })

    expect(await screen.findByTestId('continue-im-session-session-2')).toHaveTextContent(
      'Fresh session'
    )

    firstRequest.resolve({
      total: 1,
      items: [
        {
          session_key: 'session-1',
          channel_type: 'wecom',
          channel_label: 'WeCom',
          channel_id: 101,
          conversation_id: 'conversation-1',
          sender_id: 'sender-1',
          display_name: 'Stale session',
          mode: 'chat',
          state: 'idle',
          active_task_id: null,
          last_seen_at: '2026-06-20T00:00:00.000Z',
        },
      ],
    })

    await waitFor(() => expect(screen.queryByText('Stale session')).not.toBeInTheDocument())
    expect(screen.getByText('Fresh session')).toBeInTheDocument()
  })

  test('shows a failure notice when bind handler is missing', async () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-1',
          },
        }}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-06-20T00:00:00.000Z',
          },
        ]}
        onListImPrivateSessions={vi.fn().mockResolvedValue({
          total: 1,
          items: [
            {
              session_key: 'session-1',
              channel_type: 'wecom',
              channel_label: 'WeCom',
              channel_id: 101,
              conversation_id: 'conversation-1',
              sender_id: 'sender-1',
              display_name: 'Alice',
              mode: 'chat',
              state: 'idle',
              active_task_id: null,
              last_seen_at: '2026-06-20T00:00:00.000Z',
            },
          ],
        })}
      />
    )

    await userEvent.click(screen.getByTestId('continue-in-im-button'))
    expect(await screen.findByTestId('continue-im-session-session-1')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await userEvent.click(screen.getByTestId('continue-im-submit-button'))

    expect(await screen.findByTestId('transient-notice')).toHaveTextContent('继续到私聊失败')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  test('positions the scroll-to-bottom button above the sticky composer footer', async () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Long reply',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
        ]}
      />
    )

    const scrollContainer = screen.getByTestId('desktop-chat-scroll')
    const scroller = screen.getByTestId('desktop-workbench-content')
    Object.defineProperty(scroller, 'clientHeight', {
      value: 200,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollHeight', {
      value: 600,
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTop', {
      value: 0,
      writable: true,
      configurable: true,
    })

    fireEvent.scroll(scrollContainer)

    expect(await screen.findByTestId('scroll-to-bottom-button')).toHaveClass('bottom-4', 'z-10')
  })

  test('keeps queued messages inside the sticky composer footer flow', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
        ]}
        queuedMessages={[
          {
            id: 'queued-1',
            content: '你叫什么',
            status: 'failed',
            error: '发送失败',
            createdAt: '2026-05-29T00:01:00.000Z',
          },
        ]}
      />
    )

    expect(screen.getByTestId('desktop-chat-scroll-sticky-footer')).toHaveClass(
      'sticky',
      'bottom-0'
    )
    expect(screen.getByTestId('desktop-chat-scroll')).not.toHaveClass(
      'pb-[var(--desktop-floating-composer-clearance)]'
    )
  })
})
