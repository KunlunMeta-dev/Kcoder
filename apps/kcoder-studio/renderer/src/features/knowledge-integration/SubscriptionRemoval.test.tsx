import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import fixtures from '../../../../../../tests/fixtures/integrations/knowledge/contract-fixtures.json'
import type { IntegrationRequest, IntegrationScope } from '../../../../shared/generated/contracts'
import { KnowledgeIntegrationClient } from './client'
import { SubscriptionRemoval } from './SubscriptionRemoval'
import { BusinessSubscriptions } from './BusinessSubscriptions'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key === 'removeSubscriptionDescription' ? `Remove future triggers: ${values?.title}` : key,
  }),
}))
const subscription = fixtures.AutomationSubscription.valid[0].value
const scope: IntegrationScope = {
  ...subscription.owner,
  identityGeneration: 'owned-generation',
  targetRevision: 'owned-target',
}
const reply = (request: IntegrationRequest, result: unknown, status = 'completed') => ({
  contractVersion: 'parallel-v1',
  requestId: request.requestId,
  operationId: request.operationId ?? null,
  entityRevision: null,
  observedAt: '2026-10-26T00:00:00Z',
  status,
  result,
  error: null,
})

it('requires explicit confirmation and deletes the exact subscription revision only', async () => {
  const call = vi.fn()
  const management = vi.fn(async (_domain, _method, request: IntegrationRequest) =>
    reply(request, { removed: true })
  )
  const refresh = vi.fn()
  const client = new KnowledgeIntegrationClient(scope, { call, management })
  render(<SubscriptionRemoval client={client} subscription={subscription} refresh={refresh} />)
  fireEvent.click(screen.getByTestId('subscription-remove-open'))
  expect(screen.getByRole('dialog')).toHaveTextContent(subscription.draft.title)
  expect(management).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('subscription-remove-dialog-close'))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(management).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('subscription-remove-open'))
  fireEvent.click(screen.getByTestId('subscription-remove-dialog-confirm'))
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
  expect(management).toHaveBeenCalledOnce()
  expect(management.mock.calls[0].slice(0, 2)).toEqual(['automation', 'removeSubscription'])
  expect(management.mock.calls[0][2]).toMatchObject({
    scope,
    payload: { id: subscription.draft.id },
    expectedRevision: String(subscription.revision),
    operationId: expect.any(String),
  })
  expect(call).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  client.dispose()
})

it('keeps an accepted but uncompleted removal uncertain without automatically resubmitting', async () => {
  const management = vi.fn(async (_domain, _method, request: IntegrationRequest) =>
    reply(request, { removed: true }, 'accepted')
  )
  const refresh = vi.fn()
  const client = new KnowledgeIntegrationClient(scope, { call: vi.fn(), management })
  render(<SubscriptionRemoval client={client} subscription={subscription} refresh={refresh} />)
  fireEvent.click(screen.getByTestId('subscription-remove-open'))
  fireEvent.click(screen.getByTestId('subscription-remove-dialog-confirm'))
  await screen.findByText('uncertain')
  expect(screen.getByTestId('subscription-remove-dialog-confirm')).toBeDisabled()
  expect(screen.getByTestId('knowledge-inspect-operation')).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('subscription-remove-dialog-confirm'))
  expect(management).toHaveBeenCalledOnce()
  expect(refresh).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('subscription-remove-dialog-close'))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByTestId('knowledge-inspect-operation')).toBeInTheDocument()
  expect(screen.getByTestId('subscription-remove-open')).toBeDisabled()
  client.dispose()
})

it('does not accept a completed reply that lacks the actual removal result', async () => {
  const management = vi.fn(async (_domain, _method, request: IntegrationRequest) =>
    reply(request, { removed: false })
  )
  const client = new KnowledgeIntegrationClient(scope, { call: vi.fn(), management })
  await expect(client.removeSubscription(subscription)).rejects.toMatchObject({
    code: 'KNOWLEDGE_INVALID_RECEIPT',
    uncertain: true,
  })
  client.dispose()
})

it('exposes deletion from the subscription row while retaining the existing inbox run', async () => {
  let removed = false
  const originalBudgeted = {
    ...subscription,
    draft: {
      ...subscription.draft,
      periodBudget: { windowSeconds: 3600, maximumTokens: 5000, maximumModelCalls: 8 },
    },
  }
  const originalSnapshot = structuredClone(originalBudgeted)
  const run = fixtures.AutomationRun.valid[0].value
  const management = vi.fn(async (_domain, method, request: IntegrationRequest) => {
    if (method === 'removeSubscription') {
      removed = true
      return reply(request, { removed: true })
    }
    return reply(request, {
      page: {
        items: method === 'listSubscriptions' ? (removed ? [] : [originalBudgeted]) : [run],
        nextCursor: null,
      },
    })
  })
  const call = vi.fn()
  const client = new KnowledgeIntegrationClient(scope, { call, management })
  render(<BusinessSubscriptions client={client} />)
  await screen.findByTestId('subscription-row')
  await screen.findByTestId('automation-run')
  expect(screen.queryByTestId('existing-period-budget')).not.toBeInTheDocument()
  expect(screen.queryByTestId('period-budget-observation')).not.toBeInTheDocument()
  expect(originalBudgeted).toEqual(originalSnapshot)
  fireEvent.click(screen.getByTestId('subscription-remove-open'))
  fireEvent.click(screen.getByTestId('subscription-remove-dialog-confirm'))
  await waitFor(() => expect(screen.queryByTestId('subscription-row')).not.toBeInTheDocument())
  expect(screen.getByTestId('automation-run')).toBeInTheDocument()
  const methods = management.mock.calls.map(entry => entry[1])
  for (const method of ['cancelAutomationRun', 'hideAutomationRun', 'cancelAutomationDelivery'])
    expect(methods).not.toContain(method)
  expect(call).not.toHaveBeenCalled()
  client.dispose()
})
