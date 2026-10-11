import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { PluginsWorkspace } from '@/components/plugins/PluginsWorkspace'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import { GatewayRpcError } from '@/kcoder/gatewayRpc'

const api = vi.hoisted(() => ({
  readState: vi.fn(),
  revalidate: vi.fn(),
  install: vi.fn(),
  revalidationEnabled: true,
}))
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => false,
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}))
vi.mock('@/api/local/codexPlugins', () => ({
  createLocalCodexPluginApi: () => ({
    readState: api.readState,
    selectMarketplace: api.readState,
    installAvailablePlugin: api.install,
    supportsAuthoring: false,
    revalidateAvailablePlugin: api.revalidationEnabled ? api.revalidate : undefined,
  }),
}))

function fixture() {
  return {
    marketplaces: [{ id: 'retry-market', name: 'Retry market', path: '/isolated/market' }],
    selectedMarketplaceId: 'retry-market',
    marketplacePath: '/isolated/market',
    installRegistryPath: '/isolated/store',
    installedPlugins: [],
    marketplaceItems: [
      {
        id: 'retry@retry-market',
        remotePluginId: 'retry',
        name: 'retry',
        displayName: 'Retry plugin',
        description: 'A network audit fixture',
        visibility: 'public',
        featured: false,
        installed: false,
        enabled: false,
        sourceType: 'marketplace',
        ownerUserId: 0,
        installable: false,
        components: {
          skills: [],
          commands: [],
          agents: [],
          hooks: [],
          mcps: [],
          lsps: [],
          monitors: [],
          bins: [],
        },
        manifest: {
          installationAvailability: { retryable: true },
          compatibility: {
            issues: [
              { code: 'installation_download_unverified', message: 'Previous network timeout' },
            ],
          },
        },
      },
    ],
  }
}

// These are model-independent renderer capability and state-transition checks;
// actual download/verification and target RPC are covered at their boundaries.
describe('plugin network revalidation controls', () => {
  beforeEach(() => {
    notifyAccountContextChange('plugin-lifecycle-test')
    window.localStorage.clear()
    api.readState.mockReset()
    api.revalidate.mockReset()
    api.install.mockReset()
    api.revalidationEnabled = true
    api.readState.mockResolvedValue(fixture())
  })
  it('runs preflight and refreshes availability without automatically installing', async () => {
    const state = fixture()
    api.readState.mockImplementation(async () => state)
    api.revalidate.mockImplementation(async () => {
      state.marketplaceItems[0].installable = true
      state.marketplaceItems[0].manifest.compatibility.issues = []
    })
    render(<PluginsWorkspace />)
    const button = await screen.findByTestId('plugin-marketplace-install-retry@retry-market')
    expect(button).toBeEnabled()
    fireEvent.click(button)
    await waitFor(() =>
      expect(api.revalidate).toHaveBeenCalledWith(
        'retry@retry-market',
        expect.objectContaining({ revalidationAttemptId: expect.any(String) })
      )
    )
    await waitFor(() =>
      expect(screen.getByTestId('plugin-marketplace-install-retry@retry-market')).toBeEnabled()
    )
    expect(api.install).not.toHaveBeenCalled()
  })
  it('keeps retry unavailable on older endpoints without silently installing', async () => {
    api.revalidationEnabled = false
    render(<PluginsWorkspace />)
    expect(
      await screen.findByTestId('plugin-marketplace-install-retry@retry-market')
    ).toBeDisabled()
    expect(api.install).not.toHaveBeenCalled()
    expect(api.revalidate).not.toHaveBeenCalled()
  })
  it('preserves a hard integrity block even alongside retryable network metadata', async () => {
    const state = fixture()
    state.marketplaceItems[0].manifest.compatibility.issues.push({
      code: 'installation_package_integrity',
      message: 'SHA mismatch',
    })
    api.readState.mockResolvedValue(state)
    render(<PluginsWorkspace />)
    expect(
      await screen.findByTestId('plugin-marketplace-install-retry@retry-market')
    ).toBeDisabled()
    expect(api.install).not.toHaveBeenCalled()
    expect(api.revalidate).not.toHaveBeenCalled()
  })
  it('turns a new source download timeout into preflight recovery without reinstalling', async () => {
    const state = fixture()
    state.marketplaceItems[0].installable = true
    state.marketplaceItems[0].manifest.compatibility.issues = []
    state.marketplaceItems[0].manifest.installationAvailability.retryable = false
    api.readState.mockResolvedValue(state)
    api.install.mockRejectedValue(
      new GatewayRpcError('timeout', -32000, { kind: 'network_timeout' }, 'unknown', 'remote')
    )
    api.revalidate.mockResolvedValue(undefined)
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<PluginsWorkspace />)
    fireEvent.click(await screen.findByTestId('plugin-marketplace-install-retry@retry-market'))
    await waitFor(() => expect(api.install).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByTestId('plugin-marketplace-install-retry@retry-market')).toHaveTextContent(
        i18n.t('pluginActivation.revalidate', {
          ns: 'common',
          defaultValue: 'Recheck availability',
        })
      )
    )
    fireEvent.click(screen.getByTestId('plugin-marketplace-install-retry@retry-market'))
    await waitFor(() => expect(api.revalidate).toHaveBeenCalledTimes(1))
    expect(api.install).toHaveBeenCalledTimes(1)
    diagnostic.mockRestore()
  })
})
