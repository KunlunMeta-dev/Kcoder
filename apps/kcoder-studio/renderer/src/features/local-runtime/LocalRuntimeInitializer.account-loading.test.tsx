import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { clearTestTransports, installTestTransport } from '@/test/runtime-transport'
import { ensureLocalExecutorStarted } from '@/host/localExecutor'
import { LocalRuntimeInitializer } from './LocalRuntimeInitializer'
import '@/i18n'

const accountModule = vi.hoisted(() => {
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  return { ready, release, loaded: vi.fn() }
})
vi.mock('@/kcoder/KCoderAccountStartup', async () => {
  accountModule.loaded()
  await accountModule.ready
  return { KCoderAccountStartup: ({ onChanged }: { onChanged(): Promise<void> }) =>
    <button onClick={() => void onChanged()}>Finish account setup</button> }
})
vi.mock('@/host/localExecutor', () => ({
  ensureLocalExecutorStarted: vi.fn(),
  readLocalExecutorLog: vi.fn(),
  copyLocalExecutorDebugInfo: vi.fn(),
  connectLocalExecutorToBackend: vi.fn(),
  disconnectLocalExecutorFromBackend: vi.fn(),
}))
afterEach(() => { clearTestTransports(); vi.unstubAllEnvs() })

test('ready startup never loads account settings; required account setup still retries readiness', async () => {
  installTestTransport(() => null)
  vi.stubEnv('DEV', false)
  const ensure = vi.mocked(ensureLocalExecutorStarted)
  ensure.mockResolvedValueOnce({ running: true, ready: true, deviceId: 'local' })
  const view = render(<LocalRuntimeInitializer><p>Ready workspace</p></LocalRuntimeInitializer>)
  await screen.findByText('Ready workspace')
  expect(accountModule.loaded).not.toHaveBeenCalled()
  view.unmount()

  ensure.mockResolvedValueOnce({ running: true, ready: false, accountLoginServerId: 'owned-target' })
    .mockResolvedValueOnce({ running: true, ready: true, deviceId: 'owned-target' })
  render(<LocalRuntimeInitializer><p>Authenticated workspace</p></LocalRuntimeInitializer>)
  await screen.findByTestId('page-loading-state')
  await waitFor(() => expect(accountModule.loaded).toHaveBeenCalledTimes(1))
  expect(screen.queryByText('Authenticated workspace')).not.toBeInTheDocument()
  expect(ensure).toHaveBeenCalledTimes(2)
  await act(async () => { accountModule.release(); await accountModule.ready })
  fireEvent.click(await screen.findByRole('button', { name: 'Finish account setup' }))
  await screen.findByText('Authenticated workspace')
  expect(accountModule.loaded).toHaveBeenCalledTimes(1)
  expect(ensure).toHaveBeenCalledTimes(3)
})
