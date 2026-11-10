import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { WebSearchDetails } from './WebSearchDetails'
import { readWebSearchStatus, startWebSearchProbe, readWebSearchProbe, cancelWebSearchProbe } from '@/kcoder/webSearchDiagnostics'
vi.mock('@/kcoder/webSearchDiagnostics', () => ({ readWebSearchStatus: vi.fn(), startWebSearchProbe: vi.fn(), readWebSearchProbe: vi.fn(), cancelWebSearchProbe: vi.fn() }))
const status = { targetId: 'owned-target', revision: 'r1', mode: 'kcoder' as const, automatic: true, webSearchVisible: true, webFetchVisible: false, candidates: ['exa-public' as const], observations: [{ provider: 'exa-public' as const, component: 'unknown' as const }] }
const receipt = { targetId: 'owned-target', revision: 'r1', requestId: 'probe-a', state: 'unknown' as const }
beforeEach(async () => {
  vi.clearAllMocks()
  vi.stubGlobal('crypto', { randomUUID: () => 'probe-a' })
  await i18n.changeLanguage('en')
  vi.mocked(readWebSearchStatus).mockResolvedValue(status)
  vi.mocked(readWebSearchProbe).mockResolvedValue(receipt)
  vi.mocked(cancelWebSearchProbe).mockResolvedValue({ ...receipt, state: 'cancelled' })
})
test('opening existing tool details reads status without probing or creating a switch', async () => {
  render(<WebSearchDetails serverId="ssh-target" mode="kcoder" isCurrent={() => true} />)
  expect(readWebSearchStatus).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Search status' }))
  await screen.findByText('Not used yet', { exact: false })
  expect(readWebSearchStatus).toHaveBeenCalledWith('ssh-target', { mode: 'kcoder' }, undefined)
  expect(startWebSearchProbe).not.toHaveBeenCalled()
  expect(screen.queryByRole('switch')).not.toBeInTheDocument()
})
test('a lost start receipt is only read; unknown cannot replay and explicit cancel settles it', async () => {
  vi.mocked(startWebSearchProbe).mockRejectedValue(new Error('lost receipt'))
  render(<WebSearchDetails serverId="ssh-target" mode="kcoder" isCurrent={() => true} />)
  fireEvent.click(screen.getByRole('button', { name: 'Search status' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Check search' }))
  await waitFor(() => expect(readWebSearchProbe).toHaveBeenCalledWith('ssh-target', { requestId: 'probe-a', expectedRevision: 'r1' }, undefined))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Check search' })).toBeDisabled())
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }))
  await waitFor(() => expect(readWebSearchProbe).toHaveBeenCalledTimes(2))
  expect(startWebSearchProbe).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel check' }))
  await screen.findByText('Search check stopped.')
  expect(cancelWebSearchProbe).toHaveBeenCalledWith('ssh-target', { requestId: 'probe-a', expectedRevision: 'r1' }, undefined)
})
test('a stale target status cannot overwrite its replacement', async () => {
  let resolve!: (value: typeof status) => void
  vi.mocked(readWebSearchStatus).mockImplementation(() => new Promise(done => { resolve = done }))
  let current = true
  const view = render(<WebSearchDetails serverId="ssh-target" mode="kcoder" isCurrent={() => current} />)
  fireEvent.click(screen.getByRole('button', { name: 'Search status' }))
  current = false
  await act(async () => resolve(status))
  expect(screen.queryByRole('button', { name: 'Check search' })).not.toBeInTheDocument()
  view.unmount()
})

test('passive success observations do not invent a diagnostic result count', async () => {
  vi.mocked(readWebSearchStatus).mockResolvedValue({ ...status, observations: [{ provider: 'exa-public', component: 'unknown', status: 'success' }] })
  render(<WebSearchDetails serverId="ssh-target" mode="kcoder" isCurrent={() => true} />)
  fireEvent.click(screen.getByRole('button', { name: 'Search status' }))
  await screen.findByText('exa-public: Last request succeeded')
  expect(screen.queryByText(/\{\{count\}\}/)).not.toBeInTheDocument()
  expect(startWebSearchProbe).not.toHaveBeenCalled()
})

test('an empty source ceiling stays distinct from the enabled tool and hides excluded observations', async () => {
  vi.mocked(readWebSearchStatus).mockResolvedValue({ ...status, candidates: [] })
  render(<WebSearchDetails serverId="ssh-target" mode="kcoder" isCurrent={() => true} />)
  fireEvent.click(screen.getByRole('button', { name: 'Search status' }))
  await screen.findByText('The target source policy currently allows no search sources.')
  expect(screen.queryByText('exa-public: Not used yet')).not.toBeInTheDocument()
  expect(screen.queryByText('Search is enabled; sources are selected automatically.')).not.toBeInTheDocument()
  expect(startWebSearchProbe).not.toHaveBeenCalled()
})

test('an unsupported probe is a known rejection and never becomes an unknown replay', async () => {
  vi.mocked(startWebSearchProbe).mockRejectedValue(new Error('SEARCH_DIAGNOSTIC_UNSUPPORTED'))
  const view = render(<WebSearchDetails serverId="ssh-target" mode="kcoder" isCurrent={() => true} />)
  fireEvent.click(screen.getByRole('button', { name: 'Search status' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Check search' }))
  await screen.findByText('This target does not support search diagnostics. Update the target to inspect status.')
  expect(readWebSearchProbe).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Check search' })).not.toBeDisabled()
  view.unmount()
  expect(cancelWebSearchProbe).not.toHaveBeenCalled()
})
