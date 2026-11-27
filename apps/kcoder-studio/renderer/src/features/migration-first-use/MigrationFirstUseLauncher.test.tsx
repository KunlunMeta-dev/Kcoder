import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { MigrationFirstUseLauncher } from './MigrationFirstUseLauncher'
import { fetchGatewayServers } from '@/kcoder/gatewayRpc'
import { readProviderSettings } from '@/kcoder/providerSettings'
import { RetainedPageActive } from '@/components/layout/retainedPageState'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'

vi.mock('@/kcoder/gatewayRpc', async original => ({ ...await original<typeof import('@/kcoder/gatewayRpc')>(), fetchGatewayServers: vi.fn(), isKCoderGatewayPage: () => true }))
vi.mock('@/kcoder/providerSettings', () => ({ readProviderSettings: vi.fn() }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({ usePluginTargetScope: (id: string) => ({ key: id, isCurrent: () => true }) }))
vi.mock('@/components/settings/MigrationDialog', () => ({ MigrationDialog: ({ onClose, target, workspacePath }: { onClose(): void; target: { id: string }; workspacePath?: string }) => <div data-testid="first-use-dialog" data-target={target.id} data-workspace={workspacePath}><button onClick={onClose}>close import</button></div> }))
const target = { id: 'current', label: 'Current', description: '', runtime: 'kcoder' as const, transport: 'local' as const }
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); vi.mocked(fetchGatewayServers).mockResolvedValue([target]); vi.mocked(readProviderSettings).mockResolvedValue({ profiles: [], restartRequired: false }) })
afterEach(() => { delete window.__KCODER_STUDIO_RUNTIME_CONFIG__ })
it('offers a scoped optional migration only after the current target confirms empty settings and refreshes on return', async () => {
  render(<MigrationFirstUseLauncher targetId="current" enabled/>)
  await screen.findByTestId('migration-first-use-import')
  expect(readProviderSettings).toHaveBeenCalledWith('current')
  fireEvent.click(screen.getByTestId('migration-first-use-import'))
  expect(screen.getByTestId('first-use-dialog')).toHaveAttribute('data-target', 'current')
  fireEvent.click(screen.getByText('close import'))
  await waitFor(() => expect(readProviderSettings).toHaveBeenCalledTimes(2))
  expect(await screen.findByTestId('migration-first-use-import')).toBeTruthy()
  fireEvent.click(screen.getByTestId('migration-first-use-skip'))
  expect(screen.queryByTestId('migration-first-use')).toBeNull()
  act(() => window.dispatchEvent(new Event('kcoder:servers-changed')))
  await waitFor(() => expect(readProviderSettings).toHaveBeenCalledTimes(3))
  expect(screen.queryByTestId('migration-first-use')).toBeNull()
})
it('does not infer missing configuration from read failure or choose the first of multiple targets', async () => {
  vi.mocked(readProviderSettings).mockRejectedValue(new Error('offline'))
  const first = render(<MigrationFirstUseLauncher targetId="current" enabled/>)
  await waitFor(() => expect(readProviderSettings).toHaveBeenCalledOnce())
  expect(screen.queryByTestId('migration-first-use-import')).toBeNull(); first.unmount()
  // Without an explicit target only the current host is implied; several remote targets never default to the first one.
  vi.mocked(fetchGatewayServers).mockResolvedValue([{ ...target, id: 'peer', transport: 'ssh' }, { ...target, id: 'other-peer', transport: 'ssh' }]); vi.mocked(readProviderSettings).mockClear()
  render(<MigrationFirstUseLauncher enabled/>)
  await waitFor(() => expect(fetchGatewayServers).toHaveBeenCalledTimes(2))
  expect(readProviderSettings).not.toHaveBeenCalled()
})
it('already configured targets do not show another first-use guide or migration dialog', async () => {
  vi.mocked(readProviderSettings).mockResolvedValue({ restartRequired: false, profiles: [{ id: 'ready', endpoint: 'https://example.invalid', model: 'ready', apiFormat: 'openai_chat_completions', contextWindowTokens: 32000, maxOutputTokens: 4096, apiKeyConfigured: true, isDefault: true }] })
  render(<MigrationFirstUseLauncher targetId="current" enabled/>)
  await waitFor(() => expect(readProviderSettings).toHaveBeenCalledOnce())
  expect(screen.queryByTestId('migration-first-use')).toBeNull()
  expect(screen.queryByTestId('first-use-dialog')).toBeNull()
})
it('rejects a delayed old-account settings read and does not carry skip choices into a new account', async () => {
  let finish!: (value: { profiles: []; restartRequired: false }) => void
  vi.mocked(readProviderSettings).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  render(<MigrationFirstUseLauncher targetId="current" enabled/>)
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  vi.mocked(fetchGatewayServers).mockResolvedValue([{ ...target, accountIdentity: { principalId: 'new', username: 'new', role: 'user' } }])
  act(() => notifyAccountContextChange('current'))
  await act(async () => { finish({ profiles: [], restartRequired: false }) })
  await screen.findByTestId('migration-first-use-import')
  expect(readProviderSettings).toHaveBeenCalledTimes(2)
})

it('workspace changes preserve the profile read while import and skip choices follow the current workspace', async () => {
  const view = render(<MigrationFirstUseLauncher targetId="current" workspacePath="/first" enabled/>)
  await screen.findByTestId('migration-first-use-import')
  fireEvent.click(screen.getByTestId('migration-first-use-import'))
  expect(screen.getByTestId('first-use-dialog')).toHaveAttribute('data-workspace', '/first')
  view.rerender(<MigrationFirstUseLauncher targetId="current" workspacePath="/second" enabled/>)
  await act(async () => {})
  expect(screen.queryByTestId('first-use-dialog')).toBeNull()
  expect(fetchGatewayServers).toHaveBeenCalledOnce()
  expect(readProviderSettings).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByTestId('migration-first-use-import'))
  expect(screen.getByTestId('first-use-dialog')).toHaveAttribute('data-workspace', '/second')
  fireEvent.click(screen.getByText('close import'))
  await waitFor(() => expect(readProviderSettings).toHaveBeenCalledTimes(2))
  fireEvent.click(screen.getByTestId('migration-first-use-skip'))
  expect(screen.queryByTestId('migration-first-use')).toBeNull()
  view.rerender(<MigrationFirstUseLauncher targetId="current" workspacePath="/third" enabled/>)
  await screen.findByTestId('migration-first-use-import')
  expect(readProviderSettings).toHaveBeenCalledTimes(2)
  act(() => window.dispatchEvent(new Event('kcoder:servers-changed')))
  await waitFor(() => expect(readProviderSettings).toHaveBeenCalledTimes(3))
})

it('workspace completion joins the current target profile read without starting another', async () => {
  let finish!: (value: { profiles: []; restartRequired: false }) => void
  vi.mocked(readProviderSettings).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const view = render(<MigrationFirstUseLauncher targetId="current" enabled/>)
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  view.rerender(<MigrationFirstUseLauncher targetId="current" workspacePath="/resolved" enabled/>)
  await act(async () => { finish({ profiles: [], restartRequired: false }) })
  await screen.findByTestId('migration-first-use-import')
  expect(fetchGatewayServers).toHaveBeenCalledOnce()
  expect(readProviderSettings).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByTestId('migration-first-use-import'))
  expect(screen.getByTestId('first-use-dialog')).toHaveAttribute('data-workspace', '/resolved')
})

it('changing the target retires its profile observation and pins import to the replacement', async () => {
  vi.mocked(fetchGatewayServers).mockResolvedValue([target, { ...target, id: 'replacement' }])
  const view = render(<MigrationFirstUseLauncher targetId="current" workspacePath="/same" enabled/>)
  await screen.findByTestId('migration-first-use-import')
  view.rerender(<MigrationFirstUseLauncher targetId="replacement" workspacePath="/same" enabled/>)
  expect(screen.queryByTestId('migration-first-use-import')).toBeNull()
  await screen.findByTestId('migration-first-use-import')
  expect(readProviderSettings).toHaveBeenCalledTimes(2)
  expect(readProviderSettings).toHaveBeenLastCalledWith('replacement')
  fireEvent.click(screen.getByTestId('migration-first-use-import'))
  expect(screen.getByTestId('first-use-dialog')).toHaveAttribute('data-target', 'replacement')
})

it('a hidden homepage defers profile discovery until the tab is visible', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  try {
    render(<MigrationFirstUseLauncher targetId="current" enabled/>)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(fetchGatewayServers).not.toHaveBeenCalled()
    expect(readProviderSettings).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    fireEvent(document, new Event('visibilitychange'))
    await screen.findByTestId('migration-first-use-import')
    expect(readProviderSettings).toHaveBeenCalledOnce()
  } finally { visibility.mockRestore() }
})

it('hidden configuration events defer display reads without discarding the owned import dialog', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  try {
    render(<MigrationFirstUseLauncher targetId="current" enabled/>)
    await screen.findByTestId('migration-first-use-import')
    fireEvent.click(screen.getByTestId('migration-first-use-import'))
    visibility.mockReturnValue('hidden')
    act(() => { window.dispatchEvent(new Event('kcoder:servers-changed')); window.dispatchEvent(new Event('kcoder:servers-changed')) })
    await act(async () => {})
    expect(fetchGatewayServers).toHaveBeenCalledOnce()
    expect(readProviderSettings).toHaveBeenCalledOnce()
    expect(screen.getByTestId('first-use-dialog')).toHaveAttribute('data-target', 'current')
    visibility.mockReturnValue('visible')
    fireEvent(document, new Event('visibilitychange'))
    await waitFor(() => expect(readProviderSettings).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('first-use-dialog')).toBeInTheDocument()
  } finally { visibility.mockRestore() }
})

it('a directory reply cannot start a provider read after the tab hides', async () => {
  let finish!: (value: typeof target[]) => void
  vi.mocked(fetchGatewayServers).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  try {
    render(<MigrationFirstUseLauncher targetId="current" enabled/>)
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    visibility.mockReturnValue('hidden')
    fireEvent(document, new Event('visibilitychange'))
    await act(async () => finish([target]))
    expect(readProviderSettings).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    fireEvent(document, new Event('visibilitychange'))
    await screen.findByTestId('migration-first-use-import')
    expect(readProviderSettings).toHaveBeenCalledOnce()
  } finally { visibility.mockRestore() }
})

it('repeated foreground hints share the unfinished profile read', async () => {
  let finish!: (value: { profiles: []; restartRequired: false }) => void
  vi.mocked(readProviderSettings).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  render(<MigrationFirstUseLauncher targetId="current" enabled/>)
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  fireEvent(document, new Event('visibilitychange')); fireEvent(document, new Event('visibilitychange'))
  await act(async () => finish({ profiles: [], restartRequired: false }))
  await screen.findByTestId('migration-first-use-import')
  expect(fetchGatewayServers).toHaveBeenCalledOnce()
  expect(readProviderSettings).toHaveBeenCalledOnce()
})

it('returning from import while hidden retires a pre-import profile read before foreground recovery', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  let finish!: (value: { profiles: []; restartRequired: false }) => void
  try {
    render(<MigrationFirstUseLauncher targetId="current" enabled/>)
    await screen.findByTestId('migration-first-use-import')
    fireEvent.click(screen.getByTestId('migration-first-use-import'))
    vi.mocked(readProviderSettings).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    act(() => window.dispatchEvent(new Event('kcoder:servers-changed')))
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    visibility.mockReturnValue('hidden')
    fireEvent.click(screen.getByText('close import'))
    await act(async () => {})
    expect(readProviderSettings).toHaveBeenCalledTimes(2)
    vi.mocked(readProviderSettings).mockResolvedValue({ restartRequired: false, profiles: [{
      id: 'ready', endpoint: 'https://example.invalid', model: 'ready', apiFormat: 'openai_chat_completions',
      contextWindowTokens: 32000, maxOutputTokens: 4096, apiKeyConfigured: true, isDefault: true,
    }] })
    visibility.mockReturnValue('visible')
    fireEvent(document, new Event('visibilitychange'))
    await waitFor(() => expect(readProviderSettings).toHaveBeenCalledTimes(3))
    await act(async () => finish({ profiles: [], restartRequired: false }))
    expect(screen.queryByTestId('migration-first-use-import')).toBeNull()
    expect(readProviderSettings).toHaveBeenCalledTimes(3)
  } finally { visibility.mockRestore() }
})


it('a hidden retained page defers discovery and configuration hints until it becomes visible', async () => {
  const view = render(<RetainedPageActive value={false}><MigrationFirstUseLauncher targetId="current" enabled /></RetainedPageActive>)
  act(() => window.dispatchEvent(new Event('kcoder:servers-changed')))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(fetchGatewayServers).not.toHaveBeenCalled()
  expect(readProviderSettings).not.toHaveBeenCalled()
  view.rerender(<RetainedPageActive value={true}><MigrationFirstUseLauncher targetId="current" enabled /></RetainedPageActive>)
  await screen.findByTestId('migration-first-use-import')
  expect(fetchGatewayServers).toHaveBeenCalledOnce()
  expect(readProviderSettings).toHaveBeenCalledOnce()
})

it('hiding a retained page cancels its directory consumer and a late reply cannot start profile work', async () => {
  let reply!: (value: typeof target[]) => void
  vi.mocked(fetchGatewayServers).mockImplementationOnce(() => new Promise(resolve => { reply = resolve }))
  const view = render(<RetainedPageActive value={true}><MigrationFirstUseLauncher targetId="current" enabled /></RetainedPageActive>)
  await waitFor(() => expect(reply).toBeTypeOf('function'))
  const signal = vi.mocked(fetchGatewayServers).mock.calls[0][1]?.signal
  view.rerender(<RetainedPageActive value={false}><MigrationFirstUseLauncher targetId="current" enabled /></RetainedPageActive>)
  expect(signal?.aborted).toBe(true)
  await act(async () => reply([target]))
  expect(readProviderSettings).not.toHaveBeenCalled()
  view.rerender(<RetainedPageActive value={true}><MigrationFirstUseLauncher targetId="current" enabled /></RetainedPageActive>)
  await screen.findByTestId('migration-first-use-import')
  expect(readProviderSettings).toHaveBeenCalledOnce()
})

it('unmounting cancels its pending directory consumer without issuing a provider read', async () => {
  let reply!: (value: typeof target[]) => void
  vi.mocked(fetchGatewayServers).mockImplementationOnce(() => new Promise(resolve => { reply = resolve }))
  const view = render(<MigrationFirstUseLauncher targetId="current" enabled />)
  await waitFor(() => expect(reply).toBeTypeOf('function'))
  const signal = vi.mocked(fetchGatewayServers).mock.calls[0][1]?.signal
  view.unmount()
  expect(signal?.aborted).toBe(true)
  await act(async () => reply([target]))
  expect(readProviderSettings).not.toHaveBeenCalled()
})


it('unchanged foreground hints do not rediscover a settled profile while a real return does', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  try {
    render(<MigrationFirstUseLauncher targetId="current" enabled />)
    await screen.findByTestId('migration-first-use-import')
    fireEvent(document, new Event('visibilitychange'))
    fireEvent(document, new Event('visibilitychange'))
    await act(async () => {})
    expect(readProviderSettings).toHaveBeenCalledOnce()
    visibility.mockReturnValue('hidden')
    fireEvent(document, new Event('visibilitychange'))
    visibility.mockReturnValue('visible')
    fireEvent(document, new Event('visibilitychange'))
    await waitFor(() => expect(readProviderSettings).toHaveBeenCalledTimes(2))
  } finally { visibility.mockRestore() }
})

it('StrictMode and a synchronous configuration burst retain one current directory/profile read', async () => {
  render(<StrictMode><MigrationFirstUseLauncher targetId="current" enabled /></StrictMode>)
  await screen.findByTestId('migration-first-use-import')
  expect(fetchGatewayServers).toHaveBeenCalledOnce()
  act(() => { window.dispatchEvent(new Event('kcoder:servers-changed')); window.dispatchEvent(new Event('kcoder:servers-changed')) })
  await waitFor(() => expect(readProviderSettings).toHaveBeenCalledTimes(2))
  expect(fetchGatewayServers).toHaveBeenCalledTimes(2)
})

it('an old directory failure cannot hide a replacement account guide', async () => {
  let reject!: (reason: Error) => void
  vi.mocked(fetchGatewayServers).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
  render(<MigrationFirstUseLauncher targetId="current" enabled />)
  await waitFor(() => expect(reject).toBeTypeOf('function'))
  const signal = vi.mocked(fetchGatewayServers).mock.calls[0][1]?.signal
  act(() => notifyAccountContextChange('current'))
  expect(signal?.aborted).toBe(true)
  await screen.findByTestId('migration-first-use-import')
  await act(async () => reject(new Error('late old-account failure')))
  expect(screen.getByTestId('migration-first-use-import')).toBeVisible()
  expect(readProviderSettings).toHaveBeenCalledOnce()
})
