import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { KCoderOrganizationBudgetStatus } from './KCoderOrganizationBudgetStatus'

const { manage } = vi.hoisted(() => ({ manage: vi.fn() }))
vi.mock('@/kcoder/gatewayRpc', () => ({ manageGatewayAccounts: manage }))
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
const label = (name: string) => `organization.budgetService.${name}`
const policy = {
  id: 'original-cap',
  scope: { kind: 'organization', id: 'owned-org' },
  window: { id: 'original-window', startsAtMs: 1, endsAtMs: 2 },
  limits: { tokens: 100 },
  currency: null,
}
const ready = {
  version: 1,
  organizationId: 'owned-org',
  policyRevision: 7,
  status: 'ready',
  nextAfter: null,
  items: [
    {
      configured: policy,
      current: true,
      observation: {
        charged: { tokens: 70, modelCalls: 1, runMillis: 1500, costMicros: null },
        unknownCostReservations: 1,
        activeTasks: 0,
        activeCalls: 1,
      },
    },
  ],
}
const props = {
  serverId: 'owned-target',
  organizationId: 'owned-org',
  revision: 7,
  canInitialize: true,
}
const renderStatus = () => {
  const view = render(<KCoderOrganizationBudgetStatus {...props} />)
  fireEvent.click(screen.getByText(label('title')))
  return view
}
beforeEach(() => manage.mockReset())

test('only an explicit refresh reads the exact original target and revision', async () => {
  manage.mockResolvedValue(ready)
  renderStatus()
  expect(manage).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText(label('refresh')))
  await screen.findByText('70')
  expect(manage).toHaveBeenCalledWith('owned-target', {
    operation: 'organization.budget.inspect',
    expectedRevision: 7,
    after: null,
  })
  expect(screen.getByText('1.5')).toBeInTheDocument()
  expect(screen.getByText(label('unknown'))).toBeInTheDocument()
  expect(screen.queryByText(label('initialize'))).not.toBeInTheDocument()
})

test('native micro-currency is displayed as currency units rather than a million-fold charge', async () => {
  manage.mockResolvedValue({
    ...ready,
    items: [
      {
        ...ready.items[0],
        configured: { ...policy, currency: 'USD' },
        observation: {
          ...ready.items[0].observation,
          charged: { ...ready.items[0].observation.charged, costMicros: 1_500_000 },
          unknownCostReservations: 0,
        },
      },
    ],
  })
  renderStatus()
  fireEvent.click(screen.getByText(label('refresh')))
  await screen.findByText('$1.50')
  expect(screen.queryByText('1,500,000')).not.toBeInTheDocument()
})

test('initialization is explicit and an unknown result requires a fresh inspection', async () => {
  manage.mockResolvedValueOnce({ ...ready, status: 'uninitialized', items: [] })
  renderStatus()
  fireEvent.click(screen.getByText(label('refresh')))
  await screen.findByText(label('uninitialized'))
  expect(manage).toHaveBeenCalledTimes(1)
  manage.mockRejectedValueOnce(new Error('lost response'))
  fireEvent.click(screen.getByText(label('initialize')))
  await screen.findByRole('alert')
  expect(manage).toHaveBeenLastCalledWith('owned-target', {
    operation: 'organization.budget.initialize',
  })
  expect(manage).toHaveBeenCalledTimes(2)
  expect(screen.queryByText(label('initialize'))).not.toBeInTheDocument()
  manage.mockResolvedValueOnce(ready)
  fireEvent.click(screen.getByText(label('refresh')))
  await screen.findByText('70')
  expect(manage).toHaveBeenCalledTimes(3)
})

test('a known initialization is followed by inspection without replaying the action', async () => {
  manage.mockResolvedValueOnce({ ...ready, status: 'uninitialized', items: [] })
  renderStatus()
  fireEvent.click(screen.getByText(label('refresh')))
  await screen.findByText(label('uninitialized'))
  manage.mockResolvedValueOnce({ initialized: true }).mockResolvedValueOnce(ready)
  fireEvent.click(screen.getByText(label('initialize')))
  await screen.findByText('70')
  expect(manage.mock.calls.map(call => call[1].operation)).toEqual([
    'organization.budget.inspect',
    'organization.budget.initialize',
    'organization.budget.inspect',
  ])
})

test('page navigation keeps the original revision and shows only the received ten rows', async () => {
  const items = Array.from({ length: 10 }, (_, index) => ({
    ...ready.items[0],
    configured: { ...policy, id: `cap-${index}` },
  }))
  manage.mockResolvedValueOnce({ ...ready, items, nextAfter: 10 }).mockResolvedValueOnce({
    ...ready,
    items: [{ ...ready.items[0], configured: { ...policy, id: 'last-cap' } }],
  })
  renderStatus()
  fireEvent.click(screen.getByText(label('refresh')))
  await screen.findByText('cap-9')
  fireEvent.click(screen.getByText(label('next')))
  await screen.findByText('last-cap')
  expect(screen.queryByText('cap-0')).not.toBeInTheDocument()
  expect(manage).toHaveBeenLastCalledWith('owned-target', {
    operation: 'organization.budget.inspect',
    expectedRevision: 7,
    after: 10,
  })
  expect(screen.getByText(label('next'))).toBeDisabled()
  expect(screen.getByText(label('previous'))).toBeEnabled()
})

test.each([
  { ...ready, organizationId: 'foreign-org' },
  { ...ready, policyRevision: 8 },
  { ...ready, items: [null] },
  { ...ready, nextAfter: 129 },
])('invalid or stale observations do not publish counters', async report => {
  manage.mockResolvedValue(report)
  renderStatus()
  fireEvent.click(screen.getByText(label('refresh')))
  await screen.findByRole('alert')
  expect(screen.queryByText('70')).not.toBeInTheDocument()
})

test('a closed account view drops a late response', async () => {
  let resolve: (value: typeof ready) => void = () => {
    throw new Error('request not started')
  }
  manage.mockReturnValue(
    new Promise<typeof ready>(done => {
      resolve = done
    })
  )
  const view = renderStatus()
  fireEvent.click(screen.getByText(label('refresh')))
  view.unmount()
  await act(async () => resolve(ready))
  await waitFor(() => expect(screen.queryByText('70')).not.toBeInTheDocument())
})
