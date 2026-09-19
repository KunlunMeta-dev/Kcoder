import { getDesktopWorkbenchHoistedMocks } from './DesktopWorkbenchLayout.test-mocks'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  DesktopWorkbenchLayout,
  baseProps,
  createDeferred,
  getDesktopWorkbenchMainElement,
} from './DesktopWorkbenchLayout.test-harness'
import {
  createTemporaryRuntimeTaskMock,
  startDeviceTerminalSessionMock,
  subscribeRuntimeTaskStreamMock,
} from './DesktopWorkbenchLayout.test-mocks'
import {
  createCloudWorkspacePanelState,
  createLocalRuntimeTaskPanelFixture,
  createRect,
  mockDesktopWorkbenchMainWidth,
  renderWorkspacePanelLayout,
} from './DesktopWorkbenchMain.workspace.test-support'

const { tauriMenuMocks } = getDesktopWorkbenchHoistedMocks()

describe('DesktopWorkbenchLayout', () => {
  test('opens and resizes the right workspace panel', async () => {
    renderWorkspacePanelLayout({ mainWidth: 1000 })

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    const panel = screen.getByTestId('right-workspace-panel')
    expect(panel).toBeInTheDocument()
    expect(screen.getByTestId('toggle-right-workspace-panel-button')).toBeInTheDocument()
    expect(screen.getByTestId('toggle-bottom-workspace-panel-button')).toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-launcher')).toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-review-option')).toHaveTextContent('审查')
    expect(screen.getByTestId('right-workspace-terminal-option')).toHaveTextContent('终端')
    expect(screen.getByTestId('right-workspace-browser-option')).toHaveTextContent('浏览器')
    expect(screen.getByTestId('right-workspace-file-option')).toHaveTextContent('文件')
    await userEvent.click(screen.getByTestId('right-workspace-file-option'))
    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-tool-launcher')).not.toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-resize-handle')).toHaveAttribute('role', 'separator')
    expect(screen.getByTestId('right-workspace-resize-handle')).toHaveClass(
      'absolute',
      'bottom-[-6px]',
      'top-0',
      'w-1.5',
      '-translate-x-1/2',
      'cursor-col-resize'
    )
    expect(screen.getByTestId('right-workspace-resize-handle')).toHaveStyle({ left: '420px' })

    const content = screen.getByTestId('desktop-workbench-content')
    const rightPanelShell = screen.getByTestId('right-workspace-panel-shell')
    await waitFor(() => {
      expect(content).toHaveStyle({ width: '420px' })
      expect(rightPanelShell).toHaveStyle({ width: 'calc(100% - 420px)' })
    })
    expect(panel).toHaveClass('min-w-0', 'flex-1', 'basis-0')
    expect(panel).toHaveClass('transition-[opacity,transform]', 'duration-300', 'ease-out')
    expect(content).toHaveClass(
      'transition-[width]',
      'duration-[240ms]',
      'ease-[cubic-bezier(0.2,0,0,1)]'
    )

    fireEvent.pointerDown(screen.getByTestId('right-workspace-resize-handle'), { clientX: 422 })
    fireEvent.pointerMove(document, { clientX: 582 })
    fireEvent.pointerUp(document)

    expect(content).toHaveStyle({ width: '580px' })
    expect(rightPanelShell).toHaveStyle({ width: 'calc(100% - 580px)' })
    expect(screen.getByTestId('workspace-file-tree')).toHaveClass('w-[240px]')
  })

  test('shows the workbench background through the right and bottom panels', async () => {
    localStorage.setItem(
      'wework.appearance',
      JSON.stringify({
        backgroundImagePath: '/app-data/background.png',
        backgroundInMain: true,
      })
    )
    renderWorkspacePanelLayout({ withAppearance: true })

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('toggle-bottom-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-browser-option'))

    expect(screen.getByTestId('right-workspace-panel-shell')).toHaveClass('bg-background/20')
    expect(screen.getByTestId('right-workspace-panel')).toHaveClass('bg-transparent')
    expect(screen.getByTestId('right-workspace-tabbar')).toHaveClass('bg-transparent')
    expect(screen.getByTestId('bottom-workspace-panel')).toHaveClass('bg-background/20')
    expect(screen.getByTestId('bottom-workspace-tabbar')).toHaveClass('bg-transparent')
  })

  test('opens the browser from the right workspace launcher row', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    expect(screen.getByTestId('right-workspace-launcher')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('right-workspace-browser-option'))

    const browserTab = screen.getByTestId('right-workspace-browser-tab')
    expect(browserTab).toHaveAttribute('role', 'tab')
    expect(browserTab).toHaveAttribute('aria-selected', 'true')
    expect(browserTab).toHaveTextContent(/^新选项卡$/)
    expect(within(browserTab).getByTestId('right-workspace-browser-tab-icon')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-browser-panel')).toHaveClass('bg-background')
    expect(screen.getByTestId('workspace-browser-url-input')).toBeInTheDocument()

    await userEvent.type(screen.getByTestId('workspace-browser-url-input'), 'weibo.com{Enter}')

    expect(browserTab).toHaveTextContent(/^weibo.com$/)
    expect(within(browserTab).getByTestId('right-workspace-browser-tab-favicon')).toHaveAttribute(
      'src',
      'https://weibo.com/favicon.ico'
    )
    expect(screen.getByTestId('workspace-browser-frame')).toHaveAttribute(
      'src',
      'https://weibo.com/'
    )
    expect(screen.getByTestId('workspace-browser-frame')).toHaveClass('bg-background')

    await userEvent.click(screen.getByTestId('right-workspace-browser-tab-close-button'))
    await waitFor(() =>
      expect(screen.queryByTestId('right-workspace-browser-tab')).not.toBeInTheDocument()
    )
  })

  test('deactivates the right workspace browser while settings are open', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-browser-option'))
    expect(screen.getByTestId('workspace-browser-panel')).not.toHaveClass('hidden')

    await userEvent.click(screen.getByTestId('settings-button'))
    await userEvent.click(screen.getByTestId('settings-menu-button'))

    expect(screen.getByTestId('studio-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-browser-panel')).toHaveClass('hidden')

    await userEvent.click(screen.getByTestId('settings-back-button'))
    await waitFor(() =>
      expect(screen.queryByTestId('studio-settings-page')).not.toBeInTheDocument()
    )
    await userEvent.click(screen.getByTestId('right-workspace-browser-tab-close-button'))
    await waitFor(() =>
      expect(screen.queryByTestId('right-workspace-browser-tab')).not.toBeInTheDocument()
    )
  })

  test('preserves the browser tab after closing and reopening the right workspace area', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-browser-option'))
    await userEvent.type(screen.getByTestId('workspace-browser-url-input'), 'weibo.com{Enter}')

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    const rightPanelShell = screen.getByTestId('right-workspace-panel-shell')
    expect(rightPanelShell).toHaveAttribute('aria-hidden', 'true')
    expect(rightPanelShell).toHaveStyle({ width: '0px' })
    expect(screen.getByTestId('right-workspace-panel')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-browser-panel')).toHaveClass('hidden')
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue('https://weibo.com/')
    expect(screen.getByTestId('workspace-browser-frame')).toHaveAttribute(
      'src',
      'https://weibo.com/'
    )

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    expect(rightPanelShell).toHaveAttribute('aria-hidden', 'false')
    expect(screen.getByTestId('right-workspace-browser-tab')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('workspace-browser-panel')).not.toHaveClass('hidden')
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue('https://weibo.com/')
    expect(screen.getByTestId('workspace-browser-frame')).toHaveAttribute(
      'src',
      'https://weibo.com/'
    )
  })

  test('restores the browser tab and URL after a full workbench remount', async () => {
    const first = renderWorkspacePanelLayout({ standaloneChatKey: 7 })

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-browser-option'))
    await userEvent.type(screen.getByTestId('workspace-browser-url-input'), 'example.com{Enter}')
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue('https://example.com/')

    await waitFor(() =>
      expect(
        [...Array(localStorage.length).keys()]
          .map(index => localStorage.key(index))
          .some(key => key?.startsWith('wework.desktop.pane-workspace.v1:'))
      ).toBe(true)
    )
    first.unmount()

    renderWorkspacePanelLayout({ standaloneChatKey: 0 })

    expect(screen.getByTestId('right-workspace-panel-shell')).toHaveAttribute(
      'aria-hidden',
      'false'
    )
    expect(screen.getByTestId('right-workspace-browser-tab')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue('https://example.com/')
  })

  test('resizes the browser area while dragging and collapses the right panel at the edge', async () => {
    renderWorkspacePanelLayout({ mainWidth: 1000 })

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-browser-option'))
    await userEvent.type(screen.getByTestId('workspace-browser-url-input'), 'weibo.com{Enter}')

    vi.spyOn(getDesktopWorkbenchMainElement(), 'getBoundingClientRect').mockReturnValue(
      createRect({ left: 0, top: 0, width: 1000, height: 720 })
    )

    const content = screen.getByTestId('desktop-workbench-content')
    const rightPanelShell = screen.getByTestId('right-workspace-panel-shell')

    await waitFor(() => {
      expect(content).toHaveStyle({ width: '420px' })
      expect(rightPanelShell).toHaveStyle({ width: 'calc(100% - 420px)' })
    })

    fireEvent.pointerDown(screen.getByTestId('right-workspace-resize-handle'), { clientX: 422 })
    fireEvent.pointerMove(document, { clientX: 702 })

    expect(content).toHaveClass('transition-none')
    expect(rightPanelShell).toHaveClass('transition-none')
    expect(content).toHaveStyle({ width: '700px' })
    expect(rightPanelShell).toHaveStyle({ width: 'calc(100% - 700px)' })

    fireEvent.pointerMove(document, { clientX: 902 })

    await waitFor(() => {
      expect(rightPanelShell).toHaveAttribute('aria-hidden', 'true')
      expect(rightPanelShell).toHaveStyle({ width: '0px' })
      expect(screen.queryByTestId('right-workspace-resize-handle')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue('https://weibo.com/')
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    expect(content).toHaveStyle({ width: '420px' })
    expect(rightPanelShell).toHaveStyle({ width: 'calc(100% - 420px)' })
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue('https://weibo.com/')
  })

  test('hides unsupported browser and file actions for a gateway runtime target', async () => {
    renderWorkspacePanelLayout({
      deviceCapabilities: ['runtime-work', 'device-commands', 'kcoder-gateway', 'runtime-terminal'],
    })

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    expect(screen.getByTestId('right-workspace-terminal-option')).toHaveTextContent('终端')
    expect(screen.queryByTestId('right-workspace-browser-option')).not.toBeInTheDocument()
    expect(screen.queryByTestId('right-workspace-file-option')).not.toBeInTheDocument()
  })

  test('does not leave the browser loading when submitting the current URL again', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-browser-option'))

    const urlInput = screen.getByTestId('workspace-browser-url-input')
    await userEvent.type(urlInput, 'weibo.com{Enter}')
    expect(screen.getByTestId('workspace-browser-frame')).toHaveAttribute(
      'src',
      'https://weibo.com/'
    )

    await userEvent.type(urlInput, '{Enter}')

    await waitFor(() =>
      expect(screen.getByTestId('workspace-browser-frame')).toHaveAttribute(
        'src',
        'https://weibo.com/'
      )
    )
    expect(screen.queryByTestId('workspace-browser-loading')).not.toBeInTheDocument()
  })

  test('keeps one browser tab and preserves it when opening files from the new tab menu', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-browser-option'))
    await userEvent.type(screen.getByTestId('workspace-browser-url-input'), 'weibo.com{Enter}')

    await userEvent.click(screen.getByTestId('right-workspace-new-tab-button'))

    const menu = screen.getByTestId('right-workspace-new-tab-menu')
    expect(menu).toBeInTheDocument()
    expect(within(menu).queryByTestId('right-workspace-browser-option')).not.toBeInTheDocument()
    expect(within(menu).getByTestId('right-workspace-file-option')).toHaveTextContent('文件')

    await userEvent.click(within(menu).getByTestId('right-workspace-file-option'))

    expect(screen.queryByTestId('right-workspace-new-tab-menu')).not.toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-file-tab')).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue('https://weibo.com/')
    expect(screen.getByTestId('workspace-browser-frame')).toHaveAttribute(
      'src',
      'https://weibo.com/'
    )

    await userEvent.click(screen.getByTestId('right-workspace-browser-tab'))

    expect(screen.getByTestId('right-workspace-browser-tab')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue('https://weibo.com/')
    expect(screen.getByTestId('workspace-browser-frame')).toHaveAttribute(
      'src',
      'https://weibo.com/'
    )
  })

  test('opens the right workspace new tab menu as an anchored popup in Tauri', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-browser-option'))

    const newTabButton = screen.getByTestId('right-workspace-new-tab-button')
    ;(window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}

    await userEvent.click(newTabButton)

    const menu = screen.getByTestId('right-workspace-new-tab-menu')
    expect(menu).toBeInTheDocument()
    expect(within(menu).getByTestId('right-workspace-review-option')).toHaveTextContent('审查')
    expect(within(menu).getByTestId('right-workspace-terminal-option')).toHaveTextContent('终端')
    expect(within(menu).queryByTestId('right-workspace-browser-option')).not.toBeInTheDocument()
    expect(within(menu).getByTestId('right-workspace-file-option')).toHaveTextContent('文件')
    expect(tauriMenuMocks.menuNew).not.toHaveBeenCalled()
    expect(tauriMenuMocks.menuPopup).not.toHaveBeenCalled()

    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    await userEvent.click(screen.getByTestId('right-workspace-browser-tab-close-button'))
    await waitFor(() =>
      expect(screen.queryByTestId('right-workspace-browser-tab')).not.toBeInTheDocument()
    )
  })

  test('opens terminal in the right workspace panel from the right add menu', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-file-option'))
    await userEvent.click(screen.getByTestId('right-workspace-new-tab-button'))

    const menu = screen.getByTestId('right-workspace-new-tab-menu')
    await userEvent.click(within(menu).getByTestId('right-workspace-terminal-option'))

    expect(screen.queryByTestId('right-workspace-new-tab-menu')).not.toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-terminal-tab')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('bottom-workspace-panel')).toHaveAttribute('aria-hidden', 'true')
    await waitFor(() =>
      expect(startDeviceTerminalSessionMock).toHaveBeenCalledWith(
        'workspace-cloud-device',
        '/workspace/project'
      )
    )
    expect(screen.getByTestId('remote-terminal')).toHaveAttribute('data-session-id', 'terminal-1')
  })

  test('opens terminal directly from the empty right workspace launcher', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-terminal-option'))

    expect(screen.getByTestId('right-workspace-terminal-tab')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await waitFor(() =>
      expect(startDeviceTerminalSessionMock).toHaveBeenCalledWith(
        'workspace-cloud-device',
        '/workspace/project'
      )
    )
    expect(screen.getByTestId('remote-terminal')).toHaveAttribute('data-session-id', 'terminal-1')

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    expect(screen.getByTestId('remote-terminal')).toHaveAttribute('hidden')
  })

  test('right workspace panel pushes the conversation chat into a narrow split column', async () => {
    mockDesktopWorkbenchMainWidth(1000)
    const workspacePanelState = createCloudWorkspacePanelState()
    render(
      <DesktopWorkbenchLayout
        {...baseProps}
        state={{
          ...baseProps.state,
          ...workspacePanelState,
        }}
        messages={[
          {
            id: 'message-1',
            role: 'assistant',
            content: 'Ready',
            status: 'done',
            createdAt: '2026-05-29T00:00:00.000Z',
          },
        ]}
        projectWork={{
          ...baseProps.projectWork,
          projects: workspacePanelState.projects,
          devices: workspacePanelState.devices,
          currentProjectId: workspacePanelState.currentProject.id,
        }}
      />
    )

    const content = screen.getByTestId('desktop-workbench-content')
    const topBar = screen.getByTestId('workbench-topbar')
    const rightPanelShell = screen.getByTestId('right-workspace-panel-shell')
    expect(topBar).toHaveStyle({ width: '100%' })
    expect(content).toHaveClass(
      'flex-none',
      'transition-[width]',
      'duration-[240ms]',
      'ease-[cubic-bezier(0.2,0,0,1)]'
    )
    expect(content).toHaveStyle({ width: '100%' })
    expect(rightPanelShell).toHaveClass(
      'overflow-hidden',
      'opacity-0',
      'transition-[width,opacity]',
      'duration-[240ms]',
      'ease-[cubic-bezier(0.2,0,0,1)]'
    )
    expect(rightPanelShell).toHaveStyle({ width: '0px' })
    expect(screen.queryByTestId('right-workspace-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('desktop-floating-composer-layer')).toHaveClass(
      'w-[min(46rem,calc(100%_-_2rem))]',
      'min-w-0',
      'max-w-[calc(100%_-_2rem)]'
    )

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    expect(content).toHaveClass(
      'flex-none',
      'transition-[width]',
      'duration-[240ms]',
      'ease-[cubic-bezier(0.2,0,0,1)]'
    )
    expect(content).not.toHaveClass('border-r')
    await waitFor(() => {
      expect(content).toHaveStyle({ width: '420px' })
      expect(topBar).toHaveStyle({ width: '420px' })
      expect(rightPanelShell).toHaveStyle({ width: 'calc(100% - 420px)' })
    })
    expect(rightPanelShell).toHaveClass('opacity-100')
    expect(screen.queryByTestId('workbench-topbar-right-actions')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-panel-floating-actions')).toContainElement(
      screen.getByTestId('toggle-bottom-workspace-panel-button')
    )
    expect(screen.getByTestId('workspace-panel-floating-actions')).toContainElement(
      screen.getByTestId('toggle-right-workspace-panel-button')
    )
    expect(screen.getByTestId('workspace-panel-floating-actions')).toHaveClass('right-8', 'gap-1')
    expect(screen.getByTestId('right-workspace-panel')).toHaveClass(
      'min-w-0',
      'flex-1',
      'basis-0',
      'transition-[opacity,transform]',
      'duration-300',
      'ease-out'
    )
    expect(screen.getByTestId('desktop-floating-composer-layer')).toHaveClass(
      'w-[min(46rem,calc(100%_-_2rem))]',
      'min-w-0',
      'max-w-[calc(100%_-_2rem)]'
    )
    expect(screen.getByTestId('desktop-chat-scroll-content').firstElementChild).toHaveClass(
      'w-[min(46rem,calc(100%_-_6rem))]',
      'min-w-0',
      'max-w-[calc(100%_-_6rem)]',
      'px-0'
    )
  })

  test('right workspace panel opens the file tab from the launcher', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    expect(screen.getByTestId('right-workspace-launcher')).toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-file-option')).toHaveClass(
      'h-11',
      'rounded-xl',
      'font-light'
    )
    expect(screen.getByTestId('right-workspace-file-option')).toHaveTextContent('⌥⌘F')
    await userEvent.click(screen.getByTestId('right-workspace-file-option'))

    const tabbar = screen.getByTestId('right-workspace-tabbar')
    const fileTab = screen.getByTestId('right-workspace-file-tab')
    expect(tabbar).toHaveAttribute('role', 'tablist')
    expect(screen.queryByTestId('right-workspace-review-tab')).not.toBeInTheDocument()
    expect(fileTab).toHaveAttribute('role', 'tab')
    expect(fileTab).toHaveAttribute('aria-selected', 'true')
    expect(fileTab).toHaveTextContent(/^文件$/)
    expect(fileTab).toHaveClass('group/tab')
    const closeButton = within(fileTab).getByTestId('right-workspace-file-tab-close-button')
    expect(closeButton.parentElement).toHaveClass(
      'absolute',
      'right-1',
      'pointer-events-auto',
      'opacity-0',
      'group-hover/tab:opacity-100',
      'focus-within:opacity-100'
    )
    expect(closeButton.parentElement).not.toHaveClass('pointer-events-none')
    expect(closeButton).toHaveClass(
      'h-[18px]',
      'w-[18px]',
      'rounded-full',
      'hover:bg-black/70',
      'hover:text-white'
    )
    expect(closeButton).not.toHaveClass('ml-auto')
    expect(closeButton).not.toHaveClass('border', 'bg-muted')
    expect(screen.getByTestId('right-workspace-new-tab-button')).toBeInTheDocument()
    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
  })

  test('right workspace launcher keyboard shortcut opens the file tab', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    expect(screen.getByTestId('right-workspace-launcher')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'f', metaKey: true, altKey: true })

    expect(screen.getByTestId('right-workspace-file-tab')).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
  })

  test('right workspace can open multiple temporary chat tabs', async () => {
    renderWorkspacePanelLayout({ mainWidth: 1000 })

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-chat-option'))

    const tabbar = screen.getByTestId('right-workspace-tabbar')
    const sideChat = screen.getByTestId('right-workspace-chat-panel')
    expect(sideChat).toBeInTheDocument()
    expect(within(tabbar).getAllByText('临时聊天')).toHaveLength(1)
    await waitFor(() => {
      expect(screen.getByTestId('desktop-workbench-content')).toHaveStyle({ width: '580px' })
      expect(screen.getByTestId('right-workspace-panel-shell')).toHaveStyle({
        width: 'calc(100% - 580px)',
      })
    })

    await userEvent.upload(
      within(sideChat).getByTestId('attachment-file-input'),
      new File(['side chat'], 'side-chat.txt', { type: 'text/plain' })
    )

    expect(await within(sideChat).findByTestId('attachment-badge')).toBeInTheDocument()
    expect(within(sideChat).getByTestId('attachment-text-preview')).toHaveAttribute(
      'title',
      'side chat'
    )
    expect(baseProps.projectChat.handleFileSelect).not.toHaveBeenCalled()
    expect(screen.getAllByTestId('attachment-badge')).toHaveLength(1)

    await userEvent.click(screen.getByTestId('right-workspace-new-tab-button'))
    await userEvent.click(
      within(screen.getByTestId('right-workspace-new-tab-menu')).getByTestId(
        'right-workspace-chat-option'
      )
    )

    expect(within(tabbar).getAllByText('临时聊天')).toHaveLength(2)
    expect(screen.getByTestId('right-workspace-chat-panel')).toBeInTheDocument()
  })

  test('temporary chat subscribes before its runtime create request settles', async () => {
    const createResult = createDeferred<RuntimeTaskAddress | false>()
    const optimisticAddress: RuntimeTaskAddress = {
      deviceId: 'workspace-cloud-device',
      taskId: 'runtime-side-chat',
      workspacePath: '/workspace/project',
    }
    createTemporaryRuntimeTaskMock.mockImplementation(async (_input, options) => {
      options?.onRuntimeTaskOptimisticOpen?.(optimisticAddress)
      return createResult.promise
    })
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-chat-option'))

    const sideChat = screen.getByTestId('right-workspace-chat-panel')
    await userEvent.type(within(sideChat).getByTestId('chat-message-input'), 'side chat')
    await userEvent.click(within(sideChat).getByTestId('send-message-button'))

    await waitFor(() => expect(createTemporaryRuntimeTaskMock).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(subscribeRuntimeTaskStreamMock).toHaveBeenCalledWith(
        optimisticAddress,
        expect.any(Object)
      )
    )

    await act(async () => {
      createResult.resolve(optimisticAddress)
      await createResult.promise
    })
  })

  test('temporary chat rolls back its optimistic address when runtime creation fails', async () => {
    const createResult = createDeferred<RuntimeTaskAddress | false>()
    const optimisticAddress: RuntimeTaskAddress = {
      deviceId: 'workspace-cloud-device',
      taskId: 'runtime-side-chat-failed',
      workspacePath: '/workspace/project',
    }
    const unsubscribe = vi.fn()
    subscribeRuntimeTaskStreamMock.mockReturnValue(unsubscribe)
    createTemporaryRuntimeTaskMock.mockImplementation(async (_input, options) => {
      options?.onRuntimeTaskOptimisticOpen?.(optimisticAddress)
      return createResult.promise
    })
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-chat-option'))

    const sideChat = screen.getByTestId('right-workspace-chat-panel')
    await userEvent.type(within(sideChat).getByTestId('chat-message-input'), 'side chat')
    await userEvent.click(within(sideChat).getByTestId('send-message-button'))

    await waitFor(() =>
      expect(subscribeRuntimeTaskStreamMock).toHaveBeenCalledWith(
        optimisticAddress,
        expect.any(Object)
      )
    )

    await act(async () => {
      createResult.resolve(false)
      await createResult.promise
    })

    await waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1))
  })

  test('moves right workspace tabs into the titlebar in Tauri', async () => {
    const previousTauriInternals = (window as typeof window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    try {
      renderWorkspacePanelLayout({ mainWidth: 1000 })

      await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
      expect(screen.queryByTestId('right-workspace-titlebar-spacer')).not.toBeInTheDocument()

      await userEvent.click(screen.getByTestId('right-workspace-file-option'))

      const titlebarRightPanel = screen.getByTestId('titlebar-right-panel')
      expect(screen.getByTestId('titlebar-right-workspace-zone')).toHaveClass(
        'absolute',
        'right-0',
        'top-0',
        'h-full'
      )
      expect(screen.getByTestId('titlebar-right-workspace-zone')).toHaveClass('border-l')
      expect(screen.getByTestId('titlebar-actions')).toHaveClass('min-w-[5rem]')
      expect(screen.getByTestId('titlebar-actions')).toContainElement(
        screen.getByTestId('toggle-right-workspace-panel-button')
      )
      expect(screen.getByTestId('titlebar-right-workspace-zone')).toHaveStyle({
        width: 'calc(100% - 420px)',
      })
      expect(screen.getByTestId('right-workspace-resize-handle')).toHaveClass(
        'after:bg-transparent'
      )
      const tabbar = screen.getByTestId('right-workspace-tabbar')
      expect(titlebarRightPanel).toContainElement(tabbar)
      expect(titlebarRightPanel).toContainElement(screen.getByTestId('right-workspace-file-tab'))
      expect(titlebarRightPanel).toContainElement(
        screen.getByTestId('right-workspace-new-tab-button')
      )
      const rightTitlebarDragRegion = screen.getByTestId('right-workspace-titlebar-drag-region')
      expect(titlebarRightPanel).toContainElement(rightTitlebarDragRegion)
      expect(
        within(rightTitlebarDragRegion).getByTestId('macos-titlebar-drag-region')
      ).toHaveAttribute('data-tauri-drag-region')
      expect(screen.getByTestId('right-workspace-file-tab')).not.toContainElement(
        rightTitlebarDragRegion
      )
      expect(screen.getByTestId('right-workspace-new-tab-button')).not.toContainElement(
        rightTitlebarDragRegion
      )
      expect(screen.queryByTestId('right-workspace-titlebar-spacer')).not.toBeInTheDocument()
      await userEvent.click(screen.getByTestId('right-workspace-new-tab-button'))
      expect(screen.getByTestId('right-workspace-new-tab-menu')).toBeInTheDocument()
    } finally {
      if (previousTauriInternals === undefined) {
        delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
      } else {
        Object.defineProperty(window, '__TAURI_INTERNALS__', {
          configurable: true,
          value: previousTauriInternals,
        })
      }
    }
  })

  test('removes right workspace tabs from the titlebar when the Tauri panel is closed', async () => {
    const previousTauriInternals = (window as typeof window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    try {
      renderWorkspacePanelLayout({ mainWidth: 1000 })

      await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
      await userEvent.click(screen.getByTestId('right-workspace-file-option'))

      const titlebarRightPanel = screen.getByTestId('titlebar-right-panel')
      expect(within(titlebarRightPanel).getByTestId('right-workspace-file-tab')).toBeInTheDocument()

      await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

      const rightPanelShell = screen.getByTestId('right-workspace-panel-shell')
      expect(rightPanelShell).toHaveAttribute('aria-hidden', 'true')
      expect(rightPanelShell).toHaveStyle({ width: '0px' })
      expect(within(titlebarRightPanel).queryByTestId('right-workspace-file-tab')).toBeNull()
      expect(rightPanelShell).toContainElement(screen.getByTestId('right-workspace-file-tab'))
      expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
    } finally {
      if (previousTauriInternals === undefined) {
        delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
      } else {
        Object.defineProperty(window, '__TAURI_INTERNALS__', {
          configurable: true,
          value: previousTauriInternals,
        })
      }
    }
  })

  test('does not show inactive runtime task right workspace tabs in the Tauri titlebar', async () => {
    const previousTauriInternals = (window as typeof window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    const { propsForTask, taskA, taskB } = createLocalRuntimeTaskPanelFixture()

    try {
      mockDesktopWorkbenchMainWidth(1000)
      const { rerender } = render(<DesktopWorkbenchLayout {...propsForTask(taskA)} />)

      await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
      await userEvent.click(screen.getByTestId('right-workspace-file-option'))

      const titlebarRightPanel = screen.getByTestId('titlebar-right-panel')
      const sharedMainHeader = screen.getByTestId('workbench-main-header')
      expect(within(titlebarRightPanel).getByTestId('right-workspace-file-tab')).toBeInTheDocument()

      rerender(<DesktopWorkbenchLayout {...propsForTask(taskB)} />)

      expect(screen.getAllByTestId('workbench-main-header')).toHaveLength(1)
      expect(screen.getByTestId('workbench-main-header')).toBe(sharedMainHeader)
      expect(sharedMainHeader).toHaveClass('h-[38px]', 'shrink-0')
      expect(screen.getAllByTestId('workbench-pane-task-title')).toHaveLength(1)
      expect(screen.getByTestId('workbench-pane-task-title')).toHaveTextContent('Task B')
      expect(screen.getByTestId('workbench-pane-task-title')).not.toHaveTextContent('Task A')
      expect(within(titlebarRightPanel).queryByTestId('right-workspace-file-tab')).toBeNull()
    } finally {
      if (previousTauriInternals === undefined) {
        delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
      } else {
        Object.defineProperty(window, '__TAURI_INTERNALS__', {
          configurable: true,
          value: previousTauriInternals,
        })
      }
    }
  })

  test('right workspace panel restores the previous tab after closing and reopening', async () => {
    renderWorkspacePanelLayout()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    await userEvent.click(screen.getByTestId('right-workspace-file-option'))
    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-file-tab')).toHaveAttribute('aria-selected', 'true')

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))
    expect(screen.getByTestId('right-workspace-panel-shell')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('right-workspace-panel-shell')).toHaveStyle({ width: '0px' })
    expect(screen.getByTestId('right-workspace-panel')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('toggle-right-workspace-panel-button'))

    expect(screen.queryByTestId('right-workspace-launcher')).not.toBeInTheDocument()
    expect(screen.getByTestId('right-workspace-file-tab')).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByTestId('workspace-file-tree')).toBeInTheDocument()
  })
})
