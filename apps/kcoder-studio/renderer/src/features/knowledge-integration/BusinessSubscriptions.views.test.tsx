import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import fixtures from '../../../../../../tests/fixtures/integrations/knowledge/contract-fixtures.json'
import { KnowledgeIntegrationClient } from './client'
import { BusinessSubscriptions } from './BusinessSubscriptions'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
it('shows the original inbox output and failure states without loading or creating subscriptions', async () => {
  const run = {
    ...fixtures.AutomationRun.valid[0].value,
    status: 'failed' as const,
    deliveryStatus: 'failed' as const,
    artifactRefs: [],
    output: 'Original retained run output',
  }
  const client = new KnowledgeIntegrationClient(
    { ...run.owner, identityGeneration: '1', targetRevision: '1' },
    { call: vi.fn(), management: vi.fn() }
  )
  const runs = vi.spyOn(client, 'listRuns').mockResolvedValue({ items: [run], nextCursor: null })
  const subscriptions = vi.spyOn(client, 'listSubscriptions')
  const create = vi.spyOn(client, 'saveSubscription')
  render(<BusinessSubscriptions client={client} view="inbox" />)
  await screen.findByText('Original retained run output')
  expect(screen.getByText('runState.failed')).toBeInTheDocument()
  expect(screen.getByText('deliveryState.failed')).toBeInTheDocument()
  expect(runs).toHaveBeenCalledOnce()
  expect(subscriptions).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
  expect(screen.queryByTestId('subscription-form-toggle')).not.toBeInTheDocument()
  client.dispose()
})
