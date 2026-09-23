import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { OPEN_SETTINGS_COMMAND, setActiveKeybindings } from '@/lib/keybindings'
import { getLocalCodexUsageDisplay } from '@/api/local/codexUsage'
import { DesktopSettingsMenu } from './DesktopSettingsMenu'

const mockCheckNow = vi.fn()
const mockInstallUpdate = vi.fn()
const mockDismissError = vi.fn()
const runtimeModeMock = vi.hoisted(() => ({
  isLocalFirstAppRuntime: vi.fn(() => false),
}))
let mockUpdateState = {
  supported: true,
  dismissError: mockDismissError,
  availableUpdate: null as null | { currentVersion: string; version: string },
  status: 'idle',
  downloadProgress: null as null | { downloadedBytes: number; totalBytes: number | null },
  error: null as string | null,
  checkNow: mockCheckNow,
  installUpdate: mockInstallUpdate,
}

vi.mock('@/features/app-update/app-update-context', () => ({
  useOptionalAppUpdate: () => mockUpdateState,
}))

vi.mock('@/lib/runtime-mode', () => runtimeModeMock)

vi.mock('@/api/local/codexUsage', () => ({
  getLocalCodexUsageDisplay: vi.fn(),
}))

function renderMenu({
  showLogout,
  onLogout = vi.fn(),
  onLogin,
  accountTargets,
  onAccountLogin,
  onAccountSwitch,
  onAccountLogout,
}: {
  showLogout?: boolean
  onLogout?: () => void
  onLogin?: () => void
  accountTargets?: Parameters<typeof DesktopSettingsMenu>[0]['accountTargets']
  onAccountLogin?: (server: unknown) => void
  onAccountSwitch?: (server: unknown) => void
  onAccountLogout?: (server: unknown) => void
} = {}) {
  return render(
    <DesktopSettingsMenu
      user={{ id: 1, email: 'user@example.com', user_name: 'User' }}
      onOpenSettings={vi.fn()}
      onLogout={onLogout}
      onLogin={onLogin}
      showLogout={showLogout}
      accountTargets={accountTargets}
      onAccountLogin={onAccountLogin as never}
      onAccountSwitch={onAccountSwitch as never}
      onAccountLogout={onAccountLogout as never}
    />
  )
}

describe('DesktopSettingsMenu', () => {
  afterEach(() => {
    delete (window as Window & { kcoderDesktopHost?: unknown }).kcoderDesktopHost
    vi.restoreAllMocks()
    setActiveKeybindings([])
  })

  test('shows the Windows settings binding and tracks customization and clearing', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    setActiveKeybindings([])
    renderMenu()
    const button = screen.getByTestId('settings-menu-button')
    expect(button).toHaveTextContent('Ctrl,')
    act(() => {
      setActiveKeybindings([{ command: OPEN_SETTINGS_COMMAND, key: 'Control+Alt+S' }])
    })
    expect(button).toHaveTextContent('CtrlAltS')
    act(() => {
      setActiveKeybindings([{ command: OPEN_SETTINGS_COMMAND, key: null }])
    })
    expect(button).not.toHaveTextContent('Ctrl')
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateState = {
      supported: true,
      dismissError: mockDismissError,
      availableUpdate: null,
      status: 'idle',
      downloadProgress: null,
      error: null,
      checkNow: mockCheckNow,
      installUpdate: mockInstallUpdate,
    }
    runtimeModeMock.isLocalFirstAppRuntime.mockReturnValue(false)
    document.querySelector('meta[name="kcoder-rpc-token"]')?.remove()
    document.querySelector('meta[name="kcoder-desktop-host"]')?.remove()
  })

  test('checks for app updates from the settings menu', async () => {
    mockCheckNow.mockResolvedValue(null)

    renderMenu()

    await userEvent.click(screen.getByTestId('check-app-update-button'))

    expect(mockCheckNow).toHaveBeenCalledTimes(1)
  })

  test('unsupported hosts cannot trigger updater and update errors are dismissible on close', async () => {
    mockUpdateState.supported = false
    const first = renderMenu()
    expect(screen.getByTestId('check-app-update-button')).toBeDisabled()
    await userEvent.click(screen.getByTestId('check-app-update-button'))
    expect(mockCheckNow).not.toHaveBeenCalled()
    first.unmount()
    expect(mockDismissError).toHaveBeenCalledTimes(2)
    mockUpdateState.supported = true
    mockUpdateState.error = 'Update failed'
    renderMenu()
    await userEvent.click(screen.getByTestId('dismiss-app-update-error'))
    expect(mockDismissError).toHaveBeenCalledTimes(4)
  })

  test('remote Electron keeps authenticated logout and offers a separate confirmed application quit', async () => {
    const windowAction = vi.fn().mockResolvedValue(undefined)
    const onLogout = vi.fn()
    Object.assign(window, { kcoderDesktopHost: { windowAction } })
    document.head.insertAdjacentHTML(
      'beforeend',
      '<meta name="kcoder-rpc-token" content="test-gateway">'
    )
    renderMenu({ onLogout })
    expect(screen.getByTestId('logout-menu-button')).toBeInTheDocument()
    expect(screen.getByTestId('quit-app-menu-button')).not.toHaveTextContent(
      'workbench.local_session_no_account'
    )
    await userEvent.click(screen.getByTestId('quit-app-menu-button'))
    expect(windowAction).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('quit-app-dialog-close'))
    expect(windowAction).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('quit-app-menu-button'))
    await userEvent.click(screen.getByTestId('quit-app-dialog-confirm'))
    expect(windowAction).toHaveBeenCalledExactlyOnceWith('quit')
    expect(onLogout).not.toHaveBeenCalled()
    expect(screen.getByTestId('quit-app-dialog-confirm')).toBeDisabled()
  })

  test('failed application quit can be dismissed and reopening the menu clears its error', async () => {
    Object.assign(window, {
      kcoderDesktopHost: {
        windowAction: vi.fn().mockRejectedValue(new Error('internal IPC failure')),
      },
    })
    const first = renderMenu({ showLogout: false })
    await userEvent.click(screen.getByTestId('quit-app-menu-button'))
    await userEvent.click(screen.getByTestId('quit-app-dialog-confirm'))
    expect(await screen.findByRole('alert')).not.toHaveTextContent('internal IPC failure')
    await userEvent.click(screen.getByTestId('dismiss-quit-error'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('quit-app-menu-button'))
    await userEvent.click(screen.getByTestId('quit-app-dialog-confirm'))
    await screen.findByRole('alert')
    first.unmount()
    renderMenu({ showLogout: false })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.queryByTestId('quit-app-dialog')).not.toBeInTheDocument())
  })

  test('uses subdued regular text for normal menu actions', () => {
    renderMenu()

    expect(screen.getByTestId('settings-menu-button')).toHaveClass(
      'font-normal',
      'text-text-primary'
    )
  })

  test('does not render the old account or quota summary row', () => {
    renderMenu()

    expect(screen.queryByTestId('settings-account-group')).not.toBeInTheDocument()
    expect(screen.queryByTestId('account-menu-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('usage-menu-button')).not.toBeInTheDocument()
    expect(screen.queryByText('Codex 剩余额度')).not.toBeInTheDocument()
  })

  test('hides logout in local-first app runtime', () => {
    runtimeModeMock.isLocalFirstAppRuntime.mockReturnValue(true)

    renderMenu()

    expect(screen.queryByTestId('logout-menu-button')).not.toBeInTheDocument()
    expect(screen.queryByText('退出登录')).not.toBeInTheDocument()
  })

  test('shows logout for a connected cloud account in local-first app runtime', async () => {
    runtimeModeMock.isLocalFirstAppRuntime.mockReturnValue(true)
    const onLogout = vi.fn()

    renderMenu({ showLogout: true, onLogout })

    await userEvent.click(screen.getByTestId('logout-menu-button'))

    expect(onLogout).toHaveBeenCalledTimes(1)
  })

  test('shows logout for an authenticated KCoder gateway session', () => {
    runtimeModeMock.isLocalFirstAppRuntime.mockReturnValue(true)
    const meta = document.createElement('meta')
    meta.name = 'kcoder-rpc-token'
    meta.content = 'cookie-auth'
    document.head.appendChild(meta)

    renderMenu()

    expect(screen.getByTestId('logout-menu-button')).toBeInTheDocument()
  })

  test('hides infrastructure logout in the self-authenticated Electron host', () => {
    runtimeModeMock.isLocalFirstAppRuntime.mockReturnValue(true)
    document.head.insertAdjacentHTML(
      'beforeend',
      '<meta name="kcoder-rpc-token" content="cookie-auth"><meta name="kcoder-desktop-host" content="1">'
    )

    renderMenu()

    expect(screen.queryByTestId('logout-menu-button')).not.toBeInTheDocument()
  })

  test('shows a descriptive login action for a disconnected cloud account', async () => {
    const onLogin = vi.fn()

    renderMenu({ showLogout: false, onLogin })

    const loginButton = screen.getByTestId('login-menu-button')
    expect(loginButton).toHaveTextContent('云登录不可用')
    expect(loginButton).toHaveTextContent('当前客户端不提供旧版云登录')
    expect(screen.queryByTestId('logout-menu-button')).not.toBeInTheDocument()

    await userEvent.click(loginButton)

    expect(onLogin).toHaveBeenCalledTimes(1)
  })

  test('installs a discovered app update', async () => {
    mockUpdateState = {
      ...mockUpdateState,
      availableUpdate: {
        currentVersion: '0.1.0',
        version: '0.1.1',
      },
      status: 'available',
    }
    mockInstallUpdate.mockResolvedValue(undefined)

    renderMenu()

    const updateButton = screen.getByTestId('check-app-update-button')
    expect(updateButton).toHaveTextContent('更新到 0.1.1')

    await userEvent.click(updateButton)
    expect(mockInstallUpdate).toHaveBeenCalledTimes(1)
  })

  test('shows download progress in the update icon and menu item', () => {
    mockUpdateState = {
      ...mockUpdateState,
      availableUpdate: {
        currentVersion: '0.1.0',
        version: '0.1.1',
      },
      status: 'installing',
      downloadProgress: {
        downloadedBytes: 50,
        totalBytes: 100,
      },
    }

    renderMenu()

    expect(screen.getByTestId('app-update-download-icon-progress')).toHaveAttribute(
      'aria-label',
      '50%'
    )
    expect(screen.getByTestId('app-update-download-progress')).toHaveTextContent('正在下载更新 50%')
  })

  test.each([false, true])(
    'does not expose or request quota in local-first mode %s',
    async localFirst => {
      runtimeModeMock.isLocalFirstAppRuntime.mockReturnValue(localFirst)
      renderMenu()

      await userEvent.click(screen.getByTestId('settings-menu-button'))
      await userEvent.click(screen.getByTestId('check-app-update-button'))

      expect(screen.queryByTestId('usage-menu-button')).not.toBeInTheDocument()
      expect(screen.queryByTestId('usage-detail-panel')).not.toBeInTheDocument()
      expect(screen.queryByText(/5小时额度|7天额度/)).not.toBeInTheDocument()
      expect(getLocalCodexUsageDisplay).not.toHaveBeenCalled()
    }
  )

  test('shows per-target KCoder account actions for logged-in and anonymous targets', async () => {
    const onAccountLogout = vi.fn().mockResolvedValue(undefined)
    const onAccountSwitch = vi.fn().mockResolvedValue(undefined)
    const onAccountLogin = vi.fn()
    const accountTargets = [
      {
        id: 'h20', label: 'H20', description: '', runtime: 'kcoder' as const, transport: 'ssh' as const,
        security: { identity: { mode: 'kcoder-account' as const } },
        accountIdentity: { principalId: '0b6cfba4-5f61-4d17-9d92-3d60a1ef2f01', username: 'root', role: 'admin' as const },
      },
      {
        id: 'lab', label: 'Lab', description: '', runtime: 'kcoder' as const, transport: 'ssh' as const,
        security: { identity: { mode: 'kcoder-account' as const } },
      },
    ]
    renderMenu({ accountTargets, onAccountLogin, onAccountSwitch, onAccountLogout })

    expect(screen.getByTestId('gateway-account-section')).toHaveTextContent('KCoder 账号')
    expect(screen.getByTestId('gateway-account-switch-h20')).toHaveTextContent('切换账号 · H20')
    expect(screen.getByTestId('gateway-account-logout-h20')).toHaveTextContent('退出账号 · H20')
    expect(screen.getByTestId('gateway-account-login-lab')).toHaveTextContent('登录账号 · Lab')

    await userEvent.click(screen.getByTestId('gateway-account-logout-h20'))
    expect(screen.getByTestId('gateway-account-logout-dialog')).toBeTruthy()
    await userEvent.click(screen.getByTestId('gateway-account-logout-dialog-confirm'))
    await waitFor(() => expect(onAccountLogout).toHaveBeenCalledOnce())

    await userEvent.click(screen.getByTestId('gateway-account-switch-h20'))
    expect(screen.getByTestId('gateway-account-switch-dialog')).toBeTruthy()
  })

  test('the login item opens an inline login dialog without navigating', async () => {
    const login = vi.hoisted(() => vi.fn())
    vi.mock('@/kcoder/gatewayRpc', async original => {
      const actual = await original<typeof import('@/kcoder/gatewayRpc')>()
      return { ...actual, loginGatewayAccount: login }
    })
    login.mockResolvedValue({ authenticated: true })
    const accountTargets = [
      {
        id: 'lab', label: 'Lab', description: '', runtime: 'kcoder' as const, transport: 'ssh' as const,
        security: { identity: { mode: 'kcoder-account' as const } },
      },
    ]
    renderMenu({ accountTargets })
    await userEvent.click(screen.getByTestId('gateway-account-login-lab'))
    expect(screen.getByTestId('gateway-account-login-dialog')).toBeTruthy()
    await userEvent.type(screen.getByTestId('gateway-account-dialog-username'), 'root')
    await userEvent.type(screen.getByTestId('gateway-account-dialog-password'), 'fixture-password-1')
    await userEvent.click(screen.getByTestId('gateway-account-dialog-submit'))
    await waitFor(() => expect(login).toHaveBeenCalledWith('lab', expect.objectContaining({ username: 'root' })))
  })

  test('hides the KCoder account section when no account targets exist', () => {
    renderMenu({})
    expect(screen.queryByTestId('gateway-account-section')).toBeNull()
  })
})
