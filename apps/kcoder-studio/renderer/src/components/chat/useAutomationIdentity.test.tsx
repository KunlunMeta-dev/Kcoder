import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useCallback, useState } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useAutomationIdentity } from './useAutomationIdentity'
const fixture = vi.hoisted(() => ({ servers: vi.fn() }))
vi.mock('@/kcoder/gatewayRpc', () => ({ fetchGatewayServers: fixture.servers }))
const original = { id: 'owned', label: 'Owned', transport: 'local', profile: 'original' }
function Form() {
  const [draft, setDraft] = useState('')
  const invalidate = useCallback((changed: boolean) => {
    if (changed) setDraft('')
  }, [])
  const identity = useAutomationIdentity(
    { deviceId: 'owned', workspacePath: '/workspace' },
    invalidate
  )
  return (
    <>
      <textarea aria-label="draft" value={draft} onChange={event => setDraft(event.target.value)} />
      <button disabled={!identity.ready}>confirm</button>
    </>
  )
}
beforeEach(() => fixture.servers.mockReset().mockResolvedValue([original]))
it('keeps an unsent draft while the same owner metadata is being revalidated', async () => {
  render(<Form />)
  await waitFor(() => expect(screen.getByRole('button')).not.toBeDisabled())
  fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'My unsent task.' } })
  let finish!: (value: unknown) => void
  fixture.servers.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  fireEvent(window, new CustomEvent('kcoder:servers-changed', { detail: { targetId: 'owned' } }))
  expect(screen.getByRole('button')).toBeDisabled()
  expect(screen.getByLabelText('draft')).toHaveValue('My unsent task.')
  finish([{ ...original, label: 'New display label' }])
  await waitFor(() => expect(screen.getByRole('button')).not.toBeDisabled())
  expect(screen.getByLabelText('draft')).toHaveValue('My unsent task.')
})
it('clears the old owner draft on a real profile change and stays blocked when revalidation fails', async () => {
  render(<Form />)
  await waitFor(() => expect(screen.getByRole('button')).not.toBeDisabled())
  fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'Old owner draft.' } })
  fixture.servers.mockResolvedValueOnce([{ ...original, profile: 'replacement' }])
  fireEvent(window, new CustomEvent('kcoder:servers-changed', { detail: { targetId: 'owned' } }))
  await waitFor(() => expect(screen.getByLabelText('draft')).toHaveValue(''))
  fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'New unsent draft.' } })
  fixture.servers.mockRejectedValueOnce(new Error('owned test directory unavailable'))
  fireEvent(window, new CustomEvent('kcoder:servers-changed', { detail: { targetId: 'owned' } }))
  await waitFor(() => expect(screen.getByRole('button')).toBeDisabled())
  expect(screen.getByLabelText('draft')).toHaveValue('New unsent draft.')
})
