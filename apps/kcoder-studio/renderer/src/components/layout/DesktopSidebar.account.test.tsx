import '@/i18n'
import { openLocalWorkspace } from '@/lib/local-terminal'
import { screen } from '@testing-library/react'
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
describe('DesktopSidebar account', () => {
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
  test('keeps the account settings trigger and notification bell inside the sidebar width', () => {
    renderSidebar()

    expect(screen.getByTestId('settings-button')).toHaveClass('h-[60px]', 'min-w-0', 'flex-1')
    expect(screen.getByTestId('settings-button')).toHaveClass('pr-10')
    expect(screen.getByTestId('settings-button')).not.toHaveClass('w-full', 'shrink-0')
    expect(screen.getByTestId('settings-button')).toHaveTextContent('alice')
    expect(screen.getByTestId('settings-button')).toHaveTextContent('alice@example.com')
    expect(screen.getByTestId('sidebar-account-avatar').querySelector('svg')).toHaveClass(
      'lucide-user-round'
    )
    expect(screen.getByTestId('sidebar-account-avatar')).not.toHaveTextContent('AL')
    expect(screen.getByTestId('sidebar-global-im-notification-button')).toHaveClass(
      'h-8',
      'w-8',
      'shrink-0'
    )
  })

  test('keeps the account menu available before cloud login', async () => {
    vi.stubEnv('VITE_WEGENT_BACKEND_URL', 'http://localhost:8000')
    renderSidebar({}, { status: 'disconnected', isConnected: false, user: null })

    const accountButton = screen.getByTestId('settings-button')
    expect(accountButton).toHaveAccessibleName('账户与设置')
    expect(accountButton).toHaveTextContent('旧版云账号')
    expect(accountButton).toHaveTextContent('未登录')
    expect(accountButton).not.toHaveTextContent('http://localhost:8000')
    expect(accountButton).not.toHaveTextContent('alice@example.com')

    await userEvent.click(accountButton)

    expect(screen.getByTestId('settings-menu')).toBeInTheDocument()
    expect(screen.getByTestId('settings-menu-button')).toHaveTextContent('设置')
    expect(screen.getByTestId('login-menu-button')).toHaveTextContent('云登录不可用')
    expect(screen.queryByTestId('cloud-connection-dialog')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('login-menu-button'))

    expect(screen.getByTestId('cloud-connection-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-backend-url-input')).toHaveValue('http://localhost:8000')
    expect(screen.queryByTestId('settings-menu')).not.toBeInTheDocument()
  })

  test('shows the cloud username and email after login', async () => {
    vi.stubEnv('VITE_WEGENT_BACKEND_URL', 'http://localhost:8000')
    const disconnect = vi.fn()
    renderSidebar(
      {},
      {
        status: 'connected',
        isConnected: true,
        backendUrl: 'http://localhost:8000',
        user: { id: 7, user_name: 'cloud-user', email: 'cloud@example.com' },
        disconnect,
      }
    )

    const accountButton = screen.getByTestId('settings-button')
    expect(accountButton).toHaveTextContent('cloud-user')
    expect(accountButton).toHaveTextContent('cloud@example.com')
    expect(accountButton).not.toHaveTextContent('alice@example.com')

    await userEvent.click(accountButton)

    expect(screen.getByTestId('settings-menu')).toBeInTheDocument()
    expect(screen.getByTestId('logout-menu-button')).toHaveTextContent('退出登录')
    expect(screen.queryByTestId('cloud-connection-dialog')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('logout-menu-button'))

    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('settings-menu')).not.toBeInTheDocument()
  })

  test('shows an exposed update button in the account row when an app update is available', async () => {
    const installUpdate = vi.fn().mockResolvedValue(undefined)
    renderSidebar({}, undefined, {
      availableUpdate: { currentVersion: '0.1.0', version: '0.1.1' },
      status: 'available',
      installUpdate,
    })

    const button = screen.getByTestId('sidebar-app-update-button')
    const action = screen.getByTestId('sidebar-app-update-action')
    expect(button).toHaveClass('h-8', 'w-8')
    expect(button).toHaveAttribute('title', '更新到 0.1.1')
    expect(action).not.toHaveClass('max-w-0', 'opacity-0', 'overflow-hidden')
    expect(screen.getByTestId('settings-button')).toHaveClass('pr-[72px]')

    await userEvent.click(button)

    expect(installUpdate).toHaveBeenCalledTimes(1)
  })

  test('does not show an update icon without an available update', () => {
    renderSidebar({}, undefined, {
      availableUpdate: null,
      status: 'error',
      error: 'updater does not have any endpoints set',
    })

    expect(screen.queryByTestId('sidebar-app-update-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-app-update-action')).not.toBeInTheDocument()
    expect(screen.getByTestId('settings-button')).toHaveClass('pr-10')
  })

  test('shows download progress in the account-row update icon', () => {
    renderSidebar({}, undefined, {
      availableUpdate: { currentVersion: '0.1.0', version: '0.1.1' },
      status: 'installing',
      downloadProgress: { downloadedBytes: 40, totalBytes: 100 },
    })

    const progress = screen.getByTestId('sidebar-app-update-download-progress')
    expect(progress).toHaveAttribute('aria-valuenow', '40')
    expect(screen.getByTestId('sidebar-app-update-button')).toHaveAttribute(
      'title',
      '正在下载更新 40%'
    )
  })

  test('opens away reminder controls from the account notification bell', async () => {
    const user = userEvent.setup()
    const onToggleGlobalImNotification = vi.fn()

    renderSidebar({
      imNotificationSettings: {
        global: {
          enabled: false,
          sessionKey: 'session-telegram',
          session: {
            sessionKey: 'session-telegram',
            channelType: 'telegram',
            channelLabel: 'Telegram',
            channelId: 9,
            conversationId: 'telegram-1',
            senderId: '100200300',
            displayName: 'Alice',
          },
        },
        runtimeTaskSubscriptions: [],
      },
      onToggleGlobalImNotification,
    })

    const toggle = screen.getByTestId('sidebar-global-im-notification-button')

    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('sidebar-global-im-notification-muted-icon')).toBeInTheDocument()
    expect(toggle).toHaveAttribute('title', expect.stringContaining('Telegram'))

    await user.click(toggle)
    expect(screen.getByTestId('sidebar-global-im-notification-menu')).toHaveTextContent(
      '离开电脑提醒'
    )
    expect(screen.getByTestId('sidebar-global-im-notification-menu')).toHaveTextContent(
      'Telegram / Alice'
    )
    await user.click(screen.getByTestId('sidebar-global-im-notification-primary-button'))

    expect(onToggleGlobalImNotification).toHaveBeenCalledTimes(1)
  })

  test('hides global IM notifications while experimental features are disabled', () => {
    experimentalFeatures.enabled = false

    renderSidebar({ onToggleGlobalImNotification: vi.fn() })

    expect(screen.queryByTestId('sidebar-global-im-notification-button')).not.toBeInTheDocument()
  })

  test('anchors the away reminder menu to the full-width account area', async () => {
    // Regression guard (POPOVER-CONTAINING-BLOCK-MISMATCH): the menu must portal
    // into the full-width account/settings container (group/account), not remain
    // a child of the narrow 32px icon-action group, otherwise `left-4 right-4`
    // resolves against the icon group and the panel collapses to a sliver.
    const user = userEvent.setup()

    renderSidebar({
      imNotificationSettings: {
        global: {
          enabled: false,
          sessionKey: 'session-telegram',
          session: {
            sessionKey: 'session-telegram',
            channelType: 'telegram',
            channelLabel: 'Telegram',
            channelId: 9,
            conversationId: 'telegram-1',
            senderId: '100200300',
            displayName: 'Alice',
          },
        },
        runtimeTaskSubscriptions: [],
      },
      onToggleGlobalImNotification: vi.fn(),
    })

    await user.click(screen.getByTestId('sidebar-global-im-notification-button'))

    const menu = screen.getByTestId('sidebar-global-im-notification-menu')

    // The menu DOM owner must be the account area, reachable through the
    // group/account container — never the icon-action group wrapper.
    const accountArea = menu.closest('.group\\/account')
    expect(accountArea, 'menu must be portalled into the account area').not.toBeNull()

    const iconGroup = screen.getByTestId('sidebar-global-im-notification-button').parentElement
    expect(
      iconGroup?.contains(menu),
      'menu must NOT stay inside the narrow icon-action group'
    ).toBe(false)

    // jsdom does not compute CSS layout, so a numeric width floor is not
    // enforceable here; the DOM-ownership assertions above are the durable
    // guard against the containing-block regression.
    expect(menu).toBeInTheDocument()
  })

  test('opens away reminder channel settings from the bell menu', async () => {
    const user = userEvent.setup()
    const onToggleGlobalImNotification = vi.fn()
    const onOpenGlobalImNotificationSettings = vi.fn()

    renderSidebar({
      imNotificationSettings: {
        global: {
          enabled: true,
          sessionKey: 'session-telegram',
          session: {
            sessionKey: 'session-telegram',
            channelType: 'telegram',
            channelLabel: 'Telegram',
            channelId: 9,
            conversationId: 'telegram-1',
            senderId: '100200300',
            displayName: 'Alice',
          },
        },
        runtimeTaskSubscriptions: [],
      },
      onToggleGlobalImNotification,
      onOpenGlobalImNotificationSettings,
    })

    await user.click(screen.getByTestId('sidebar-global-im-notification-button'))
    expect(screen.getByTestId('sidebar-global-im-notification-on-icon')).toBeInTheDocument()
    await user.click(screen.getByTestId('sidebar-global-im-notification-settings-button'))

    expect(onOpenGlobalImNotificationSettings).toHaveBeenCalledTimes(1)
    expect(onToggleGlobalImNotification).not.toHaveBeenCalled()
  })

  test('keeps the away reminder bell neutral when cloud is disconnected', async () => {
    const user = userEvent.setup()

    renderSidebar(
      {
        imNotificationSettings: {
          global: {
            enabled: false,
            sessionKey: null,
            session: null,
          },
          runtimeTaskSubscriptions: [],
        },
        onToggleGlobalImNotification: vi.fn(),
      },
      {
        status: 'disconnected',
        isConnected: false,
        token: null,
        user: null,
        error: null,
      }
    )

    const bell = screen.getByTestId('sidebar-global-im-notification-button')
    expect(bell).toHaveAttribute('title', '登录云端后可开启离开电脑提醒')
    expect(bell).not.toHaveClass('text-red-500')
    expect(screen.getByTestId('sidebar-global-im-notification-muted-icon')).toBeInTheDocument()

    await user.click(bell)

    expect(screen.getByTestId('sidebar-global-im-notification-menu')).toHaveTextContent(
      '登录云端后可开启离开电脑提醒'
    )
  })

  test('shows the away reminder bell even when notification handlers are unavailable', async () => {
    const user = userEvent.setup()

    renderSidebar(
      {
        onToggleGlobalImNotification: undefined,
        onOpenGlobalImNotificationSettings: undefined,
      },
      {
        status: 'disconnected',
        isConnected: false,
        token: null,
        user: null,
        error: null,
      }
    )

    const bell = screen.getByTestId('sidebar-global-im-notification-button')
    expect(bell).toBeInTheDocument()
    expect(bell).toHaveAttribute('title', '登录云端后可开启离开电脑提醒')
    expect(bell).not.toHaveClass('text-red-500')
    expect(screen.getByTestId('sidebar-global-im-notification-muted-icon')).toBeInTheDocument()

    await user.click(bell)

    expect(screen.getByTestId('sidebar-global-im-notification-menu')).toHaveTextContent(
      '登录云端后可开启离开电脑提醒'
    )
  })

  test('wraps cloud connection errors without turning the away reminder bell red', async () => {
    const user = userEvent.setup()
    const error = '读取云端用户失败 (http://localhost:8000/api/users/me): Cloud connection failed'

    renderSidebar(
      {
        imNotificationSettings: {
          global: {
            enabled: false,
            sessionKey: null,
            session: null,
          },
          runtimeTaskSubscriptions: [],
        },
      },
      {
        status: 'error',
        isConnected: false,
        token: null,
        user: null,
        error,
      }
    )

    const bell = screen.getByTestId('sidebar-global-im-notification-button')
    expect(bell).toHaveAttribute('title', '登录云端后可开启离开电脑提醒')
    expect(bell).not.toHaveClass('text-red-500')
    expect(screen.getByTestId('sidebar-global-im-notification-muted-icon')).toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-global-im-notification-indicator')).not.toBeInTheDocument()

    await user.click(bell)

    const errorMessage = screen.getByTestId('sidebar-global-im-notification-error')
    expect(errorMessage).toHaveTextContent(error)
    expect(errorMessage).toHaveClass('break-words', '[overflow-wrap:anywhere]')
  })
})
