import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { IntegrationRequest, IntegrationScope } from '../../../../shared/generated/contracts'
import { KnowledgeIntegrationClient } from './client'
import { AutomationQuarantine } from './AutomationQuarantine'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const scope: IntegrationScope = {
  accountId: 'owned',
  targetId: 'target',
  workspaceId: null,
  identityGeneration: '1',
  targetRevision: '1',
}
const fact = (index: number) => ({
  id: String(index).padStart(64, '0'),
  subscriptionId: 'original-subscription',
  subscriptionRevision: 3,
  sourceRef: 'selected-file-source',
  eventId: `old-event-${index}`,
  occurredAtMs: 0,
  reasonCode: 'AUTOMATION_EVENT_STALE_QUARANTINED',
})
const reply = (request: IntegrationRequest, result: unknown, status = 'completed') => ({
  contractVersion: 'parallel-v1',
  requestId: request.requestId,
  operationId: null,
  entityRevision: null,
  observedAt: '2026-10-26T00:00:00Z',
  status,
  result,
  error: null,
})

it('loads original quarantined facts only when opened and pages by the original cursor without mutations', async () => {
  const call = vi.fn()
  const management = vi.fn(async (_domain, _method, request: IntegrationRequest) =>
    reply(request, {
      page: request.payload.after
        ? {
            items: [
              {
                ...fact(11),
                occurredAtMs: 2000000000000,
                reasonCode: 'AUTOMATION_EVENT_CLOCK_QUARANTINED',
              },
            ],
            nextCursor: null,
          }
        : {
            items: Array.from({ length: 10 }, (_, index) => fact(index + 1)),
            nextCursor: fact(10).id,
          },
    })
  )
  const client = new KnowledgeIntegrationClient(scope, { call, management })
  render(<AutomationQuarantine client={client} />)
  expect(management).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('automation-quarantine-toggle'))
  expect(await screen.findAllByTestId('automation-quarantined-event')).toHaveLength(10)
  expect(screen.getAllByText('quarantineStale')).toHaveLength(10)
  expect(screen.getAllByText(/eventTimeUnavailable/)).toHaveLength(10)
  fireEvent.click(screen.getByTestId('knowledge-page-next'))
  await waitFor(() => expect(screen.getAllByTestId('automation-quarantined-event')).toHaveLength(1))
  expect(screen.getByText('quarantineClock')).toBeInTheDocument()
  expect(screen.queryByText(/eventTimeUnavailable/)).not.toBeInTheDocument()
  expect(management.mock.calls[1][2].payload.after).toBe(fact(10).id)
  for (const entry of management.mock.calls) {
    expect(entry.slice(0, 2)).toEqual(['automation', 'listQuarantinedEvents'])
    expect(entry[2].operationId).toBeUndefined()
    expect(entry[2].expectedRevision).toBeUndefined()
  }
  expect(call).not.toHaveBeenCalled()
  client.dispose()
})

it('shows an unavailable old target as an error instead of a successful empty page', async () => {
  const management = vi.fn(async (_domain, _method, request: IntegrationRequest) =>
    reply(request, null, 'unavailable')
  )
  const client = new KnowledgeIntegrationClient(scope, { call: vi.fn(), management })
  render(<AutomationQuarantine client={client} />)
  fireEvent.click(screen.getByTestId('automation-quarantine-toggle'))
  await screen.findByTestId('knowledge-operation-error')
  expect(screen.queryByText('noQuarantinedEvents')).not.toBeInTheDocument()
  expect(screen.queryByTestId('automation-quarantined-event')).not.toBeInTheDocument()
  client.dispose()
})

it('rejects uncompleted or malformed read results and never invents event data', async () => {
  const management = vi.fn(async (_domain, _method, request: IntegrationRequest) =>
    reply(request, { page: { items: [], nextCursor: null } }, 'accepted')
  )
  const client = new KnowledgeIntegrationClient(scope, { call: vi.fn(), management })
  await expect(client.listQuarantinedEvents()).rejects.toMatchObject({
    code: 'AUTOMATION_QUARANTINE_READ_UNCONFIRMED',
  })
  management.mockImplementationOnce(async (_domain, _method, request: IntegrationRequest) =>
    reply(request, { page: { items: [{ id: 'missing-original-facts' }], nextCursor: null } })
  )
  await expect(client.listQuarantinedEvents()).rejects.toMatchObject({
    code: 'KNOWLEDGE_INVALID_RECEIPT',
  })
  client.dispose()
})
