import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { TaskForkDialog } from './TaskForkDialog'
import type {
  DeviceInfo,
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
} from '@/types/api'

function source(overrides: Partial<RuntimeTaskAddress> = {}): RuntimeTaskAddress {
  return {
    deviceId: 'local-1',
    workspacePath: '/workspace/current',
    taskId: 'runtime-current',
    ...overrides,
  }
}

function workspace(overrides: Partial<RuntimeDeviceWorkspace> = {}): RuntimeDeviceWorkspace {
  return {
    deviceId: 'local-1',
    deviceName: 'This Mac',
    deviceStatus: 'online',
    available: true,
    workspacePath: '/workspace/current',
    tasks: [],
    ...overrides,
  }
}

function runtimeWork(workspaces: RuntimeDeviceWorkspace[]): RuntimeWorkListResponse {
  return {
    projects: [
      {
        project: { id: 7, name: 'Project' },
        deviceWorkspaces: workspaces,
        totalTasks: workspaces.reduce(
          (total, deviceWorkspace) => total + deviceWorkspace.tasks.length,
          0
        ),
      },
    ],
    chats: [],
    totalTasks: 0,
  }
}

function device(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 1,
    device_id: 'local-1',
    name: 'This Mac',
    status: 'online',
    is_default: false,
    device_type: 'local',
    bind_shell: 'claudecode',
    executor_version: '1.8.5',
    ...overrides,
  }
}

describe('TaskForkDialog', () => {
  test.each([
    { name: 'closed', open: false, source: source() },
    { name: 'missing source', open: true, source: null },
  ])('$name dialog does not scan changing runtime directories', options => {
    let reads = 0
    const projects = runtimeWork([workspace(), workspace({ deviceId: 'local-2' })]).projects
    const work = (): RuntimeWorkListResponse => ({
      get projects() { reads++; return projects }, chats: [], totalTasks: 0,
    })
    const callbacks = { onOpenChange: vi.fn(), onFork: vi.fn(), onStopCurrentResponse: vi.fn() }
    const view = () => <TaskForkDialog {...options} {...callbacks} requiresStop={false} runtimeWork={work()} />
    const page = render(view())
    try {
      for (let index = 0; index < 40; index++) page.rerender(view())
      expect(reads).toBe(0)
      expect(screen.queryByTestId('task-fork-dialog')).not.toBeInTheDocument()
      expect(callbacks.onFork).not.toHaveBeenCalled()
      expect(callbacks.onStopCurrentResponse).not.toHaveBeenCalled()
    } finally { page.unmount() }
  })

  test('opening reads current targets and reopening starts fresh after a refused fork', async () => {
    const onFork = vi.fn().mockRejectedValueOnce(new Error('owned previous fork refused')).mockResolvedValueOnce(undefined)
    const onOpenChange = vi.fn()
    let open = false, target = 'local-2'
    const view = () => <TaskForkDialog open={open} source={source()} requiresStop={false}
      runtimeWork={runtimeWork([workspace(), workspace({ deviceId: target, deviceName: `Target ${target}` })])}
      onFork={onFork} onOpenChange={onOpenChange} onStopCurrentResponse={vi.fn()} />
    const page = render(view())
    try {
      target = 'local-3'; open = true; page.rerender(view())
      expect(screen.getByTestId('task-fork-target-local-3')).toHaveTextContent('Target local-3')
      expect(screen.queryByTestId('task-fork-target-local-2')).not.toBeInTheDocument()
      await userEvent.click(screen.getByTestId('task-fork-confirm-button'))
      expect(await screen.findByText('owned previous fork refused')).toBeInTheDocument()
      expect(onOpenChange).not.toHaveBeenCalled()
      open = false; page.rerender(view())
      target = 'local-4'; open = true; page.rerender(view())
      expect(screen.queryByText('owned previous fork refused')).not.toBeInTheDocument()
      await userEvent.click(screen.getByTestId('task-fork-confirm-button'))
      expect(onFork).toHaveBeenLastCalledWith({ deviceId: 'local-4', workspacePath: '/workspace/current' })
      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
    } finally { page.unmount() }
  })

  test('keeps a refused fork open and displays its error without a global sidebar error', async () => {
    const onOpenChange = vi.fn()
    const onFork = vi.fn().mockRejectedValue(new Error('fork response unknown; inspect original'))
    render(<TaskForkDialog open source={source()} runtimeWork={runtimeWork([
      workspace({ deviceId: 'local-2', deviceName: 'Other device' }),
    ])} requiresStop={false} onOpenChange={onOpenChange} onStopCurrentResponse={vi.fn()} onFork={onFork} />)
    await userEvent.click(screen.getByTestId('task-fork-confirm-button'))
    expect(await screen.findByText('fork response unknown; inspect original')).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  test('stops the current response before forking a running runtime task', async () => {
    const onStopCurrentResponse = vi.fn().mockResolvedValue(undefined)
    const onFork = vi.fn().mockResolvedValue(undefined)

    render(
      <TaskForkDialog
        open
        source={source()}
        runtimeWork={runtimeWork([
          workspace(),
          workspace({
            deviceId: 'local-2',
            deviceName: 'Office Mac',
            workspacePath: '/workspace/current',
          }),
        ])}
        requiresStop
        onOpenChange={vi.fn()}
        onStopCurrentResponse={onStopCurrentResponse}
        onFork={onFork}
      />
    )

    await userEvent.click(screen.getByTestId('task-fork-confirm-button'))

    await waitFor(() => expect(onStopCurrentResponse).toHaveBeenCalled())
    expect(onFork).toHaveBeenCalledWith({
      deviceId: 'local-2',
      workspacePath: '/workspace/current',
    })
  })

  test('hides the source device and uses an available target', async () => {
    const onFork = vi.fn().mockResolvedValue(undefined)

    render(
      <TaskForkDialog
        open
        source={source()}
        runtimeWork={runtimeWork([
          workspace(),
          workspace({
            workspacePath: '/workspace/other-local-worktree',
          }),
          workspace({
            deviceId: 'local-2',
            deviceName: 'Office Mac',
            workspacePath: '/workspace/target',
          }),
        ])}
        requiresStop={false}
        onOpenChange={vi.fn()}
        onStopCurrentResponse={vi.fn()}
        onFork={onFork}
      />
    )

    expect(screen.queryAllByTestId('task-fork-target-local-1')).toHaveLength(0)
    expect(screen.getByTestId('task-fork-guidance')).toHaveTextContent('其他设备')

    await userEvent.click(screen.getByTestId('task-fork-confirm-button'))

    await waitFor(() =>
      expect(onFork).toHaveBeenCalledWith({
        deviceId: 'local-2',
        workspacePath: '/workspace/target',
      })
    )
  })

  test('does not offer the source device as a bind target', () => {
    render(
      <TaskForkDialog
        open
        source={source()}
        runtimeWork={runtimeWork([
          workspace({
            deviceId: 'local-2',
            deviceName: 'Office Mac',
            workspacePath: '/workspace/target',
          }),
        ])}
        currentProject={{ id: 7, name: 'Project', tasks: [] }}
        devices={[
          device(),
          device({
            id: 3,
            device_id: 'local-3',
            name: 'Office Mac',
          }),
        ]}
        requiresStop={false}
        onOpenChange={vi.fn()}
        onStopCurrentResponse={vi.fn()}
        onFork={vi.fn()}
        onPrepareDeviceWorkspace={vi.fn()}
      />
    )

    expect(screen.queryByTestId('task-fork-bind-device-local-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('task-fork-bind-device-local-3')).toBeInTheDocument()
  })

  test('only lists target workspaces from the source project', () => {
    render(
      <TaskForkDialog
        open
        source={source()}
        runtimeWork={{
          projects: [
            {
              project: { id: 7, name: 'Project' },
              deviceWorkspaces: [
                workspace({
                  tasks: [
                    {
                      taskId: 'runtime-current',
                      workspacePath: '/workspace/current',
                      title: 'Current task',
                      runtime: 'codex',
                    },
                  ],
                }),
                workspace({
                  deviceId: 'local-2',
                  deviceName: 'Office Mac',
                  workspacePath: '/workspace/project-worktree',
                  workspaceKind: 'worktree',
                }),
              ],
              totalTasks: 1,
            },
            {
              project: { id: 8, name: 'Other Project' },
              deviceWorkspaces: [
                workspace({
                  deviceId: 'other-device',
                  deviceName: 'Other Device',
                  workspacePath: '/workspace/unrelated',
                }),
              ],
              totalTasks: 0,
            },
          ],
          chats: [
            workspace({
              deviceId: 'chat-device',
              deviceName: 'Chat Device',
              workspacePath: '/workspace/chat-history',
            }),
          ],
          totalTasks: 1,
        }}
        currentProject={{ id: 7, name: 'Project', tasks: [] }}
        requiresStop={false}
        onOpenChange={vi.fn()}
        onStopCurrentResponse={vi.fn()}
        onFork={vi.fn()}
      />
    )

    expect(screen.getByTestId('task-fork-target-local-2')).toHaveTextContent(
      '/workspace/project-worktree'
    )
    expect(screen.getByTestId('task-fork-target-local-2')).toHaveTextContent('Worktree')
    expect(screen.queryByTestId('task-fork-target-other-device')).not.toBeInTheDocument()
    expect(screen.queryByTestId('task-fork-target-chat-device')).not.toBeInTheDocument()
  })

  test('binds an unbound device path to the current project before forking', async () => {
    const onPrepareDeviceWorkspace = vi.fn().mockResolvedValue({
      preparedAction: 'selected',
      mapping: {
        id: 99,
        userId: 1,
        projectId: 7,
        deviceId: 'local-3',
        workspacePath: '/home/alice/office-project',
        repoUrl: null,
        repoRootFingerprint: null,
        label: null,
        createdAt: '2026-06-22T00:00:00',
        updatedAt: '2026-06-22T00:00:00',
        lastSeenAt: null,
      },
    })
    const onFork = vi.fn().mockResolvedValue(undefined)

    render(
      <TaskForkDialog
        open
        source={source()}
        runtimeWork={runtimeWork([
          workspace({
            tasks: [
              {
                taskId: 'runtime-current',
                workspacePath: '/workspace/current',
                title: 'Current task',
                runtime: 'codex',
              },
            ],
          }),
        ])}
        currentProject={{ id: 7, name: 'Project', tasks: [] }}
        devices={[
          device(),
          device({
            id: 3,
            device_id: 'local-3',
            name: 'Office Mac',
          }),
        ]}
        requiresStop={false}
        onOpenChange={vi.fn()}
        onStopCurrentResponse={vi.fn()}
        onFork={onFork}
        onPrepareDeviceWorkspace={onPrepareDeviceWorkspace}
        onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/home/alice')}
        onGetProjectWorkspaceRoot={vi.fn().mockResolvedValue('/workspace/projects')}
        onListDeviceDirectories={vi.fn().mockResolvedValue(['office-project'])}
        onCreateDeviceDirectory={vi.fn().mockResolvedValue(undefined)}
      />
    )

    await userEvent.click(screen.getByTestId('task-fork-bind-device-local-3'))
    expect(await screen.findByTestId('project-create-dialog')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('project-folder-select-button'))
    await waitFor(() =>
      expect(screen.getByTestId('device-folder-path-input')).toHaveValue('/home/alice')
    )
    await userEvent.click(screen.getByTestId('project-workspace-kind-worktree'))
    await userEvent.click(await screen.findByText('office-project'))
    await userEvent.click(screen.getByTestId('confirm-device-folder-picker-button'))
    await userEvent.click(screen.getByTestId('create-project-button'))

    await waitFor(() =>
      expect(onPrepareDeviceWorkspace).toHaveBeenCalledWith({
        projectId: 7,
        deviceId: 'local-3',
        workspacePath: '/home/alice/office-project',
        action: 'select',
        label: 'worktree',
      })
    )
    expect(onFork).toHaveBeenCalledWith({
      deviceId: 'local-3',
      workspacePath: '/home/alice/office-project',
    })
  })
})
