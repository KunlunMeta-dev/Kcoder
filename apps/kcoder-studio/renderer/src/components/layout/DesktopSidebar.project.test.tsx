import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import '@/i18n'
import { openLocalWorkspace } from '@/lib/local-terminal'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DesktopSidebar } from './DesktopSidebar'
import {
  createSidebarProps,
  enableTauri,
  localDevice,
  renderSidebar,
} from './sidebar/DesktopSidebar.test-support'
const experimentalFeatures = vi.hoisted(() => ({ enabled: true }))
vi.mock('@/features/experimental-features/useExperimentalFeaturesEnabled', () => ({
  useExperimentalFeaturesEnabled: () => experimentalFeatures.enabled,
}))
vi.mock('@/lib/local-terminal', () => ({
  openLocalWorkspace: vi.fn(),
}))
describe('DesktopSidebar project', () => {
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
  test('keeps reserved project actions pointer-targetable before hover settles', () => {
    renderSidebar()

    const actions = screen.getByTestId('project-new-conversation-button').parentElement
    expect(actions).toHaveClass('pointer-events-auto')
    expect(actions).not.toHaveClass('pointer-events-none')
  })

  test('exposes a remote project as sortable through its local Codex state identity', () => {
    const onReorderRuntimeProjects = vi.fn().mockResolvedValue(undefined)
    renderSidebar({
      devices: [
        localDevice(),
        localDevice({
          id: 2,
          device_id: 'remote-device',
          name: 'Remote Host',
          is_default: false,
          device_type: 'remote',
        }),
      ],
      runtimeWork: {
        projects: [
          {
            project: {
              id: 7,
              key: '/repo/local',
              name: 'Local',
              stateDeviceId: 'local-device',
            },
            totalTasks: 0,
            deviceWorkspaces: [
              {
                deviceId: 'local-device',
                workspacePath: '/repo/local',
                available: true,
                tasks: [],
              },
            ],
          },
          {
            project: {
              id: 8,
              key: '/srv/remote',
              sidebarStateKey: 'remote-project-id',
              name: 'Remote',
              kind: 'remote',
              source: 'remote_project',
              stateDeviceId: 'local-device',
            },
            totalTasks: 0,
            deviceWorkspaces: [
              {
                deviceId: 'remote-device',
                remoteHostId: 'remote-device',
                workspacePath: '/srv/remote',
                workspaceSource: 'remote',
                available: true,
                tasks: [
                  {
                    taskId: 'remote-task',
                    workspacePath: '/srv/remote',
                    title: 'Remote task',
                    runtime: 'codex',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 0,
      },
      onReorderRuntimeProjects,
    })

    const remoteSortable = document.querySelector(
      '[data-sidebar-sortable-id="local-device:remote-project-id"]'
    ) as HTMLElement
    expect(remoteSortable).toHaveAttribute('tabindex', '0')
    expect(remoteSortable).toHaveAttribute('role', 'button')
    expect(remoteSortable).toHaveClass('touch-none')
  })

  test('shows an interactive project hover card', async () => {
    vi.useFakeTimers()
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
              roots: [{ kind: 'local', path: '/Users/alice/repo/Wegent' }],
            },
            totalTasks: 3,
            deviceWorkspaces: [
              {
                deviceId: 'local-device',
                available: true,
                workspacePath: '/Users/alice/repo/Wegent',
                repoUrl: 'git@github.com:wecode-ai/Wegent.git',
                tasks: [
                  {
                    taskId: 'running-task',
                    workspacePath: '/Users/alice/repo/Wegent',
                    title: 'Running task',
                    runtime: 'codex',
                    running: true,
                  },
                  {
                    taskId: 'waiting-task',
                    workspacePath: '/Users/alice/repo/Wegent',
                    title: 'Waiting task',
                    runtime: 'codex',
                    status: 'waiting_for_user_input',
                  },
                  {
                    taskId: 'unread-task',
                    workspacePath: '/Users/alice/repo/Wegent',
                    title: 'Unread task',
                    runtime: 'codex',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 3,
      },
      unreadRuntimeTaskKeys: new Set(['local-device\0unread-task']),
      onSetRuntimeProjectPinned,
    })

    const projectRow = screen.getByTestId('project-row-7')
    expect(screen.getByTestId('project-title-7')).not.toHaveAttribute('title')
    fireEvent.mouseEnter(projectRow)
    await act(async () => vi.advanceTimersByTime(450))

    const hoverCard = screen.getByTestId('project-hover-card-7')
    expect(hoverCard).toHaveAttribute('role', 'dialog')
    expect(hoverCard).toHaveClass('pointer-events-auto')
    expect(hoverCard).toHaveTextContent('Wegent')
    expect(hoverCard).toHaveTextContent('3 个任务')
    expect(hoverCard).toHaveTextContent('1 个等待中')
    expect(hoverCard).toHaveTextContent('1 个未读')
    expect(hoverCard).toHaveTextContent('1 个运行中')
    expect(hoverCard).not.toHaveTextContent('wecode-ai/Wegent')
    expect(screen.queryByTestId('project-hover-source-7-repository')).not.toBeInTheDocument()
    expect(hoverCard).toHaveTextContent('~/repo/Wegent')

    fireEvent.mouseLeave(projectRow)
    fireEvent.mouseEnter(hoverCard)
    await act(async () => vi.advanceTimersByTime(120))
    expect(screen.getByTestId('project-hover-card-7')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('project-hover-pin-7'))
    expect(onSetRuntimeProjectPinned).toHaveBeenCalledWith({
      deviceId: 'local-device',
      projectKey: 'project-7',
      pinned: true,
    })
    fireEvent.click(screen.getByTestId('project-hover-rename-7'))
    expect(screen.getByTestId('rename-project-input')).toHaveValue('Wegent')
    fireEvent.click(screen.getByTestId('rename-project-input-close-button'))

    const menuTrigger = screen.getByTestId('project-menu-7')
    fireEvent.pointerDown(menuTrigger)
    fireEvent.click(menuTrigger)

    expect(screen.queryByTestId('project-hover-card-7')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-menu-7-menu')).toBeInTheDocument()
  })

  test('renders project runtime tasks directly under projects and opens by address', async () => {
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
                label: 'Wegent local',
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
      onOpenRuntimeTask,
    })

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(screen.queryByTestId('runtime-workspace-row-91')).not.toBeInTheDocument()
    const taskRow = screen.getByTestId('runtime-local-task-row-codex-1')
    expect(taskRow).toHaveTextContent('Fix reconnect')
    expect(taskRow).not.toHaveTextContent('Codex')
    expect(screen.queryByTestId('runtime-local-task-device-marker-codex-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-local-task-device-icon-codex-1')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('runtime-local-task-row-codex-1'))

    expect(onOpenRuntimeTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      workspacePath: '/repo/Wegent',
      taskId: 'codex-1',
    })
  })

  test('expands a project without changing the center selection', async () => {
    const onSelectProject = vi.fn()

    renderSidebar({
      onSelectProject,
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
    })

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(onSelectProject).not.toHaveBeenCalled()
    expect(screen.getByTestId('runtime-local-task-row-codex-1')).toBeInTheDocument()
  })

  test('excludes pinned runtime tasks from the collapsed project task count', async () => {
    const user = userEvent.setup()

    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            totalTasks: 6,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                tasks: Array.from({ length: 6 }, (_, index) => ({
                  taskId: `task-${index + 1}`,
                  threadId: `thread-${index + 1}`,
                  pinned: index === 0,
                  workspacePath: '/repo/Wegent',
                  title: `Task ${index + 1}`,
                  runtime: 'codex',
                  updatedAt: `2026-06-2${6 - index}T00:00:00Z`,
                })),
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 6,
      },
    })

    await user.click(screen.getByTestId('project-item-button'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(6)
    expect(screen.queryByTestId('project-runtime-tasks-expand-7')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-runtime-tasks-collapse-7')).not.toBeInTheDocument()
  })

  test('edits a local multi-root project owned by a Gateway device', async () => {
    const user = userEvent.setup()
    renderSidebar({
      projects: [],
      devices: [
        localDevice(),
        localDevice({
          id: 2,
          device_id: 'gateway-server',
          name: 'Gateway Server',
          device_type: 'remote',
          is_default: false,
        }),
      ],
      runtimeWork: {
        projects: [
          {
            project: {
              id: 7,
              key: 'multi-root-project',
              name: 'Multi Root',
              source: 'local_project',
              stateDeviceId: 'gateway-server',
              roots: [
                { kind: 'local', path: '/repo/root-a' },
                { kind: 'local', path: '/repo/root-b' },
              ],
            },
            totalTasks: 0,
            deviceWorkspaces: [
              {
                deviceId: 'gateway-server',
                workspacePath: '/repo/root-a',
                available: true,
                tasks: [],
              },
              {
                deviceId: 'gateway-server',
                workspacePath: '/repo/root-b',
                available: true,
                tasks: [],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 0,
      },
      onUpdateLocalRuntimeProject: vi.fn().mockResolvedValue(undefined),
    })

    await user.click(screen.getByTestId('project-menu-7'))
    expect(screen.getByTestId('edit-project-7')).toHaveTextContent('编辑项目')
    expect(screen.queryByTestId('rename-project-7')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('edit-project-7'))

    expect(screen.getByTestId('local-project-edit-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('local-project-root-0')).toHaveTextContent('root-a')
    expect(screen.getByTestId('local-project-root-1')).toHaveTextContent('root-b')
  })

  test('creates a permanent worktree from a runtime project', async () => {
    const user = userEvent.setup()
    const onCreatePermanentWorktree = vi.fn().mockResolvedValue(undefined)

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
      onCreatePermanentWorktree,
    })

    await user.click(screen.getByTestId('project-menu-7'))
    await user.click(screen.getByTestId('create-permanent-worktree-7'))

    expect(screen.getByTestId('permanent-worktree-name-7')).toHaveValue('Wegent_2')
    await user.clear(screen.getByTestId('permanent-worktree-name-7'))
    await user.type(screen.getByTestId('permanent-worktree-name-7'), 'Wegent docs')
    await user.click(screen.getByTestId('confirm-create-permanent-worktree-7'))

    await waitFor(() => {
      expect(onCreatePermanentWorktree).toHaveBeenCalledWith({
        deviceId: 'local-device',
        sourcePath: '/Users/alice/dev/Wegent',
        name: 'Wegent docs',
      })
    })
  })

  test('shows an empty task state when a project has no runtime tasks', async () => {
    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            totalTasks: 0,
            deviceWorkspaces: [
              {
                id: 92,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                label: 'Duplicated project label should not hide the path',
                tasks: [],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 0,
      },
    })

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(screen.queryByTestId('runtime-workspace-row-92')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-local-tasks-empty-7')).toHaveTextContent('暂无会话')
  })

  test('shows managed worktree tasks directly under the source project with device marker', async () => {
    const onOpenRuntimeTask = vi.fn()

    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            totalTasks: 1,
            deviceWorkspaces: [
              {
                id: null,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/workspace/Wegent',
                tasks: [
                  {
                    taskId: 'codex-worktree',
                    workspacePath: '/workspace/worktrees/42/Wegent',
                    workspaceKind: 'worktree',
                    worktreeId: '42',
                    title: 'Fix worktree sidebar',
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
      onOpenRuntimeTask,
    })

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(screen.queryByTestId('runtime-workspace-row-/workspace/Wegent')).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-row-codex-worktree')).toHaveTextContent(
      'Fix worktree sidebar'
    )
    expect(screen.getByTestId('runtime-local-task-row-codex-worktree')).not.toHaveTextContent(
      'Codex'
    )
    expect(
      screen.getByTestId('runtime-local-task-worktree-icon-codex-worktree')
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('runtime-local-task-device-marker-codex-worktree')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('runtime-local-task-device-icon-codex-worktree')
    ).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('runtime-local-task-row-codex-worktree'))

    expect(onOpenRuntimeTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      workspacePath: '/workspace/worktrees/42/Wegent',
      taskId: 'codex-worktree',
    })
  })

  test('limits project runtime tasks to five newest rows', async () => {
    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            totalTasks: 6,
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
                    taskId: 'task-oldest',
                    workspacePath: '/repo/Wegent',
                    title: 'Oldest hidden task',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T01:00:00Z',
                  },
                  {
                    taskId: 'task-third',
                    workspacePath: '/repo/Wegent',
                    title: 'Third task',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T04:00:00Z',
                  },
                  {
                    taskId: 'task-newest',
                    workspacePath: '/repo/Wegent',
                    title: 'Newest task',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T06:00:00Z',
                  },
                  {
                    taskId: 'task-fifth',
                    workspacePath: '/repo/Wegent',
                    title: 'Fifth task',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T02:00:00Z',
                  },
                  {
                    taskId: 'task-second',
                    workspacePath: '/repo/Wegent',
                    title: 'Second task',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T05:00:00Z',
                  },
                  {
                    taskId: 'task-fourth',
                    workspacePath: '/repo/Wegent',
                    title: 'Fourth task',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T03:00:00Z',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 6,
      },
    })

    await userEvent.click(screen.getByTestId('project-item-button'))

    const collapsedRows = screen.getAllByTestId(/^runtime-local-task-row-/)
    expect(collapsedRows).toHaveLength(5)
    expect(collapsedRows.map(row => row.textContent)).toEqual([
      expect.stringContaining('Newest task'),
      expect.stringContaining('Second task'),
      expect.stringContaining('Third task'),
      expect.stringContaining('Fourth task'),
      expect.stringContaining('Fifth task'),
    ])
    expect(screen.queryByText('Oldest hidden task')).not.toBeInTheDocument()

    expect(screen.getByTestId('project-runtime-tasks-expand-7')).toHaveTextContent('展开显示')

    await userEvent.click(screen.getByTestId('project-runtime-tasks-expand-7'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(6)
    expect(screen.getByText('Fourth task')).toBeInTheDocument()
    expect(screen.getByTestId('project-runtime-tasks-collapse-7')).toHaveTextContent('折叠显示')

    await userEvent.click(screen.getByTestId('project-runtime-tasks-collapse-7'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(5)
    expect(screen.queryByText('Oldest hidden task')).not.toBeInTheDocument()
  })

  test('expands project runtime tasks by ten and collapses back to five', async () => {
    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            totalTasks: 26,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                tasks: Array.from({ length: 26 }, (_, index) => ({
                  taskId: `task-${index + 1}`,
                  workspacePath: '/repo/Wegent',
                  title: `Task ${index + 1}`,
                  runtime: 'codex',
                  updatedAt: '2026-06-20T06:00:00Z',
                })),
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 26,
      },
    })

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(5)

    await userEvent.click(screen.getByTestId('project-runtime-tasks-expand-7'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(15)
    expect(screen.getByTestId('project-runtime-tasks-expand-7')).toHaveTextContent('展开显示')
    expect(screen.queryByTestId('project-runtime-tasks-collapse-7')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('project-runtime-tasks-expand-7'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(25)
    expect(screen.getByTestId('project-runtime-tasks-expand-7')).toBeInTheDocument()
    expect(screen.queryByTestId('project-runtime-tasks-collapse-7')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('project-runtime-tasks-expand-7'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(26)
    expect(screen.queryByTestId('project-runtime-tasks-expand-7')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-runtime-tasks-collapse-7')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('project-runtime-tasks-collapse-7'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(5)
    expect(screen.getByTestId('project-runtime-tasks-expand-7')).toBeInTheDocument()
    expect(screen.queryByTestId('project-runtime-tasks-collapse-7')).not.toBeInTheDocument()
  })

  test('shows one project runtime task action after the task list grows past the current limit', async () => {
    const runtimeWorkWithTaskCount = (count: number) => ({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          totalTasks: count,
          deviceWorkspaces: [
            {
              id: 91,
              deviceId: 'local-device',
              deviceName: 'Local Mac',
              deviceStatus: 'online',
              available: true,
              workspacePath: '/repo/Wegent',
              tasks: Array.from({ length: count }, (_, index) => ({
                taskId: `task-${index + 1}`,
                workspacePath: '/repo/Wegent',
                title: `Task ${index + 1}`,
                runtime: 'codex',
                updatedAt: '2026-06-20T06:00:00Z',
              })),
            },
          ],
        },
      ],
      chats: [],
      totalTasks: count,
    })

    const initialProps = createSidebarProps({ runtimeWork: runtimeWorkWithTaskCount(6) })
    const lifecycleStore = new RuntimeTaskLifecycleStore('desktop-sidebar-growing-list-test')
    lifecycleStore.syncRuntimeWork(initialProps.runtimeWork)
    const view = render(
      <RuntimeTaskLifecycleProvider store={lifecycleStore}>
        <DesktopSidebar {...initialProps} />
      </RuntimeTaskLifecycleProvider>
    )

    await userEvent.click(screen.getByTestId('project-item-button'))
    await userEvent.click(screen.getByTestId('project-runtime-tasks-expand-7'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(6)
    expect(screen.queryByTestId('project-runtime-tasks-expand-7')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-runtime-tasks-collapse-7')).toBeInTheDocument()

    const nextProps = createSidebarProps({ runtimeWork: runtimeWorkWithTaskCount(16) })
    act(() => lifecycleStore.syncRuntimeWork(nextProps.runtimeWork))
    view.rerender(
      <RuntimeTaskLifecycleProvider store={lifecycleStore}>
        <DesktopSidebar {...nextProps} />
      </RuntimeTaskLifecycleProvider>
    )

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(6)
    expect(screen.getByTestId('project-runtime-tasks-expand-7')).toHaveTextContent('展开显示')
    expect(screen.queryByTestId('project-runtime-tasks-collapse-7')).not.toBeInTheDocument()
  })

  test('toggles a project when its sidebar row is clicked', async () => {
    const user = userEvent.setup()

    renderSidebar()

    const button = screen.getByTestId('project-item-button')
    const panel = screen.getByTestId('project-local-tasks-panel-7')

    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(panel).toHaveAttribute('aria-hidden', 'true')
    expect(panel).toHaveClass(
      'grid',
      'overflow-hidden',
      'transition-[grid-template-rows,opacity]',
      'grid-rows-[0fr]',
      'opacity-0'
    )

    await user.click(button)

    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(panel).toHaveAttribute('aria-hidden', 'false')
    expect(panel).toHaveClass('grid-rows-[1fr]', 'opacity-100')

    await user.click(button)

    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(panel).toHaveAttribute('aria-hidden', 'true')
    expect(panel).toHaveClass('grid-rows-[0fr]', 'opacity-0')
  })

  test('switches project hover affordance based on expanded state', async () => {
    const user = userEvent.setup()

    renderSidebar()

    const button = screen.getByTestId('project-item-button')
    const title = screen.getByTestId('project-title-7')
    const collapsedIndicator = screen.getByTestId('project-collapsed-hover-indicator-7')
    const expandedIndicator = screen.getByTestId('project-expanded-hover-indicator-7')

    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(title).toHaveTextContent('Wegent')
    expect(title).not.toHaveClass('group-hover/project:hidden')
    expect(title.parentElement).toHaveClass('gap-1.5')
    expect(collapsedIndicator).toHaveClass(
      'hidden',
      'group-hover/project:block',
      'group-hover/project:opacity-100',
      'group-focus-within/project:block',
      'group-focus-within/project:opacity-100'
    )
    expect(expandedIndicator).toHaveClass('hidden')

    await user.click(button)

    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('project-title-7')).not.toHaveClass('group-hover/project:hidden')
    expect(screen.getByTestId('project-collapsed-hover-indicator-7')).toHaveClass('hidden')
    expect(screen.getByTestId('project-expanded-hover-indicator-7')).toHaveClass(
      'group-hover/project:block',
      'group-focus-within/project:block'
    )
  })

  test('allows collapsing a project while one of its runtime tasks is active', async () => {
    const user = userEvent.setup()

    renderSidebar({
      currentRuntimeTask: {
        deviceId: 'local-device',
        workspacePath: '/repo/Wegent',
        taskId: 'codex-active',
      },
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
                    taskId: 'codex-active',
                    workspacePath: '/repo/Wegent',
                    title: 'Active fix',
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
    })

    const button = screen.getByTestId('project-item-button')
    const panel = screen.getByTestId('project-local-tasks-panel-7')

    await waitFor(() => expect(button).toHaveAttribute('aria-expanded', 'true'))

    expect(screen.getByTestId('runtime-local-task-row-codex-active')).toHaveClass(
      'bg-[rgb(var(--color-sidebar-active))]'
    )

    await user.click(button)

    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(panel).toHaveAttribute('aria-hidden', 'true')
    expect(panel).toHaveClass('grid-rows-[0fr]', 'opacity-0')
  })

  test('auto-expands the opened standalone runtime project', () => {
    renderSidebar({
      projects: [],
      devices: [localDevice({ device_id: 'device-1', name: 'Local Mac' })],
      standaloneDeviceId: 'device-1',
      standaloneWorkspacePath: '/Users/alice/hello 20',
      runtimeWork: {
        projects: [
          {
            project: {
              key: 'local:/Users/alice/hello 20',
              name: 'hello 20',
            },
            totalTasks: 0,
            deviceWorkspaces: [
              {
                id: null,
                projectId: null,
                deviceId: 'device-1',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/Users/alice/hello 20',
                workspaceKind: 'workspace',
                mapped: true,
                tasks: [],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 0,
      },
    })

    const button = screen.getByTestId('project-item-button')
    expect(button).toHaveTextContent('hello 20')
    expect(button).toHaveAttribute('aria-expanded', 'true')
  })
})
