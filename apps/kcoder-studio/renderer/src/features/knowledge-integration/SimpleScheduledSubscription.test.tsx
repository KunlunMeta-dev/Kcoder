import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import fixtures from '../../../../../../tests/fixtures/integrations/knowledge/contract-fixtures.json'
import type { AutomationTemplate } from '../../../../shared/generated/contracts'
import { KnowledgeIntegrationClient, KnowledgeOperationError } from './client'
import { BusinessSubscriptions } from './BusinessSubscriptions'
import { SimpleScheduledSubscription } from './SimpleScheduledSubscription'
const fixture = vi.hoisted(() => ({ verify: vi.fn() }))
vi.mock('./adopted-publication-inputs', () => ({ verifyAdoptedPublicationInputs: fixture.verify }))
vi.mock('./AdoptedPublicationInputs', () => ({
  AdoptedPublicationInputs: ({ onChange }: { onChange: (refs: unknown[]) => void }) => (
    <button
      type="button"
      onClick={() => onChange([{ kind: 'publication', id: 'owned-material', revision: '4' }])}
    >
      Owned material
    </button>
  ),
}))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const template = {
  ...fixtures.AutomationTemplate.valid[0].value,
  id: 'scheduled-review',
  workflowId: 'builtin-office-scheduled-review',
  workflowVersion: 1,
} as AutomationTemplate
function setup() {
  const client = new KnowledgeIntegrationClient(
    {
      accountId: 'owned',
      targetId: 'owned-target',
      workspaceId: null,
      identityGeneration: '1',
      targetRevision: '1',
    },
    { call: vi.fn(), management: vi.fn() }
  )
  const preview = vi
    .spyOn(client, 'previewSubscription')
    .mockResolvedValue({ nextFireAtMs: 2_000_000_000_000 })
  const save = vi
    .spyOn(client, 'saveSubscription')
    .mockResolvedValue(fixtures.AutomationSubscription.valid[0].value)
  render(<SimpleScheduledSubscription client={client} template={template} refresh={vi.fn()} />)
  return { client, preview, save }
}
async function previewReady() {
  fireEvent.change(screen.getByTestId('simple-subscription-focus'), {
    target: { value: 'Summarize the decisions and missing evidence.' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Owned material' }))
  fireEvent.click(screen.getByTestId('simple-subscription-preview'))
  await waitFor(() => expect(screen.getByTestId('simple-subscription-consent')).not.toBeDisabled())
}
beforeEach(() => fixture.verify.mockReset().mockResolvedValue(undefined))
it('uses actual instructions and pinned materials and requires preview plus explicit consent to save', async () => {
  const { client, preview, save } = setup()
  expect(preview).not.toHaveBeenCalled()
  expect(save).not.toHaveBeenCalled()
  await previewReady()
  expect(save).not.toHaveBeenCalled()
  expect(screen.getByTestId('simple-subscription-save')).toBeDisabled()
  const draft = preview.mock.calls[0][0]
  expect(draft).toMatchObject({
    workflowId: 'builtin-office-scheduled-review',
    workflowVersion: 1,
    inputs: {
      requirements: 'Summarize the decisions and missing evidence.',
      sourceRefs: [{ kind: 'publication', id: 'owned-material', revision: '4' }],
    },
    delivery: { kind: 'studio' },
  })
  expect(draft).toMatchObject({
    maximumTokens: template.maximumTokens,
    maximumRuntimeSeconds: template.maximumRuntimeSeconds,
  })
  expect(draft).not.toHaveProperty('periodBudget')
  expect(screen.queryByText('simpleSubscriptionLimits')).not.toBeInTheDocument()
  expect(screen.queryByText('simpleSubscriptionBudget')).not.toBeInTheDocument()
  expect(draft.inputs).not.toHaveProperty('period')
  expect(draft.inputs).not.toHaveProperty('asOfDate')
  fireEvent.click(screen.getByTestId('simple-subscription-consent'))
  fireEvent.click(screen.getByTestId('simple-subscription-save'))
  await waitFor(() => expect(save).toHaveBeenCalledOnce())
  expect(save).toHaveBeenCalledWith(draft)
  expect(fixture.verify).toHaveBeenCalledTimes(2)
  client.dispose()
})
it('invalidates preview and consent when the instructions change', async () => {
  const { client, save } = setup()
  await previewReady()
  fireEvent.click(screen.getByTestId('simple-subscription-consent'))
  fireEvent.change(screen.getByTestId('simple-subscription-focus'), {
    target: { value: 'A different review.' },
  })
  expect(screen.getByTestId('simple-subscription-save')).toBeDisabled()
  expect(screen.getByTestId('simple-subscription-consent')).not.toBeChecked()
  expect(save).not.toHaveBeenCalled()
  client.dispose()
})
it('does not preview unreadable materials or replay an uncertain creation', async () => {
  const { client, preview, save } = setup()
  fixture.verify.mockRejectedValueOnce(new KnowledgeOperationError('KNOWLEDGE_RESOURCE_DENIED'))
  fireEvent.change(screen.getByTestId('simple-subscription-focus'), {
    target: { value: 'Review this material.' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Owned material' }))
  fireEvent.click(screen.getByTestId('simple-subscription-preview'))
  await screen.findByRole('alert')
  expect(preview).not.toHaveBeenCalled()
  fixture.verify.mockResolvedValue(undefined)
  await previewReady()
  save.mockRejectedValueOnce(
    new KnowledgeOperationError(
      'AUTOMATION_SUBSCRIPTION_UNCONFIRMED',
      'owned-original-operation',
      true
    )
  )
  fireEvent.click(screen.getByTestId('simple-subscription-consent'))
  fireEvent.click(screen.getByTestId('simple-subscription-save'))
  await screen.findByText('uncertain')
  expect(screen.getByTestId('simple-subscription-save')).toBeDisabled()
  fireEvent.click(screen.getByTestId('simple-subscription-save'))
  expect(save).toHaveBeenCalledOnce()
  client.dispose()
})

it('keeps workflow identifiers and raw inputs behind an explicit advanced expansion', async () => {
  const client = new KnowledgeIntegrationClient(
    {
      accountId: 'owned',
      targetId: 'owned-target',
      workspaceId: null,
      identityGeneration: '1',
      targetRevision: '1',
    },
    { call: vi.fn(), management: vi.fn() }
  )
  vi.spyOn(client, 'listSubscriptions').mockResolvedValue({ items: [], nextCursor: null })
  vi.spyOn(client, 'listRuns').mockResolvedValue({ items: [], nextCursor: null })
  render(<BusinessSubscriptions client={client} templates={[template]} />)
  expect(screen.getByTestId('simple-subscription-focus')).toBeInTheDocument()
  expect(screen.queryByTestId('subscription-workflow')).not.toBeInTheDocument()
  expect(screen.queryByTestId('subscription-inputs')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('advanced-workflow-subscriptions'))
  await screen.findByTestId('subscription-form-toggle')
  expect(screen.getByTestId('subscription-workflow')).toBeInTheDocument()
  client.dispose()
})
