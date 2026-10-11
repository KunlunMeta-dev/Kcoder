import { getDesktopWorkbenchHoistedMocks } from './DesktopWorkbenchLayout.test-mocks'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { DesktopWorkbenchLayout, baseProps } from './DesktopWorkbenchLayout.test-harness'

const { automationMocks, nativeDirectoryPickerMocks } = getDesktopWorkbenchHoistedMocks()

describe('DesktopWorkbenchLayout', () => {
  test('opens the project create dialog with grouped local and cloud choices', async () => {
    const onRefreshDevices = vi.fn().mockResolvedValue(undefined)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onRefreshDevices={onRefreshDevices}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'device-1',
              name: 'executor',
              status: 'online',
              is_default: true,
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))

    expect(screen.getByTestId('projects-create-button-menu')).toBeInTheDocument()
    expect(screen.getByTestId('project-create-local-option')).toHaveTextContent('本地项目')
    expect(screen.queryByTestId('project-create-blank-option')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-create-remote-option')).toHaveTextContent('云端项目')
    expect(screen.queryByTestId('project-create-dialog')).not.toBeInTheDocument()
    expect(onRefreshDevices).toHaveBeenCalledTimes(1)
  })

  test('opens project create menu before device refresh completes', async () => {
    let resolveRefreshDevices: (() => void) | undefined
    const onRefreshDevices = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolveRefreshDevices = resolve
        })
    )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onRefreshDevices={onRefreshDevices}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'device-1',
              name: 'executor',
              status: 'online',
              is_default: true,
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))

    expect(screen.getByTestId('projects-create-button-menu')).toBeInTheDocument()
    expect(screen.getByTestId('project-create-local-option')).toBeInTheDocument()
    expect(onRefreshDevices).toHaveBeenCalledTimes(1)

    resolveRefreshDevices?.()
  })

  test('remote project device picker includes cloud and remote devices but not local devices', async () => {
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
              status: 'online',
              is_default: true,
              device_type: 'local',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
            {
              id: 2,
              device_id: 'cloud-device',
              name: 'Cloud Device',
              status: 'online',
              is_default: false,
              device_type: 'cloud',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
              runtime_transfer_host: '203.0.113.10',
            },
            {
              id: 3,
              device_id: 'remote-device',
              name: 'Remote Device',
              status: 'online',
              is_default: false,
              device_type: 'remote',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
              client_ip: '127.0.0.1',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-remote-option'))

    const select = screen.getByTestId('standalone-remote-device-select')
    expect(select).toHaveTextContent('203.0.113.10')
    expect(select).toHaveTextContent('127.0.0.1')
    expect(select).not.toHaveTextContent('Cloud Device')
    expect(select).not.toHaveTextContent('Remote Device')
    expect(select).not.toHaveTextContent('Local Device')
  })

  test('remote project dialog excludes incompatible non-local devices', async () => {
    const onUpgradeDevice = vi.fn().mockResolvedValue(undefined)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onUpgradeDevice={onUpgradeDevice}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'old-device',
              name: 'Old Device',
              status: 'online',
              is_default: false,
              device_type: 'cloud',
              bind_shell: 'claudecode',
              executor_version: '1.8.4',
              slot_used: 0,
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-remote-option'))

    expect(screen.getByTestId('standalone-folder-project-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('standalone-folder-no-device')).toHaveTextContent('连接一台云端设备')
    expect(screen.getByTestId('standalone-folder-no-device')).toHaveTextContent('启动脚本')
    expect(screen.queryByTestId('standalone-remote-device-select')).not.toBeInTheDocument()
    expect(onUpgradeDevice).not.toHaveBeenCalled()
  })

  test('local project dialog accepts a same-host KCoder gateway target', async () => {
    const onGetDeviceHomeDirectory = vi.fn().mockResolvedValue('/workspace')
    const onListDeviceDirectories = vi.fn().mockResolvedValue(['KCoder-App'])

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onListDeviceDirectories={onListDeviceDirectories}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'local',
              name: '当前虚拟机',
              status: 'online',
              is_default: true,
              device_type: 'remote',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
              capabilities: ['kcoder-gateway', 'kcoder-gateway-local'],
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-local-option'))

    expect(await screen.findByTestId('device-folder-directory-list')).toHaveTextContent(
      'KCoder-App'
    )
    expect(onGetDeviceHomeDirectory).toHaveBeenCalledWith('local')
    expect(nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('confirm-device-folder-picker-button'))

    expect(await screen.findByTestId('local-project-create-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('local-project-create-root-0')).toHaveTextContent('workspace')
  })

  test('remote project dialog excludes remote routes that belong to the local runtime', async () => {
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'remote-device',
              name: 'Remote Device',
              status: 'online',
              is_default: false,
              device_type: 'remote',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
              runtime_instance_id: 'runtime-local',
              runtime_routes: [
                {
                  kind: 'app-ipc',
                  device_id: 'app-device',
                  runtime_device_id: 'app-device',
                  device_type: 'app',
                  name: 'Local Executor',
                  status: 'online',
                },
                {
                  kind: 'remote-relay',
                  device_id: 'remote-device',
                  runtime_device_id: 'remote-device',
                  device_type: 'remote',
                  name: 'Remote Device',
                  status: 'online',
                },
              ],
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-remote-option'))

    expect(screen.getByTestId('standalone-folder-project-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('standalone-folder-no-device')).toHaveTextContent('连接一台云端设备')
    expect(screen.queryByTestId('standalone-remote-device-select')).not.toBeInTheDocument()
    expect(screen.queryByText('Remote Device')).not.toBeInTheDocument()
  })

  test('closes the project create dialog from its backdrop', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('projects-create-button'))
    expect(screen.getByTestId('projects-create-button-menu')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('project-create-dialog-overlay'))
    expect(screen.queryByTestId('projects-create-button-menu')).not.toBeInTheDocument()
  })

  test('renders the project create dialog as a centered page-level overlay', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('projects-create-button'))

    const dialog = screen.getByTestId('projects-create-button-menu')
    const overlay = screen.getByTestId('project-create-dialog-overlay')
    expect(document.body).toContainElement(dialog)
    expect(document.querySelector('aside')).not.toContainElement(dialog)
    expect(overlay).toHaveClass('fixed', 'inset-0', 'items-center', 'justify-center')
    expect(dialog).toHaveAttribute('role', 'dialog')
  })

  test('renders standalone folder dialog as a page-level overlay', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-remote-option'))

    const dialog = screen.getByTestId('standalone-folder-project-dialog')
    const overlay = dialog.parentElement

    expect(overlay).not.toBeNull()
    expect(document.body).toContainElement(overlay)
    expect(document.querySelector('aside')).not.toContainElement(overlay)
    expect(overlay).toHaveClass('fixed', 'inset-0')
    expect(dialog).toHaveClass('max-w-[520px]', 'rounded-[24px]', 'p-5')
  })

  test('closes the standalone remote project dialog on backdrop click', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-remote-option'))
    await userEvent.click(screen.getByTestId('standalone-folder-project-dialog-overlay'))

    expect(screen.queryByTestId('standalone-folder-project-dialog')).not.toBeInTheDocument()
  })

  test('opens local folder selection directly from the project work menu', async () => {
    const onRefreshDevices = vi.fn().mockResolvedValue(undefined)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onRefreshDevices={onRefreshDevices}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'device-1',
              name: 'executor',
              status: 'online',
              is_default: true,
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('project-work-button'))

    const menu = screen.getByTestId('project-work-menu')
    const addLocalProjectOption = screen.getByTestId('add-local-project-option')
    expect([...menu.querySelectorAll('button')].map(button => button.dataset.testid)).toEqual([
      'add-local-project-option',
      'add-remote-project-option',
      'no-project-option',
    ])

    await userEvent.click(addLocalProjectOption)

    expect(onRefreshDevices).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('project-work-menu')).not.toBeInTheDocument()
    expect(screen.getByTestId('standalone-folder-project-dialog')).toBeInTheDocument()
  })

  test('shows an empty remote project dialog when there are no remote or cloud devices', async () => {
    const onRefreshDevices = vi.fn().mockResolvedValue(undefined)

    render(<DesktopWorkbenchLayout {...baseProps} onRefreshDevices={onRefreshDevices} />)

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-remote-option'))

    expect(screen.getByTestId('standalone-folder-project-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('standalone-folder-no-device')).toHaveTextContent('连接一台云端设备')
    expect(screen.getByTestId('standalone-folder-no-device')).toHaveTextContent('启动脚本')
  })

  test('opens the standalone remote dialog from the project work menu', async () => {
    const onRefreshDevices = vi.fn().mockResolvedValue(undefined)

    render(<DesktopWorkbenchLayout {...baseProps} onRefreshDevices={onRefreshDevices} />)

    await userEvent.click(screen.getByTestId('project-work-button'))
    await userEvent.click(screen.getByTestId('add-remote-project-option'))

    expect(onRefreshDevices).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('standalone-folder-project-dialog')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '新建远程项目' })).toBeInTheDocument()
  })

  test('opens local project creation after selecting a folder in Finder', async () => {
    const onGetDeviceHomeDirectory = vi.fn().mockResolvedValue('/Users/alice')
    const onOpenStandaloneWorkspace = vi.fn()
    nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker.mockImplementation(
      async initialDirectory => {
        expect(initialDirectory).toBeUndefined()
        expect(screen.queryByTestId('projects-create-button-menu')).not.toBeInTheDocument()
        return '/Users/alice/repo'
      }
    )

    render(
      <StrictMode>
        <DesktopWorkbenchLayout
          {...baseProps}
          onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
          onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
          state={{
            ...baseProps.state,
            devices: [
              {
                id: 1,
                device_id: 'device-1',
                name: 'build-executor',
                status: 'online',
                is_default: true,
                bind_shell: 'claudecode',
                device_type: 'local',
                executor_version: '1.8.5',
              },
            ],
          }}
        />
      </StrictMode>
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-local-option'))

    await waitFor(() =>
      expect(nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker).toHaveBeenCalledTimes(1)
    )
    expect(onGetDeviceHomeDirectory).not.toHaveBeenCalled()
    expect(await screen.findByTestId('local-project-create-dialog')).toBeInTheDocument()
    await userEvent.type(screen.getByTestId('local-project-create-name-input'), 'Product')
    await userEvent.click(screen.getByTestId('confirm-local-project-create-button'))
    await waitFor(() =>
      expect(onOpenStandaloneWorkspace).toHaveBeenCalledWith(
        'device-1',
        '/Users/alice/repo',
        'Product',
        ['/Users/alice/repo']
      )
    )
    expect(screen.queryByTestId('standalone-folder-project-dialog')).not.toBeInTheDocument()
  })

  test('opens Finder without waiting for the local executor home directory', async () => {
    const onGetDeviceHomeDirectory = vi.fn(() => new Promise<string>(() => undefined))
    nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker.mockResolvedValue(null)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'device-1',
              name: 'build-executor',
              status: 'online',
              is_default: true,
              bind_shell: 'claudecode',
              device_type: 'local',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-local-option'))

    await waitFor(() =>
      expect(nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker).toHaveBeenCalledTimes(1)
    )
    expect(onGetDeviceHomeDirectory).not.toHaveBeenCalled()
  })

  test('opens the local project creation dialog under React StrictMode', async () => {
    const onOpenStandaloneWorkspace = vi.fn()
    nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker.mockResolvedValue(
      '/Users/alice/repo'
    )

    render(
      <StrictMode>
        <DesktopWorkbenchLayout
          {...baseProps}
          onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
          state={{
            ...baseProps.state,
            devices: [
              {
                id: 1,
                device_id: 'device-1',
                name: 'build-executor',
                status: 'online',
                is_default: true,
                bind_shell: 'claudecode',
                device_type: 'local',
                executor_version: '1.8.5',
              },
            ],
          }}
        />
      </StrictMode>
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-local-option'))

    await waitFor(() =>
      expect(nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker).toHaveBeenCalledTimes(1)
    )
    expect(await screen.findByTestId('local-project-create-dialog')).toBeInTheDocument()
    expect(onOpenStandaloneWorkspace).not.toHaveBeenCalled()
  })

  test('keeps the native folder picker active while callback identities change', async () => {
    const onOpenStandaloneWorkspace = vi.fn()
    let resolvePicker: (path: string) => void = () => undefined
    nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker.mockImplementation(
      () =>
        new Promise(resolve => {
          resolvePicker = resolve
        })
    )
    const props = {
      ...baseProps,
      state: {
        ...baseProps.state,
        devices: [
          {
            id: 1,
            device_id: 'device-1',
            name: 'build-executor',
            status: 'online' as const,
            is_default: true,
            bind_shell: 'claudecode' as const,
            device_type: 'local' as const,
            executor_version: '1.8.5',
          },
        ],
      },
    }
    const view = render(
      <DesktopWorkbenchLayout
        {...props}
        onOpenStandaloneWorkspace={(deviceId, workspacePath) =>
          onOpenStandaloneWorkspace(deviceId, workspacePath)
        }
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-local-option'))
    await waitFor(() =>
      expect(nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker).toHaveBeenCalledTimes(1)
    )

    view.rerender(
      <DesktopWorkbenchLayout
        {...props}
        onOpenStandaloneWorkspace={(deviceId, workspacePath) =>
          onOpenStandaloneWorkspace(deviceId, workspacePath)
        }
      />
    )
    resolvePicker('/Users/alice/repo')

    expect(await screen.findByTestId('local-project-create-dialog')).toBeInTheDocument()
    expect(onOpenStandaloneWorkspace).not.toHaveBeenCalled()
  })

  test('does not open the in-app folder dialog when the native folder picker is cancelled', async () => {
    const onOpenStandaloneWorkspace = vi.fn()
    nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker.mockResolvedValue(null)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'device-1',
              name: 'build-executor',
              status: 'online',
              is_default: true,
              bind_shell: 'claudecode',
              device_type: 'local',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-local-option'))

    await waitFor(() =>
      expect(nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker).toHaveBeenCalledTimes(1)
    )
    expect(onOpenStandaloneWorkspace).not.toHaveBeenCalled()
    expect(screen.queryByTestId('standalone-folder-project-dialog')).not.toBeInTheDocument()
  })

  test('uses the controllable folder dialog during desktop E2E verification', async () => {
    automationMocks.useNativeDirectoryPicker = false
    const onGetDeviceHomeDirectory = vi.fn().mockResolvedValue('/Users/alice')
    const onListDeviceDirectories = vi.fn().mockResolvedValue(['repo'])

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onListDeviceDirectories={onListDeviceDirectories}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'device-1',
              name: 'build-executor',
              status: 'online',
              is_default: true,
              bind_shell: 'claudecode',
              device_type: 'local',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-local-option'))

    expect(await screen.findByTestId('standalone-folder-project-dialog')).toBeInTheDocument()
    await waitFor(() => expect(onGetDeviceHomeDirectory).toHaveBeenCalledWith('device-1'))
    expect(nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker).not.toHaveBeenCalled()
  })

  test('keeps local project creation on the local device when a remote device is preferred', async () => {
    automationMocks.useNativeDirectoryPicker = false
    const onGetDeviceHomeDirectory = vi.fn().mockResolvedValue('/Users/alice')
    const onListDeviceDirectories = vi.fn().mockResolvedValue(['repo'])

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onListDeviceDirectories={onListDeviceDirectories}
        state={{
          ...baseProps.state,
          standaloneDeviceId: 'remote-device',
          devices: [
            {
              id: 1,
              device_id: 'local-device',
              name: 'Local Device',
              status: 'online',
              is_default: false,
              bind_shell: 'claudecode',
              device_type: 'local',
              executor_version: '1.8.5',
            },
            {
              id: 2,
              device_id: 'remote-device',
              name: '203.0.113.10',
              status: 'online',
              is_default: true,
              bind_shell: 'claudecode',
              device_type: 'remote',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-local-option'))

    await waitFor(() => expect(onGetDeviceHomeDirectory).toHaveBeenCalledWith('local-device'))
    expect(screen.getByTestId('standalone-folder-project-dialog')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '使用现有文件夹' })).toBeInTheDocument()
    expect(screen.queryByTestId('standalone-remote-device-select')).not.toBeInTheDocument()
    expect(nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker).not.toHaveBeenCalled()
  })

  test('opens a standalone Codex workspace from an existing remote folder selected in the directory tree', async () => {
    const onCreateProject = vi.fn().mockResolvedValue({ id: 2, name: 'repo', tasks: [] })
    const onPrepareDeviceWorkspace = vi.fn().mockResolvedValue({
      preparedAction: 'selected',
      mapping: {
        id: 10,
        userId: 1,
        projectId: 2,
        deviceId: 'device-1',
        workspacePath: '/home/ubuntu/repo',
        repoUrl: null,
        repoRootFingerprint: null,
        label: null,
        createdAt: '2026-06-21T00:00:00',
        updatedAt: '2026-06-21T00:00:00',
        lastSeenAt: null,
      },
    })
    const onGetDeviceHomeDirectory = vi.fn().mockResolvedValue('/home/ubuntu')
    const onListDeviceDirectories = vi.fn().mockResolvedValue(['.cache', 'repo'])
    const onOpenStandaloneWorkspace = vi.fn()

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        onCreateProject={onCreateProject}
        onPrepareDeviceWorkspace={onPrepareDeviceWorkspace}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onListDeviceDirectories={onListDeviceDirectories}
        onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
        state={{
          ...baseProps.state,
          devices: [
            {
              id: 1,
              device_id: 'device-1',
              name: 'build-executor',
              status: 'online',
              is_default: true,
              bind_shell: 'claudecode',
              device_type: 'remote',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('projects-create-button'))
    await userEvent.click(screen.getByTestId('project-create-remote-option'))

    await waitFor(() => expect(onGetDeviceHomeDirectory).toHaveBeenCalledWith('device-1'))
    await waitFor(() =>
      expect(onListDeviceDirectories).toHaveBeenCalledWith('device-1', '/home/ubuntu')
    )
    expect(screen.queryByText('.cache')).not.toBeInTheDocument()
    expect(screen.getByTestId('confirm-device-folder-picker-button')).toBeInTheDocument()

    const repoEntry = await screen.findByText('repo')
    await userEvent.click(repoEntry)
    expect(onListDeviceDirectories).not.toHaveBeenCalledWith('device-1', '/home/ubuntu/repo')

    await userEvent.dblClick(repoEntry)
    await waitFor(() =>
      expect(onListDeviceDirectories).toHaveBeenCalledWith('device-1', '/home/ubuntu/repo')
    )

    await userEvent.click(screen.getByTestId('confirm-device-folder-picker-button'))
    expect(onOpenStandaloneWorkspace).toHaveBeenCalledWith('device-1', '/home/ubuntu/repo')
    expect(onCreateProject).not.toHaveBeenCalled()
    expect(onPrepareDeviceWorkspace).not.toHaveBeenCalled()
    expect(nativeDirectoryPickerMocks.openNativeProjectDirectoryPicker).not.toHaveBeenCalled()
  })
})
