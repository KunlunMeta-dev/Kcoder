import '@/i18n'
import { openLocalWorkspace } from '@/lib/local-terminal'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { enableTauri, localDevice, renderSidebar } from './sidebar/DesktopSidebar.test-support'
const experimentalFeatures = vi.hoisted(() => ({ enabled: true }))
vi.mock('@/features/experimental-features/useExperimentalFeaturesEnabled', () => ({
  useExperimentalFeaturesEnabled: () => experimentalFeatures.enabled,
}))
vi.mock('@/lib/local-terminal', () => ({
  openLocalWorkspace: vi.fn(),
}))
describe('DesktopSidebar menus', () => {
  beforeEach(() => {
    experimentalFeatures.enabled = true
    localStorage.clear()
    enableTauri()
    Element.prototype.scrollIntoView = vi.fn()
    vi.mocked(openLocalWorkspace).mockReset()
  })
  afterEach(() => {
    delete (window as Window & { kcoderDesktopHost?: unknown }).kcoderDesktopHost
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })
  test('uses the project action model for right click and global-state pinning', async () => {
    const onSetRuntimeProjectPinned = vi.fn().mockResolvedValue(undefined)
    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: {
              id: 7,
              key: 'project-7',
              name: 'Wegent',
              stateDeviceId: 'local-device',
              pinned: false,
            },
            totalTasks: 0,
            deviceWorkspaces: [],
          },
        ],
        chats: [],
        totalTasks: 0,
      },
      onSetRuntimeProjectPinned,
    })

    fireEvent.contextMenu(screen.getByTestId('project-row-7'), {
      clientX: 120,
      clientY: 80,
    })

    expect(await screen.findByTestId('project-menu-7-menu')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('pin-project-7'))
    expect(onSetRuntimeProjectPinned).toHaveBeenCalledWith({
      deviceId: 'local-device',
      projectKey: 'project-7',
      pinned: true,
    })
  })

  test.each(['project', 'task'] as const)(
    'shows %s pin failures and prevents duplicate requests while pending',
    async kind => {
      let rejectPin!: (error: Error) => void
      const pin = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectPin = reject
            })
        )
        .mockResolvedValue(undefined)
      renderSidebar({
        runtimeWork: {
          projects: [
            {
              project: {
                id: 7,
                key: 'project-7',
                name: 'KCoder',
                stateDeviceId: 'local-device',
                pinned: false,
              },
              totalTasks: 1,
              deviceWorkspaces: [
                {
                  id: 91,
                  deviceId: 'local-device',
                  deviceName: 'Local',
                  deviceStatus: 'online',
                  available: true,
                  workspacePath: '/repo/KCoder',
                  tasks: [
                    {
                      taskId: 'pin-task',
                      threadId: 'pin-thread',
                      title: 'Pin fixture',
                      runtime: 'kcoder',
                      workspacePath: '/repo/KCoder',
                    },
                  ],
                },
              ],
            },
          ],
          chats: [],
          totalTasks: 1,
        },
        onSetRuntimeProjectPinned: pin,
        onSetRuntimeTaskPinned: pin,
      })
      const clickPin = async () => {
        if (kind === 'project') {
          fireEvent.contextMenu(screen.getByTestId('project-row-7'), { clientX: 120, clientY: 80 })
          await userEvent.click(await screen.findByTestId('pin-project-7'))
        } else {
          await userEvent.click(screen.getByTestId('runtime-local-task-mark-pin-task'))
        }
      }
      if (kind === 'task') await userEvent.click(screen.getByTestId('project-item-button'))
      await clickPin()
      if (kind === 'project') {
        fireEvent.contextMenu(screen.getByTestId('project-row-7'), { clientX: 120, clientY: 80 })
        expect(await screen.findByTestId('pin-project-7')).toBeDisabled()
        await userEvent.keyboard('{Escape}')
      } else {
        expect(screen.getByTestId('runtime-local-task-mark-pin-task')).toBeDisabled()
      }
      await act(async () => {
        rejectPin(new Error('workspace state is busy'))
        await Promise.resolve()
      })
      const errorId =
        kind === 'project' ? 'project-pin-error-7' : 'runtime-local-task-pin-error-pin-task'
      expect(screen.getByTestId(errorId)).toHaveTextContent('workspace state is busy')
      await clickPin()
      expect(screen.queryByTestId(errorId)).not.toBeInTheDocument()
      expect(pin).toHaveBeenCalledTimes(2)
    }
  )

  test('returns a chat task to the task section when pinning fails', async () => {
    const onSetRuntimeTaskPinned = vi.fn().mockRejectedValue(new Error('pin failed'))
    const chatPath = '/Users/alice/Documents/Codex/2026-07-12/pin-failure'
    renderSidebar({
      runtimeWork: {
        projects: [],
        chats: [
          {
            deviceId: 'local-device',
            available: true,
            workspacePath: chatPath,
            workspaceKind: 'chat',
            tasks: [
              {
                taskId: 'failed-pin-chat',
                threadId: 'failed-pin-thread',
                workspacePath: chatPath,
                workspaceKind: 'chat',
                title: 'Failed pinned task',
                runtime: 'codex',
              },
            ],
          },
        ],
        totalTasks: 1,
      },
      onSetRuntimeTaskPinned,
    })

    await userEvent.click(screen.getByTestId('runtime-local-task-mark-failed-pin-chat'))

    await waitFor(() => {
      const taskRow = screen.getByTestId('runtime-local-task-row-failed-pin-chat')
      expect(screen.getByTestId('runtime-chat-section')).toContainElement(taskRow)
      expect(screen.queryByTestId('sidebar-pinned-section')).not.toBeInTheDocument()
    })
  })

  test('renames a runtime conversation from double click dialog', async () => {
    const user = userEvent.setup()
    const onOpenRuntimeTask = vi.fn()
    const onRenameRuntimeTask = vi.fn().mockResolvedValue(undefined)

    renderSidebar({
      projects: [],
      runtimeWork: {
        projects: [],
        chats: [
          {
            deviceId: 'local-device',
            deviceName: 'Local Mac',
            deviceStatus: 'online',
            available: true,
            workspacePath: '/workspace/chats/chat-rename',
            workspaceKind: 'chat',
            tasks: [
              {
                taskId: 'codex-rename',
                workspacePath: '/workspace/chats/chat-rename',
                workspaceKind: 'chat',
                title: '对齐需求核心点',
                runtime: 'codex',
              },
            ],
          },
        ],
        totalTasks: 1,
      },
      onOpenRuntimeTask,
      onRenameRuntimeTask,
    })

    await user.dblClick(screen.getByTestId('runtime-local-task-row-codex-rename'))

    expect(screen.getByTestId('rename-runtime-local-task-input-codex-rename')).toHaveValue(
      '对齐需求核心点'
    )
    expect(screen.getByText('保持简短且易于识别')).toBeInTheDocument()

    await user.clear(screen.getByTestId('rename-runtime-local-task-input-codex-rename'))
    await user.type(screen.getByTestId('rename-runtime-local-task-input-codex-rename'), '对齐方案')
    await user.click(screen.getByTestId('confirm-rename-runtime-local-task-codex-rename'))

    await waitFor(() => {
      expect(onRenameRuntimeTask).toHaveBeenCalledWith(
        {
          deviceId: 'local-device',
          workspacePath: '/workspace/chats/chat-rename',
          taskId: 'codex-rename',
        },
        '对齐方案'
      )
    })
  })

  test('optimistically archives project runtime tasks with an undo notice', async () => {
    const user = userEvent.setup()
    const onArchiveRuntimeTask = vi.fn().mockResolvedValue(undefined)
    const originalSetTimeout = window.setTimeout
    const originalClearTimeout = window.clearTimeout
    const archiveTimerId = 3000
    let archiveTimerCallback: (() => void) | null = null
    const setTimeoutSpy = vi
      .spyOn(window, 'setTimeout')
      .mockImplementation((handler: TimerHandler, timeout?: number) => {
        if (timeout === archiveTimerId && typeof handler === 'function') {
          archiveTimerCallback = handler
          return archiveTimerId
        }
        return originalSetTimeout(handler, timeout)
      })
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout').mockImplementation((id?: number) => {
      if (id === archiveTimerId) {
        archiveTimerCallback = null
        return
      }
      originalClearTimeout(id)
    })

    try {
      const sidebar = renderSidebar({
        runtimeWork: {
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              totalTasks: 1,
              deviceWorkspaces: [
                {
                  id: 91,
                  deviceId: 'local-device',
                  deviceName: 'Local Mac',
                  deviceStatus: 'online',
                  available: true,
                  workspacePath: '/repo/Wegent',
                  tasks: [
                    {
                      taskId: 'codex-1',
                      workspacePath: '/repo/Wegent',
                      title: 'Fix reconnect',
                      runtime: 'codex',
                      updatedAt: '2026-06-20T02:00:00Z',
                    },
                  ],
                },
              ],
            },
          ],
          chats: [],
          totalTasks: 1,
        },
        onArchiveRuntimeTask,
      })

      await user.click(screen.getByTestId('project-item-button'))
      const taskRow = screen.getByTestId('runtime-local-task-row-codex-1')
      const rowChildren = Array.from(taskRow.children)

      expect(screen.getByTestId('runtime-local-task-mark-codex-1')).toBeInTheDocument()
      expect(screen.getByTestId('runtime-local-task-archive-codex-1')).toBeInTheDocument()
      expect(rowChildren).toHaveLength(2)
      expect(rowChildren[1]).toHaveAttribute('data-testid', 'runtime-local-task-trailing-codex-1')
      expect(screen.getByTestId('runtime-local-task-time-codex-1').parentElement).toBe(
        rowChildren[1]
      )
      expect(
        screen.queryByTestId('runtime-local-task-device-marker-codex-1')
      ).not.toBeInTheDocument()
      expect(screen.getByTestId('runtime-local-task-hover-actions-codex-1').parentElement).toBe(
        rowChildren[1]
      )
      expect(screen.getByTestId('runtime-local-task-pin-icon-codex-1')).toBeInTheDocument()
      expect(screen.getByTestId('runtime-local-task-archive-icon-codex-1')).toBeInTheDocument()
      expect(screen.getByTestId('runtime-local-task-hover-actions-codex-1')).toHaveClass(
        'z-[70]',
        'hover:pointer-events-auto',
        'focus-within:pointer-events-auto'
      )
      expect(screen.getByTestId('runtime-local-task-time-codex-1').className).not.toContain(
        'focus-within'
      )

      expect(taskRow).not.toHaveAttribute('data-marked')
      expect(taskRow.className).not.toContain('color-sidebar-marked')

      await user.click(screen.getByTestId('runtime-local-task-archive-codex-1'))

      expect(onArchiveRuntimeTask).not.toHaveBeenCalled()
      expect(taskRow).toHaveClass('hidden')
      expect(screen.getByTestId('runtime-local-task-archive-toast-codex-1')).toHaveTextContent(
        '撤销'
      )

      await user.click(screen.getByTestId('runtime-local-task-archive-undo-codex-1'))

      expect(onArchiveRuntimeTask).not.toHaveBeenCalled()
      expect(taskRow).not.toHaveClass('hidden')
      expect(archiveTimerCallback).toBeNull()

      await user.click(screen.getByTestId('runtime-local-task-archive-codex-1'))
      const runArchiveTimer = archiveTimerCallback
      await act(async () => {
        runArchiveTimer?.()
        await Promise.resolve()
      })

      await waitFor(() =>
        expect(onArchiveRuntimeTask).toHaveBeenCalledWith({
          deviceId: 'local-device',
          workspacePath: '/repo/Wegent',
          taskId: 'codex-1',
        })
      )

      await user.click(screen.getByTestId('runtime-local-task-archive-codex-1'))
      expect(onArchiveRuntimeTask).toHaveBeenCalledTimes(1)
      sidebar.unmount()
      await waitFor(() =>
        expect(onArchiveRuntimeTask).toHaveBeenNthCalledWith(2, {
          deviceId: 'local-device',
          workspacePath: '/repo/Wegent',
          taskId: 'codex-1',
        })
      )
    } finally {
      setTimeoutSpy.mockRestore()
      clearTimeoutSpy.mockRestore()
    }
  })

  test.each(['response', 'exception'] as const)(
    'shows an archive %s failure beside the restored task and allows retry',
    async failure => {
      const user = userEvent.setup()
      const message = '任务运行中，暂时无法归档'
      const onArchiveRuntimeTask = vi.fn().mockResolvedValue({ status: 'archived' })
      if (failure === 'response')
        onArchiveRuntimeTask.mockResolvedValueOnce({ status: 'failed', error: message })
      else onArchiveRuntimeTask.mockRejectedValueOnce(new Error(message))
      let runTimer: (() => void) | undefined
      const originalSetTimeout = window.setTimeout
      const timer = vi.spyOn(window, 'setTimeout').mockImplementation((handler, delay) => {
        if (delay === 3000 && typeof handler === 'function') {
          runTimer = handler
          return 3000
        }
        return originalSetTimeout(handler, delay)
      })
      try {
        renderSidebar({
          runtimeWork: {
            projects: [
              {
                project: { id: 7, name: 'KCoder' },
                totalTasks: 1,
                deviceWorkspaces: [
                  {
                    id: 91,
                    deviceId: 'local-device',
                    deviceName: 'Local',
                    deviceStatus: 'online',
                    available: true,
                    workspacePath: '/repo/KCoder',
                    tasks: [
                      {
                        taskId: 'archive-failure',
                        workspacePath: '/repo/KCoder',
                        title: 'Retry archive',
                        runtime: 'kcoder',
                      },
                    ],
                  },
                ],
              },
            ],
            chats: [],
            totalTasks: 1,
          },
          onArchiveRuntimeTask,
        })
        await user.click(screen.getByTestId('project-item-button'))
        const button = screen.getByTestId('runtime-local-task-archive-archive-failure')
        await user.click(button)
        await act(async () => {
          runTimer?.()
          await Promise.resolve()
        })
        expect(
          screen.getByTestId('runtime-local-task-archive-error-archive-failure')
        ).toHaveTextContent(message)
        expect(screen.getByTestId('runtime-local-task-row-archive-failure')).not.toHaveClass(
          'hidden'
        )
        expect(button).toBeEnabled()
        await user.click(button)
        expect(
          screen.queryByTestId('runtime-local-task-archive-error-archive-failure')
        ).not.toBeInTheDocument()
        await act(async () => {
          runTimer?.()
          await Promise.resolve()
        })
        expect(onArchiveRuntimeTask).toHaveBeenCalledTimes(2)
      } finally {
        timer.mockRestore()
      }
    }
  )

  test('offers force archive when a worktree task has uncommitted changes', async () => {
    const user = userEvent.setup()
    const onArchiveRuntimeTask = vi
      .fn()
      .mockResolvedValueOnce({ status: 'dirty_worktree' })
      .mockResolvedValueOnce({ status: 'archived' })
    const originalSetTimeout = window.setTimeout
    const archiveTimerId = 3000
    let archiveTimerCallback: (() => void) | null = null
    const setTimeoutSpy = vi
      .spyOn(window, 'setTimeout')
      .mockImplementation((handler: TimerHandler, timeout?: number) => {
        if (timeout === archiveTimerId && typeof handler === 'function') {
          archiveTimerCallback = handler
          return archiveTimerId
        }
        return originalSetTimeout(handler, timeout)
      })

    try {
      renderSidebar({
        runtimeWork: {
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              totalTasks: 1,
              deviceWorkspaces: [
                {
                  id: 91,
                  deviceId: 'local-device',
                  deviceName: 'Local Mac',
                  deviceStatus: 'online',
                  available: true,
                  workspacePath: '/repo/worktrees/9/Wegent',
                  workspaceKind: 'worktree',
                  worktreeId: '9',
                  tasks: [
                    {
                      taskId: 'codex-1',
                      workspacePath: '/repo/worktrees/9/Wegent',
                      workspaceKind: 'worktree',
                      worktreeId: '9',
                      title: 'Fix reconnect',
                      runtime: 'codex',
                      updatedAt: '2026-06-20T02:00:00Z',
                    },
                  ],
                },
              ],
            },
          ],
          chats: [],
          totalTasks: 1,
        },
        onArchiveRuntimeTask,
      })

      await user.click(screen.getByTestId('project-item-button'))
      await user.click(screen.getByTestId('runtime-local-task-archive-codex-1'))
      const runArchiveTimer = archiveTimerCallback
      await act(async () => {
        runArchiveTimer?.()
        await Promise.resolve()
      })

      const dialog = await screen.findByTestId('runtime-local-task-force-archive-dialog-codex-1')
      expect(dialog).toHaveTextContent('工作树有未提交代码')
      expect(dialog).toHaveTextContent('强制归档会删除这个工作树目录')
      expect(onArchiveRuntimeTask).toHaveBeenCalledTimes(1)
      expect(onArchiveRuntimeTask).toHaveBeenNthCalledWith(1, {
        deviceId: 'local-device',
        workspacePath: '/repo/worktrees/9/Wegent',
        taskId: 'codex-1',
      })

      await user.click(
        screen.getByTestId('runtime-local-task-force-archive-dialog-codex-1-confirm-button')
      )

      await waitFor(() => expect(onArchiveRuntimeTask).toHaveBeenCalledTimes(2))
      expect(onArchiveRuntimeTask).toHaveBeenNthCalledWith(
        2,
        {
          deviceId: 'local-device',
          workspacePath: '/repo/worktrees/9/Wegent',
          taskId: 'codex-1',
        },
        { force: true }
      )
      expect(
        screen.queryByTestId('runtime-local-task-force-archive-dialog-codex-1')
      ).not.toBeInTheDocument()
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })

  test('pins and unpins runtime tasks without opening the task', async () => {
    const user = userEvent.setup()
    const onOpenRuntimeTask = vi.fn()
    const onSetRuntimeTaskPinned = vi.fn().mockResolvedValue(undefined)

    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'project-7', name: 'Wegent', stateDeviceId: 'local-device' },
            totalTasks: 1,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                tasks: [
                  {
                    taskId: 'codex-1',
                    threadId: 'thread-1',
                    workspacePath: '/repo/Wegent',
                    title: 'Fix reconnect',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T02:00:00Z',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 1,
      },
      onOpenRuntimeTask,
      onSetRuntimeTaskPinned,
    })

    await user.click(screen.getByTestId('project-item-button'))

    const taskRow = screen.getByTestId('runtime-local-task-row-codex-1')
    const markButton = screen.getByTestId('runtime-local-task-mark-codex-1')
    const pinIcon = screen.getByTestId('runtime-local-task-pin-icon-codex-1')

    expect(taskRow).not.toHaveAttribute('data-marked')
    expect(taskRow.className).not.toContain('color-sidebar-marked')

    await user.click(markButton)

    expect(taskRow).toHaveAttribute('data-marked', 'true')
    expect(taskRow.className).not.toContain('color-sidebar-marked')
    expect(pinIcon).toHaveClass('fill-current')
    expect(markButton).toHaveAttribute('aria-label', '取消置顶')
    expect(onOpenRuntimeTask).not.toHaveBeenCalled()
    expect(onSetRuntimeTaskPinned).toHaveBeenLastCalledWith({
      deviceId: 'local-device',
      threadId: 'thread-1',
      pinned: true,
    })

    await user.click(markButton)

    expect(taskRow).not.toHaveAttribute('data-marked')
    expect(taskRow.className).not.toContain('color-sidebar-marked')
    expect(pinIcon).not.toHaveClass('fill-current')
    expect(markButton).toHaveAttribute('aria-label', '置顶任务')
    expect(onSetRuntimeTaskPinned).toHaveBeenLastCalledWith({
      deviceId: 'local-device',
      threadId: 'thread-1',
      pinned: false,
    })
  })

  test('pins Codex tasks that only expose the thread id as taskId', async () => {
    const onSetRuntimeTaskPinned = vi.fn().mockResolvedValue(undefined)
    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'project-7', name: 'Wegent' },
            totalTasks: 1,
            deviceWorkspaces: [
              {
                deviceId: 'local-device',
                available: true,
                workspacePath: '/repo/Wegent',
                tasks: [
                  {
                    taskId: 'legacy-thread-id',
                    workspacePath: '/repo/Wegent',
                    title: 'Legacy Codex task',
                    runtime: 'codex',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 1,
      },
      onSetRuntimeTaskPinned,
    })

    await userEvent.click(screen.getByTestId('project-item-button'))
    const pinButton = screen.getByTestId('runtime-local-task-mark-legacy-thread-id')
    expect(pinButton).not.toBeDisabled()

    await userEvent.click(pinButton)

    expect(onSetRuntimeTaskPinned).toHaveBeenCalledWith({
      deviceId: 'local-device',
      threadId: 'legacy-thread-id',
      pinned: true,
    })
    expect(pinButton).toHaveAttribute('aria-label', '取消置顶')
  })

  test('stores runtime task pinning in Codex global state instead of localStorage', async () => {
    const user = userEvent.setup()
    const onSetRuntimeTaskPinned = vi.fn().mockResolvedValue(undefined)
    const runtimeWork = {
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          totalTasks: 3,
          deviceWorkspaces: [
            {
              id: 91,
              deviceId: 'local-device',
              deviceName: 'Local Mac',
              deviceStatus: 'online',
              available: true,
              workspacePath: '/repo/Wegent',
              tasks: [
                {
                  taskId: 'old-task',
                  threadId: 'old-thread',
                  workspacePath: '/repo/Wegent',
                  title: 'Old task',
                  runtime: 'codex',
                  updatedAt: '2026-06-20T00:00:00Z',
                },
                {
                  taskId: 'new-task',
                  workspacePath: '/repo/Wegent',
                  title: 'New task',
                  runtime: 'codex',
                  updatedAt: '2026-06-22T00:00:00Z',
                },
                {
                  taskId: 'middle-task',
                  workspacePath: '/repo/Wegent',
                  title: 'Middle task',
                  runtime: 'codex',
                  updatedAt: '2026-06-21T00:00:00Z',
                },
              ],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 3,
    }
    renderSidebar({ runtimeWork, onSetRuntimeTaskPinned })

    await user.click(screen.getByTestId('project-item-button'))
    await user.click(screen.getByTestId('runtime-local-task-mark-old-task'))

    expect(onSetRuntimeTaskPinned).toHaveBeenCalledWith({
      deviceId: 'local-device',
      threadId: 'old-thread',
      pinned: true,
    })
    expect(localStorage.getItem('wework.desktop.sidebar.pinnedRuntimeTaskKeys.7.1')).toBeNull()
  })

  test('opens centered archive confirmation dialog for project archive', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm')
    const onArchiveProjectConversations = vi.fn().mockResolvedValue(undefined)

    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'project:7', name: 'Wegent' },
            totalTasks: 2,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                tasks: [
                  {
                    taskId: 'codex-1',
                    workspacePath: '/repo/Wegent',
                    title: 'Fix reconnect',
                    runtime: 'codex',
                  },
                  {
                    taskId: 'codex-2',
                    workspacePath: '/repo/Wegent',
                    title: 'Follow up',
                    runtime: 'codex',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 2,
      },
      onArchiveProjectConversations,
    })

    await user.click(screen.getByTestId('project-menu-7'))
    await user.click(screen.getByTestId('archive-project-conversations-7'))

    const dialog = screen.getByTestId('archive-project-conversations-dialog-7')
    expect(dialog).toHaveTextContent('归档 2 个对话?')
    expect(dialog).toHaveTextContent('这会将 Wegent 中的对话归档')
    expect(confirmSpy).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('archive-project-conversations-dialog-7-confirm-button'))

    await waitFor(() => {
      expect(onArchiveProjectConversations).toHaveBeenCalledWith('project:7', undefined)
    })
    expect(confirmSpy).not.toHaveBeenCalled()

    confirmSpy.mockRestore()
  })

  test('renames a project from the project row menu', async () => {
    const user = userEvent.setup()
    const onUpdateProjectName = vi.fn().mockResolvedValue(undefined)

    renderSidebar({ onUpdateProjectName })

    await user.click(screen.getByTestId('project-menu-7'))
    await user.click(screen.getByTestId('rename-project-7'))
    await user.clear(screen.getByTestId('rename-project-input'))
    await user.type(screen.getByTestId('rename-project-input'), 'weekly-mail')
    await user.click(screen.getByTestId('confirm-rename-project-button'))

    await waitFor(() => {
      expect(onUpdateProjectName).toHaveBeenCalledWith(7, 'weekly-mail')
    })
  })

  test('keeps runtime project rename and remove actions enabled without move project action', async () => {
    const user = userEvent.setup()
    const onUpdateProjectName = vi.fn().mockResolvedValue(undefined)
    const onRemoveProject = vi.fn().mockResolvedValue(undefined)
    const confirmSpy = vi.spyOn(window, 'confirm')

    renderSidebar({
      projects: [],
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'project:7', name: 'Wegent' },
            totalTasks: 1,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                tasks: [
                  {
                    taskId: 'codex-1',
                    workspacePath: '/repo/Wegent',
                    title: 'Fix reconnect',
                    runtime: 'codex',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 1,
      },
      onUpdateProjectName,
      onRemoveProject,
    })

    await user.click(screen.getByTestId('project-menu-7'))

    expect(screen.getByTestId('rename-project-7')).not.toBeDisabled()
    expect(screen.getByTestId('remove-project-7')).not.toBeDisabled()
    expect(screen.queryByTestId('move-project-7')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('rename-project-7'))
    await user.clear(screen.getByTestId('rename-project-input'))
    await user.type(screen.getByTestId('rename-project-input'), 'weekly-mail')
    await user.click(screen.getByTestId('confirm-rename-project-button'))

    await waitFor(() => {
      expect(onUpdateProjectName).toHaveBeenCalledWith(7, 'weekly-mail')
    })

    await user.click(screen.getByTestId('project-menu-7'))
    await user.click(screen.getByTestId('remove-project-7'))

    expect(confirmSpy).not.toHaveBeenCalled()
    const dialog = screen.getByTestId('remove-project-dialog-7')
    expect(dialog).toHaveTextContent('移除 Wegent?')
    expect(dialog).toHaveTextContent('这将从 KCoder 中移除该项目。磁盘上的文件不会被删除。')
    expect(onRemoveProject).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('remove-project-dialog-7-confirm-button'))

    await waitFor(() => {
      expect(onRemoveProject).toHaveBeenCalledWith(7)
    })

    confirmSpy.mockRestore()
  })

  test('opens a local runtime project folder in Finder from the project row menu', async () => {
    const user = userEvent.setup()

    renderSidebar({
      projects: [],
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'project:7', name: 'Wegent' },
            totalTasks: 0,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/Users/alice/dev/Wegent',
                workspaceKind: 'workspace',
                workspaceSource: 'local',
                tasks: [],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 0,
      },
    })

    await user.click(screen.getByTestId('project-menu-7'))
    await user.click(screen.getByTestId('show-project-in-finder-7'))

    expect(openLocalWorkspace).toHaveBeenCalledWith({
      opener: 'finder',
      path: '/Users/alice/dev/Wegent',
    })
  })

  test('hides the Finder action for remote runtime project folders', async () => {
    const user = userEvent.setup()

    renderSidebar({
      projects: [],
      devices: [
        localDevice({
          id: 2,
          device_id: 'remote-device',
          name: 'Remote Box',
          device_type: 'remote',
        }),
      ],
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'project:7', name: 'Wegent' },
            totalTasks: 1,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'remote-device',
                deviceName: 'Remote Box',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/home/alice/Wegent',
                workspaceKind: 'workspace',
                workspaceSource: 'remote',
                tasks: [
                  {
                    taskId: 'codex-1',
                    workspacePath: '/home/alice/Wegent',
                    title: 'Remote work',
                    runtime: 'codex',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 1,
      },
    })

    await user.click(screen.getByTestId('project-menu-7'))

    expect(screen.queryByTestId('show-project-in-finder-7')).not.toBeInTheDocument()
    expect(openLocalWorkspace).not.toHaveBeenCalled()
  })
})
