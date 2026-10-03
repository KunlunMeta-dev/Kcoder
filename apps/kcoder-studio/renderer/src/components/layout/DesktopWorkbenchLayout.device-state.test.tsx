import './DesktopWorkbenchLayout.test-mocks'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { DesktopWorkbenchLayout, baseProps } from './DesktopWorkbenchLayout.test-harness'

describe('DesktopWorkbenchLayout', () => {
  test('shows project device network status for non-local devices when multiple devices exist', () => {
    const onlineDevice = {
      id: 1,
      device_id: 'online-device',
      name: 'Online Device',
      status: 'online' as const,
      is_default: false,
      device_type: 'cloud' as const,
      bind_shell: 'claudecode',
      client_ip: '127.0.0.1',
      runtime_transfer_host: '192.0.2.10:9000',
    }

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          devices: [
            onlineDevice,
            {
              id: 2,
              device_id: 'local-device',
              name: 'Local Device',
              status: 'online' as const,
              is_default: true,
              device_type: 'local' as const,
              bind_shell: 'claudecode',
            },
          ],
          projects: [
            {
              id: 7,
              name: 'hello',
              config: {
                execution: {
                  targetType: 'cloud',
                  deviceId: 'online-device',
                },
              },
              tasks: [],
            },
          ],
        }}
      />
    )

    const projectRow = screen.getByTestId('project-row-7')
    expect(within(projectRow).getByTestId('project-device-status-7')).toHaveTextContent(
      '192.0.2.10'
    )
    expect(within(projectRow).getByTestId('project-new-conversation-button')).not.toBeDisabled()
  })

  test('shows a loopback IP instead of the device ID for a remote project', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: '9d317900-0c00-4000-8000-000000000000',
              name: 'Remote Device',
              status: 'online' as const,
              is_default: false,
              device_type: 'remote' as const,
              bind_shell: 'claudecode',
              client_ip: '127.0.0.1',
            },
            {
              id: 2,
              device_id: 'local-device',
              name: 'Local Device',
              status: 'online' as const,
              is_default: true,
              device_type: 'local' as const,
              bind_shell: 'claudecode',
            },
          ],
          projects: [
            {
              id: 7,
              name: 'hello',
              config: {
                execution: {
                  targetType: 'remote',
                  deviceId: '9d317900-0c00-4000-8000-000000000000',
                },
              },
              tasks: [],
            },
          ],
        }}
      />
    )

    const status = within(screen.getByTestId('project-row-7')).getByTestId(
      'project-device-status-7'
    )
    expect(status).toHaveTextContent('127.0.0.1')
    expect(status).not.toHaveTextContent('9d317900')
  })

  test('hides project device network status when only one device exists', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'online-device',
              name: 'Online Device',
              status: 'online' as const,
              is_default: false,
              device_type: 'cloud' as const,
              bind_shell: 'claudecode',
              runtime_transfer_host: '192.0.2.10:9000',
            },
          ],
          projects: [
            {
              id: 7,
              name: 'hello',
              config: {
                execution: {
                  targetType: 'cloud',
                  deviceId: 'online-device',
                },
              },
              tasks: [],
            },
          ],
        }}
      />
    )

    const projectRow = screen.getByTestId('project-row-7')
    expect(within(projectRow).queryByTestId('project-device-status-7')).not.toBeInTheDocument()
  })

  test('hides project device network status for local devices when multiple devices exist', () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'local-device',
              name: 'Local Device',
              status: 'online' as const,
              is_default: true,
              device_type: 'local' as const,
              bind_shell: 'claudecode',
              runtime_transfer_host: '192.0.2.10:9000',
            },
            {
              id: 2,
              device_id: 'cloud-device',
              name: 'Cloud Device',
              status: 'online' as const,
              is_default: false,
              device_type: 'cloud' as const,
              bind_shell: 'claudecode',
            },
          ],
          projects: [
            {
              id: 7,
              name: 'hello',
              config: {
                execution: {
                  targetType: 'local',
                  deviceId: 'local-device',
                },
              },
              tasks: [],
            },
          ],
        }}
      />
    )

    const projectRow = screen.getByTestId('project-row-7')
    expect(within(projectRow).queryByTestId('project-device-status-7')).not.toBeInTheDocument()
  })

  test('keeps offline project conversations readable but locks the composer', async () => {
    const offlineDevice = {
      id: 1,
      device_id: 'offline-device',
      name: 'Offline Device',
      status: 'offline' as const,
      is_default: false,
      device_type: 'cloud' as const,
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
      client_ip: '203.0.113.10',
    }
    const project = {
      id: 7,
      name: 'hello',
      config: {
        execution: {
          targetType: 'cloud' as const,
          deviceId: 'offline-device',
        },
      },
      tasks: [],
    }

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          projects: [project],
          devices: [offlineDevice],
          currentProject: project,
          input: 'hello offline',
        }}
        messages={[
          {
            id: 'message-1',
            role: 'user',
            content: 'hello',
            status: 'done',
            createdAt: new Date().toISOString(),
          },
        ]}
        projectWork={{
          ...baseProps.projectWork,
          projects: [project],
          devices: [offlineDevice],
          currentProjectId: 7,
        }}
      />
    )

    expect(screen.getByTestId('desktop-chat-scroll')).toHaveTextContent('hello')
    expect(screen.getByTestId('conversation-device-offline-banner')).toHaveTextContent(
      '203.0.113.10 已离线，恢复在线后可继续对话'
    )
    expect(screen.queryByTestId('composer-disabled-reason')).not.toBeInTheDocument()
    expect(screen.queryByTestId('device-status-prompt')).not.toBeInTheDocument()
    expect(screen.getByTestId('send-message-button')).toBeDisabled()

    await userEvent.click(screen.getByTestId('send-message-button'))
    expect(baseProps.onSend).not.toHaveBeenCalled()
  })

  test('shows one consistent running state across the composer and message area', () => {
    const onlineDevice = {
      id: 1,
      device_id: 'device-1',
      name: 'Runtime Device',
      status: 'online' as const,
      is_default: false,
      device_type: 'cloud' as const,
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
    }

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        lifecycleTaskRunning
        state={{
          ...baseProps.state,
          devices: [onlineDevice],
          currentRuntimeTask: {
            deviceId: 'device-1',
            workspacePath: '/workspace/project-alpha',
            taskId: 'runtime-a',
          },
          input: '',
        }}
        messages={[
          {
            id: 'message-1',
            role: 'user',
            content: '执行pwd',
            status: 'done',
            createdAt: new Date().toISOString(),
          },
        ]}
        projectWork={{
          ...baseProps.projectWork,
          devices: [onlineDevice],
        }}
      />
    )

    expect(screen.queryByTestId('composer-disabled-reason')).not.toBeInTheDocument()
    expect(screen.getByTestId('chat-message-input')).toHaveAttribute('placeholder', '要求后续变更')
    expect(screen.getByTestId('pause-response-button')).toBeInTheDocument()
    expect(screen.queryByTestId('send-message-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('thinking-indicator')).toBeInTheDocument()
  })

  test('hides inline composer notice while a send request is in flight', async () => {
    const onlineDevice = {
      id: 1,
      device_id: 'device-1',
      name: 'Runtime Device',
      status: 'online' as const,
      is_default: true,
      device_type: 'cloud' as const,
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
    }

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          devices: [onlineDevice],
          standaloneDeviceId: 'device-1',
          input: '正在发送的消息',
          isSending: true,
        }}
        projectWork={{
          ...baseProps.projectWork,
          devices: [onlineDevice],
          currentStandaloneDeviceId: 'device-1',
        }}
      />
    )

    expect(screen.queryByTestId('composer-disabled-reason')).not.toBeInTheDocument()
    expect(screen.getByTestId('pause-response-button')).toBeInTheDocument()
    expect(screen.queryByTestId('send-message-button')).not.toBeInTheDocument()
  })

  test('shows an external upgrade action for the active low-version device', async () => {
    const onUpgradeDevice = vi.fn().mockResolvedValue(undefined)
    const oldDevice = {
      id: 1,
      device_id: 'old-device',
      name: 'Old Device',
      status: 'online' as const,
      is_default: false,
      device_type: 'cloud' as const,
      bind_shell: 'claudecode',
      executor_version: '1.8.4',
      slot_used: 0,
    }
    const compatibleDevice = {
      id: 2,
      device_id: 'compatible-device',
      name: 'Compatible Device',
      status: 'online' as const,
      is_default: false,
      device_type: 'cloud' as const,
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
    }
    const project = {
      id: 7,
      name: 'hello',
      config: {
        execution: {
          targetType: 'cloud' as const,
          deviceId: 'old-device',
        },
      },
      tasks: [],
    }

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onUpgradeDevice={onUpgradeDevice}
        state={{
          ...baseProps.state,
          projects: [project],
          devices: [oldDevice, compatibleDevice],
          currentProject: project,
          input: 'hello old device',
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: [project],
          devices: [oldDevice, compatibleDevice],
          currentProjectId: 7,
        }}
      />
    )

    expect(screen.getByTestId('composer-disabled-reason')).toHaveTextContent(
      'Old Device 版本低于 1.8.5，升级后可继续对话'
    )
    expect(screen.getByTestId('device-status-prompt')).toHaveTextContent(
      'Old Device 版本低于 1.8.5，升级后可继续对话'
    )
    expect(screen.getByTestId('send-message-button')).toBeDisabled()

    await userEvent.click(screen.getByTestId('device-status-upgrade-button'))

    expect(onUpgradeDevice).toHaveBeenCalledWith('old-device')
  })

  test('keeps projects and chats in the scrollable sidebar region above settings', () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.getByTestId('sidebar-worklists-scroll')).toHaveClass(
      'flex-1',
      'overflow-y-auto',
      'scrollbar-none',
      '[overflow-anchor:none]'
    )
    expect(screen.getByTestId('settings-button')).toHaveClass('h-[60px]', 'min-w-0', 'flex-1')
    expect(screen.getByTestId('settings-button')).not.toHaveClass('w-full')
    expect(screen.getByTestId('sidebar-global-im-notification-button')).toHaveClass('h-8', 'w-8')
  })

  test('toggles an empty project without changing the center selection', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.getByTestId('runtime-chat-empty')).toHaveTextContent('暂无会话')
    expect(screen.getByTestId('project-local-tasks-panel-1')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('project-row-1')).not.toHaveClass('bg-white')

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(baseProps.onSelectProject).not.toHaveBeenCalled()
    expect(screen.getByTestId('project-local-tasks-panel-1')).toHaveAttribute(
      'aria-hidden',
      'false'
    )
    expect(screen.getByTestId('project-local-tasks-empty-1')).toHaveTextContent('暂无会话')
    expect(screen.getByTestId('project-row-1')).not.toHaveClass('bg-white')

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(screen.getByTestId('project-local-tasks-panel-1')).toHaveAttribute('aria-hidden', 'true')
    expect(baseProps.onSelectProject).not.toHaveBeenCalled()
  })

  test('opens the general settings page from the settings menu', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('settings-button'))
    await userEvent.click(screen.getByTestId('settings-menu-button'))

    expect(screen.getByTestId('studio-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('settings-back-button')).toHaveTextContent('返回')
    expect(screen.queryByText('返回应用')).not.toBeInTheDocument()
    expect(screen.getByTestId('general-settings-page')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '通用' })).toBeInTheDocument()
    expect(screen.getByTestId('settings-nav-general')).toHaveClass(
      'bg-[rgb(var(--color-sidebar-active))]'
    )
    expect(screen.queryByRole('heading', { name: '云端连接' })).not.toBeInTheDocument()
    expect(screen.queryByText('连接这台设备')).not.toBeInTheDocument()
    expect(screen.queryByText('链接这台设备')).not.toBeInTheDocument()
    expect(screen.queryByText('控制其他设备')).not.toBeInTheDocument()
    expect(screen.queryByText('SSH')).not.toBeInTheDocument()
    expect(screen.getByTestId('settings-nav-connections')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-nav-projects')).not.toBeInTheDocument()
    expect(screen.getByTestId('settings-nav-general')).toBeInTheDocument()
    expect(screen.queryByText('Personal Devices')).not.toBeInTheDocument()
    expect(screen.queryByText('Linux-Device-481b616e8e0b')).not.toBeInTheDocument()
    expect(screen.queryByText('可连接这台设备的云设备')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('settings-nav-connections'))

    expect(await screen.findByRole('heading', { name: '云端连接' })).toBeInTheDocument()
    expect(screen.getByText('已连接云端')).toBeInTheDocument()
    expect(screen.getByText('在线')).toBeInTheDocument()
    expect(screen.queryByText('Online')).not.toBeInTheDocument()
    expect(
      screen.getByTestId('connection-terminal-button-24a59054-4638-4744-983d-372706c30fcd')
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('connection-code-server-button-24a59054-4638-4744-983d-372706c30fcd')
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('connection-cloud-desktop-button-24a59054-4638-4744-983d-372706c30fcd')
    ).not.toBeInTheDocument()
    expect(screen.getByText('终端')).toBeInTheDocument()
    expect(screen.getByText('IDE')).toBeInTheDocument()
    expect(screen.queryByText('桌面')).not.toBeInTheDocument()
    expect(screen.queryByText('Terminal')).not.toBeInTheDocument()
    expect(screen.queryByText('Code Server')).not.toBeInTheDocument()
    expect(screen.queryByText('云桌面')).not.toBeInTheDocument()
    expect(screen.getByText('203.0.113.10')).toBeInTheDocument()
    expect(screen.queryByText('dev-executor-372706c30fcd')).not.toBeInTheDocument()
    expect(screen.queryByText('CPU')).not.toBeInTheDocument()
    expect(screen.queryByText('MEM')).not.toBeInTheDocument()
    expect(screen.queryByText('磁盘')).not.toBeInTheDocument()
    expect(screen.queryByText('42%')).not.toBeInTheDocument()
    expect(screen.queryByText('68%')).not.toBeInTheDocument()
    expect(screen.queryByText('57%')).not.toBeInTheDocument()
    expect(screen.queryByTestId('connection-scale-wiki')).not.toBeInTheDocument()
    expect(screen.queryByText('说明')).not.toBeInTheDocument()
    expect(screen.queryByText('扩容 Wiki')).not.toBeInTheDocument()
    expect(screen.queryByText(/持续超过 80%/)).not.toBeInTheDocument()
    expect(screen.queryByText('a8791aa3-4e8a-4076-b9a6-481b616e8e0b')).not.toBeInTheDocument()
    expect(screen.queryByText('Nevis')).not.toBeInTheDocument()
    expect(screen.queryByText('Cloud computing powered by Nevis')).not.toBeInTheDocument()
    expect(screen.queryByText('其他设置')).not.toBeInTheDocument()
    expect(screen.queryByText('Start Task')).not.toBeInTheDocument()
  })
})
