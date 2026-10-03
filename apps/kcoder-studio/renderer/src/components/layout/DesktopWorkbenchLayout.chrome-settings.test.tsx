import './DesktopWorkbenchLayout.test-mocks'

const runtimeEnvironmentMock = vi.hoisted(() => ({
  isMacOSRuntime: vi.fn(() => true),
}))
vi.mock('@/lib/runtime-environment', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/runtime-environment')>()),
  isMacOSRuntime: runtimeEnvironmentMock.isMacOSRuntime,
}))
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test } from 'vitest'
import { getKeyboardPlatform } from '@/lib/keyboard-platform'
import { requestDesktopSidebarToggle } from './useDesktopSidebarCollapsed'
import {
  DesktopWorkbenchLayout,
  baseProps,
  getDesktopWorkbenchMainElement,
} from './DesktopWorkbenchLayout.test-harness'
import {
  expectAndClearConsoleError,
  getLocalCodexUsageDisplayMock,
  isLocalTerminalAvailableMock,
  openExternalUrlMock,
  openLocalWorkspaceMock,
  startCodeServerSessionMock,
} from './DesktopWorkbenchLayout.test-mocks'

describe('DesktopWorkbenchLayout', () => {
  test('restores and stores sidebar width in localStorage', () => {
    localStorage.setItem('wework.desktop.sidebar.width', '340')

    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(document.querySelector('aside')).toHaveStyle({ width: '340px' })

    fireEvent.pointerDown(screen.getByTestId('sidebar-resize-handle'))
    fireEvent.pointerMove(document, { clientX: 360 })
    fireEvent.pointerUp(document)

    expect(document.querySelector('aside')).toHaveStyle({ width: '360px' })
    expect(localStorage.getItem('wework.desktop.sidebar.width')).toBe('360')
  })

  test('clamps sidebar resizing to the maximum width', () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    fireEvent.pointerDown(screen.getByTestId('sidebar-resize-handle'))
    fireEvent.pointerMove(document, { clientX: 900 })
    fireEvent.pointerUp(document)

    expect(document.querySelector('aside')).toHaveStyle({ width: '480px' })
    expect(localStorage.getItem('wework.desktop.sidebar.width')).toBe('480')
  })

  test('collapses the sidebar when dragging below the close threshold', () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    const sidebar = screen.getByTestId('desktop-sidebar')
    expect(sidebar).toHaveStyle({ width: '240px' })

    fireEvent.pointerDown(screen.getByTestId('sidebar-resize-handle'))
    fireEvent.pointerMove(document, { clientX: 150 })

    expect(sidebar).toHaveStyle({ width: '0px' })
    expect(sidebar).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('desktop-sidebar-hover-edge')).toBeInTheDocument()
    expect(getDesktopWorkbenchMainElement()).not.toHaveClass('ml-1.5')
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
  })

  test('uses the selected sidebar width as the default', () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(document.querySelector('aside')).toHaveStyle({ width: '240px' })
  })

  test('clamps older narrow stored sidebar widths to the new minimum', () => {
    localStorage.setItem('wework.desktop.sidebar.width', '240')

    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(document.querySelector('aside')).toHaveStyle({ width: '240px' })
  })

  test('auto-collapses the sidebar in compact desktop windows and restores it when wide', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 920,
    })

    render(<DesktopWorkbenchLayout {...baseProps} />)

    const sidebar = screen.getByTestId('desktop-sidebar')
    await waitFor(() => expect(sidebar).toHaveStyle({ width: '0px' }))
    expect(sidebar).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('desktop-sidebar-hover-edge')).toBeInTheDocument()

    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1200,
    })
    fireEvent.resize(window)

    await waitFor(() => expect(sidebar).toHaveStyle({ width: '240px' }))
    expect(sidebar).toHaveAttribute('aria-hidden', 'false')
  })

  test('expands an auto-collapsed sidebar from the titlebar toggle request', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 920,
    })

    render(<DesktopWorkbenchLayout {...baseProps} />)

    const sidebar = screen.getByTestId('desktop-sidebar')
    await waitFor(() => expect(sidebar).toHaveStyle({ width: '0px' }))
    expect(sidebar).toHaveAttribute('aria-hidden', 'true')

    let handled = false
    act(() => {
      handled = requestDesktopSidebarToggle()
    })

    expect(handled).toBe(true)
    await waitFor(() => expect(sidebar).toHaveStyle({ width: '240px' }))
    expect(sidebar).toHaveAttribute('aria-hidden', 'false')
  })

  test('collapses and expands the sidebar', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.queryByTestId('desktop-sidebar-topbar')).not.toBeInTheDocument()
    expect(getDesktopWorkbenchMainElement()).toHaveClass('mt-1.5')
    expect(getDesktopWorkbenchMainElement()).not.toHaveClass('mb-1.5', 'mr-1.5', 'ml-1.5')
    expect(screen.getByTestId('collapse-sidebar-button')).toHaveClass('h-8', 'w-8', 'rounded-lg')
    expect(screen.getByTestId('sidebar-resize-handle')).toHaveClass('right-[-14px]', 'w-[18px]')
    expect(screen.getByTestId('workbench-topbar-left-actions')).toContainElement(
      screen.getByTestId('desktop-window-controls')
    )
    expect(screen.queryByTestId('workbench-topbar-right-actions')).not.toBeInTheDocument()
    expect(screen.queryByTestId('environment-info-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-panel-floating-actions')).toContainElement(
      screen.getByTestId('toggle-bottom-workspace-panel-button')
    )
    expect(screen.getByTestId('workspace-panel-floating-actions')).toContainElement(
      screen.getByTestId('toggle-right-workspace-panel-button')
    )

    const sidebar = screen.getByTestId('desktop-sidebar')
    expect(sidebar).toHaveStyle({ width: '240px' })
    await userEvent.click(screen.getByTestId('collapse-sidebar-button'))

    expect(sidebar).toHaveStyle({ width: '0px' })
    expect(sidebar).toHaveAttribute('aria-hidden', 'true')
    expect(sidebar).toHaveClass(
      'transition-[width,background-color]',
      'duration-[300ms]',
      'will-change-[width]'
    )
    expect(screen.getByTestId('expand-sidebar-button')).toBeInTheDocument()
    expect(screen.getByTestId('workbench-topbar-left-actions')).toContainElement(
      screen.getByTestId('desktop-window-controls')
    )
    expect(getDesktopWorkbenchMainElement()).toHaveClass('mt-1.5')
    expect(getDesktopWorkbenchMainElement()).not.toHaveClass('mb-1.5', 'mr-1.5', 'ml-1.5')
    expect(getDesktopWorkbenchMainElement()).toHaveClass('transition-[margin]', 'duration-[300ms]')
    expect(getDesktopWorkbenchMainElement()).not.toHaveClass('will-change-[margin]')
    expect(screen.getByTestId('desktop-empty-composer-dock')).toHaveClass(
      'w-[min(46rem,calc(100%_-_2rem))]'
    )
    expect(document.querySelector('aside')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('expand-sidebar-button'))

    expect(screen.getByText('新建任务')).toBeInTheDocument()
    expect(sidebar).toHaveStyle({ width: '240px' })
    expect(sidebar).toHaveAttribute('aria-hidden', 'false')
    expect(screen.getByTestId('desktop-empty-composer-dock')).toHaveClass(
      'w-[min(46rem,calc(100%_-_2rem))]'
    )
  })

  test('slides out a sidebar preview from the left edge without resizing the workspace', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('collapse-sidebar-button'))

    const main = getDesktopWorkbenchMainElement()
    const preview = screen.getByTestId('desktop-sidebar-preview')
    expect(main).not.toHaveClass('ml-1.5')
    expect(screen.getByTestId('desktop-sidebar-hover-edge')).toHaveClass('w-4')
    expect(preview).toHaveClass('pointer-events-none', '-translate-x-full', 'opacity-100')

    fireEvent.pointerEnter(screen.getByTestId('desktop-sidebar-hover-edge'))

    expect(preview).toHaveClass('pointer-events-auto', 'translate-x-0', 'opacity-100')
    expect(preview).toHaveClass('h-full')
    expect(screen.getByTestId('desktop-sidebar-preview-panel')).toHaveClass('h-full')
    expect(screen.getByTestId('desktop-sidebar-preview-panel')).toHaveStyle({ width: '240px' })
    expect(main).not.toHaveClass('ml-1.5')

    fireEvent.pointerEnter(preview)

    expect(preview).toHaveClass('translate-x-0', 'opacity-100')

    fireEvent.pointerLeave(preview)

    expect(preview).toHaveClass('pointer-events-none', '-translate-x-full', 'opacity-100')
    expect(main).not.toHaveClass('ml-1.5')
  })

  test('keeps sidebar controls out of the page chrome in Tauri', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.queryByTestId('desktop-sidebar-topbar')).not.toBeInTheDocument()
    expect(screen.getByTestId('desktop-sidebar')).toContainElement(
      screen.getByTestId('collapse-sidebar-button')
    )
    expect(screen.getByTestId('desktop-sidebar-chrome-controls')).toContainElement(
      screen.getByTestId('collapse-sidebar-button')
    )
    expect(screen.getByTestId('desktop-sidebar-chrome-controls')).toHaveClass('left-[92px]')
    expect(screen.getByTestId('desktop-sidebar-chrome-controls')).toContainElement(
      screen.getByTestId('chrome-tab-studio')
    )
    expect(screen.queryByTestId('chrome-tab-todo')).not.toBeInTheDocument()
    expect(screen.queryByTestId('chrome-tab-apps')).not.toBeInTheDocument()
    expect(screen.getByTestId('desktop-app-switcher')).toHaveTextContent('任务')
    expect(screen.queryByTestId('workbench-topbar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('environment-info-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('titlebar-actions')).toContainElement(
      screen.getByTestId('toggle-bottom-workspace-panel-button')
    )
    expect(screen.getByTestId('titlebar-actions')).toContainElement(
      screen.getByTestId('toggle-right-workspace-panel-button')
    )
    expect(screen.getByTestId('desktop-workbench-content')).not.toHaveClass('pt-11')
    expect(getDesktopWorkbenchMainElement()).not.toHaveClass('mt-1.5', 'mb-1.5', 'mr-1.5')
  })

  test('keeps a collapsed Tauri task title clear of titlebar controls', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    localStorage.setItem('wework.desktop.sidebar.collapsed', 'true')

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
                    title:
                      'wework的聊天链路现在代码逻辑比较混乱，尤其是状态方面，经常出现消息结束了但是发送按钮还显示运行中',
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

    expect(screen.queryByTestId('workbench-topbar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workbench-topbar-left-actions')).not.toBeInTheDocument()
    expect(screen.getByTestId('workbench-main-header')).toContainElement(
      screen.getByTestId('workbench-pane-task-title')
    )
    expect(screen.getByTestId('workbench-main-header')).toHaveClass('h-[38px]', 'border-b')
    // Only macOS reserves space for the traffic-light buttons; on Windows/Linux the titlebar starts directly from the left edge.
    expect(screen.getByTestId('workbench-main-header-left-controls')).toHaveClass('pl-[92px]')
    expect(screen.getByTestId('workbench-main-header-left-controls')).toContainElement(
      screen.getByTestId('expand-sidebar-button')
    )
    const collapsedHeaderControls = within(
      screen.getByTestId('workbench-main-header-left-controls')
    )
    expect(collapsedHeaderControls.getByTestId('chrome-tab-studio')).toBeInTheDocument()
    expect(collapsedHeaderControls.queryByTestId('chrome-tab-todo')).not.toBeInTheDocument()
    expect(collapsedHeaderControls.queryByTestId('chrome-tab-apps')).not.toBeInTheDocument()
    expect(screen.getByTestId('workbench-pane-task-title')).toHaveClass(
      'relative',
      'h-full',
      'flex-1',
      'pl-4',
      'truncate'
    )
    expect(screen.getByTestId('titlebar-main-actions')).toBeInTheDocument()
    expect(screen.getByTestId('workbench-pane-task-title')).toHaveTextContent(
      'wework的聊天链路现在代码逻辑比较混乱'
    )
    expect(screen.getByTestId('workbench-pane-task-title')).not.toHaveAttribute('title')
    expect(screen.getByTestId('desktop-workbench-content')).not.toHaveClass('pt-11')
    expect(getDesktopWorkbenchMainElement()).toHaveClass('top-0')
    expect(getDesktopWorkbenchMainElement()).not.toHaveClass('rounded-xl')
  })

  test('lets the workbench background show through the Tauri right workspace titlebar', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    localStorage.setItem(
      'wework.appearance',
      JSON.stringify({
        backgroundImagePath: '/app-data/background.png',
        backgroundInTopBar: true,
      })
    )

    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.getByTestId('workbench-main-header')).toHaveClass('bg-background/20')
    expect(screen.getByTestId('titlebar-right-workspace-zone')).toHaveClass('bg-transparent')
    expect(screen.getByTestId('titlebar-right-workspace-zone')).not.toHaveClass('bg-background/95')
  })

  test('opens project code-server from the Tauri titlebar', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: '24a59054-4638-4744-983d-372706c30fcd',
              },
            },
            tasks: [],
          },
          devices: [
            {
              id: 1,
              device_id: '24a59054-4638-4744-983d-372706c30fcd',
              name: 'cloud executor',
              status: 'online',
              is_default: false,
              device_type: 'cloud',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('open-code-server-titlebar-button'))

    await waitFor(() => expect(startCodeServerSessionMock).toHaveBeenCalledWith(1))
    expect(openExternalUrlMock).toHaveBeenCalledWith('http://localhost/ide', {
      target: 'system',
    })
    expect(screen.getByTestId('titlebar-main-actions')).toContainElement(
      screen.getByTestId('open-code-server-titlebar-button')
    )
    expect(screen.getByTestId('open-code-server-titlebar-button')).toHaveAttribute(
      'title',
      '打开项目 IDE'
    )
    expect(screen.getByTestId('toggle-bottom-workspace-panel-button')).not.toHaveAttribute('title')
    expect(screen.getByTestId('toggle-right-workspace-panel-button')).not.toHaveAttribute('title')
    const bottomPanelTooltip = screen.getByText('切换底部面板显示').closest('[role="tooltip"]')
    expect(bottomPanelTooltip).toHaveTextContent(getKeyboardPlatform() === 'mac' ? '⌘' : 'Ctrl')
    expect(bottomPanelTooltip).toHaveTextContent('J')
  })

  test('shows project code-server in the Tauri titlebar before devices hydrate', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: '24a59054-4638-4744-983d-372706c30fcd',
              },
            },
            tasks: [],
          },
          devices: [],
        }}
      />
    )

    expect(screen.getByTestId('titlebar-main-actions')).toContainElement(
      screen.getByTestId('open-code-server-titlebar-button')
    )
  })

  test('opens the local project from the Tauri titlebar with VS Code for local devices', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    isLocalTerminalAvailableMock.mockReturnValue(true)

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: 'local-claude',
              },
              workspace: {
                source: 'local_path',
                localPath: '/Users/me/github_wegent',
              },
            },
            tasks: [],
          },
          devices: [
            {
              id: 1,
              device_id: 'local-claude',
              name: 'local claude',
              status: 'online',
              is_default: false,
              device_type: 'local',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    const button = screen.getByTestId('open-code-server-titlebar-button')
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('title', '使用 VS Code 打开')

    await userEvent.click(button)

    expect(openLocalWorkspaceMock).toHaveBeenCalledWith({
      opener: 'vscode',
      path: '/Users/me/github_wegent',
    })
    expect(startCodeServerSessionMock).not.toHaveBeenCalled()
  })

  test('shows a dialog when project code-server fails to start', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    startCodeServerSessionMock.mockRejectedValueOnce(
      new Error('Local devices do not support code-server sessions')
    )

    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          currentProject: {
            id: 1,
            name: 'github_wegent',
            config: {
              mode: 'workspace',
              execution: {
                targetType: 'local',
                deviceId: '24a59054-4638-4744-983d-372706c30fcd',
              },
            },
            tasks: [],
          },
          devices: [
            {
              id: 1,
              device_id: '24a59054-4638-4744-983d-372706c30fcd',
              name: 'cloud executor',
              status: 'online',
              is_default: false,
              device_type: 'cloud',
              bind_shell: 'claudecode',
              executor_version: '1.8.5',
            },
          ],
        }}
      />
    )

    await userEvent.click(screen.getByTestId('open-code-server-titlebar-button'))

    expect(await screen.findByTestId('code-server-error-dialog')).toHaveTextContent(
      'Local devices do not support code-server sessions'
    )
    expectAndClearConsoleError(
      'Failed to start project IDE:',
      expect.objectContaining({ message: 'Local devices do not support code-server sessions' })
    )
  })

  test('keeps panel toggles in stable workbench actions on web', () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.queryByTestId('workbench-topbar-right-actions')).not.toBeInTheDocument()
    expect(screen.getByTestId('workbench-topbar')).toHaveClass('z-chrome')
    expect(screen.getByTestId('workspace-panel-floating-actions')).toHaveClass(
      'pointer-events-auto',
      'z-popover'
    )
    expect(screen.queryByTestId('environment-info-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-panel-floating-actions')).toContainElement(
      screen.getByTestId('toggle-bottom-workspace-panel-button')
    )
    expect(screen.getByTestId('workspace-panel-floating-actions')).toContainElement(
      screen.getByTestId('toggle-right-workspace-panel-button')
    )
    expect(screen.queryByTestId('titlebar-actions')).not.toBeInTheDocument()
  })

  test('opens the settings menu from the sidebar', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('settings-button'))

    expect(screen.getByTestId('settings-menu')).toBeInTheDocument()
    expect(screen.queryByTestId('usage-menu-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('settings-menu-button')).toHaveTextContent('设置')
    expect(screen.getByTestId('settings-menu-button')).toHaveTextContent(
      getKeyboardPlatform() === 'mac' ? '⌘,' : 'Ctrl,'
    )
    expect(screen.getByText('退出登录')).toBeInTheDocument()
  })

  test('opens settings page from the browser path on reload', () => {
    window.history.pushState({}, '', '/settings')

    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.getByTestId('studio-settings-page')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '我们该做什么？', hidden: true })).not.toBeVisible()
  })

  test('preserves the composer while visiting settings', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)
    const composerHeading = screen.getByRole('heading', { name: '我们该做什么？' })

    await userEvent.click(screen.getByTestId('settings-button'))
    await userEvent.click(screen.getByTestId('settings-menu-button'))
    expect(composerHeading).not.toBeVisible()
    await userEvent.click(screen.getByTestId('settings-back-button'))

    expect(screen.getByRole('heading', { name: '我们该做什么？' })).toBe(composerHeading)
    expect(composerHeading).toBeVisible()
  })

  test('does not show a page scrollbar for the empty task launcher', () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    expect(screen.getByTestId('desktop-workbench-content')).toHaveClass('overflow-hidden')
    expect(screen.getByTestId('desktop-workbench-content')).not.toHaveClass('overflow-y-auto')
  })

  test('closes the settings menu when clicking outside it', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('settings-button'))
    expect(screen.getByTestId('settings-menu')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('heading', { name: '我们该做什么？' }))

    expect(screen.queryByTestId('settings-menu')).not.toBeInTheDocument()
  })

  test('opens settings without exposing or fetching unsupported quota', async () => {
    render(<DesktopWorkbenchLayout {...baseProps} />)

    await userEvent.click(screen.getByTestId('settings-button'))
    expect(screen.getByTestId('settings-menu-button')).toBeInTheDocument()
    expect(screen.queryByTestId('usage-menu-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('usage-detail-panel')).not.toBeInTheDocument()
    expect(getLocalCodexUsageDisplayMock).not.toHaveBeenCalled()
  })
})
