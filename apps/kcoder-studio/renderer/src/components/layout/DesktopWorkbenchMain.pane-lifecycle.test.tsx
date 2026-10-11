import { getDesktopWorkbenchHoistedMocks } from './DesktopWorkbenchLayout.test-mocks'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { requestDesktopFileAction } from '@/kcoder/desktopFileActions'
import userEvent from '@testing-library/user-event'
import { describe, expect, test } from 'vitest'
import { DesktopWorkbenchLayout, baseProps } from './DesktopWorkbenchLayout.test-harness'
import {
  closeLocalTerminalMock,
  expectAndClearConsoleWarn,
  getLocalExecutorDeviceIdMock,
  isLocalTerminalAvailableMock,
  localPathExistsMock,
  startDeviceTerminalSessionMock,
  startLocalTerminalMock,
  startTerminalSessionMock,
} from './DesktopWorkbenchLayout.test-mocks'
import {
  createLocalRuntimeTaskPanelFixture,
  renderWorkspacePanelLayout,
} from './DesktopWorkbenchMain.workspace.test-support'

const { cloudDesktopExtensionMock } = getDesktopWorkbenchHoistedMocks()

describe('DesktopWorkbenchLayout', () => {
  test('File temporary chat targets the active pane after A to B to A switching', async () => {
    const { localDevice, propsForTask, taskA, taskB } = createLocalRuntimeTaskPanelFixture()
    isLocalTerminalAvailableMock.mockReturnValue(true)
    getLocalExecutorDeviceIdMock.mockResolvedValue(localDevice.device_id)
    localPathExistsMock.mockResolvedValue(true)
    startLocalTerminalMock
      .mockResolvedValueOnce('menu-terminal-a')
      .mockResolvedValueOnce('menu-terminal-b')
    const activePane = () => within(screen.getByTestId('desktop-workbench-main'))
    const { rerender } = render(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)
    await userEvent.click(activePane().getByTestId('toggle-bottom-workspace-panel-button'))
    await waitFor(() => expect(startLocalTerminalMock).toHaveBeenCalledTimes(1))
    rerender(<DesktopWorkbenchLayout {...propsForTask(taskB)} />)
    await userEvent.click(activePane().getByTestId('toggle-bottom-workspace-panel-button'))
    await waitFor(() => expect(startLocalTerminalMock).toHaveBeenCalledTimes(2))
    rerender(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)
    act(() => requestDesktopFileAction('new-temporary-chat'))
    expect(activePane().getByTestId('right-workspace-chat-panel')).toBeInTheDocument()
    rerender(<DesktopWorkbenchLayout {...propsForTask(taskB)} />)
    expect(activePane().queryByTestId('right-workspace-chat-panel')).not.toBeInTheDocument()
  })
  test('closes the right workspace panel from the panel actions', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    const floatingActions = screen.getByTestId('workspace-panel-floating-actions')
    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    expect(screen.getByTestId('right-workspace-panel')).toBeInTheDocument()
    expect(floatingActions).toContainElement(
      screen.getByTestId('toggle-right-workspace-panel-button')
    )

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    expect(screen.queryByTestId('right-workspace-panel')).not.toBeInTheDocument()
    expect(floatingActions).toContainElement(
      screen.getByTestId('toggle-right-workspace-panel-button')
    )
  })

  test('opens and resizes the bottom workspace panel', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))

    const panel = screen.getByTestId('bottom-workspace-panel')
    expect(panel).toBeInTheDocument()
    expect(panel).toHaveClass(
      'transition-[height,opacity,transform]',
      'duration-300',
      'ease-out',
      'pointer-events-auto',
      'translate-y-0',
      'opacity-100'
    )
    expect(panel).toHaveAttribute('aria-hidden', 'false')
    expect(screen.getByTestId('desktop-workbench-content')).not.toContainElement(panel)
    expect(screen.getByTestId('desktop-workbench-main')).toContainElement(panel)
    expect(screen.getByTestId('toggle-bottom-workspace-panel-button')).toBeInTheDocument()
    expect(screen.getByTestId('toggle-right-workspace-panel-button')).toBeInTheDocument()

    fireEvent.pointerDown(screen.getByTestId('bottom-workspace-resize-handle'), { clientY: 700 })
    expect(panel).toHaveClass('transition-none')
    expect(panel).not.toHaveClass('transition-[height,opacity,transform]')
    fireEvent.pointerMove(document, { clientY: 620 })
    fireEvent.pointerUp(document)

    expect(panel).toHaveStyle({ height: '400px' })
    expect(panel).toHaveClass('transition-[height,opacity,transform]', 'duration-300')
  })

  test('starts a terminal directly when the bottom panel opens', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))

    await waitFor(() =>
      expect(startDeviceTerminalSessionMock).toHaveBeenCalledWith(
        'workspace-cloud-device',
        '/workspace/project'
      )
    )
    expect(screen.queryByTestId('workspace-tool-launcher')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-ide-card')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-terminal-window')).toBeInTheDocument()
  })

  test('restores an explicitly opened terminal when the bottom panel reopens', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))

    await waitFor(() =>
      expect(startDeviceTerminalSessionMock).toHaveBeenCalledWith(
        'workspace-cloud-device',
        '/workspace/project'
      )
    )
    expect(screen.getByTestId('remote-terminal')).toHaveAttribute('data-session-id', 'terminal-1')

    await userEvent.click(screen.getByTestId('close-bottom-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))

    expect(startDeviceTerminalSessionMock).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('remote-terminal')).toHaveAttribute('data-session-id', 'terminal-1')
    expect(screen.getByTestId('workspace-terminal-window')).toBeInTheDocument()
  })

  test('restores bottom terminal tabs and the active tab after a page remount', async () => {
    localStorage.setItem(
      'wework.workspace.bottom-terminal-tabs.v1:workspace:12:workspace-cloud-device:/workspace/project:current_workspace',
      JSON.stringify({
        activeTabId: 'terminal-2',
        tabIds: ['terminal-1', 'terminal-2'],
      })
    )

    renderWorkspacePanelLayout()
    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))

    const tabs = screen.getAllByTestId('bottom-workspace-terminal-tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]).toHaveAttribute('aria-selected', 'false')
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')

    await waitFor(() => expect(startDeviceTerminalSessionMock).toHaveBeenCalledTimes(1))
    await userEvent.click(tabs[0])
    await waitFor(() => expect(startDeviceTerminalSessionMock).toHaveBeenCalledTimes(2))
  })

  test('opens a local project terminal when a project is selected without an active task', async () => {
    const otherWorkspaceProject = {
      id: 31,
      name: 'ws1',
      tasks: [],
      config: {
        mode: 'workspace' as const,
        execution: {
          targetType: 'local' as const,
        },
        workspace: {
          source: 'local_path' as const,
          localPath: '/Users/me/ws1',
        },
      },
    }
    const localWorkspaceProject = {
      id: 32,
      name: 'Wegent',
      tasks: [],
      config: {
        mode: 'workspace' as const,
        execution: {
          targetType: 'local' as const,
        },
        workspace: {
          source: 'local_path' as const,
          localPath: '/Users/me/Wegent',
        },
      },
    }
    isLocalTerminalAvailableMock.mockReturnValue(true)
    localPathExistsMock.mockResolvedValue(true)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentProject: null,
          projects: [otherWorkspaceProject, localWorkspaceProject],
          devices: [],
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: [otherWorkspaceProject, localWorkspaceProject],
          currentProjectId: localWorkspaceProject.id,
        }}
      />
    )

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))

    await waitFor(() =>
      expect(startLocalTerminalMock).toHaveBeenCalledWith({
        cwd: '/Users/me/Wegent',
      })
    )
    expect(startTerminalSessionMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('embedded-local-terminal')).toHaveAttribute(
      'data-session-id',
      'local-terminal-1'
    )
    expect(screen.queryByTestId('workspace-local-device-limited-tools')).not.toBeInTheDocument()
  })

  test('uses local mode for a selected git project without an active task', async () => {
    const gitWorkspaceProject = {
      id: 33,
      name: 'Wegent',
      tasks: [],
      config: {
        mode: 'workspace' as const,
        execution: {
          targetType: 'cloud' as const,
          deviceId: 'workspace-cloud-device',
        },
        workspace: {
          source: 'git' as const,
          checkoutPath: '/Users/me/Wegent',
        },
      },
    }
    isLocalTerminalAvailableMock.mockReturnValue(true)
    getLocalExecutorDeviceIdMock.mockResolvedValue(null)
    localPathExistsMock.mockResolvedValue(true)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentProject: null,
          projects: [gitWorkspaceProject],
          devices: [],
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: [gitWorkspaceProject],
          currentProjectId: gitWorkspaceProject.id,
          executionMode: 'current_workspace',
        }}
      />
    )

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))

    await waitFor(() =>
      expect(startLocalTerminalMock).toHaveBeenCalledWith({
        cwd: '/Users/me/Wegent',
      })
    )
    expect(startTerminalSessionMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('embedded-local-terminal')).toHaveAttribute(
      'data-session-id',
      'local-terminal-1'
    )
    expect(screen.queryByTestId('workspace-local-device-limited-tools')).not.toBeInTheDocument()
  })

  test('opens the selected runtime project workspace path instead of the home directory', async () => {
    const runtimeProject = {
      id: 34,
      name: 'Wegent',
      tasks: [],
    }
    const localDevice = {
      id: 41,
      device_id: 'local-device',
      name: 'Mac',
      status: 'online' as const,
      is_default: false,
      device_type: 'local' as const,
      bind_shell: 'claudecode',
      executor_version: '1.8.5',
    }
    isLocalTerminalAvailableMock.mockReturnValue(true)
    getLocalExecutorDeviceIdMock.mockResolvedValue('local-device')
    localPathExistsMock.mockResolvedValue(true)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentProject: runtimeProject,
          projects: [],
          devices: [localDevice],
          runtimeWork: {
            projects: [
              {
                project: {
                  id: runtimeProject.id,
                  key: 'project:wegent',
                  name: runtimeProject.name,
                },
                deviceWorkspaces: [
                  {
                    id: 42,
                    deviceId: localDevice.device_id,
                    deviceStatus: 'online',
                    available: true,
                    workspacePath: '/Users/me/Wegent',
                    workspaceSource: 'local',
                    tasks: [],
                  },
                ],
              },
            ],
            chats: [],
            totalTasks: 0,
          },
        }}
        projectWork={{
          ...baseProps.projectWork,
          projects: [],
          devices: [localDevice],
          runtimeWork: {
            projects: [
              {
                project: {
                  id: runtimeProject.id,
                  key: 'project:wegent',
                  name: runtimeProject.name,
                },
                deviceWorkspaces: [
                  {
                    id: 42,
                    deviceId: localDevice.device_id,
                    deviceStatus: 'online',
                    available: true,
                    workspacePath: '/Users/me/Wegent',
                    workspaceSource: 'local',
                    tasks: [],
                  },
                ],
              },
            ],
            chats: [],
            totalTasks: 0,
          },
          currentProject: runtimeProject,
          currentProjectId: runtimeProject.id,
          selectedDeviceWorkspaceId: 42,
          executionMode: 'current_workspace',
        }}
      />
    )

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))

    await waitFor(() =>
      expect(startLocalTerminalMock).toHaveBeenCalledWith({
        cwd: '/Users/me/Wegent',
      })
    )
    expect(startTerminalSessionMock).not.toHaveBeenCalled()
    expect(localPathExistsMock).toHaveBeenCalledWith('/Users/me/Wegent')
    expect(screen.queryByTestId('workspace-local-device-limited-tools')).not.toBeInTheDocument()
  })

  test('preserves bottom terminal state when switching runtime tasks', async () => {
    const { localDevice, propsForTask, taskA, taskB } = createLocalRuntimeTaskPanelFixture()
    isLocalTerminalAvailableMock.mockReturnValue(true)
    getLocalExecutorDeviceIdMock.mockResolvedValue(localDevice.device_id)
    localPathExistsMock.mockResolvedValue(true)
    startLocalTerminalMock
      .mockResolvedValueOnce('local-terminal-a')
      .mockResolvedValueOnce('local-terminal-b')
    const visibleLocalTerminals = () =>
      within(screen.getByTestId('desktop-workbench-main'))
        .queryAllByTestId('embedded-local-terminal')
        .filter(element => !element.hasAttribute('hidden'))

    const { rerender } = render(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))

    await waitFor(() =>
      expect(startLocalTerminalMock).toHaveBeenCalledWith({
        cwd: '/Users/me/Wegent/.worktrees/a',
        env: {
          KCODER_STUDIO_PARENT_TITLE: 'Task A',
          KCODER_STUDIO_PARENT_PROJECT: 'Wegent',
          KCODER_STUDIO_PARENT_WORKSPACE: '/Users/me/Wegent/.worktrees/a',
        },
      })
    )
    await waitFor(() => {
      const terminals = visibleLocalTerminals()
      expect(terminals).toHaveLength(1)
      expect(terminals[0]).toHaveAttribute('data-session-id', 'local-terminal-a')
    })

    rerender(<DesktopWorkbenchLayout {...propsForTask(taskB)} />)

    expect(visibleLocalTerminals()).toHaveLength(0)
    expect(startLocalTerminalMock).toHaveBeenCalledTimes(1)

    await userEvent.click(
      within(screen.getByTestId('desktop-workbench-main')).getByTestId(
        'toggle-bottom-workspace-panel-button'
      )
    )

    await waitFor(() =>
      expect(startLocalTerminalMock).toHaveBeenCalledWith({
        cwd: '/Users/me/Wegent/.worktrees/b',
        env: {
          KCODER_STUDIO_PARENT_TITLE: 'Task B',
          KCODER_STUDIO_PARENT_PROJECT: 'Wegent',
          KCODER_STUDIO_PARENT_WORKSPACE: '/Users/me/Wegent/.worktrees/b',
        },
      })
    )
    await waitFor(() => {
      const terminals = visibleLocalTerminals()
      expect(terminals).toHaveLength(1)
      expect(terminals[0]).toHaveAttribute('data-session-id', 'local-terminal-b')
    })

    rerender(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)

    await waitFor(() => {
      const terminals = visibleLocalTerminals()
      expect(terminals).toHaveLength(1)
      expect(terminals[0]).toHaveAttribute('data-session-id', 'local-terminal-a')
    })
    expect(startLocalTerminalMock).toHaveBeenCalledTimes(2)
    expect(closeLocalTerminalMock).not.toHaveBeenCalled()
  })

  test('preserves the right workspace browser state when switching runtime tasks', async () => {
    const { propsForTask, taskA, taskB } = createLocalRuntimeTaskPanelFixture()
    const activePane = () => within(screen.getByTestId('desktop-workbench-main'))
    const { rerender } = render(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)

    await userEvent.click(activePane().getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(activePane().getByTestId('right-workspace-browser-option'))
    await userEvent.type(
      activePane().getByTestId('workspace-browser-url-input'),
      'example.com{Enter}'
    )

    expect(activePane().getByTestId('workspace-browser-url-input')).toHaveValue(
      'https://example.com/'
    )

    rerender(<DesktopWorkbenchLayout {...propsForTask(taskB)} />)
    expect(activePane().queryByTestId('workspace-browser-panel')).not.toBeInTheDocument()

    rerender(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)

    expect(activePane().getByTestId('right-workspace-panel-shell')).toHaveAttribute(
      'aria-hidden',
      'false'
    )
    expect(activePane().getByTestId('right-workspace-browser-tab')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(activePane().getByTestId('workspace-browser-url-input')).toHaveValue(
      'https://example.com/'
    )
    expect(activePane().getByTestId('workspace-browser-frame')).toHaveAttribute(
      'src',
      'https://example.com/'
    )
  })

  test('restores serializable right workspace state without retaining the conversation pane', async () => {
    const { propsForTask, taskA, taskB } = createLocalRuntimeTaskPanelFixture()
    const activePane = () => within(screen.getByTestId('desktop-workbench-main'))
    const { rerender } = render(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)

    await userEvent.click(activePane().getByTestId('toggle-right-workspace-panel-button'))
    expect(activePane().getByTestId('right-workspace-launcher')).toBeInTheDocument()

    rerender(<DesktopWorkbenchLayout {...propsForTask(taskB)} />)
    expect(activePane().queryByTestId('right-workspace-panel')).not.toBeInTheDocument()

    rerender(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)

    expect(activePane().getByTestId('right-workspace-panel-shell')).toHaveAttribute(
      'aria-hidden',
      'false'
    )
    expect(activePane().getByTestId('right-workspace-launcher')).toBeInTheDocument()
  })

  test('resets cached conversation horizontal scroll when the task becomes active', () => {
    const { propsForTask, taskA, taskB } = createLocalRuntimeTaskPanelFixture()
    const { rerender } = render(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)
    const activeContent = () =>
      within(screen.getByTestId('desktop-workbench-main')).getByTestId('desktop-workbench-content')

    activeContent().scrollLeft = 180
    rerender(<DesktopWorkbenchLayout {...propsForTask(taskB)} />)
    rerender(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)

    expect(activeContent().scrollLeft).toBe(0)
  })

  test('keeps runtime task terminals alive while switching through many tasks', async () => {
    const { localDevice, propsForTask, taskA, taskAddresses } = createLocalRuntimeTaskPanelFixture()
    isLocalTerminalAvailableMock.mockReturnValue(true)
    getLocalExecutorDeviceIdMock.mockResolvedValue(localDevice.device_id)
    localPathExistsMock.mockResolvedValue(true)
    taskAddresses.forEach(task => {
      const suffix = task.taskId.replace('runtime-', '')
      startLocalTerminalMock.mockResolvedValueOnce(`local-terminal-${suffix}`)
    })
    const visibleLocalTerminals = () =>
      within(screen.getByTestId('desktop-workbench-main'))
        .queryAllByTestId('embedded-local-terminal')
        .filter(element => !element.hasAttribute('hidden'))

    const { rerender } = render(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)

    for (const [index, task] of taskAddresses.entries()) {
      if (index > 0) {
        rerender(<DesktopWorkbenchLayout {...propsForTask(task)} />)
      }
      const suffix = task.taskId.replace('runtime-', '')
      await userEvent.click(
        within(screen.getByTestId('desktop-workbench-main')).getByTestId(
          'toggle-bottom-workspace-panel-button'
        )
      )
      await waitFor(() => {
        const terminals = visibleLocalTerminals()
        expect(terminals).toHaveLength(1)
        expect(terminals[0]).toHaveAttribute('data-session-id', `local-terminal-${suffix}`)
      })
    }

    expect(startLocalTerminalMock).toHaveBeenCalledTimes(taskAddresses.length)
    expect(closeLocalTerminalMock).not.toHaveBeenCalled()
    expectAndClearConsoleWarn('[KCoder Studio] Runtime sidebar selected task is hidden', 6)
  }, 20000)

  test('omits the desktop add-menu item when the internal extension is unavailable', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('workspace-terminal-new-tab-button'))

    const menu = screen.getByTestId('workspace-terminal-new-tab-menu')
    expect(within(menu).getByTestId('workspace-add-terminal-option')).toBeInTheDocument()
    expect(within(menu).queryByTestId('workspace-add-ide-option')).not.toBeInTheDocument()
    expect(within(menu).queryByTestId('workspace-add-desktop-option')).not.toBeInTheDocument()
  })

  test('opens the bottom workspace add menu without replacing the terminal', async () => {
    cloudDesktopExtensionMock.available = true
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))
    await waitFor(() =>
      expect(startDeviceTerminalSessionMock).toHaveBeenCalledWith(
        'workspace-cloud-device',
        '/workspace/project'
      )
    )

    expect(screen.getByTestId('bottom-workspace-panel')).not.toHaveClass('rounded-t-xl')
    expect(screen.getByTestId('bottom-workspace-tabbar')).toHaveClass('bg-background')
    expect(screen.getByTestId('bottom-workspace-tabbar')).not.toHaveClass('border-b')
    const initialTab = screen.getByTestId('bottom-workspace-terminal-tab')
    expect(initialTab).toHaveClass('bg-muted', 'text-text-primary')
    expect(initialTab).not.toHaveClass('border', 'border-border', 'shadow-sm')
    expect(initialTab).not.toHaveTextContent('终端')
    await waitFor(() => expect(initialTab).toHaveTextContent('project'))
    expect(initialTab).toHaveAttribute('title', 'project')
    expect(initialTab).toHaveClass('max-w-[200px]', 'pr-7')
    expect(initialTab).not.toHaveClass('hover:max-w-none')
    const initialCloseButton = within(initialTab).getByTestId('close-bottom-workspace-tab-button')
    expect(initialCloseButton).toHaveClass(
      'group-hover:bg-border/70',
      'hover:!bg-text-secondary',
      'hover:text-background'
    )
    expect(initialCloseButton).not.toHaveClass('hover:bg-black/70', 'hover:text-white')

    await userEvent.click(screen.getByTestId('workspace-terminal-new-tab-button'))

    const menu = screen.getByTestId('workspace-terminal-new-tab-menu')
    expect(menu).toBeInTheDocument()
    expect(screen.getByTestId('workspace-terminal-window')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-tool-launcher')).not.toBeInTheDocument()
    expect(within(menu).getByTestId('workspace-add-terminal-option')).toHaveTextContent('终端')
    expect(within(menu).queryByTestId('workspace-add-ide-option')).not.toBeInTheDocument()
    expect(within(menu).getByTestId('workspace-add-desktop-option')).toHaveTextContent('桌面')
    expect(within(menu).queryByTestId('workspace-add-review-option')).not.toBeInTheDocument()
    expect(within(menu).queryByTestId('workspace-add-browser-option')).not.toBeInTheDocument()
    expect(within(menu).queryByTestId('workspace-add-files-option')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('workspace-add-desktop-option'))

    await waitFor(() =>
      expect(cloudDesktopExtensionMock.launch).toHaveBeenCalledWith({ notifyOpened: false })
    )
    expect(screen.getByTestId('bottom-workspace-panel')).toHaveAttribute('aria-hidden', 'false')
    expect(screen.getByTestId('remote-terminal')).toHaveAttribute('data-session-id', 'terminal-1')

    await userEvent.click(screen.getByTestId('workspace-terminal-new-tab-button'))
    const terminalMenu = screen.getByTestId('workspace-terminal-new-tab-menu')

    await userEvent.click(within(terminalMenu).getByTestId('workspace-add-terminal-option'))

    expect(screen.queryByTestId('workspace-terminal-new-tab-menu')).not.toBeInTheDocument()
    await waitFor(() => expect(startDeviceTerminalSessionMock).toHaveBeenCalledTimes(2))
    expect(screen.getAllByTestId('remote-terminal')).toHaveLength(2)
    expect(screen.getAllByTestId('bottom-workspace-terminal-tab')).toHaveLength(2)
    expect(screen.getAllByTestId('bottom-workspace-terminal-tab')[1]).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('right-workspace-panel-shell')).toHaveAttribute('aria-hidden', 'true')
  })

  test('closes the bottom workspace panel from the panel edge', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))
    const panel = screen.getByTestId('bottom-workspace-panel')
    expect(panel).toBeInTheDocument()
    expect(panel).toHaveClass('opacity-100')

    await userEvent.click(screen.getByTestId('close-bottom-workspace-panel-button'))

    expect(panel).toBeInTheDocument()
    expect(panel).toHaveStyle({ height: '0px' })
    expect(panel).toHaveClass('pointer-events-none', 'translate-y-3', 'opacity-0')
    expect(panel).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('toggle-bottom-workspace-panel-button')).toBeInTheDocument()
  })
})
