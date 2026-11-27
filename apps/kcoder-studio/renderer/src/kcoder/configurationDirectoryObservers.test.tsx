import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { fetchGatewayServers } from './gatewayRpc'
import { useAutomationDefaultTarget } from '@/components/chat/useAutomationDefaultTarget'
import { useAutomationIdentity } from '@/components/chat/useAutomationIdentity'
import { MigrationFirstUseLauncher } from '@/features/migration-first-use/MigrationFirstUseLauncher'
import { KCoderProviderSettingsPage } from '@/components/settings/KCoderProviderSettingsPage'
import { StorageSettingsPage } from '@/components/settings/StorageSettingsPage'
import { KCoderHooksSettingsPage } from './KCoderHooksSettingsPage'

// Keep the real React observers and directory transport; substitute only unrelated
// domain reads. This suite proves HTTP ownership/order, not native configuration.
const writes = vi.hoisted(() => vi.fn(() => { throw new Error('Unexpected domain mutation') }))
vi.mock('./providerSettings', async original => ({
  ...await original<typeof import('./providerSettings')>(),
  readProviderSettings: vi.fn(async () => ({ profiles: [], restartRequired: false })),
  readProviderTemplates: vi.fn(async () => ({ templates: [] })),
  saveProviderSettings: writes, deleteProviderSettings: writes, applyProviderSettings: writes,
  probeProviderSettings: writes, clearProviderUserOverride: writes,
}))
vi.mock('./hookConfigurationApi', () => ({
  readHookConfiguration: vi.fn(async () => ({ hooks: {}, revision: 'owned',
    configurationPath: '/owned/settings.json', appliesToNewConversations: true })),
  updateHookConfiguration: writes,
}))
vi.mock('./storageDiagnostics', () => ({
  readStorageReport: vi.fn(async () => ({ configRoot: '/owned', totalBytes: 0, totalFiles: 0,
    buckets: [], devDebug: { enabled: false, envSet: false, dotenvLines: 0, retentionDays: 7, logBytes: 0, logFiles: 0 },
    credentials: { path: '/owned/credentials.json', present: false, providers: 0, dotenvCredentialLines: 0,
      keyringAvailable: false, keyringBackend: 'none', keyringProviders: [], plaintextProviders: [] } })),
  cancelStorageScan: writes, cleanStorage: writes, disableDebugLog: writes,
}))
vi.mock('./turnFileChanges', () => ({ readTurnFileChangesPolicy: vi.fn(async () => null), saveTurnFileChangesPolicy: writes }))
vi.mock('@/features/model-policies/NativeModelPolicyWorkspace', () => ({ NativeModelPolicyWorkspace: () => null }))
vi.mock('@/components/settings/ConfigTemplatesSection', () => ({ ConfigTemplatesSection: () => null }))
vi.mock('@/components/settings/StorageLocationsPanel', () => ({ StorageLocationsPanel: () => null }))
vi.mock('@/features/migration-first-use/MigrationFirstUsePanel', () => ({
  MigrationFirstUsePanel: () => <output data-testid="directory-observer-ready">ready</output>,
}))

const target = { id: 'directory-observer-owned', label: 'Owned directory target', runtime: 'kcoder',
  transport: 'local', workspacePath: '/owned', command: '/owned/kcoder', profile: 'owned' }
const invalidate = () => {}
function DefaultTarget({ hostId = target.id }: { hostId?: string | null }) {
  const host = useAutomationDefaultTarget(hostId ?? undefined, true)
  return host ? <output data-testid="directory-observer-ready">{host.id}</output> : null
}
function AutomationIdentity() {
  const identity = useAutomationIdentity({ deviceId: target.id, workspacePath: '/owned' }, invalidate)
  return identity.ready ? <output data-testid="directory-observer-ready">ready</output> : null
}
const observers = [
  { name: 'automation default target', render: () => <DefaultTarget />, ready: 'directory-observer-ready' },
  { name: 'automation identity', render: () => <AutomationIdentity />, ready: 'directory-observer-ready' },
  { name: 'first-use profile', render: () => <MigrationFirstUseLauncher targetId={target.id} enabled />, ready: 'directory-observer-ready' },
  { name: 'provider settings', render: () => <KCoderProviderSettingsPage />, ready: 'provider-new' },
  { name: 'storage settings', render: () => <StorageSettingsPage />, ready: 'storage-scan-target' },
  { name: 'Hooks settings', render: () => <KCoderHooksSettingsPage />, ready: 'hooks-json' },
]

beforeEach(() => {
  document.head.insertAdjacentHTML('beforeend', '<meta name="kcoder-rpc-token" content="owned-directory-observer-test">')
  writes.mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
  document.querySelectorAll('meta[content="owned-directory-observer-test"]').forEach(node => node.remove())
})

test.each(observers)('$name coalesces configuration bursts before actual HTTP and cancels queued reads on unmount', async observer => {
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ servers: [target] }))
  const page = render(observer.render())
  try {
    await waitFor(() => expect(screen.getByTestId(observer.ready)).not.toBeDisabled())
    await act(async () => {})
    expect(network).toHaveBeenCalledTimes(1)
    await act(async () => {
      for (let index = 0; index < 100; index++) window.dispatchEvent(new Event('kcoder:servers-changed'))
    })
    expect(network).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.getByTestId(observer.ready)).not.toBeDisabled())
    act(() => { window.dispatchEvent(new Event('kcoder:servers-changed')); page.unmount() })
    await act(async () => {})
    expect(network).toHaveBeenCalledTimes(2)
    expect(writes).not.toHaveBeenCalled()
  } finally { page.unmount() }
})

test.each(observers)('$name cannot join an old directory read from before configuration invalidation', async observer => {
  let hold = false, finish!: (response: Response) => void
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => hold
    ? new Promise<Response>(resolve => { hold = false; finish = resolve })
    : Promise.resolve(Response.json({ servers: [target] })))
  const page = render(observer.render())
  let peer: Promise<unknown> | undefined
  try {
    await waitFor(() => expect(screen.getByTestId(observer.ready)).not.toBeDisabled())
    await act(async () => {})
    hold = true
    peer = fetchGatewayServers()
    expect(network).toHaveBeenCalledTimes(2)
    await act(async () => { window.dispatchEvent(new Event('kcoder:servers-changed')) })
    expect(network).toHaveBeenCalledTimes(3)
    await waitFor(() => expect(screen.getByTestId(observer.ready)).not.toBeDisabled())
    await act(async () => { finish(Response.json({ servers: [{ ...target, label: 'Retired directory' }] })); await peer })
    expect(writes).not.toHaveBeenCalled()
  } finally {
    finish?.(Response.json({ servers: [] }))
    await peer
    page.unmount()
  }
})

// Explicit target observers must not turn another target's notice into a profile read.
test.each(observers.filter(observer => ['automation default target', 'automation identity', 'first-use profile'].includes(observer.name)))(
  '$name ignores unrelated target notices while preserving current/global refresh', async observer => {
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ servers: [target] }))
    const page = render(observer.render())
    try {
      await waitFor(() => expect(screen.getByTestId(observer.ready)).not.toBeDisabled())
      await act(async () => {})
      expect(network).toHaveBeenCalledTimes(1)
      await act(async () => {
        for (let index = 0; index < 100; index++) window.dispatchEvent(new CustomEvent('kcoder:servers-changed', {
          detail: { targetId: 'unrelated-directory-target' },
        }))
      })
      expect(network).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId(observer.ready)).not.toBeDisabled()
      await act(async () => { window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId: target.id } })) })
      expect(network).toHaveBeenCalledTimes(2)
      await waitFor(() => expect(screen.getByTestId(observer.ready)).not.toBeDisabled())
      await act(async () => { window.dispatchEvent(new Event('kcoder:servers-changed')) })
      expect(network).toHaveBeenCalledTimes(3)
      await waitFor(() => expect(screen.getByTestId(observer.ready)).not.toBeDisabled())
      expect(writes).not.toHaveBeenCalled()
    } finally { page.unmount() }
  }
)

test.each([
  { name: 'unresolved automation default', render: () => <DefaultTarget hostId={null} /> },
  { name: 'implicit first-use target', render: () => <MigrationFirstUseLauncher enabled /> },
])('$name still reconciles a target-specific directory notice', async observer => {
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ servers: [target] }))
  const page = render(observer.render())
  try {
    await waitFor(() => expect(screen.getByTestId('directory-observer-ready')).not.toBeDisabled())
    await act(async () => {})
    expect(network).toHaveBeenCalledTimes(1)
    await act(async () => { window.dispatchEvent(new CustomEvent('kcoder:servers-changed', { detail: { targetId: target.id } })) })
    expect(network).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.getByTestId('directory-observer-ready')).not.toBeDisabled())
    expect(writes).not.toHaveBeenCalled()
  } finally { page.unmount() }
})
