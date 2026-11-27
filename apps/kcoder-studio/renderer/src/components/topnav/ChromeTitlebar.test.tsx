import { registerRuntimeTransport } from '@/lib/runtime-transport'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ChromeTitlebar } from './ChromeTitlebar'
import type { AppTab } from '@/config/apps'



const mockTabs: AppTab[] = [
  { key: 'studio', label: 'WeWork', mode: 'native', requiresAuth: true },
  {
    key: 'wegent',
    label: 'Wegent',
    mode: 'iframe',
    url: 'http://localhost:3000',
    requiresAuth: true,
  },
]

const appTabs: AppTab[] = [
  { key: 'studio', label: 'WeWork', mode: 'native', requiresAuth: true },
  { key: 'apps', label: '应用', mode: 'native', requiresAuth: true },
]

function mockUserAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    get() {
      return ua
    },
  })
}

let cleanup: (() => void) | undefined
function enableGateway() { cleanup = registerRuntimeTransport(() => null) }
function disableGateway() { cleanup?.(); cleanup = undefined }

describe('ChromeTitlebar', () => {
  beforeEach(() => {
    disableGateway()
  })

  test('renders all tab buttons', () => {
    render(<ChromeTitlebar tabs={mockTabs} activeKey="wework" onNavigate={vi.fn()} />)
    expect(screen.getByTestId('chrome-tab-studio')).toBeInTheDocument()
    expect(screen.getByTestId('chrome-tab-wegent')).toBeInTheDocument()
  })

  test('active tab connects to the window canvas', () => {
    render(<ChromeTitlebar tabs={mockTabs} activeKey="wegent" onNavigate={vi.fn()} />)
    expect(screen.getByTestId('chrome-tab-wegent')).toHaveClass('bg-black/[0.045]')
    expect(screen.getByTestId('chrome-tab-studio')).not.toHaveClass('bg-black/[0.045]')
    expect(screen.getByTestId('chrome-tab-wegent')).toHaveClass(
      'h-8',
      'min-w-24',
      'justify-center',
      'rounded-lg',
      'px-3',
      'text-center',
      'leading-none',
      'bg-black/[0.045]'
    )
    expect(screen.getByTestId('chrome-tab-wegent')).not.toHaveClass(
      'border',
      'shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
    )
    expect(screen.getByTestId('chrome-titlebar')).toHaveClass('h-[38px]', 'bg-surface')
    expect(screen.getByTestId('titlebar-right-workspace-zone')).toHaveClass(
      'top-0',
      'h-full',
      'items-center'
    )
    expect(screen.getByTestId('titlebar-center')).toHaveClass('h-full', 'flex-1')
    expect(screen.getByTestId('titlebar-actions')).toHaveClass('h-full', 'gap-1', 'pr-3')
  })

  test('renders app tabs as icon-only controls with hover labels', () => {
    render(<ChromeTitlebar tabs={appTabs} activeKey="wework" onNavigate={vi.fn()} iconOnlyTabs />)

    const weworkTab = screen.getByTestId('chrome-tab-studio')
    expect(screen.getByTestId('desktop-app-switcher')).toHaveTextContent('任务')
    expect(weworkTab).toHaveAttribute('aria-haspopup', 'menu')
    expect(screen.queryByTestId('chrome-tab-todo')).not.toBeInTheDocument()
    expect(screen.queryByTestId('chrome-tab-apps')).not.toBeInTheDocument()
  })

  test('renders after-tabs content between tabs and titlebar actions', () => {
    render(
      <ChromeTitlebar
        tabs={mockTabs}
        activeKey="wework"
        onNavigate={vi.fn()}
        afterTabs={<button type="button">Update</button>}
      />
    )

    const afterTabs = screen.getByTestId('chrome-titlebar-after-tabs')
    const activeTab = screen.getByTestId('chrome-tab-studio')
    const titlebarActions = screen.getByTestId('titlebar-actions')
    expect(afterTabs).toHaveTextContent('Update')
    expect(
      activeTab.compareDocumentPosition(afterTabs) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      afterTabs.compareDocumentPosition(titlebarActions) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  test('renders before-tabs content between traffic lights and tabs', () => {
    mockUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    enableGateway()
    render(
      <ChromeTitlebar
        tabs={mockTabs}
        activeKey="wework"
        onNavigate={vi.fn()}
        beforeTabs={<button type="button">Toggle sidebar</button>}
      />
    )

    const spacer = screen.getByTestId('macos-traffic-light-spacer')
    const beforeTabs = screen.getByTestId('chrome-titlebar-before-tabs')
    const activeTab = screen.getByTestId('chrome-tab-studio')
    const toggleButton = screen.getByRole('button', { name: 'Toggle sidebar' })
    expect(beforeTabs).toHaveTextContent('Toggle sidebar')
    expect(screen.getByTestId('chrome-titlebar')).not.toHaveAttribute('data-kcoder-drag-region')
    expect(toggleButton.closest('[data-kcoder-drag-region]')).toBeNull()
    expect(activeTab.closest('[data-kcoder-drag-region]')).toBeNull()
    expect(
      spacer.compareDocumentPosition(beforeTabs) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      beforeTabs.compareDocumentPosition(activeTab) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    disableGateway()
  })

  test('calls onNavigate on tab click', async () => {
    const fn = vi.fn()
    render(<ChromeTitlebar tabs={mockTabs} activeKey="wework" onNavigate={fn} />)
    await userEvent.click(screen.getByTestId('chrome-tab-wegent'))
    expect(fn).toHaveBeenCalledWith('wegent')
  })

  test('shows macOS traffic light spacer in Gateway runtime on Mac', () => {
    mockUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    enableGateway()
    render(<ChromeTitlebar tabs={mockTabs} activeKey="wework" onNavigate={vi.fn()} />)
    const dragRegion = screen.getByTestId('macos-traffic-light-spacer')
    expect(dragRegion.className).toContain('w-[92px]')
    expect(dragRegion).toHaveClass('self-stretch')
    expect(within(dragRegion).getByTestId('macos-titlebar-drag-region')).toHaveAttribute(
      'data-kcoder-drag-region'
    )
    // macOS spacer is first child (left side)
    expect(dragRegion?.parentElement?.firstChild).toBe(dragRegion)
    disableGateway()
  })

  test('starts native dragging from the Wegent titlebar window drag region', async () => {
    mockUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    enableGateway()
    render(<ChromeTitlebar tabs={mockTabs} activeKey="wegent" onNavigate={vi.fn()} />)

    const dragRegion = screen.getByTestId('titlebar-center')
    expect(dragRegion).toHaveClass('h-full', 'flex-1')
    const nativeDragRegion = within(dragRegion).getByTestId('macos-titlebar-drag-region')
    expect(nativeDragRegion).toHaveClass('pointer-events-auto')
    fireEvent.mouseDown(nativeDragRegion, {
      button: 0,
    })

    expect(nativeDragRegion).toHaveClass('[-webkit-app-region:drag]')
    disableGateway()
  })

  test('starts native dragging from the empty right workspace titlebar area', async () => {
    mockUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    enableGateway()
    render(<ChromeTitlebar tabs={mockTabs} activeKey="wework" onNavigate={vi.fn()} />)

    const rightPanelDragRegion = screen.getByTestId('titlebar-right-panel-drag-region')
    expect(screen.getByTestId('titlebar-right-panel')).toContainElement(rightPanelDragRegion)
    fireEvent.mouseDown(within(rightPanelDragRegion).getByTestId('macos-titlebar-drag-region'), {
      button: 0,
    })

    expect(within(rightPanelDragRegion).getByTestId('macos-titlebar-drag-region')).toHaveClass('[-webkit-app-region:drag]')
    disableGateway()
  })

  test('keeps the Windows right spacer without making the toolbar draggable', () => {
    mockUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    enableGateway()
    render(<ChromeTitlebar tabs={mockTabs} activeKey="wework" onNavigate={vi.fn()} />)
    const dragRegion = screen.getByTestId('chrome-titlebar').lastElementChild
    expect(dragRegion).toBeInTheDocument()
    expect(dragRegion).toHaveAttribute('data-kcoder-drag-region')
    expect(dragRegion).toHaveClass('w-[138px]', 'self-stretch')
    const spacer = within(dragRegion as HTMLElement).getByTestId('macos-titlebar-drag-region')
    expect(spacer).not.toHaveAttribute('data-kcoder-drag-region')
    expect(spacer).toHaveClass('pointer-events-none')
    for (const region of screen.getAllByTestId('macos-titlebar-drag-region')) {
      expect(region).not.toHaveClass('[-webkit-app-region:drag]')
    }
    // Windows spacer is last child (right side)
    expect(dragRegion?.parentElement?.lastChild).toBe(dragRegion)
    disableGateway()
  })

  test('no spacer when not in Gateway runtime', () => {
    render(<ChromeTitlebar tabs={mockTabs} activeKey="wework" onNavigate={vi.fn()} />)
    expect(document.querySelector('[data-kcoder-drag-region]')).not.toBeInTheDocument()
  })
})
