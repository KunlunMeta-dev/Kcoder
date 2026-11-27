import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { KnowledgeIntegrationClient, type AutomationTaskDraft } from './client'
import { SubscriptionPeriodBudgetEditor } from './AutomationPeriodBudget'
import type {
  AutomationSubscription,
  IntegrationRequest,
  IntegrationScope,
} from '../../../../shared/generated/contracts'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)
const scope: IntegrationScope = {
  accountId: 'owned',
  targetId: 'target',
  workspaceId: null,
  identityGeneration: '1',
  targetRevision: '1',
}
const sub: AutomationSubscription = {
  owner: { accountId: 'owned', targetId: 'target', workspaceId: null },
  revision: 7,
  enabled: true,
  consentRef: 'old-explicit-consent',
  nextFireAtMs: 2000000000000,
  createdAtMs: 1,
  updatedAtMs: 2,
  draft: {
    id: 'same-existing-subscription',
    title: 'Existing task',
    workflowId: 'saved-graph',
    workflowVersion: 3,
    inputs: { sourceRefs: [{ kind: 'publication', id: 'fixed-original', revision: 'r1' }] },
    schedule: { kind: 'every', every_seconds: 60 },
    eventSource: null,
    maximumTokens: 5000,
    maximumRuntimeSeconds: 30,
    delivery: { kind: 'studio' },
  },
}
function fixture(swapped = false) {
  const call = vi.fn(async (_port: unknown, method: unknown, request: IntegrationRequest) => {
    const draft = request.payload.draft as AutomationTaskDraft
    const result =
      method === 'previewSubscription'
        ? {
            nextFireAtMs: 2000000000000,
            periodBudget: {
              configuration: swapped
                ? { ...draft.periodBudget!, maximumTokens: 1 }
                : draft.periodBudget,
              currentWindow: { startsAtMs: 0, endsAtMs: 86400000 },
              effectiveMaximumTokens: 4000,
              effectiveMaximumModelCalls: 8,
              chargedTokens: 700,
              chargedModelCalls: 2,
              unknownCostReservations: 2,
              activeTasks: 0,
              activeCalls: 0,
              increasesApplyNextWindow: true,
              createsSubscription: false,
            },
          }
        : { subscription: { ...sub, revision: 8, draft } }
    return {
      contractVersion: 'parallel-v1',
      requestId: request.requestId,
      operationId: request.operationId ?? null,
      entityRevision: null,
      observedAt: '2026-10-25T00:00:00Z',
      status: 'completed',
      result,
      error: null,
    }
  })
  return { client: new KnowledgeIntegrationClient(scope, { call }), call }
}
it('previews without saving and explicitly updates the same original subscription/revision and inputs', async () => {
  const f = fixture()
  render(<SubscriptionPeriodBudgetEditor client={f.client} subscription={sub} refresh={() => {}} />)
  expect(f.call).not.toHaveBeenCalled()
  expect(screen.getByTestId('existing-period-save')).toBeDisabled()
  fireEvent.click(screen.getByTestId('period-budget-enabled'))
  fireEvent.click(screen.getByTestId('existing-period-preview'))
  await waitFor(() => expect(screen.getByTestId('existing-period-consent')).not.toBeDisabled())
  expect(f.call.mock.calls.map(value => value[1])).toEqual(['previewSubscription'])
  fireEvent.click(screen.getByTestId('existing-period-consent'))
  fireEvent.click(screen.getByTestId('existing-period-save'))
  await waitFor(() =>
    expect(f.call.mock.calls.filter(value => value[1] === 'saveSubscription')).toHaveLength(1)
  )
  const saved = f.call.mock.calls.at(-1)![2]
  expect(saved.expectedRevision).toBe('7')
  expect(saved.payload.draft).toMatchObject({
    ...sub.draft,
    periodBudget: { windowSeconds: 86400, maximumTokens: 5000, maximumModelCalls: 128 },
  })
  f.client.dispose()
})
it('a changed period invalidates preview/consent; a swapped server budget never enables saving', async () => {
  const f = fixture()
  const view = render(
    <SubscriptionPeriodBudgetEditor client={f.client} subscription={sub} refresh={() => {}} />
  )
  fireEvent.click(screen.getByTestId('period-budget-enabled'))
  fireEvent.click(screen.getByTestId('existing-period-preview'))
  await waitFor(() => expect(screen.getByTestId('existing-period-consent')).not.toBeDisabled())
  fireEvent.click(screen.getByTestId('existing-period-consent'))
  fireEvent.change(screen.getByTestId('period-budget-tokens'), { target: { value: '6000' } })
  expect(screen.getByTestId('existing-period-consent')).not.toBeChecked()
  expect(screen.getByTestId('existing-period-save')).toBeDisabled()
  view.unmount()
  f.client.dispose()
  const wrong = fixture(true)
  render(
    <SubscriptionPeriodBudgetEditor client={wrong.client} subscription={sub} refresh={() => {}} />
  )
  fireEvent.click(screen.getByTestId('period-budget-enabled'))
  fireEvent.click(screen.getByTestId('existing-period-preview'))
  await waitFor(() => expect(wrong.call).toHaveBeenCalled())
  expect(screen.getByTestId('existing-period-save')).toBeDisabled()
  wrong.client.dispose()
})
