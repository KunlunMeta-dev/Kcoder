import { installTestTransport, clearTestTransports } from '@/test/runtime-transport'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ConnectionsSettingsPage } from './ConnectionsSettingsPage'
import { createDeviceApi } from '@/api/devices'
import { createUserApi } from '@/api/users'
import { AppearanceProvider } from '@/features/appearance'
import { requestDesktopSidebarToggle } from '@/components/layout/useDesktopSidebarCollapsed'
import {
  CloudConnectionContext,
  DISCONNECTED_STATE,
} from '@/features/cloud-connection/CloudConnectionContext'
import type { CloudConnectionContextValue } from '@/features/cloud-connection/CloudConnectionContext'
import { openExternalUrl } from '@/lib/external-links'
import { requestLocalExecutor } from '@/host/localExecutor'
import '@/i18n'
import type { DeviceInfo } from '@/types/devices'

vi.mock('./SshConnectionsSettingsPage', () => ({
  SshConnectionsSettingsPage: () => <div data-testid="ssh-connections-settings-page" />,
}))
vi.mock('./KCoderProviderSettingsPage', () => ({
  KCoderProviderSettingsPage: () => <div data-testid="kcoder-provider-settings-page" />,
}))
vi.mock('./MobileConnectionSettingsPage', () => ({
  MobileConnectionSettingsPage: () => <div data-testid="mobile-connection-settings-page" />,
}))
vi.mock('@/features/execution-settings/ExecutionDefaultsSettingsPage', () => ({
  ExecutionDefaultsSettingsPage: () => <div data-testid="execution-defaults-settings-page" />,
}))

const runtimeConfigMock = vi.hoisted(() => ({
  value: {
    appBasePath: '',
    apiBaseUrl: '/api',
    socketBaseUrl: 'http://203.0.113.10:8000',
    socketPath: '/socket.io',
    cloudDeviceScalingWikiUrl: '',
  },
}))
const localCodexPluginApiMock = vi.hoisted(() => ({
  readCodexLocalConfig: vi.fn(),
  updateCodexLocalConfig: vi.fn(),
}))
const cloudDesktopExtensionMock = vi.hoisted(() => ({
  available: true,
  DeviceAction: vi.fn(),
  isInternalPageUrl: vi.fn(() => false),
  open: vi.fn(),
}))

vi.mock('@extensions/cloud-desktop', () => ({
  cloudDesktopExtension: cloudDesktopExtensionMock,
}))

vi.mock('@/config/runtime', () => ({
  getRuntimeConfig: () => runtimeConfigMock.value,
  stripAppBasePath: (path: string) => path,
}))

vi.mock('@/api/http', () => ({
  createHttpClient: vi.fn((options: unknown) => ({ options })),
  shouldUseGatewayFetch: vi.fn(() => false),
}))

vi.mock('@/api/models', () => ({
  createModelApi: vi.fn(() => ({
    listModels: vi.fn().mockResolvedValue({ data: [] }),
  })),
}))

vi.mock('@/api/local/codexOfficialModels', () => ({
  getLocalCodexOfficialModels: vi.fn().mockResolvedValue({
    providers: [],
    models: [],
  }),
}))

vi.mock('@/api/local/runtimeAuthStatus', () => ({
  getLocalCodexAuthStatus: vi.fn().mockResolvedValue({
    runtime: 'codex',
    targetPath: '/Users/me/.codex/auth.json',
    exists: true,
    updatedAt: '2026-07-01T00:00:00.000Z',
    sha256: 'abc123',
    sizeBytes: 128,
    error: null,
  }),
}))

vi.mock('@/api/local/codexPlugins', () => ({
  createLocalCodexPluginApi: () => localCodexPluginApiMock,
}))

vi.mock('@/api/devices', () => ({
  createDeviceApi: vi.fn(),
}))

vi.mock('@/api/users', () => ({
  createUserApi: vi.fn(),
}))

vi.mock('@/lib/external-links', () => ({
  openExternalUrl: vi.fn(),
}))

vi.mock('@/host/localExecutor', () => ({
  ensureLocalExecutorStarted: vi.fn().mockResolvedValue({
    running: true,
    ready: true,
    runtimeInstanceId: 'runtime-instance-1',
  }),
  requestLocalExecutor: vi.fn().mockResolvedValue({ restarted: true }),
}))

vi.mock('@/components/layout/workspace-panels/RemoteTerminal', () => ({
  RemoteTerminal: ({ sessionId, active }: { sessionId: string; active: boolean }) => (
    <div
      data-testid="settings-device-remote-terminal"
      data-session-id={sessionId}
      hidden={!active}
    />
  ),
}))

const createDeviceApiMock = vi.mocked(createDeviceApi)
const createUserApiMock = vi.mocked(createUserApi)
const openExternalUrlMock = vi.mocked(openExternalUrl)

function cloudDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 1,
    device_id: 'device-1',
    name: 'device-1',
    status: 'online',
    is_default: false,
    device_type: 'cloud',
    bind_shell: 'claudecode',
    executor_version: '1.712',
    client_ip: '203.0.113.10',
    cloud_config: {
      sandboxId: 'sandbox-1',
      deviceId: 'cloud-runtime-device-1',
      deviceName: 'device-1',
      ubuntuInitialPassword: 'initial-password-1',
    },
    ...overrides,
  }
}

function localDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return cloudDevice({
    id: 2,
    device_id: 'local-device',
    name: 'Local Claude Device',
    device_type: 'local',
    bind_shell: 'claudecode',
    cloud_config: undefined,
    ...overrides,
  })
}

describe('ConnectionsSettingsPage', () => {
  test('removes cloud settings navigation and falls back safely for old links', () => {
    window.history.replaceState({}, '', '/settings/connections')
    render(<ConnectionsSettingsPage onBack={vi.fn()} />)
    expect(screen.queryByTestId('settings-nav-connections')).not.toBeInTheDocument()
    expect(screen.queryByTestId('settings-cloud-connect-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('general-settings-page')).toBeInTheDocument()
  })

  test('opens the separate SSH settings page only on a KCoder Gateway host', async () => {
    const marker = document.createElement('meta')
    marker.name = 'kcoder-rpc-token'
    marker.content = 'synthetic-settings-test'
    document.head.append(marker)
    try {
      render(<ConnectionsSettingsPage onBack={vi.fn()} />)
      await userEvent.click(screen.getByTestId('settings-nav-ssh-connections'))
      expect(screen.getByTestId('ssh-connections-settings-page')).toBeInTheDocument()
      expect(window.location.pathname).toBe('/settings/ssh-connections')
      expect(screen.getByTestId('settings-nav-kcoder-servers')).toBeInTheDocument()
    } finally {
      marker.remove()
    }
  })

  test('routes new-session defaults to the Gateway-only target settings page', async () => {
    const marker = document.createElement('meta')
    marker.name = 'kcoder-rpc-token'
    marker.content = 'synthetic-settings-test'
    document.head.append(marker)
    try {
      render(<ConnectionsSettingsPage onBack={vi.fn()} />)
      const nav = screen.getByTestId('settings-nav-execution-defaults')
      expect(nav).toBeInTheDocument()
      await userEvent.click(nav)
      expect(screen.getByTestId('execution-defaults-settings-page')).toBeInTheDocument()
      expect(window.location.pathname).toBe('/settings/execution-defaults')
      expect(screen.queryByTestId('settings-nav-target-extensions')).not.toBeInTheDocument()
    } finally {
      marker.remove()
    }
  })

  test('removes the duplicate target extensions entry and handles its old URL safely', () => {
    const marker = document.createElement('meta')
    marker.name = 'kcoder-rpc-token'
    marker.content = 'synthetic-settings-test'
    document.head.append(marker)
    const onBack = vi.fn()
    try {
      window.history.replaceState({}, '', '/settings/target-extensions')
      render(<ConnectionsSettingsPage onBack={onBack} />)
      expect(screen.queryByTestId('settings-nav-target-extensions')).not.toBeInTheDocument()
      expect(screen.getByTestId('general-settings-page')).toBeInTheDocument()
      expect(onBack).not.toHaveBeenCalled()
    } finally {
      marker.remove()
    }
  })

  test('keeps a direct new-session defaults route on non-Gateway hosts for an explicit unsupported page', () => {
    window.history.pushState({}, '', '/settings/execution-defaults')
    render(<ConnectionsSettingsPage onBack={vi.fn()} />)
    expect(screen.queryByTestId('settings-nav-execution-defaults')).not.toBeInTheDocument()
    expect(screen.queryByTestId('settings-nav-target-extensions')).not.toBeInTheDocument()
    expect(screen.getByTestId('execution-defaults-settings-page')).toBeInTheDocument()
  })

  test('combines phone pairing and browser access under Access links', async () => {
    const marker = document.createElement('meta')
    marker.name = 'kcoder-rpc-token'
    marker.content = 'synthetic-settings-test'
    document.head.append(marker)
    try {
      render(<ConnectionsSettingsPage onBack={vi.fn()} />)
      await userEvent.click(screen.getByTestId('settings-nav-access-links'))
      expect(screen.getByTestId('browser-access-settings-page')).toBeInTheDocument()
      expect(window.location.pathname).toBe('/settings/access-links')
    } finally {
      marker.remove()
    }
  })

  test('hides SSH settings and rejects its direct route on non-Gateway hosts', () => {
    window.history.pushState({}, '', '/settings/ssh-connections')
    render(<ConnectionsSettingsPage onBack={vi.fn()} />)
    expect(screen.queryByTestId('settings-nav-ssh-connections')).not.toBeInTheDocument()
    expect(screen.queryByTestId('settings-nav-access-links')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ssh-connections-settings-page')).not.toBeInTheDocument()
    expect(screen.getByTestId('settings-nav-general')).toBeInTheDocument()
  })

  const api = {
    getAllDevices: vi.fn(),
    startTerminal: vi.fn(),
    startCodeServer: vi.fn(),
    createCloudDevice: vi.fn(),
    createDockerRemoteDeviceCommand: vi.fn(),
    renameDevice: vi.fn(),
    restartCloudDevice: vi.fn(),
    deleteCloudDevice: vi.fn(),
    deleteDevice: vi.fn(),
    getMetrics: vi.fn(),
    getMetricsHistory: vi.fn(),
  }
  const userApi = {
    updateCurrentUser: vi.fn(),
    getRuntimeConfig: vi.fn(),
    updateRuntimeConfig: vi.fn(),
    getProxyConfig: vi.fn(),
    updateProxyConfig: vi.fn(),
    uploadRuntimeAuthJson: vi.fn(),
    importRuntimeAuthJson: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    clearTestTransports()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
    runtimeConfigMock.value = {
      appBasePath: '',
      apiBaseUrl: '/api',
      socketBaseUrl: 'http://203.0.113.10:8000',
      socketPath: '/socket.io',
      cloudDeviceScalingWikiUrl: '',
    }
    window.history.pushState({}, '', '/settings/connections')
    openExternalUrlMock.mockResolvedValue(true)
    cloudDesktopExtensionMock.available = true
    cloudDesktopExtensionMock.DeviceAction.mockImplementation(
      ({ deviceId, disabled, onOpened }) => (
        <button
          type="button"
          data-testid={`connection-cloud-desktop-button-${deviceId}`}
          disabled={disabled}
          onClick={onOpened}
        >
          桌面
        </button>
      )
    )
    api.getMetrics.mockResolvedValue({
      cpu_usage: 42,
      memory_usage: 68,
      disk_usage: 57,
    })
    api.getMetricsHistory.mockResolvedValue({
      cpu: [],
      memory: [],
      disk: [],
    })
    localCodexPluginApiMock.readCodexLocalConfig.mockResolvedValue({
      codexHome: '/Users/dev/.wegent-executor/codex',
      configPath: '/Users/dev/.wegent-executor/codex/config.toml',
      remoteAppsEnabled: false,
    })
    localCodexPluginApiMock.updateCodexLocalConfig.mockImplementation(patch =>
      Promise.resolve({
        codexHome: '/Users/dev/.wegent-executor/codex',
        configPath: '/Users/dev/.wegent-executor/codex/config.toml',
        remoteAppsEnabled: Boolean(patch.remoteAppsEnabled),
      })
    )
    createDeviceApiMock.mockReturnValue(api)
    userApi.getRuntimeConfig.mockResolvedValue({
      runtime: 'codex',
      display_name: 'Codex',
      use_user_config: false,
      use_proxy: false,
      configured: true,
      target_path: '~/.codex/auth.json',
      auth_json_sha256: 'abc1234567890',
      auth_json_updated_at: '2026-06-09T00:00:00Z',
      proxy_configured: false,
      proxy_url_masked: '',
      proxy_updated_at: null,
      updated_at: '2026-06-09T00:00:00Z',
    })
    userApi.updateRuntimeConfig.mockResolvedValue({
      runtime: 'codex',
      display_name: 'Codex',
      use_user_config: true,
      use_proxy: false,
      configured: true,
      target_path: '~/.codex/auth.json',
      auth_json_sha256: 'abc1234567890',
      auth_json_updated_at: '2026-06-09T00:00:00Z',
      proxy_configured: false,
      proxy_url_masked: '',
      proxy_updated_at: null,
      updated_at: '2026-06-09T00:00:01Z',
    })
    userApi.getProxyConfig.mockResolvedValue({
      configured: false,
      proxy_url_masked: '',
      proxy_updated_at: null,
      updated_at: null,
    })
    userApi.updateProxyConfig.mockResolvedValue({
      configured: true,
      proxy_url_masked: 'http://127.0.0.1:7890',
      proxy_updated_at: '2026-06-09T00:00:02Z',
      updated_at: '2026-06-09T00:00:02Z',
    })
    userApi.uploadRuntimeAuthJson.mockResolvedValue({
      runtime: 'codex',
      display_name: 'Codex',
      use_user_config: false,
      use_proxy: false,
      configured: true,
      target_path: '~/.codex/auth.json',
      auth_json_sha256: 'abc1234567890',
      auth_json_updated_at: '2026-06-09T00:00:00Z',
      proxy_configured: false,
      proxy_url_masked: '',
      proxy_updated_at: null,
      updated_at: '2026-06-09T00:00:00Z',
    })
    userApi.importRuntimeAuthJson.mockResolvedValue({
      runtime: 'codex',
      display_name: 'Codex',
      use_user_config: false,
      use_proxy: false,
      configured: true,
      target_path: '~/.codex/auth.json',
      auth_json_sha256: 'abc1234567890',
      auth_json_updated_at: '2026-06-09T00:00:00Z',
      proxy_configured: false,
      proxy_url_masked: '',
      proxy_updated_at: null,
      updated_at: '2026-06-09T00:00:00Z',
    })
    createUserApiMock.mockReturnValue(userApi as ReturnType<typeof createUserApi>)
  })

  test('opens general settings by default', async () => {
    window.history.pushState({}, '', '/settings')
    api.getAllDevices.mockResolvedValue([])

    render(
      <ConnectionsSettingsPage
        onBack={vi.fn()}
        services={
          {
            runtimeWorkApi: {
              listArchivedConversations: vi
                .fn()
                .mockResolvedValue({ items: [], projectGroups: [], total: 0 }),
            },
          } as unknown as NonNullable<Parameters<typeof ConnectionsSettingsPage>[0]['services']>
        }
      />
    )

    expect(await screen.findByTestId('general-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('settings-nav-general')).toHaveClass(
      'bg-[rgb(var(--color-sidebar-active))]'
    )
    const integrationsCategory = screen.getByTestId('settings-category-integrations')
    const codingCategory = screen.getByTestId('settings-category-coding')
    const archivedCategory = screen.getByTestId('settings-category-archived')
    const pluginsNav = screen.getByTestId('settings-nav-plugins')
    const worktreesNav = screen.getByTestId('settings-nav-worktrees')

    expect(integrationsCategory).toHaveTextContent('集成')
    expect(codingCategory).toHaveTextContent('编码')
    expect(archivedCategory).toHaveTextContent('已归档')
    expect(integrationsCategory.parentElement).toContainElement(pluginsNav)
    expect(
      within(integrationsCategory.parentElement!).queryByTestId('settings-nav-worktrees')
    ).toBeNull()
    expect(codingCategory.parentElement).toContainElement(worktreesNav)
    expect(screen.getByTestId('settings-nav-keyboard-shortcuts')).toBeInTheDocument()
    expect(within(codingCategory.parentElement!).queryByTestId('settings-nav-plugins')).toBeNull()
    expect(
      pluginsNav.compareDocumentPosition(codingCategory) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      worktreesNav.compareDocumentPosition(archivedCategory) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    expect(archivedCategory.tagName).toBe('BUTTON')
    await userEvent.click(archivedCategory)
    expect(window.location.pathname).toBe('/settings/archived-conversations')

    await userEvent.click(worktreesNav)

    expect(window.location.pathname).toBe('/settings/worktrees')
    expect(screen.getByTestId('worktrees-settings-page')).toBeInTheDocument()
  })

  test('adds titlebar clearance for the settings back button in Gateway', () => {
    installTestTransport(() => null)
    api.getAllDevices.mockResolvedValue([])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(screen.getByTestId('settings-sidebar-topbar')).toHaveClass('h-[76px]', 'pt-6', 'mb-1')
    expect(screen.getByTestId('settings-back-button')).toBeInTheDocument()
    expect(
      within(screen.getByTestId('settings-main-titlebar-drag-region')).getByTestId(
        'macos-titlebar-drag-region'
      )
    ).toHaveAttribute('data-kcoder-drag-region')
  })

  test('keeps the settings navigation scrollable within the sidebar', () => {
    api.getAllDevices.mockResolvedValue([])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(screen.getByTestId('settings-sidebar-topbar')).toHaveClass('shrink-0')
    expect(screen.getByTestId('settings-sidebar-nav')).toHaveClass(
      'min-h-0',
      'flex-1',
      'overflow-y-auto'
    )
  })

  test('the titlebar sidebar request collapses and restores the settings navigation', async () => {
    const onBack = vi.fn()
    render(<ConnectionsSettingsPage onBack={onBack} />)
    const sidebar = screen.getByTestId('settings-sidebar')
    const width = sidebar.style.width
    expect(Number.parseInt(width, 10)).toBeGreaterThan(0)
    act(() => {
      expect(requestDesktopSidebarToggle()).toBe(true)
    })
    expect(sidebar).toHaveStyle({ width: '0px' })
    expect(sidebar).toHaveAttribute('aria-hidden', 'true')
    expect(sidebar).toHaveAttribute('inert')
    expect(screen.getByTestId('settings-sidebar-resize-handle')).toBeDisabled()
    act(() => {
      expect(requestDesktopSidebarToggle()).toBe(true)
    })
    expect(sidebar).toHaveStyle({ width })
    expect(sidebar).toHaveAttribute('aria-hidden', 'false')
    await userEvent.click(screen.getByTestId('settings-back-button'))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  test('opens appearance settings from desktop settings navigation', async () => {
    api.getAllDevices.mockResolvedValue([])

    render(
      <AppearanceProvider>
        <ConnectionsSettingsPage onBack={vi.fn()} />
      </AppearanceProvider>
    )

    await userEvent.click(screen.getByTestId('settings-nav-appearance'))

    expect(screen.getByTestId('appearance-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('appearance-mode-system')).toBeInTheDocument()
  })

  test('lets the configured workbench background show through the settings shell', () => {
    localStorage.setItem(
      'wework.appearance',
      JSON.stringify({ backgroundImagePath: '/app-data/background.png' })
    )

    render(
      <AppearanceProvider>
        <ConnectionsSettingsPage onBack={vi.fn()} />
      </AppearanceProvider>
    )

    const settingsPage = screen.getByTestId('studio-settings-page')
    expect(settingsPage).toHaveClass('bg-transparent')
    expect(settingsPage.querySelector('aside')).toHaveClass('bg-background/25')
    expect(settingsPage.querySelector('aside')).not.toHaveClass('backdrop-blur-xl')
    expect(settingsPage.querySelector('main')).toHaveClass('bg-background/20')
  })

  test('opens about settings from desktop settings navigation', async () => {
    api.getAllDevices.mockResolvedValue([])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(screen.getByTestId('settings-nav-about'))

    expect(screen.getByTestId('about-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('about-check-update-button')).toBeInTheDocument()
    expect(screen.getByTestId('about-link-github')).toBeInTheDocument()
    expect(screen.queryByTestId('about-link-discord')).not.toBeInTheDocument()
  })

  test('opens browser settings from the integrations navigation', async () => {
    api.getAllDevices.mockResolvedValue([])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    const browserNav = screen.getByTestId('settings-nav-browser')
    expect(browserNav).toHaveTextContent('浏览器')
    await userEvent.click(browserNav)

    expect(await screen.findByTestId('browser-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('browser-external-link-target')).toHaveValue('system')
    expect(window.location.pathname).toBe('/settings/browser')
  })

  test('opens model settings under personal group without manual device sync', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    expect(screen.getByTestId('settings-category-personal')).toHaveTextContent('个人')

    await userEvent.click(screen.getByTestId('settings-nav-model-settings'))

    expect(await screen.findByTestId('model-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('model-interface-settings')).toHaveTextContent('模型接口')
    expect(
      within(screen.getByTestId('model-interface-settings')).queryByRole('heading', {
        name: '本机接口',
      })
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('codex-auth-settings')).toHaveTextContent('KCoder 设置')
    expect(screen.getByTestId('codex-auth-settings')).toHaveTextContent('认证信息')
    expect(screen.getByTestId('codex-auth-settings')).toHaveTextContent('模型')
    expect(screen.getByTestId('local-codex-model-row')).toHaveTextContent('旧版设备凭据')
    expect(await screen.findByTestId('runtime-config-status')).toHaveTextContent('已配置')
    expect(screen.getByText('共享认证')).toBeInTheDocument()
    expect(screen.getByText('~/.codex/auth.json')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-config-sync-source-select')).toHaveTextContent('当前设备')
    expect(screen.getByTestId('runtime-config-sync-auth-button')).toHaveTextContent(
      '同步到其他设备'
    )
    expect(screen.queryByTestId('runtime-config-import-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-config-upload-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-config-proxy-toggle')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('runtime-config-toggle'))

    await waitFor(() =>
      expect(userApi.updateRuntimeConfig).toHaveBeenCalledWith('codex', {
        use_user_config: true,
      })
    )
    await waitFor(() =>
      expect(screen.getByTestId('runtime-config-toggle')).toHaveAttribute('aria-checked', 'true')
    )

    expect(screen.queryByTestId('runtime-config-sync-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-config-sync-result')).not.toBeInTheDocument()
  })

  test('replaces the browser-local model editor with target-owned API settings on Gateway pages', () => {
    const meta = document.createElement('meta')
    meta.name = 'kcoder-rpc-token'
    meta.content = 'test-token'
    document.head.append(meta)
    window.history.pushState({}, '', '/settings/personal/models')

    try {
      render(<ConnectionsSettingsPage onBack={vi.fn()} />)

      expect(screen.getByTestId('settings-nav-model-settings')).toBeInTheDocument()
      expect(screen.queryByTestId('settings-nav-proxy')).not.toBeInTheDocument()
      expect(screen.queryByTestId('settings-nav-plugins')).not.toBeInTheDocument()
      expect(screen.queryByTestId('model-settings-page')).not.toBeInTheDocument()
      expect(screen.getByTestId('kcoder-provider-settings-page')).toBeInTheDocument()
    } finally {
      meta.remove()
    }
  })

  test('rejects a direct browser-local proxy settings route on KCoder Gateway pages', () => {
    const meta = document.createElement('meta')
    meta.name = 'kcoder-rpc-token'
    meta.content = 'test-token'
    document.head.append(meta)
    window.history.pushState({}, '', '/settings/personal/proxy')

    try {
      render(<ConnectionsSettingsPage onBack={vi.fn()} />)

      expect(screen.queryByTestId('settings-nav-proxy')).not.toBeInTheDocument()
      expect(screen.queryByTestId('proxy-settings-page')).not.toBeInTheDocument()
      expect(screen.getByTestId('general-settings-page')).toBeInTheDocument()
    } finally {
      meta.remove()
    }
  })

  test('rejects the desktop-only plugin settings route on KCoder Gateway pages', () => {
    const meta = document.createElement('meta')
    meta.name = 'kcoder-rpc-token'
    meta.content = 'test-token'
    document.head.append(meta)
    window.history.pushState({}, '', '/settings/plugins')

    try {
      render(<ConnectionsSettingsPage onBack={vi.fn()} />)

      expect(screen.queryByTestId('settings-nav-plugins')).not.toBeInTheDocument()
      expect(screen.queryByTestId('plugin-settings-page')).not.toBeInTheDocument()
      expect(screen.getByTestId('general-settings-page')).toBeInTheDocument()
    } finally {
      meta.remove()
    }
  })

  test('waits for a provider selection before showing model fields', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(screen.getByTestId('settings-nav-model-settings'))
    await screen.findByTestId('model-settings-page')
    await userEvent.click(screen.getByTestId('local-model-add-button'))

    expect(screen.getByTestId('local-model-provider-select')).toHaveValue('')
    expect(screen.queryByTestId('local-model-api-format-select')).not.toBeInTheDocument()
    expect(screen.queryByTestId('local-model-save-button')).not.toBeInTheDocument()

    await userEvent.selectOptions(screen.getByTestId('local-model-provider-select'), 'custom')

    expect(screen.getByTestId('local-model-api-format-select')).toBeInTheDocument()
    expect(screen.getByTestId('local-model-save-button')).toBeInTheDocument()
    expect(screen.queryByTestId('local-model-catalog-json-input')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('local-model-context-window-input')).toHaveLength(1)
  })

  test('persists custom catalog capabilities and silently restarts Codex when idle', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])
    vi.mocked(requestLocalExecutor).mockImplementation(async method =>
      method === 'runtime.codex.catalog.custom.write'
        ? { saved: true, modelCount: 1 }
        : { restarted: true, requiresConfirmation: false, activeTaskCount: 0 }
    )

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(screen.getByTestId('settings-nav-model-settings'))
    await screen.findByTestId('model-settings-page')
    await userEvent.click(screen.getByTestId('local-model-add-button'))
    await userEvent.selectOptions(screen.getByTestId('local-model-provider-select'), 'custom')
    expect(
      (screen.getByTestId('local-model-base-instructions-input') as HTMLTextAreaElement).value
    ).toContain('# Working with the user')
    await userEvent.clear(screen.getByTestId('local-model-context-window-input'))
    await userEvent.type(screen.getByTestId('local-model-context-window-input'), '131072')
    await userEvent.click(screen.getByTestId('local-model-parallel-tools-select'))
    await userEvent.click(screen.getByTestId('local-model-input-modality-image'))
    await userEvent.click(screen.getByTestId('local-model-image-generation-checkbox'))
    await userEvent.click(screen.getByTestId('local-model-reasoning-level-high'))
    await userEvent.selectOptions(screen.getByTestId('local-model-default-reasoning-input'), 'high')
    await userEvent.click(screen.getByTestId('local-model-advanced-capabilities-toggle'))
    await userEvent.click(screen.getByTestId('local-model-advanced-section-metadata'))
    await userEvent.type(screen.getByTestId('local-model-speed-tiers-input'), 'fast')
    await userEvent.click(screen.getByTestId('local-model-speed-tiers-add'))
    await userEvent.click(screen.getByTestId('local-model-service-tiers-add'))
    await userEvent.type(screen.getByTestId('local-model-service-tiers-0-id'), 'priority')
    await userEvent.type(screen.getByTestId('local-model-service-tiers-0-name'), 'Priority')
    await userEvent.type(
      screen.getByTestId('local-model-service-tiers-0-description'),
      'Faster requests'
    )
    expect(screen.getByTestId('local-model-service-tiers-0-delete').closest('label')).toBeNull()
    await userEvent.selectOptions(
      screen.getByTestId('local-model-default-service-tier-input'),
      'priority'
    )
    await userEvent.click(screen.getByTestId('local-model-advanced-capabilities-close'))
    await userEvent.type(screen.getByTestId('local-model-id-input'), 'custom-coder')
    await userEvent.type(screen.getByTestId('local-model-url-input'), 'http://localhost:11434/v1')
    await userEvent.click(screen.getByTestId('local-model-save-button'))

    await waitFor(() =>
      expect(requestLocalExecutor).toHaveBeenCalledWith(
        'runtime.codex.catalog.custom.write',
        expect.objectContaining({ models: expect.any(Array) })
      )
    )
    expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.codex.app_server.restart', {
      ifIdle: true,
    })
    const stored = JSON.parse(localStorage.getItem('wework.localModelSettings.v1') ?? '[]')
    expect(stored[0]).toMatchObject({
      modelId: 'custom-coder',
      codexCatalogModelId: expect.stringMatching(/^wework-custom-/),
      catalogReady: true,
      imageGenerationEnabled: true,
    })
    expect(stored[0].catalogEntry.base_instructions).toContain('# Rules for getting work done')
    expect(stored[0].catalogEntry).toMatchObject({
      context_window: 131072,
      max_context_window: 131072,
      supports_parallel_tool_calls: true,
      input_modalities: ['text', 'image'],
      supported_reasoning_levels: [{ effort: 'high', description: 'Deep reasoning' }],
      default_reasoning_level: 'high',
      service_tiers: [{ id: 'priority', name: 'Priority', description: 'Faster requests' }],
      additional_speed_tiers: ['fast'],
      default_service_tier: 'priority',
    })
  }, 15_000)

  test('keeps a custom model pending when active tasks prevent a silent restart', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])
    vi.mocked(requestLocalExecutor)
      .mockResolvedValueOnce({ saved: true, modelCount: 1 })
      .mockResolvedValueOnce({
        restarted: false,
        requiresConfirmation: true,
        activeTaskCount: 1,
      })

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(screen.getByTestId('settings-nav-model-settings'))
    await screen.findByTestId('model-settings-page')
    await userEvent.click(screen.getByTestId('local-model-add-button'))
    await userEvent.selectOptions(screen.getByTestId('local-model-provider-select'), 'custom')
    await userEvent.type(screen.getByTestId('local-model-id-input'), 'pending-coder')
    await userEvent.type(screen.getByTestId('local-model-url-input'), 'http://localhost:11434/v1')
    await userEvent.click(screen.getByTestId('local-model-save-button'))

    expect(await screen.findByTestId('local-model-catalog-restart-dialog')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('local-model-catalog-restart-later-button'))
    expect(screen.getByTestId('local-model-settings')).toHaveTextContent('等待重启执行器')
    const stored = JSON.parse(localStorage.getItem('wework.localModelSettings.v1') ?? '[]')
    expect(stored[0].catalogReady).toBe(false)
  })

  test('uses the built-in K3 catalog profile and verified model defaults', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])
    const originalFetch = globalThis.fetch
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: 'k3' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      ),
    })

    try {
      render(<ConnectionsSettingsPage onBack={vi.fn()} />)

      await userEvent.click(screen.getByTestId('settings-nav-model-settings'))
      await screen.findByTestId('model-settings-page')
      await userEvent.click(screen.getByTestId('local-model-add-button'))
      await userEvent.selectOptions(
        screen.getByTestId('local-model-provider-select'),
        'kimi-coding'
      )
      const groupInput = screen.getByTestId('local-model-group-input')
      expect(groupInput).toHaveValue('Kimi')
      await userEvent.clear(groupInput)
      await userEvent.type(groupInput, '月之暗面')
      await userEvent.type(screen.getByTestId('local-model-api-key-input'), 'test-key')
      await userEvent.click(screen.getByTestId('local-model-load-provider-models-button'))
      await waitFor(() =>
        expect(screen.getByTestId('local-model-provider-model-select')).toHaveValue('k3')
      )
      await userEvent.click(screen.getByTestId('local-model-save-button'))

      const stored = JSON.parse(localStorage.getItem('wework.localModelSettings.v1') ?? '[]')
      expect(stored[0]).toMatchObject({
        providerProfileId: 'kimi-coding',
        group: '月之暗面',
        modelId: 'k3',
        contextWindow: 262_144,
        codexCatalogModelId: 'wework-kimi-k3',
        catalogReady: true,
      })
      expect(requestLocalExecutor).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: originalFetch,
      })
    }
  })

  test('tests a model before saving it', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'resp_1',
          output: [{ type: 'custom_tool_call', name: 'wework_capability_probe' }],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    )
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    })

    try {
      render(<ConnectionsSettingsPage onBack={vi.fn()} />)

      await userEvent.click(screen.getByTestId('settings-nav-model-settings'))
      await screen.findByTestId('model-settings-page')
      await userEvent.click(screen.getByTestId('local-model-add-button'))
      await userEvent.selectOptions(screen.getByTestId('local-model-provider-select'), 'custom')
      expect(screen.getByTestId('local-model-request-url')).toHaveTextContent(
        '填写模型基础地址和请求路径；粘贴完整地址时会自动拆分'
      )
      const urlInput = screen.getByTestId('local-model-url-input')
      urlInput.focus()
      await userEvent.paste('http://localhost:11434/v1/responses')
      expect(screen.getByTestId('local-model-url-input')).toHaveValue('http://localhost:11434/v1')
      expect(screen.getByTestId('local-model-request-path-input')).toHaveValue('/responses')
      expect(screen.getByTestId('local-model-request-url')).toHaveTextContent(
        '请求地址：http://localhost:11434/v1/responses'
      )
      await userEvent.type(screen.getByTestId('local-model-id-input'), 'gpt-oss:20b')
      await userEvent.type(screen.getByTestId('local-model-api-key-input'), 'local-secret')
      await userEvent.click(screen.getByTestId('local-model-test-button'))

      expect(await screen.findByTestId('local-model-test-result')).toHaveTextContent('模型连接正常')
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:11434/v1/responses',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer local-secret',
          }),
        })
      )
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: originalFetch,
      })
    }
  })

  test('switches the endpoint and test payload for Chat Completions models', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [{ function: { name: 'wework_capability_probe', arguments: '{}' } }],
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    )
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock })

    try {
      render(<ConnectionsSettingsPage onBack={vi.fn()} />)

      await userEvent.click(screen.getByTestId('settings-nav-model-settings'))
      await screen.findByTestId('model-settings-page')
      await userEvent.click(screen.getByTestId('local-model-add-button'))
      await userEvent.selectOptions(screen.getByTestId('local-model-provider-select'), 'custom')
      await userEvent.selectOptions(
        screen.getByTestId('local-model-api-format-select'),
        'openai-chat-completions'
      )
      expect(screen.getByTestId('local-model-request-path-input')).toHaveValue('/chat/completions')
      await userEvent.type(
        screen.getByTestId('local-model-url-input'),
        'https://api.kimi.com/coding/v1'
      )
      await userEvent.type(screen.getByTestId('local-model-id-input'), 'kimi-for-coding')
      await userEvent.click(screen.getByTestId('local-model-test-button'))

      expect(await screen.findByTestId('local-model-test-result')).toHaveTextContent('模型连接正常')
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.kimi.com/coding/v1/chat/completions',
        expect.any(Object)
      )
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
        messages: [{ role: 'user', content: 'Call the capability probe with value PING.' }],
        stream: false,
      })
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: originalFetch,
      })
    }
  })

  test('switches the endpoint, headers, and test payload for Anthropic Messages models', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'tool_use', name: 'wework_capability_probe', id: 'tool_1', input: {} }],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    )
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock })

    try {
      render(<ConnectionsSettingsPage onBack={vi.fn()} />)

      await userEvent.click(screen.getByTestId('settings-nav-model-settings'))
      await screen.findByTestId('model-settings-page')
      await userEvent.click(screen.getByTestId('local-model-add-button'))
      await userEvent.selectOptions(screen.getByTestId('local-model-provider-select'), 'custom')
      await userEvent.selectOptions(
        screen.getByTestId('local-model-api-format-select'),
        'anthropic-messages'
      )
      expect(screen.getByTestId('local-model-request-path-input')).toHaveValue('/v1/messages')
      await userEvent.type(
        screen.getByTestId('local-model-url-input'),
        'https://api.kimi.com/coding/'
      )
      await userEvent.type(screen.getByTestId('local-model-id-input'), 'kimi-for-coding')
      await userEvent.type(screen.getByTestId('local-model-api-key-input'), 'local-secret')
      await userEvent.click(screen.getByTestId('local-model-test-button'))

      expect(await screen.findByTestId('local-model-test-result')).toHaveTextContent('模型连接正常')
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.kimi.com/coding/v1/messages',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-api-key': 'local-secret',
            'anthropic-version': '2023-06-01',
          }),
        })
      )
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
        messages: [{ role: 'user', content: 'Call the capability probe with value PING.' }],
        stream: false,
      })
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: originalFetch,
      })
    }
  })

  test('prompts before discarding an unsaved local model form', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(screen.getByTestId('settings-nav-model-settings'))
    await screen.findByTestId('model-settings-page')
    await userEvent.click(screen.getByTestId('local-model-add-button'))
    await userEvent.selectOptions(screen.getByTestId('local-model-provider-select'), 'custom')
    await userEvent.type(screen.getByTestId('local-model-url-input'), 'http://localhost:11434/v1')

    await userEvent.click(screen.getByTestId('local-model-add-button'))

    expect(screen.getByTestId('local-model-discard-changes-dialog')).toHaveTextContent(
      '放弃未保存的模型配置？'
    )
    expect(screen.getByTestId('local-model-url-input')).toHaveValue('http://localhost:11434/v1')

    await userEvent.click(screen.getByTestId('local-model-discard-changes-cancel-button'))

    expect(screen.queryByTestId('local-model-discard-changes-dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('local-model-url-input')).toHaveValue('http://localhost:11434/v1')

    await userEvent.click(screen.getByTestId('local-model-add-button'))
    await userEvent.click(screen.getByTestId('local-model-discard-changes-confirm-button'))

    expect(screen.queryByTestId('local-model-discard-changes-dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('local-model-provider-select')).toHaveValue('')
    expect(screen.queryByTestId('local-model-url-input')).not.toBeInTheDocument()
  })

  test('keeps cloud auth sync controls unavailable when cloud is disconnected', async () => {
    const disconnectedConnection: CloudConnectionContextValue = {
      ...DISCONNECTED_STATE,
      isConnected: false,
      serviceKey: 'disconnected',
      connectWithAuthorization: vi.fn(),
      refreshUser: vi.fn(),
      disconnect: vi.fn(),
    }
    api.getAllDevices.mockResolvedValue([localDevice()])

    render(
      <CloudConnectionContext.Provider value={disconnectedConnection}>
        <ConnectionsSettingsPage onBack={vi.fn()} />
      </CloudConnectionContext.Provider>
    )

    await userEvent.click(screen.getByTestId('settings-nav-model-settings'))

    expect(await screen.findByTestId('model-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('local-codex-model-row')).toHaveTextContent('旧版设备凭据')
    const cloudSyncSection = screen.getByTestId('runtime-config-cloud-sync')
    expect(cloudSyncSection).toHaveClass('bg-background')
    expect(screen.getByTestId('runtime-config-shared-auth-unavailable')).toHaveClass(
      'border-dashed'
    )
    expect(
      within(screen.getByTestId('model-interface-settings')).getByText('模型接口')
    ).toBeInTheDocument()
    expect(
      within(screen.getByTestId('cloud-models-section')).getByText('云端模型')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-models-configure-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('codex-auth-settings')).toHaveTextContent('KCoder 设置')
    expect(screen.getByTestId('runtime-config-cloud-required')).toHaveTextContent('未连接云端')
    expect(screen.queryByTestId('runtime-config-toggle')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-config-proxy-toggle')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-config-import-device-select')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-config-import-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-config-upload-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-config-cloud-configure-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-config-sync-source-select')).toBeDisabled()
    expect(screen.getByTestId('runtime-config-sync-auth-button')).toHaveTextContent(
      '旧版云凭据同步不可用'
    )
    expect(screen.getByTestId('runtime-config-sync-auth-button')).toBeDisabled()
    expect(userApi.getRuntimeConfig).not.toHaveBeenCalled()

    expect(screen.queryByTestId('settings-nav-connections')).not.toBeInTheDocument()
  })

  test('saves personal proxy from proxy settings', async () => {
    api.getAllDevices.mockResolvedValue([localDevice()])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    await userEvent.click(screen.getByTestId('settings-nav-proxy'))

    expect(await screen.findByTestId('proxy-settings-page')).toBeInTheDocument()
    const proxyInput = await screen.findByTestId('proxy-config-url-input')
    await userEvent.type(proxyInput, 'http://127.0.0.1:7890')
    await userEvent.click(screen.getByTestId('proxy-config-save-button'))

    await waitFor(() =>
      expect(userApi.updateProxyConfig).toHaveBeenCalledWith('http://127.0.0.1:7890')
    )
    expect(screen.getByTestId('proxy-config-local-device-section')).toHaveTextContent(
      '本地设备代理'
    )
    expect(screen.getByTestId('proxy-config-cloud-device-section')).toHaveTextContent(
      '云端设备代理'
    )
    expect(await screen.findByText('http://127.0.0.1:7890')).toBeInTheDocument()
    expect(screen.queryByTestId('runtime-config-proxy-toggle')).not.toBeInTheDocument()
  })

  test('distinguishes local and cloud proxy settings while cloud is disconnected', async () => {
    const disconnectedConnection: CloudConnectionContextValue = {
      ...DISCONNECTED_STATE,
      isConnected: false,
      serviceKey: 'disconnected',
      connectWithAuthorization: vi.fn(),
      refreshUser: vi.fn(),
      disconnect: vi.fn(),
    }
    api.getAllDevices.mockResolvedValue([localDevice()])

    render(
      <CloudConnectionContext.Provider value={disconnectedConnection}>
        <ConnectionsSettingsPage onBack={vi.fn()} />
      </CloudConnectionContext.Provider>
    )

    await userEvent.click(screen.getByTestId('settings-nav-proxy'))

    expect(await screen.findByTestId('proxy-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('proxy-config-local-device-section')).toHaveTextContent(
      '本地设备代理'
    )
    expect(screen.getByTestId('proxy-config-cloud-required')).toHaveTextContent('云端设备代理')
    await userEvent.type(
      screen.getByTestId('local-proxy-config-url-input'),
      'http://127.0.0.1:7890'
    )
    await userEvent.click(screen.getByTestId('local-proxy-config-save-button'))

    expect(requestLocalExecutor).not.toHaveBeenCalled()
    expect(screen.getByTestId('local-proxy-config-notice')).toHaveTextContent('本地设备代理已保存')
    const restartCodexButton = screen.getByTestId('local-proxy-config-restart-codex-button')
    expect(restartCodexButton).toHaveTextContent('重启 KCoder')
    await userEvent.click(restartCodexButton)
    await waitFor(() =>
      expect(requestLocalExecutor).toHaveBeenCalledWith('runtime.codex.app_server.restart')
    )
    expect(screen.getByTestId('local-proxy-config-notice')).toHaveTextContent('KCoder 已重启')
    expect(screen.getByTestId('proxy-config-local-device-section')).toHaveTextContent(
      'http://127.0.0.1:7890'
    )
    expect(userApi.getProxyConfig).not.toHaveBeenCalled()
    expect(userApi.updateProxyConfig).not.toHaveBeenCalled()
  })

  test('updates the local Codex remote apps setting from plugin settings', async () => {
    window.history.pushState({}, '', '/settings/plugins')
    api.getAllDevices.mockResolvedValue([localDevice()])

    render(<ConnectionsSettingsPage onBack={vi.fn()} />)

    const toggle = await screen.findByTestId('codex-plugin-remote-apps-toggle')
    expect(screen.getByTestId('settings-category-integrations')).toHaveTextContent('集成')
    expect(screen.getByTestId('settings-nav-plugins')).toHaveTextContent('插件')
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    await userEvent.click(toggle)

    await waitFor(() => {
      expect(localCodexPluginApiMock.updateCodexLocalConfig).toHaveBeenCalledWith({
        remoteAppsEnabled: true,
      })
    })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
  })

  test('opens appearance settings from the browser path on reload', () => {
    api.getAllDevices.mockResolvedValue([])
    window.history.pushState({}, '', '/settings/appearance')

    render(
      <AppearanceProvider>
        <ConnectionsSettingsPage onBack={vi.fn()} />
      </AppearanceProvider>
    )

    expect(screen.getByTestId('appearance-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('settings-nav-appearance')).toHaveClass(
      'bg-[rgb(var(--color-sidebar-active))]'
    )
  })
})
