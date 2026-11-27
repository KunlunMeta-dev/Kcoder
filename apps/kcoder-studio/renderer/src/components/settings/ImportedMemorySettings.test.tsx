import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { RetainedPageActive } from '@/components/layout/retainedPageState'
import { fetchGatewayServers, type GatewayServer } from '@/kcoder/gatewayRpc'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'
import { ContextSettingsPage } from './ContextSettingsPage'
import type { MigrationDialogProps } from './MigrationDialog'

vi.mock('@/kcoder/gatewayRpc', async original => ({
  ...await original<typeof import('@/kcoder/gatewayRpc')>(), fetchGatewayServers: vi.fn(),
}))
vi.mock('@/host/appPreferences', () => ({ defaultAppPreferences: { terminalContextInjectionEnabled: true },
  getAppPreferences: async () => ({ terminalContextInjectionEnabled: true }), updateAppPreferences: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: async () => ({ instructions: 'Fixture instructions', configPath: null }) }))
vi.mock('./ToolProfileSettings', () => ({ ToolProfileSettings: () => null }))
vi.mock('./CodexPersonalitySettings', () => ({ CodexPersonalitySettings: () => null }))
vi.mock('./ImportedMemoryPanel', () => ({
  ImportedMemoryPanel: ({ target, onImport, onOpenJob }: {
    target: GatewayServer; onImport: () => void; onOpenJob: (id: string) => void
  }) => <section data-testid="notes-target" data-target={target.id} data-profile={target.profile}>
    <button onClick={onImport}>Import</button>
    <button onClick={() => onOpenJob('original-job')}>Original job</button>
  </section>,
}))
vi.mock('./MigrationDialog', () => ({
  MigrationDialog: ({ target, initialMode, initialJobId, onClose }: MigrationDialogProps) =>
    <div data-testid="notes-import-dialog" data-target={target?.id}>
      {initialMode}:{initialJobId}<button onClick={onClose}>Close</button>
    </div>,
}))

const local: GatewayServer = { id: 'notes-local', label: 'Local', transport: 'local' }
const remote: GatewayServer = { id: 'notes-remote', label: 'Remote', transport: 'ssh', profile: 'first' }
let catalog: GatewayServer[]
const workbench = { state: { currentRuntimeTask: null, currentProject: null, runtimeWork: null,
  selectedDeviceWorkspaceId: null, standaloneDeviceId: null, standaloneWorkspacePath: null } } as WorkbenchContextValue
function View({ deviceId = remote.id, active = true }: { deviceId?: string; active?: boolean }) {
  return <WorkbenchContext.Provider value={workbench}><RetainedPageActive.Provider value={active}>
    <ContextSettingsPage devices={[{ id: 1, device_id: deviceId, name: deviceId,
      status: 'online', is_default: true, capabilities: ['kcoder-gateway', 'kcoder-gateway-local'] }]} />
  </RetainedPageActive.Provider></WorkbenchContext.Provider>
}
beforeEach(() => {
  catalog = [local, remote]
  vi.mocked(fetchGatewayServers).mockReset().mockImplementation(async () => structuredClone(catalog))
  document.head.insertAdjacentHTML('beforeend', '<meta name="kcoder-rpc-token" content="notes-directory-test">')
})
afterEach(() => {
  document.querySelectorAll('meta[content="notes-directory-test"]').forEach(node => node.remove())
  vi.restoreAllMocks()
})

test('resolves the exact context target instead of the directory default', async () => {
  render(<View />)
  expect(await screen.findByTestId('notes-target')).toHaveAttribute('data-target', remote.id)
  expect(fetchGatewayServers).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByText('Original job'))
  expect(screen.getByTestId('notes-import-dialog')).toHaveTextContent('batch:original-job')
  expect(screen.getByTestId('notes-import-dialog')).toHaveAttribute('data-target', remote.id)
})

test('a missing explicit target cannot borrow another available host', async () => {
  catalog = [local]
  render(<View />)
  await waitFor(() => expect(fetchGatewayServers).toHaveBeenCalledOnce())
  await act(async () => {})
  expect(screen.queryByTestId('notes-target')).not.toBeInTheDocument()
  expect(screen.queryByTestId('notes-import-dialog')).not.toBeInTheDocument()
})

test.each(['browser', 'retained'] as const)('%s-hidden notes do not read the directory until shown', async kind => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(kind === 'browser' ? 'hidden' : 'visible')
  const view = render(<View active={kind !== 'retained'} />)
  try {
    await act(async () => {})
    expect(fetchGatewayServers).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    await act(async () => { view.rerender(<View />); document.dispatchEvent(new Event('visibilitychange')) })
    expect(await screen.findByTestId('notes-target')).toHaveAttribute('data-target', remote.id)
    expect(fetchGatewayServers).toHaveBeenCalledTimes(1)
  } finally { view.unmount() }
})

test.each(['browser', 'retained'] as const)('%s-hidden invalidation retires the dialog and defers the next read', async kind => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const view = render(<View />)
  try {
    await screen.findByTestId('notes-target')
    fireEvent.click(screen.getByText('Import'))
    expect(screen.getByTestId('notes-import-dialog')).toBeInTheDocument()
    visibility.mockReturnValue(kind === 'browser' ? 'hidden' : 'visible')
    await act(async () => { view.rerender(<View active={kind !== 'retained'} />); document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { notifyAccountContextChange(remote.id) })
    expect(fetchGatewayServers).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('notes-import-dialog')).not.toBeInTheDocument()
    visibility.mockReturnValue('visible')
    await act(async () => { view.rerender(<View />); document.dispatchEvent(new Event('visibilitychange')) })
    await screen.findByTestId('notes-target')
    expect(fetchGatewayServers).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('notes-import-dialog')).not.toBeInTheDocument()
  } finally { view.unmount() }
})

test.each(['configuration', 'account'] as const)('%s replaces the original directory without reopening its dialog, even for equal metadata', async kind => {
  const view = render(<View />)
  await screen.findByTestId('notes-target')
  fireEvent.click(screen.getByText('Original job'))
  await act(async () => {
    if (kind === 'account') notifyAccountContextChange(remote.id)
    else window.dispatchEvent(new Event('kcoder:servers-changed'))
  })
  await waitFor(() => expect(fetchGatewayServers).toHaveBeenCalledTimes(2))
  expect(await screen.findByTestId('notes-target')).toHaveAttribute('data-profile', 'first')
  expect(screen.queryByTestId('notes-import-dialog')).not.toBeInTheDocument()
  view.rerender(<View deviceId={local.id} />)
  await screen.findByTestId('notes-target')
  view.rerender(<View />)
  await screen.findByTestId('notes-target')
  expect(screen.queryByTestId('notes-import-dialog')).not.toBeInTheDocument()
})

test('account invalidation rejects an old late directory reply and publishes only the new profile', async () => {
  let finishOld!: (targets: GatewayServer[]) => void
  vi.mocked(fetchGatewayServers).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
  const view = render(<View />)
  await waitFor(() => expect(fetchGatewayServers).toHaveBeenCalledTimes(1))
  catalog = [local, { ...remote, profile: 'replacement' }]
  await act(async () => { notifyAccountContextChange(remote.id) })
  expect(await screen.findByTestId('notes-target')).toHaveAttribute('data-profile', 'replacement')
  await act(async () => { finishOld([remote]) })
  expect(screen.getByTestId('notes-target')).toHaveAttribute('data-profile', 'replacement')
  view.unmount()
})

test('unmounting releases its own real HTTP waiter while a peer can still finish', async () => {
  const actual = await vi.importActual<typeof import('@/kcoder/gatewayRpc')>('@/kcoder/gatewayRpc')
  let finish!: (response: Response) => void
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  vi.mocked(fetchGatewayServers).mockImplementation(actual.fetchGatewayServers)
  const first = render(<View />), peer = render(<View deviceId={local.id} />)
  try {
    await waitFor(() => expect(fetchGatewayServers).toHaveBeenCalledTimes(2))
    expect(network).toHaveBeenCalledTimes(1)
    first.unmount()
    expect(network.mock.calls[0][1]?.signal?.aborted).toBe(false)
    peer.unmount()
    expect(network.mock.calls[0][1]?.signal?.aborted).toBe(true)
    await act(async () => { finish(Response.json({ servers: catalog })) })
  } finally { first.unmount(); peer.unmount(); network.mockRestore() }
})
