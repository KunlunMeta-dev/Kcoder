import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { BrowserAccountControls } from './BrowserAccountControls'
import { notifyAccountContextChange } from '@/kcoder/accountContextEvents'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@/lib/runtime-commands', () => ({ invoke }))
vi.mock('@/lib/embedded-browser', () => ({ setEmbeddedBrowserOcclusion: vi.fn() }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const scope = {
  accountId: 'account',
  targetId: 'native-target',
  workspaceId: null,
  identityGeneration: 'g',
  targetRevision: 'r',
}
const item = (index: number) => ({
  draft: {
    id: `account-${index}`,
    label: `Account ${index}`,
    accountLabel: null,
    purpose: 'business',
  },
  revision: 1,
  archived: false,
})
const page = (items = [item(0)], nextCursor: string | null = null) => ({
  available: true,
  targetId: 'local',
  targetLabel: 'Local',
  scope,
  page: { items, nextCursor },
})
beforeEach(() => invoke.mockReset())

test('reads ten accounts per page and selects only after an explicit action', async () => {
  invoke
    .mockResolvedValueOnce(
      page(
        Array.from({ length: 10 }, (_, i) => item(i)),
        'next'
      )
    )
    .mockResolvedValueOnce(page([item(10)]))
  const selected = vi.fn(async () => {})
  render(<BrowserAccountControls label="browser-one" choice={null} onSelect={selected} />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'workbench.browser_accounts' }))
  await screen.findByText('Account 9')
  expect(selected).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'workbench.browser_accounts_next' }))
  await screen.findByText('Account 10')
  expect(invoke).toHaveBeenLastCalledWith(
    'embedded_browser_profiles',
    expect.objectContaining({ payload: { after: 'next', includeArchived: false } })
  )
  await user.click(screen.getByRole('button', { name: 'Account 10' }))
  expect(selected).toHaveBeenCalledWith(
    expect.objectContaining({
      gatewayTargetId: 'local',
      selection: expect.objectContaining({ scope, profileId: 'account-10', expectedRevision: 1 }),
    })
  )
})

test('saving metadata does not start a browser and preserves its operation on an uncertain result', async () => {
  invoke
    .mockResolvedValueOnce(page([]))
    .mockRejectedValueOnce(new Error('lost reply'))
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce(page([item(1)]))
  const selected = vi.fn(async () => {})
  render(<BrowserAccountControls label="browser-one" choice={null} onSelect={selected} />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'workbench.browser_accounts' }))
  await screen.findByText('workbench.browser_account_add')
  await user.click(screen.getByText('workbench.browser_account_add'))
  await user.type(screen.getByLabelText('workbench.browser_account_name'), 'Department')
  await user.click(screen.getByRole('button', { name: 'workbench.browser_account_save' }))
  await screen.findByRole('alert')
  const original = invoke.mock.calls[1][1]
  expect(screen.getByLabelText('workbench.browser_account_name')).toHaveValue('Department')
  await user.click(screen.getByRole('button', { name: 'workbench.browser_account_save' }))
  await screen.findByText('Account 1')
  expect(invoke.mock.calls[2][1]).toEqual(original)
  expect(selected).not.toHaveBeenCalled()
})

test('account invalidation closes the editor and rejects a late account list', async () => {
  let complete!: (value: unknown) => void
  invoke.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        complete = resolve
      })
  )
  render(<BrowserAccountControls label="browser-one" choice={null} onSelect={async () => {}} />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'workbench.browser_accounts' }))
  act(() => notifyAccountContextChange('local'))
  await act(async () => complete(page([item(9)])))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(screen.queryByText('Account 9')).not.toBeInTheDocument()
})
