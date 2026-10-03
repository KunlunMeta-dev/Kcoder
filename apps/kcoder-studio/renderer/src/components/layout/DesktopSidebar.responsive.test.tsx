import '@/i18n'
import { openLocalWorkspace } from '@/lib/local-terminal'
import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { enableTauri, renderSidebar } from './sidebar/DesktopSidebar.test-support'
const experimentalFeatures = vi.hoisted(() => ({ enabled: true }))
vi.mock('@/features/experimental-features/useExperimentalFeaturesEnabled', () => ({
  useExperimentalFeaturesEnabled: () => experimentalFeatures.enabled,
}))
vi.mock('@/lib/local-terminal', () => ({
  openLocalWorkspace: vi.fn(),
}))
describe('DesktopSidebar responsive', () => {
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
  test('keeps the original text brand and search action in the sidebar', () => {
    renderSidebar()

    const brand = screen.getByText('KCoder Studio')
    expect(screen.queryByRole('img', { name: 'KunlunMeta' })).not.toBeInTheDocument()
    expect(brand.parentElement).toContainElement(screen.getByTestId('runtime-search-button'))
  })

  test('switches sidebar focus tokens with browser focus events', () => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    renderSidebar()
    const sidebar = screen.getByTestId('desktop-sidebar')

    act(() => window.dispatchEvent(new Event('focus')))
    expect(sidebar).toHaveAttribute('data-window-focused', 'true')
    expect(sidebar).toHaveClass('bg-[rgb(var(--color-sidebar))]')

    act(() => window.dispatchEvent(new Event('blur')))
    expect(sidebar).toHaveAttribute('data-window-focused', 'false')
    expect(sidebar).toHaveClass('bg-[rgb(var(--color-sidebar-unfocused))]')
  })

  test('keeps the resize handle hit area on the sidebar edge', () => {
    renderSidebar()

    const handle = screen.getByTestId('sidebar-resize-handle')

    expect(handle).toHaveClass('right-[-14px]', 'w-[18px]')
    expect(handle).not.toHaveClass('w-10')
  })

  test('uses the expected sidebar text emphasis levels', () => {
    renderSidebar({}, { status: 'disconnected', isConnected: false })

    const newTaskButton = screen.getByTestId('new-chat-button')
    const searchButton = screen.getByTestId('runtime-search-button')
    const pluginsButton = screen.getByTestId('plugins-button')
    const cloudButton = screen.getByTestId('sidebar-cloud-connection-button')
    const newTaskIcon = newTaskButton.querySelector('svg')
    const cloudIcon = cloudButton.parentElement?.querySelector('svg')
    const projectsToggle = screen.getByTestId('projects-section-toggle')
    const projectsTitle = projectsToggle.querySelector('span')

    for (const button of [newTaskButton, pluginsButton, cloudButton]) {
      expect(button).toHaveClass('font-normal', 'text-[rgb(var(--color-sidebar-text-primary))]')
    }
    expect(searchButton).toHaveClass('text-[rgb(var(--color-sidebar-text-primary))]')
    expect(newTaskButton).toHaveClass('h-[30px]', 'rounded-[10px]', 'text-base')
    expect(pluginsButton).toHaveClass('h-[30px]', 'rounded-[10px]', 'text-base')
    expect(cloudButton).toHaveClass('h-[30px]', 'rounded-[10px]', 'text-base')
    expect(newTaskIcon).toHaveClass('text-current')
    expect(cloudIcon).toHaveClass('text-[rgb(var(--color-sidebar-text-primary))]')
    expect(projectsTitle).toHaveClass(
      'font-medium',
      'text-[rgb(var(--color-sidebar-text-muted))]',
      'opacity-75'
    )
    expect(screen.getByTestId('project-row-7')).toHaveClass(
      'text-[rgb(var(--color-sidebar-text-primary))]'
    )
  })

  test.each(['unknown', 'waiting_approval', 'background'] as const)(
    'reserves actual %s status width alongside hover actions',
    async runActivity => {
      const user = userEvent.setup()
      const taskTitle = '修复进行中任务未显示 tool 调用'

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
                  tasks: [
                    {
                      taskId: 'codex-1',
                      workspacePath: '/repo/Wegent',
                      title: taskTitle,
                      runActivity,
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

      await user.click(screen.getByTestId('project-item-button'))

      const title = screen.getByText(taskTitle)
      const trailing = screen.getByTestId('runtime-local-task-trailing-codex-1')
      const hoverActions = screen.getByTestId('runtime-local-task-hover-actions-codex-1')

      expect(title).toHaveClass('min-w-0', 'flex-1', 'truncate')
      expect(title).not.toHaveClass('group-hover/task:pr-20')
      expect(trailing).toHaveClass('min-w-[30px]', 'shrink-0')
      expect(trailing).not.toHaveClass('group-hover/task:w-[68px]')
      expect(hoverActions).toHaveClass(
        'w-0',
        'shrink-0',
        'group-hover/task:w-[72px]',
        'group-focus-within/task:w-[72px]'
      )
      expect(hoverActions).not.toHaveClass('absolute')
      const status = screen.getByTestId('runtime-local-task-running-codex-1')
      expect(status).toBeVisible()
      expect(status).toHaveClass('group-hover/task:visible', 'group-focus-within/task:visible')
      expect(status).not.toHaveClass('group-hover/task:-translate-x-[72px]')
    }
  )
})
