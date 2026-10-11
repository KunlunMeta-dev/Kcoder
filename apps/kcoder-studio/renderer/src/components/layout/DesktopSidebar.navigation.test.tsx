import '@/i18n'
import { openLocalWorkspace } from '@/lib/local-terminal'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { enableTauri, renderSidebar } from './sidebar/DesktopSidebar.test-support'
const experimentalFeatures = vi.hoisted(() => ({ enabled: true }))
vi.mock('@/features/experimental-features/useExperimentalFeaturesEnabled', () => ({
  useExperimentalFeaturesEnabled: () => experimentalFeatures.enabled,
}))
vi.mock('@/lib/local-terminal', () => ({
  openLocalWorkspace: vi.fn(),
}))
describe('DesktopSidebar navigation', () => {
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
  test('keeps reserved section header actions pointer-targetable before hover settles', () => {
    renderSidebar()

    const actions = screen.getByTestId('projects-section-toggle-actions')

    expect(actions).toHaveClass(
      'absolute',
      'right-2.5',
      'z-[70]',
      'pointer-events-auto',
      'opacity-0'
    )
    expect(screen.getByTestId('projects-section-toggle')).toHaveClass('pr-16')
    expect(screen.getByTestId('projects-create-button')).toBeInTheDocument()
  })

  test('portal quit confirmation stays open while its buttons receive pointer events', async () => {
    const windowAction = vi.fn().mockResolvedValue(undefined)
    Object.assign(window, {
      kcoderDesktopHost: { windowAction, setTaskActivity: vi.fn().mockResolvedValue(undefined) },
    })
    renderSidebar()
    await userEvent.click(screen.getByTestId('settings-button'))
    await userEvent.click(screen.getByTestId('quit-app-menu-button'))
    const dialog = screen.getByTestId('quit-app-dialog')
    expect(screen.getByTestId('settings-menu')).not.toContainElement(dialog)
    await userEvent.click(screen.getByTestId('quit-app-dialog-close'))
    expect(windowAction).not.toHaveBeenCalled()
    expect(screen.getByTestId('settings-menu')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('quit-app-menu-button'))
    await userEvent.click(screen.getByTestId('quit-app-dialog-confirm'))
    expect(windowAction).toHaveBeenCalledExactlyOnceWith('quit')
  })

  test('does not render non-chat runtime workspace groups', async () => {
    const onOpenRuntimeTask = vi.fn()

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
            workspacePath: '/tmp/spike',
            tasks: [
              {
                taskId: 'claude-1',
                workspacePath: '/tmp/spike',
                title: 'Spike runtime task',
                runtime: 'claude_code',
              },
            ],
          },
        ],
        totalTasks: 1,
      },
      onOpenRuntimeTask,
    })

    expect(screen.queryByTestId('non-chat-runtime-section')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-workspace-row-/tmp/spike')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-local-task-row-claude-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-chat-section')).toHaveTextContent('任务')
    expect(screen.getByTestId('runtime-chat-section-toggle')).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByTestId('runtime-chat-empty')).toHaveTextContent('暂无会话')

    await userEvent.click(screen.getByTestId('runtime-chat-section-toggle'))

    expect(screen.getByTestId('runtime-chat-section-toggle')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByTestId('runtime-chat-empty')).not.toBeInTheDocument()
    expect(onOpenRuntimeTask).not.toHaveBeenCalled()
  })

  test('opens runtime search from the product header', async () => {
    const onOpenSearch = vi.fn()
    renderSidebar({ onOpenSearch })

    await userEvent.click(screen.getByTestId('runtime-search-button'))

    expect(onOpenSearch).toHaveBeenCalledTimes(1)
  })

  test('keeps search in the product header and orders primary sidebar actions', () => {
    renderSidebar()

    const newChatButton = screen.getByTestId('new-chat-button')
    const searchButton = screen.getByTestId('runtime-search-button')
    const pluginsButton = screen.getByTestId('plugins-button')
    const cloudButton = screen.getByTestId('sidebar-cloud-connection-button')
    const projectsHeader = screen.getByTestId('projects-section-toggle')

    expect(searchButton.compareDocumentPosition(newChatButton)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(newChatButton.compareDocumentPosition(pluginsButton)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(pluginsButton.compareDocumentPosition(cloudButton)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(cloudButton.compareDocumentPosition(projectsHeader)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )

    const scrollContainer = screen.getByTestId('sidebar-worklists-scroll')
    expect(scrollContainer).toHaveClass('mt-0.5', 'mb-2')
    expect(scrollContainer).not.toHaveClass('my-2', 'pt-1')
    expect(searchButton.parentElement).toHaveClass('h-9', 'justify-between')
    expect(pluginsButton.parentElement).toHaveClass('space-y-0.5')
    expect(pluginsButton.parentElement).not.toHaveClass('pt-2')
  })

  test('opens plugins navigation from the desktop sidebar', async () => {
    const onOpenPlugins = vi.fn()
    renderSidebar({ onOpenPlugins })

    await userEvent.click(screen.getByTestId('plugins-button'))

    expect(onOpenPlugins).toHaveBeenCalledTimes(1)
  })

  test('opens Sites navigation from the desktop sidebar', async () => {
    const onOpenSites = vi.fn()
    renderSidebar({ onOpenSites, activeItem: 'sites' })

    expect(screen.getByTestId('sites-button')).toHaveAttribute('aria-current', 'page')
    await userEvent.click(screen.getByTestId('sites-button'))

    expect(onOpenSites).toHaveBeenCalledTimes(1)
  })

  test('shows Sites only while experimental features are enabled', async () => {
    experimentalFeatures.enabled = false
    const { unmount } = renderSidebar()

    expect(screen.queryByTestId('sites-button')).not.toBeInTheDocument()

    unmount()
    experimentalFeatures.enabled = true
    renderSidebar()

    expect(screen.getByTestId('sites-button')).toBeInTheDocument()
  })

  test('renders chat runtime tasks as conversations instead of workspace groups', async () => {
    const onOpenRuntimeTask = vi.fn()
    const chatPath = '/Users/alice/.wecode/wegent-executor/workspace/chats/2026-06-20/hi-1'

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
            workspacePath: chatPath,
            workspaceKind: 'chat',
            tasks: [
              {
                taskId: 'chat-1',
                workspacePath: chatPath,
                workspaceKind: 'chat',
                title: 'hi',
                runtime: 'codex',
              },
            ],
          },
          {
            deviceId: 'local-device',
            deviceName: 'Local Mac',
            deviceStatus: 'online',
            available: true,
            workspacePath: '/tmp/spike',
            tasks: [
              {
                taskId: 'workspace-1',
                workspacePath: '/tmp/spike',
                title: 'Spike runtime task',
                runtime: 'claude_code',
              },
            ],
          },
        ],
        totalTasks: 2,
      },
      onOpenRuntimeTask,
    })

    expect(screen.getByTestId('runtime-chat-section')).toHaveTextContent('任务')
    expect(screen.getByTestId('runtime-chat-section-toggle')).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.queryByTestId(`runtime-workspace-row-${chatPath}`)).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-row-chat-1')).toHaveTextContent('hi')
    expect(screen.queryByTestId('runtime-local-task-device-marker-chat-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-local-task-device-icon-chat-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-workspace-row-/tmp/spike')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-local-task-row-workspace-1')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('runtime-chat-section-toggle'))

    expect(screen.queryByTestId('runtime-local-task-row-chat-1')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('runtime-chat-section-toggle'))
    await userEvent.click(screen.getByTestId('runtime-local-task-row-chat-1'))

    expect(onOpenRuntimeTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      workspacePath: chatPath,
      taskId: 'chat-1',
    })
  })

  test('removes pinned chat tasks from the task section without highlighted styling', () => {
    const chatPath = '/Users/alice/Documents/Codex/2026-07-12/pinned'
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
                taskId: 'pinned-chat',
                threadId: 'pinned-thread',
                workspacePath: chatPath,
                workspaceKind: 'chat',
                title: 'Pinned chat task',
                runtime: 'codex',
                pinned: true,
                pinnedOrder: 0,
              },
            ],
          },
        ],
        totalTasks: 1,
      },
    })

    const pinnedRow = screen.getByTestId('runtime-local-task-row-pinned-chat')
    expect(screen.getByTestId('sidebar-pinned-section')).toContainElement(pinnedRow)
    expect(screen.getByTestId('runtime-chat-section')).not.toContainElement(pinnedRow)
    expect(screen.getByTestId('runtime-chat-empty')).toBeInTheDocument()
    expect(pinnedRow.className).not.toContain('color-sidebar-marked')
  })

  test('moves a chat task to the pinned section before the pin request finishes', async () => {
    let resolvePinRequest: (() => void) | undefined
    const onSetRuntimeTaskPinned = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolvePinRequest = resolve
        })
    )
    const chatPath = '/Users/alice/Documents/Codex/2026-07-12/optimistic-pin'
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
                taskId: 'optimistic-chat',
                threadId: 'optimistic-thread',
                workspacePath: chatPath,
                workspaceKind: 'chat',
                title: 'Optimistic pinned task',
                runtime: 'codex',
              },
            ],
          },
        ],
        totalTasks: 1,
      },
      onSetRuntimeTaskPinned,
    })

    await userEvent.click(screen.getByTestId('runtime-local-task-mark-optimistic-chat'))

    await waitFor(() => {
      const pinnedRow = screen.getByTestId('runtime-local-task-row-optimistic-chat')
      expect(screen.getByTestId('sidebar-pinned-section')).toContainElement(pinnedRow)
      expect(screen.getByTestId('runtime-chat-section')).not.toContainElement(pinnedRow)
      expect(pinnedRow.className).not.toContain('color-sidebar-marked')
    })
    expect(onSetRuntimeTaskPinned).toHaveBeenCalledWith({
      deviceId: 'local-device',
      threadId: 'optimistic-thread',
      pinned: true,
    })

    await act(async () => resolvePinRequest?.())
  })

  test('exposes pointer and keyboard sorting affordances in the task section', () => {
    const onReorderRuntimeProjectTasks = vi.fn().mockResolvedValue(undefined)
    const chatPath = '/Users/alice/Documents/Codex/2026-07-12/manual'
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
                taskId: 'chat-1',
                threadId: 'thread-1',
                workspacePath: chatPath,
                workspaceKind: 'chat',
                title: 'First chat',
                runtime: 'codex',
              },
              {
                taskId: 'chat-2',
                threadId: 'thread-2',
                workspacePath: chatPath,
                workspaceKind: 'chat',
                title: 'Second chat',
                runtime: 'codex',
              },
            ],
          },
        ],
        totalTasks: 2,
      },
      onReorderRuntimeProjectTasks,
    })

    const firstSortable = document.querySelector(
      '[data-sidebar-sortable-id="local-device:thread-1"]'
    ) as HTMLElement
    const secondSortable = document.querySelector(
      '[data-sidebar-sortable-id="local-device:thread-2"]'
    ) as HTMLElement
    expect(screen.getByTestId('runtime-chat-task-sortable-list')).toContainElement(firstSortable)
    expect(firstSortable).toHaveAttribute('tabindex', '0')
    expect(firstSortable).toHaveAttribute('role', 'button')
    expect(firstSortable).toHaveClass('touch-none')
    expect(secondSortable).toHaveAttribute('tabindex', '0')
  })

  test('refreshes relative runtime task time while the sidebar stays mounted', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-03T12:01:00.000Z'))

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
            workspacePath: '/workspace/chats/chat-time',
            workspaceKind: 'chat',
            tasks: [
              {
                taskId: 'chat-time',
                workspacePath: '/workspace/chats/chat-time',
                workspaceKind: 'chat',
                title: 'Time sensitive chat',
                runtime: 'codex',
                updatedAt: '2026-07-03T12:00:00.000Z',
              },
            ],
          },
        ],
        totalTasks: 1,
      },
    })

    expect(screen.getByTestId('runtime-local-task-time-chat-time')).toHaveTextContent('1m')

    act(() => {
      vi.advanceTimersByTime(60_000)
    })

    expect(screen.getByTestId('runtime-local-task-time-chat-time')).toHaveTextContent('2m')
  })

  test('renders Codex-pinned runtime tasks in the pinned section', async () => {
    const user = userEvent.setup()

    renderSidebar({
      runtimeWork: {
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
                  {
                    taskId: 'old-task',
                    threadId: 'old-thread',
                    pinned: true,
                    workspacePath: '/repo/Wegent',
                    title: 'Old task',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T00:00:00Z',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 3,
      },
    })

    await user.click(screen.getByTestId('project-item-button'))

    const rowTestIds = () =>
      screen.getAllByTestId(/^runtime-local-task-row-/).map(row => row.getAttribute('data-testid'))

    expect(rowTestIds()).toEqual([
      'runtime-local-task-row-old-task',
      'runtime-local-task-row-new-task',
      'runtime-local-task-row-middle-task',
    ])
    expect(screen.getByTestId('sidebar-pinned-section')).toContainElement(
      screen.getByTestId('runtime-local-task-row-old-task')
    )
  })

  test('shows a subscribed runtime task notification toggle outside hover actions', async () => {
    const user = userEvent.setup()
    const onToggleRuntimeTaskNotification = vi.fn()
    const onOpenRuntimeTask = vi.fn()

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
      imNotificationSettings: {
        global: {
          enabled: true,
          sessionKey: 'session-telegram',
          session: null,
        },
        runtimeTaskSubscriptions: [
          {
            address: {
              deviceId: 'local-device',
              workspacePath: '/repo/Wegent',
              taskId: 'codex-1',
            },
            sessionKeys: ['session-telegram'],
          },
        ],
      },
      onOpenRuntimeTask,
      onToggleRuntimeTaskNotification,
    })

    await user.click(screen.getByTestId('project-item-button'))

    const toggle = screen.getByTestId('runtime-local-task-notify-codex-1')
    const hoverActions = screen.getByTestId('runtime-local-task-hover-actions-codex-1')

    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(hoverActions).not.toContainElement(toggle)
    expect(screen.getByTestId('runtime-local-task-notify-icon-codex-1')).toHaveClass('fill-current')

    await user.click(toggle)

    expect(onToggleRuntimeTaskNotification).toHaveBeenCalledWith(
      {
        deviceId: 'local-device',
        workspacePath: '/repo/Wegent',
        taskId: 'codex-1',
      },
      true
    )
    expect(onOpenRuntimeTask).not.toHaveBeenCalled()
  })
})
