import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import '@/i18n'
import { openLocalWorkspace } from '@/lib/local-terminal'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DesktopSidebar } from './DesktopSidebar'
import {
  createSidebarProps,
  enableTauri,
  renderSidebar,
} from './sidebar/DesktopSidebar.test-support'
const experimentalFeatures = vi.hoisted(() => ({ enabled: true }))
vi.mock('@/features/experimental-features/useExperimentalFeaturesEnabled', () => ({
  useExperimentalFeaturesEnabled: () => experimentalFeatures.enabled,
}))
vi.mock('@/lib/local-terminal', () => ({
  openLocalWorkspace: vi.fn(),
}))
describe('DesktopSidebar task-state', () => {
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
  test('refreshing task metadata does not scroll the selected conversation again', () => {
    const workspacePath = '/workspace/stable'
    const props = createSidebarProps({
      currentRuntimeTask: { deviceId: 'local-device', taskId: 'stable-a', workspacePath },
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'project-7', name: 'Stable' },
            deviceWorkspaces: [
              {
                deviceId: 'local-device',
                workspacePath,
                available: true,
                tasks: ['a', 'b'].map(id => ({
                  taskId: `stable-${id}`,
                  threadId: id,
                  workspacePath,
                  title: id,
                  runtime: 'kcoder',
                  running: false,
                })),
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 2,
      },
    })
    const store = new RuntimeTaskLifecycleStore('sidebar-stability')
    const tree = (next: typeof props) => (
      <RuntimeTaskLifecycleProvider store={store}>
        <DesktopSidebar {...next} />
      </RuntimeTaskLifecycleProvider>
    )
    const view = render(tree(props))
    expect(screen.getByTestId('runtime-local-task-row-stable-a')).toBeInTheDocument()
    const scroll = vi.mocked(Element.prototype.scrollIntoView)
    scroll.mockClear()
    const refreshed = {
      ...props,
      currentRuntimeTask: { ...props.currentRuntimeTask! },
      runtimeWork: {
        ...props.runtimeWork!,
        projects: props.runtimeWork!.projects.map(project => ({
          ...project,
          deviceWorkspaces: project.deviceWorkspaces.map(workspace => ({
            ...workspace,
            tasks: workspace.tasks.map(task => ({ ...task, updatedAt: Date.now() })),
          })),
        })),
      },
    }
    view.rerender(tree(refreshed))
    expect(scroll).not.toHaveBeenCalled()
    view.rerender(
      tree({
        ...refreshed,
        currentRuntimeTask: { ...refreshed.currentRuntimeTask, taskId: 'stable-b' },
      })
    )
    expect(scroll).toHaveBeenCalled()
  })

  test('shows project, repository, path, timestamps, and status in task hover cards', async () => {
    vi.useFakeTimers()
    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'project-7', name: 'Wegent' },
            deviceWorkspaces: [
              {
                deviceId: 'local-device',
                available: true,
                workspacePath: '/Users/alice/repo/Wegent',
                repoUrl: 'https://github.com/wecode-ai/Wegent.git',
                tasks: [
                  {
                    taskId: 'hover-task',
                    workspacePath: '/Users/alice/repo/Wegent',
                    title: 'Hover details',
                    runtime: 'codex',
                    createdAt: '2026-07-12T00:00:00Z',
                    updatedAt: '2026-07-12T00:30:00Z',
                    status: 'waiting_for_user_input',
                    gitInfo: {
                      branch: 'codex/hover-details',
                      currentBranch: 'main',
                    },
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

    fireEvent.click(screen.getByTestId('project-item-button'))
    const taskRow = screen.getByTestId('runtime-local-task-row-hover-task')
    expect(taskRow.querySelector('span')).not.toHaveAttribute('title')
    fireEvent.mouseEnter(taskRow)
    await act(async () => vi.advanceTimersByTime(450))

    const content = screen.getByTestId('runtime-local-task-hover-content-hover-task')
    expect(content).toHaveTextContent('Hover details')
    expect(content).toHaveTextContent('Wegent')
    expect(content).toHaveTextContent('wecode-ai/Wegent')
    expect(content).toHaveTextContent('codex/hover-details')
    expect(content).toHaveTextContent('任务分支会反映上次使用时的活动分支；发送消息会更新任务分支')
    expect(content).not.toHaveTextContent('~/repo/Wegent')
    expect(content).not.toHaveTextContent('创建时间')
    expect(content).not.toHaveTextContent('done')
    expect(content).not.toHaveTextContent('local-device /Users/alice/repo/Wegent')

    fireEvent.mouseLeave(taskRow)
    fireEvent.pointerMove(content)
    await act(async () => vi.advanceTimersByTime(120))
    expect(content).toBeInTheDocument()

    fireEvent.pointerMove(document.body)
    await act(async () => vi.advanceTimersByTime(60))
    fireEvent.pointerMove(document.body)
    await act(async () => vi.advanceTimersByTime(60))
    expect(
      screen.queryByTestId('runtime-local-task-hover-content-hover-task')
    ).not.toBeInTheDocument()
  })

  test('shows running status on running runtime tasks only', async () => {
    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
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
                    taskId: 'codex-running',
                    workspacePath: '/repo/Wegent',
                    title: 'Investigate stream',
                    runtime: 'codex',
                    running: true,
                    updatedAt: '2026-06-20T03:00:00Z',
                  },
                  {
                    taskId: 'codex-idle',
                    workspacePath: '/repo/Wegent',
                    title: 'Finished fix',
                    runtime: 'codex',
                    running: false,
                    updatedAt: '2026-06-20T02:00:00Z',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 2,
      },
    })

    await userEvent.click(screen.getByTestId('project-item-button'))

    const runningStatus = screen.getByTestId('runtime-local-task-running-codex-running')
    expect(runningStatus).toHaveAttribute('aria-label', '运行中')
    expect(runningStatus).toHaveTextContent('运行中')
    expect(runningStatus.querySelector('svg')).not.toBeNull()
    expect(screen.queryByTestId('runtime-local-task-running-codex-idle')).not.toBeInTheDocument()
  })

  test('shows unread dot from shared runtime task reminder state', async () => {
    const onOpenRuntimeTask = vi.fn()
    const onMarkRuntimeTaskRead = vi.fn()
    const completedRuntimeWork = {
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
                  taskId: 'codex-background',
                  workspacePath: '/repo/Wegent',
                  title: 'Background task',
                  runtime: 'codex' as const,
                  running: false,
                  updatedAt: '2026-06-20T03:00:00Z',
                },
              ],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 1,
    }

    renderSidebar({
      runtimeWork: completedRuntimeWork,
      onOpenRuntimeTask,
      onMarkRuntimeTaskRead,
      unreadRuntimeTaskKeys: new Set(['local-device\0codex-background']),
    })

    await userEvent.click(screen.getByTestId('project-item-button'))

    const unreadDot = screen.getByTestId('runtime-local-task-unread-dot-codex-background')
    expect(unreadDot).toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-time-codex-background')).toContainElement(
      unreadDot
    )

    await userEvent.click(screen.getByTestId('runtime-local-task-row-codex-background'))

    expect(onOpenRuntimeTask).toHaveBeenCalledTimes(1)
    expect(onMarkRuntimeTaskRead).toHaveBeenCalledTimes(1)
  })

  test('shows a failed draft error and removes it immediately even when the target is unavailable', async () => {
    const onArchiveRuntimeTask = vi.fn().mockResolvedValue({ status: 'archived' })
    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'project-7', name: 'KCoder' },
            totalTasks: 1,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'failed-target',
                deviceName: 'Unavailable target',
                deviceStatus: 'offline',
                available: false,
                workspacePath: '/fixture/work',
                tasks: [
                  {
                    taskId: 'runtime-failed-draft',
                    title: 'Failed launch',
                    workspacePath: '/fixture/work',
                    runtime: 'kcoder',
                    optimistic: true,
                    status: 'failed',
                    running: false,
                    error: 'Fixture app-server could not start',
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
    await userEvent.click(screen.getByTestId('project-item-button'))
    expect(
      screen.getByTestId('runtime-task-creation-error-runtime-failed-draft')
    ).toHaveTextContent('Fixture app-server could not start')
    const remove = screen.getByTestId('runtime-local-task-archive-runtime-failed-draft')
    expect(remove).toBeEnabled()
    expect(remove).toHaveAccessibleName('移除失败任务')
    await userEvent.click(remove)
    expect(onArchiveRuntimeTask).toHaveBeenCalledOnce()
    expect(onArchiveRuntimeTask).toHaveBeenCalledWith({
      deviceId: 'failed-target',
      workspacePath: '/fixture/work',
      taskId: 'runtime-failed-draft',
    })
    expect(
      screen.queryByTestId('runtime-local-task-archive-toast-runtime-failed-draft')
    ).not.toBeInTheDocument()
  })

  test('does not treat a failed real backend task as a removable local draft', async () => {
    const archive = vi.fn()
    const sidebar = renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'project-7', name: 'KCoder' },
            totalTasks: 1,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local',
                deviceName: 'Local',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/fixture/work',
                tasks: [
                  {
                    taskId: 'kcoder:local:real-thread',
                    title: 'Failed real thread',
                    runtime: 'kcoder',
                    workspacePath: '/fixture/work',
                    optimistic: true,
                    status: 'failed',
                    running: false,
                    error: 'Real task failed',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 1,
      },
      onArchiveRuntimeTask: archive,
    })
    await userEvent.click(screen.getByTestId('project-item-button'))
    const button = screen.getByTestId('runtime-local-task-archive-kcoder:local:real-thread')
    expect(button).toHaveAccessibleName('归档任务')
    await userEvent.click(button)
    expect(archive).not.toHaveBeenCalled()
    expect(
      screen.getByTestId('runtime-local-task-archive-toast-kcoder:local:real-thread')
    ).toBeVisible()
    await userEvent.click(
      screen.getByTestId('runtime-local-task-archive-undo-kcoder:local:real-thread')
    )
    sidebar.unmount()
    expect(archive).not.toHaveBeenCalled()
  })
})
