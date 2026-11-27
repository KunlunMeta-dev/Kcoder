import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { ApplicationAuthorizationLifecycle } from './ApplicationAuthorizationLifecycle'
import type { ApplicationAuthorizationOwner } from './nativeApplicationAuthorization'
import type { ProviderRevocationController, ProviderRevocationLocator } from './nativeProviderRevocation'
import type { ConnectivityClient } from './client'
import type { ConnectionView } from './types'
import type { McpProviderRevocationReceipt } from '../../../../shared/generated/contracts'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }))
const connection = { id: 'original-connection', revision: '1', label: 'Owned source', configuration: { mcpServerName: 'original-source' } } as ConnectionView
const client = {} as ConnectivityClient
const original: ProviderRevocationLocator = { requestId: 'original-provider', intentRef: { id: 'native-intent', revision: '1' }, stage: 'prepare', connectionRef: { id: connection.id, revision: connection.revision }, server: { name: 'original-source', pluginId: null }, currentConnectionMatches: true }
const receipt = (phase: McpProviderRevocationReceipt['phase']): McpProviderRevocationReceipt => ({ requestId: original.requestId, intentRef: original.intentRef, phase, reason: phase === 'prepared' ? 'awaitingConfirmation' : phase === 'accepted' ? 'providerAccepted' : 'outcomeUnconfirmed', localCredentialsRemoved: false, currentSourceMatches: true, sourceState: 'matches' })
function fixture(pendingInitially = false) {
  let pending: ProviderRevocationLocator | undefined = pendingInitially ? structuredClone(original) : undefined
  const provider = { pending: vi.fn(() => pending), prepare: vi.fn(async () => { pending = structuredClone(original); return receipt('prepared') }),
    commit: vi.fn(async () => { pending = undefined; return receipt('accepted') }), read: vi.fn(async () => receipt('unknown')), cancel: vi.fn(async () => receipt('unknown')), archiveChangedSource: vi.fn(async () => { pending = undefined }) } satisfies ProviderRevocationController
  const local = { pending: vi.fn(() => undefined), clear: vi.fn(async () => ({ operationId: 'original-local', connectionRef: original.connectionRef, localRemoval: 'accepted' as const, availability: 'unknown' as const, providerRevocationRequested: false })), read: vi.fn(async () => null) }
  const factory = vi.fn(() => ({ begin: vi.fn(), cancel: vi.fn(), providerRevocation: provider, localCleanup: local }) as unknown as ApplicationAuthorizationOwner)
  return { provider, local, factory }
}
beforeEach(() => window.sessionStorage.clear())
test('opening and preparing do not revoke; explicit separate confirmation sends the provider request without local clearing', async () => {
  const f = fixture(); render(<ApplicationAuthorizationLifecycle client={client} connection={connection} createNativeAuthorization={f.factory} />)
  expect(f.provider.prepare).not.toHaveBeenCalled(); expect(f.provider.commit).not.toHaveBeenCalled(); expect(f.local.clear).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Prepare provider revocation' }))
  await screen.findByText('The original request is prepared. Nothing has been sent to the provider.')
  expect(screen.getByRole('button', { name: 'Confirm provider revocation' })).toBeDisabled(); expect(f.provider.commit).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox', { name: /Submit revocation/ })); fireEvent.click(screen.getByRole('button', { name: 'Confirm provider revocation' }))
  await screen.findByText('The provider accepted revocation of the original token. Local credentials were not cleared.')
  expect(f.provider.commit).toHaveBeenCalledOnce(); expect(f.local.clear).not.toHaveBeenCalled()
})
test('remount with an unknown original request reads receipts and never creates or repeats a provider effect', async () => {
  const f = fixture(true); let view = render(<ApplicationAuthorizationLifecycle client={client} connection={connection} createNativeAuthorization={f.factory} />)
  await screen.findByText(/provider outcome is unconfirmed/); expect(f.provider.read).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button', { name: 'Prepare provider revocation' })).not.toBeInTheDocument()
  view.unmount(); view = render(<ApplicationAuthorizationLifecycle client={client} connection={connection} createNativeAuthorization={f.factory} />)
  await screen.findByText(/provider outcome is unconfirmed/); expect(f.provider.read).toHaveBeenCalledTimes(2)
  expect(f.provider.commit).not.toHaveBeenCalled(); expect(f.provider.prepare).not.toHaveBeenCalled(); expect(f.local.clear).not.toHaveBeenCalled(); view.unmount()
})
test('local cleanup is separately confirmed and its receipt never claims provider revocation', async () => {
  const f = fixture(); render(<ApplicationAuthorizationLifecycle client={client} connection={connection} createNativeAuthorization={f.factory} />)
  expect(screen.getByRole('button', { name: 'Clear local authorization and disable' })).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox', { name: /Clear this source/ })); fireEvent.click(screen.getByRole('button', { name: 'Clear local authorization and disable' }))
  await screen.findByText(/Native confirmed local authorization clearing. Provider revocation was not requested/)
  expect(screen.getByText(/Disablement is not yet confirmed/)).toBeInTheDocument(); expect(f.local.clear).toHaveBeenCalledOnce(); expect(f.provider.commit).not.toHaveBeenCalled(); expect(f.provider.prepare).not.toHaveBeenCalled()
})
test('late results from a replaced actual client are dropped and remote error text never reaches the page', async () => {
  const old = fixture(), next = fixture(); let finish!: (value: McpProviderRevocationReceipt) => void
  old.provider.prepare.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const view = render(<ApplicationAuthorizationLifecycle client={client} connection={connection} createNativeAuthorization={old.factory} />)
  fireEvent.click(screen.getByRole('button', { name: 'Prepare provider revocation' })); await waitFor(() => expect(old.provider.prepare).toHaveBeenCalledOnce())
  view.rerender(<ApplicationAuthorizationLifecycle client={{} as ConnectivityClient} connection={connection} createNativeAuthorization={next.factory} />)
  await act(async () => { finish(receipt('accepted')) })
  expect(screen.queryByText(/provider accepted revocation/)).not.toBeInTheDocument(); expect(next.provider.commit).not.toHaveBeenCalled()
  next.provider.prepare.mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE_REMOTE_BODY'))
  fireEvent.click(screen.getByRole('button', { name: 'Prepare provider revocation' })); expect(await screen.findByRole('alert')).toHaveTextContent('original operation is unconfirmed')
  expect(screen.queryByText('SYNTHETIC_PRIVATE_REMOTE_BODY')).not.toBeInTheDocument()
})
