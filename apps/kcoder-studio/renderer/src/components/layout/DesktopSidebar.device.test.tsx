import '@/i18n'
import { openLocalWorkspace } from '@/lib/local-terminal'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  cloudWorkStatus,
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
describe('DesktopSidebar device', () => {
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
  test('selects the first available cloud device when cloud is connected', async () => {
    const onSelectStandaloneDevice = vi.fn()
    renderSidebar({
      devices: [
        localDevice(),
        localDevice({
          id: 2,
          device_id: 'cloud-device',
          name: 'Cloud Box',
          device_type: 'cloud',
        }),
      ],
      onSelectStandaloneDevice,
    })

    await userEvent.click(screen.getByTestId('sidebar-cloud-connection-button'))

    expect(onSelectStandaloneDevice).toHaveBeenCalledWith('cloud-device')
    expect(screen.queryByTestId('standalone-folder-project-dialog')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-connection-dialog')).not.toBeInTheDocument()
  })

  test('shows cloud work availability and opens connection settings from the sidebar entry', async () => {
    const onOpenSettings = vi.fn()
    renderSidebar({
      devices: [
        localDevice(),
        localDevice({
          id: 2,
          device_id: 'cloud-device',
          name: 'Cloud Box',
          device_type: 'cloud',
        }),
      ],
      cloudWorkStatus: cloudWorkStatus({ availability: 'available' }),
      onOpenSettings,
    })

    const cloudButton = screen.getByTestId('sidebar-cloud-connection-button')
    const statusLabel = screen.getByTestId('sidebar-cloud-status-label')
    const settingsButton = screen.getByTestId('sidebar-cloud-management-button')

    expect(cloudButton).toHaveTextContent('云端工作')
    expect(cloudButton).toHaveTextContent('可用')
    expect(cloudButton).toHaveClass('pr-2')
    expect(cloudButton).not.toHaveClass('pr-8')
    expect(statusLabel).toHaveClass(
      'ml-auto',
      'group-hover/cloud:invisible',
      'group-focus-within/cloud:invisible'
    )
    expect(settingsButton).toHaveClass(
      'pointer-events-none',
      'group-hover/cloud:pointer-events-auto',
      'group-hover/cloud:opacity-100',
      'group-focus-within/cloud:pointer-events-auto',
      'group-focus-within/cloud:opacity-100'
    )

    await userEvent.click(cloudButton)

    expect(onOpenSettings).toHaveBeenCalledWith({ settingsPage: 'connections' })
  })

  test('opens cloud connection settings from the sidebar cloud management button', async () => {
    const onOpenSettings = vi.fn()
    renderSidebar({
      devices: [localDevice()],
      cloudWorkStatus: cloudWorkStatus({ availability: 'available' }),
      onOpenSettings,
    })

    await userEvent.click(screen.getByTestId('sidebar-cloud-management-button'))

    expect(onOpenSettings).toHaveBeenCalledWith({ settingsPage: 'connections' })
  })

  test('shows cloud work unavailable when background cloud reads fail', () => {
    renderSidebar({
      devices: [localDevice()],
      cloudWorkStatus: cloudWorkStatus({
        availability: 'unavailable',
        checks: { devices: 'unavailable' },
        error: '云端设备: request timed out',
      }),
    })

    const cloudButton = screen.getByTestId('sidebar-cloud-connection-button')

    expect(cloudButton).toHaveTextContent('云端工作')
    expect(cloudButton).toHaveTextContent('不可用')
    expect(cloudButton).toHaveAttribute('title', expect.stringContaining('request timed out'))
  })

  test('opens cloud work error details from the warning icon', async () => {
    renderSidebar({
      devices: [localDevice()],
      cloudWorkStatus: cloudWorkStatus({
        availability: 'unavailable',
        checks: { devices: 'unavailable', runtimeWork: 'available' },
        error: '云端设备: request timed out',
      }),
    })

    await userEvent.click(screen.getByTestId('sidebar-cloud-error-button'))

    const detail = screen.getByTestId('sidebar-cloud-error-popover')
    expect(detail.parentElement).toBe(document.body)
    expect(detail).toHaveClass('fixed', 'z-system-popover', 'rounded-xl')
    expect(detail).toHaveTextContent('云端工作不可用')
    expect(detail).toHaveTextContent('云端设备: request timed out')
    expect(detail).toHaveTextContent('云端设备')
    expect(detail).toHaveTextContent('不可用')
    expect(detail).toHaveTextContent('云端任务列表')
    expect(detail).toHaveTextContent('可用')

    await userEvent.click(document.body)
    expect(screen.queryByTestId('sidebar-cloud-error-popover')).not.toBeInTheDocument()
  })

  test('closes cloud work error details with Escape', async () => {
    renderSidebar({
      devices: [localDevice()],
      cloudWorkStatus: cloudWorkStatus({
        availability: 'unavailable',
        checks: { devices: 'unavailable' },
        error: '云端设备: request timed out',
      }),
    })

    await userEvent.click(screen.getByTestId('sidebar-cloud-error-button'))
    expect(screen.getByTestId('sidebar-cloud-error-popover')).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('sidebar-cloud-error-popover')).not.toBeInTheDocument()
  })

  test('closes cloud work error details when clicking outside', async () => {
    renderSidebar({
      devices: [localDevice()],
      cloudWorkStatus: cloudWorkStatus({
        availability: 'unavailable',
        checks: { devices: 'unavailable', runtimeWork: 'available' },
        error: '云端设备: request timed out',
      }),
    })

    await userEvent.click(screen.getByTestId('sidebar-cloud-error-button'))
    expect(screen.getByTestId('sidebar-cloud-error-popover')).toBeInTheDocument()

    await userEvent.click(document.body)
    expect(screen.queryByTestId('sidebar-cloud-error-popover')).not.toBeInTheDocument()
  })

  test('does not close cloud work error details when clicking inside', async () => {
    renderSidebar({
      devices: [localDevice()],
      cloudWorkStatus: cloudWorkStatus({
        availability: 'unavailable',
        checks: { devices: 'unavailable', runtimeWork: 'available' },
        error: '云端设备: request timed out',
      }),
    })

    await userEvent.click(screen.getByTestId('sidebar-cloud-error-button'))
    const detail = screen.getByTestId('sidebar-cloud-error-popover')

    await userEvent.click(detail)
    expect(screen.getByTestId('sidebar-cloud-error-popover')).toBeInTheDocument()
  })

  test('does not open add-device guidance while cloud work checks are failing', async () => {
    const onGetRemoteDeviceStartupCommand = vi.fn()
    renderSidebar({
      devices: [localDevice()],
      onGetRemoteDeviceStartupCommand,
      cloudWorkStatus: cloudWorkStatus({
        availability: 'unavailable',
        checks: { devices: 'unavailable' },
        error: '云端设备: request timed out',
      }),
    })

    await userEvent.click(screen.getByTestId('sidebar-cloud-connection-button'))

    expect(screen.getByTestId('sidebar-cloud-error-popover')).toHaveTextContent(
      '云端设备: request timed out'
    )
    expect(screen.queryByTestId('standalone-folder-project-dialog')).not.toBeInTheDocument()
    expect(onGetRemoteDeviceStartupCommand).not.toHaveBeenCalled()
  })

  test('treats an empty cloud device list as an add-device state instead of an error', async () => {
    const onGetRemoteDeviceStartupCommand = vi.fn().mockResolvedValue({
      device_id: 'remote-device',
      name: 'alice-remote-device',
      image: 'ghcr.io/wecode-ai/wegent-device:latest',
      env: {},
      command:
        'docker run -d -e DEVICE_TYPE=remote -e EXECUTOR_MODE=local ghcr.io/wecode-ai/wegent-device:latest',
      commands: [
        {
          kind: 'docker',
          label: 'Docker',
          description: 'Run in Docker.',
          command:
            'docker run -d -e DEVICE_TYPE=remote -e EXECUTOR_MODE=local ghcr.io/wecode-ai/wegent-device:latest',
        },
        {
          kind: 'process',
          label: '宿主机启动',
          description: 'Run as a local process.',
          command:
            'DEVICE_TYPE=remote EXECUTOR_MODE=local WEGENT_BACKEND_URL=http://backend wegent-executor',
        },
      ],
    })
    renderSidebar({
      devices: [localDevice()],
      onGetRemoteDeviceStartupCommand,
      cloudWorkStatus: cloudWorkStatus({
        availability: 'empty',
        checks: { devices: 'empty' },
      }),
    })

    expect(screen.queryByTestId('sidebar-cloud-error-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('sidebar-cloud-connection-button')).toHaveTextContent('无设备')

    await userEvent.click(screen.getByTestId('sidebar-cloud-connection-button'))

    expect(screen.getByTestId('standalone-folder-project-dialog')).toHaveTextContent('添加新设备')
    await waitFor(() => expect(onGetRemoteDeviceStartupCommand).toHaveBeenCalledTimes(1))
  })

  test('shows Docker and process startup scripts when no cloud device is available', async () => {
    const onGetRemoteDeviceStartupCommand = vi.fn().mockResolvedValue({
      device_id: 'remote-device',
      name: 'alice-remote-device',
      image: 'ghcr.io/wecode-ai/wegent-device:latest',
      env: {},
      command:
        'docker run -d -e DEVICE_TYPE=remote -e EXECUTOR_MODE=local ghcr.io/wecode-ai/wegent-device:latest',
      commands: [
        {
          kind: 'docker',
          label: 'Docker',
          description: 'Run in Docker.',
          command:
            'docker run -d -e DEVICE_TYPE=remote -e EXECUTOR_MODE=local ghcr.io/wecode-ai/wegent-device:latest',
        },
        {
          kind: 'process',
          label: '宿主机启动',
          description: 'Run as a local process.',
          command:
            'DEVICE_TYPE=remote EXECUTOR_MODE=local WEGENT_BACKEND_URL=http://backend wegent-executor',
        },
      ],
    })
    renderSidebar({ onGetRemoteDeviceStartupCommand })

    await userEvent.click(screen.getByTestId('sidebar-cloud-connection-button'))

    expect(screen.getByTestId('standalone-folder-project-dialog')).toHaveTextContent('添加新设备')
    await waitFor(() => expect(onGetRemoteDeviceStartupCommand).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('remote-device-startup-command')).toHaveTextContent(
      'docker run'
    )
    expect(screen.getByTestId('remote-device-startup-tab-docker')).toBeInTheDocument()
    expect(screen.getByTestId('remote-device-startup-tab-process')).toHaveTextContent('宿主机启动')

    await userEvent.click(screen.getByTestId('remote-device-startup-tab-process'))

    expect(screen.getByTestId('remote-device-startup-command')).toHaveTextContent('wegent-executor')
  })

  test('keeps an unavailable remote-only project visible with its IP and gray status', () => {
    renderSidebar({
      devices: [localDevice()],
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'remote-project-id', name: 'Remote Wegent' },
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'remote-device',
                deviceName: '203.0.113.10',
                deviceStatus: 'offline',
                available: false,
                workspacePath: '/home/ubuntu/workspace/Wegent',
                workspaceSource: 'remote',
                remoteHostId: 'remote-ssh-discovered:203.0.113.10',
                tasks: [],
              },
            ],
          },
          {
            project: { id: 8, key: 'local-project-id', name: 'Local Wegent' },
            deviceWorkspaces: [
              {
                id: 92,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/Users/alice/Wegent',
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

    expect(screen.getByText('Remote Wegent')).toBeInTheDocument()
    expect(screen.getByTestId('project-remote-folder-icon-7')).toBeInTheDocument()
    expect(screen.getByTestId('project-device-status-7')).toHaveTextContent('203.0.113.10')
    expect(screen.getByTestId('project-device-status-7-dot')).toHaveClass(
      'bg-[rgb(var(--color-sidebar-text-muted))]',
      'opacity-55'
    )
    expect(screen.getByTestId('project-device-status-7-dot')).not.toHaveAttribute('style')
    expect(screen.getByText('Local Wegent')).toBeInTheDocument()
    expect(screen.getByTestId('project-folder-icon-8')).toBeInTheDocument()
    expect(screen.getAllByTestId('project-item')).toHaveLength(2)
  })

  test('marks a missing local workspace unavailable and disables new conversations', () => {
    renderSidebar({
      devices: [localDevice()],
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'missing-local-project', name: 'Missing local project' },
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: false,
                workspacePath: '/repo/deleted-project',
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

    expect(screen.getByTestId('project-device-status-7')).toHaveTextContent('不可用')
    expect(screen.getByTestId('project-device-status-7-dot')).toHaveClass(
      'bg-[rgb(var(--color-sidebar-text-muted))]',
      'opacity-55'
    )
    const create = screen.getByTestId('project-new-conversation-button')
    expect(create).toBeDisabled()
    expect(create).toHaveAttribute('title', expect.stringContaining('不可用'))
  })

  test('shows cached tasks for an offline remote project without allowing them to open', async () => {
    const onOpenRuntimeTask = vi.fn()
    const onSetRuntimeTaskPinned = vi.fn()
    const onRenameRuntimeTask = vi.fn()
    const onArchiveRuntimeTask = vi.fn()
    renderSidebar({
      devices: [
        localDevice(),
        localDevice({
          id: 2,
          device_id: 'remote-device',
          name: 'Remote Host',
          status: 'offline',
          is_default: false,
          device_type: 'remote',
          client_ip: '203.0.113.10',
        }),
      ],
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'remote-project-id', name: 'Remote Wegent' },
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'remote-device',
                deviceName: '203.0.113.10',
                deviceStatus: 'offline',
                available: false,
                workspacePath: '/home/ubuntu/workspace/Wegent',
                workspaceSource: 'remote',
                remoteHostId: 'remote-ssh-discovered:203.0.113.10',
                tasks: [
                  {
                    taskId: 'cached-remote-task',
                    workspacePath: '/home/ubuntu/workspace/Wegent',
                    title: 'Cached remote task',
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
      onSetRuntimeTaskPinned,
      onRenameRuntimeTask,
      onArchiveRuntimeTask,
    })

    await userEvent.click(screen.getByTestId('project-item-button'))

    const taskRow = screen.getByTestId('runtime-local-task-row-cached-remote-task')
    expect(taskRow).toHaveAttribute('aria-disabled', 'true')
    expect(taskRow).toHaveAttribute('tabindex', '-1')
    expect(screen.getByTestId('runtime-local-task-mark-cached-remote-task')).toBeDisabled()
    expect(screen.getByTestId('runtime-local-task-archive-cached-remote-task')).toBeDisabled()
    fireEvent.click(taskRow)
    fireEvent.click(screen.getByTestId('runtime-local-task-mark-cached-remote-task'))
    fireEvent.doubleClick(taskRow)
    expect(onOpenRuntimeTask).not.toHaveBeenCalled()
    expect(onSetRuntimeTaskPinned).not.toHaveBeenCalled()
    expect(onRenameRuntimeTask).not.toHaveBeenCalled()
    expect(onArchiveRuntimeTask).not.toHaveBeenCalled()
  })

  test('shows an available remote project IP with green status', () => {
    renderSidebar({
      devices: [
        localDevice(),
        localDevice({
          id: 2,
          device_id: 'remote-device',
          name: 'Remote Host',
          is_default: false,
          device_type: 'remote',
          client_ip: '203.0.113.10',
        }),
      ],
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'remote-project-id', name: 'Remote Wegent' },
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'remote-device',
                deviceName: '203.0.113.10',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/home/ubuntu/workspace/Wegent',
                workspaceSource: 'remote',
                remoteHostId: 'remote-ssh-discovered:203.0.113.10',
                tasks: [],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 0,
      },
    })

    expect(screen.getByTestId('project-device-status-7')).toHaveTextContent('203.0.113.10')
    expect(screen.getByTestId('project-device-status-7-dot')).toHaveStyle({
      backgroundColor: '#1FD660',
    })
    expect(screen.getByTestId('project-device-status-7-dot')).not.toHaveClass(
      'bg-[rgb(var(--color-sidebar-text-muted))]'
    )
  })

  test('does not render online devices section and keeps all runtime tasks visible', async () => {
    renderSidebar({
      devices: [
        localDevice(),
        localDevice({
          id: 2,
          device_id: 'cloud-device',
          name: 'Cloud Box',
          device_type: 'cloud',
        }),
        localDevice({
          id: 3,
          device_id: 'offline-device',
          name: 'Offline Box',
          status: 'offline',
        }),
      ],
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
                    taskId: 'local-task',
                    workspacePath: '/repo/Wegent',
                    title: 'Runtime task',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T02:00:00Z',
                  },
                ],
              },
              {
                id: 92,
                deviceId: 'cloud-device',
                deviceName: 'Cloud Box',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                tasks: [
                  {
                    taskId: 'cloud-task',
                    workspacePath: '/repo/Wegent',
                    title: 'Cloud task',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T03:00:00Z',
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

    expect(screen.queryByTestId('sidebar-online-devices')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(screen.getByTestId('runtime-local-task-row-local-task')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-row-cloud-task')).toBeInTheDocument()
    expect(
      screen.queryByTestId('runtime-local-task-device-marker-local-task')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('runtime-local-task-device-marker-cloud-task')
    ).not.toBeInTheDocument()
  })
})
