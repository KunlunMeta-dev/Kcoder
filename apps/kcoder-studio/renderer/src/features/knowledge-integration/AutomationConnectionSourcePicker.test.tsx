import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { IntegrationRequest, IntegrationScope } from '../../../../shared/generated/contracts'
import { KnowledgeIntegrationClient } from './client'
import { AutomationConnectionSourcePicker } from './AutomationConnectionSourcePicker'

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const scope: IntegrationScope = {
  accountId: 'owner',
  targetId: 'target',
  workspaceId: null,
  identityGeneration: '1',
  targetRevision: '1',
}
const source = (index: number, available = true) => ({
  sourceRef: `connection-event-${index}`,
  connectionId: `connection-${index}`,
  platform: 'wecom',
  receivedAtMs: 1000,
  state: available ? 'available' : 'unavailable',
  reasonCode: available ? null : 'AUTOMATION_CONNECTION_SOURCE_UNAVAILABLE',
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

it('reads actual source descriptors in pages and only chooses available references without creating a subscription or run', async () => {
  const call = vi.fn()
  const selection = vi.fn()
  const management = vi.fn(async (_domain, _method, request: IntegrationRequest) =>
    reply(request, {
      page: request.payload.after
        ? { items: [source(11, false)], nextCursor: null }
        : {
            items: Array.from({ length: 10 }, (_, index) => source(index)),
            nextCursor: 'connection-event-9',
          },
    })
  )
  const client = new KnowledgeIntegrationClient(scope, { call, management })
  render(<AutomationConnectionSourcePicker client={client} onSelection={selection} />)
  expect(await screen.findAllByTestId('automation-connection-source-select')).toHaveLength(10)
  fireEvent.click(screen.getAllByTestId('automation-connection-source-select')[2])
  expect(selection).toHaveBeenLastCalledWith(source(2))
  fireEvent.click(screen.getByTestId('knowledge-page-next'))
  await waitFor(() =>
    expect(screen.getAllByTestId('automation-connection-source-select')).toHaveLength(1)
  )
  expect(screen.getByTestId('automation-connection-source-select')).toBeDisabled()
  expect(screen.getByText('connectionEventUnavailable')).toBeInTheDocument()
  expect(management.mock.calls[1][2].payload.after).toBe('connection-event-9')
  for (const entry of management.mock.calls) {
    expect(entry.slice(0, 2)).toEqual(['automation', 'listConnectionEventSources'])
    expect(entry[2].operationId).toBeUndefined()
    expect(entry[2].payload.afterSequence).toBeUndefined()
  }
  expect(call).not.toHaveBeenCalled()
  client.dispose()
})

it('reports an older target as unavailable instead of displaying an empty observed source list', async () => {
  const client = new KnowledgeIntegrationClient(scope, {
    call: vi.fn(),
    management: async (_domain, _method, request) => ({
      ...reply(request, null, 'unavailable'),
      error: {
        code: 'KNOWLEDGE_NATIVE_METHOD_UNAVAILABLE',
        recovery: 'none',
        messageKey: 'integrations.knowledge.unavailable',
      },
    }),
  })
  render(<AutomationConnectionSourcePicker client={client} onSelection={vi.fn()} />)
  expect(await screen.findByTestId('knowledge-operation-error')).toBeInTheDocument()
  expect(screen.queryByText('noConnectionEventSources')).not.toBeInTheDocument()
  client.dispose()
})

it('requires a completed, valid native source projection and rejects caller-shaped approval metadata', async () => {
  let mode = 'accepted'
  const client = new KnowledgeIntegrationClient(scope, {
    call: vi.fn(),
    management: async (_domain, _method, request) =>
      reply(
        request,
        {
          page: {
            items: [mode === 'forged' ? { ...source(1), approved: true } : source(1)],
            nextCursor: null,
          },
        },
        mode === 'accepted' ? 'accepted' : 'completed'
      ),
  })
  await expect(client.listConnectionEventSources()).rejects.toMatchObject({
    code: 'AUTOMATION_CONNECTION_SOURCE_READ_UNCONFIRMED',
  })
  mode = 'forged'
  await expect(client.listConnectionEventSources()).rejects.toMatchObject({
    code: 'KNOWLEDGE_INVALID_RECEIPT',
  })
  client.dispose()
})

it('saves an explicitly previewed connection subscription using only the selected reference and no caller-provided source start', async () => {
  const { BusinessSubscriptions } = await import('./BusinessSubscriptions')
  const management = vi.fn(async (_domain, method, request: IntegrationRequest) => {
    if (method === 'listConnectionEventSources')
      return reply(request, { page: { items: [source(1)], nextCursor: null } })
    if (method === 'previewSubscription') return reply(request, { nextFireAtMs: null })
    if (method === 'saveSubscription')
      return {
        ...reply(request, {
          subscription: {
            owner: {
              accountId: scope.accountId,
              targetId: scope.targetId,
              workspaceId: scope.workspaceId,
            },
            revision: 1,
            enabled: true,
            draft: request.payload.draft,
            consentRef: request.payload.consentRef,
            nextFireAtMs: null,
            createdAtMs: 1000,
            updatedAtMs: 1000,
          },
        }),
        operationId: request.operationId,
      }
    return reply(request, { page: { items: [], nextCursor: null } })
  })
  const client = new KnowledgeIntegrationClient(scope, { call: management, management })
  render(
    <BusinessSubscriptions
      client={client}
      workflows={[{ id: 'saved-code', title: 'Saved code', version: 1 }]}
    />
  )
  fireEvent.click(screen.getByTestId('subscription-form-toggle'))
  fireEvent.change(screen.getByTestId('subscription-title'), {
    target: { value: 'New verified messages' },
  })
  fireEvent.change(screen.getByTestId('subscription-workflow'), {
    target: { value: 'saved-code@1' },
  })
  fireEvent.change(screen.getByTestId('subscription-schedule-mode'), {
    target: { value: 'connection' },
  })
  expect(screen.getByTestId('subscription-preview')).toBeDisabled()
  fireEvent.click(await screen.findByTestId('automation-connection-source-select'))
  expect(management.mock.calls.filter(entry => entry[1] === 'saveSubscription')).toHaveLength(0)
  fireEvent.click(screen.getByTestId('subscription-preview'))
  await screen.findByText('connectionPreviewReady')
  expect(management.mock.calls.filter(entry => entry[1] === 'saveSubscription')).toHaveLength(0)
  fireEvent.click(screen.getByTestId('subscription-consent'))
  fireEvent.click(screen.getByTestId('subscription-save'))
  await waitFor(() =>
    expect(management.mock.calls.filter(entry => entry[1] === 'saveSubscription')).toHaveLength(1)
  )
  const request = management.mock.calls.find(entry => entry[1] === 'saveSubscription')![2]
  expect(request.payload.draft).toMatchObject({
    eventSource: 'connection-event-1',
    schedule: null,
    workflowId: 'saved-code',
    workflowVersion: 1,
  })
  expect(request.payload).not.toHaveProperty('afterSequence')
  expect(request.payload).not.toHaveProperty('sourceStart')
  client.dispose()
})
