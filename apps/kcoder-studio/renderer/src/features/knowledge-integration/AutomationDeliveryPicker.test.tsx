import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { IntegrationRequest, IntegrationScope } from '../../../../shared/generated/contracts'
import { KnowledgeIntegrationClient } from './client'
import { AutomationDeliveryPicker } from './AutomationDeliveryPicker'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const scope: IntegrationScope = {
  accountId: 'owner',
  targetId: 'ssh-target',
  workspaceId: null,
  identityGeneration: '1',
  targetRevision: '1',
}
const reply = (request: IntegrationRequest, result: unknown) => ({
  contractVersion: 'parallel-v1',
  requestId: request.requestId,
  operationId: null,
  entityRevision: null,
  observedAt: '2026-10-26T00:00:00Z',
  status: 'completed',
  result,
  error: null,
})
const connection = {
  configuration: {},
  enabled: true,
  hasCredential: true,
  id: 'owned-channel',
  kind: 'wecom',
  label: 'Reports',
  revision: '1',
  state: 'connected',
}
const destination = {
  id: 'granted-destination',
  revision: '7',
  label: 'Team',
  platform: 'wecom',
  purpose: 'subscription',
}
it('selects an existing C destination reference/revision using only bounded metadata reads', async () => {
  const selected = vi.fn(),
    management = vi.fn()
  const call = vi.fn(async (_port, method, request: IntegrationRequest) =>
    reply(
      request,
      method === 'listConnections'
        ? { items: [connection], nextCursor: null }
        : {
            connectionId: connection.id,
            destinations: [destination, { ...destination, id: 'reply-only', purpose: 'reply' }],
            destinationNextCursor: null,
          }
    )
  )
  const client = new KnowledgeIntegrationClient(scope, { call, management })
  render(
    <AutomationDeliveryPicker client={client} value={{ kind: 'studio' }} onSelection={selected} />
  )
  expect(call).not.toHaveBeenCalled()
  fireEvent.change(screen.getByTestId('automation-delivery-mode'), { target: { value: 'channel' } })
  expect(selected).toHaveBeenLastCalledWith(undefined)
  fireEvent.click(await screen.findByTestId('automation-delivery-connection'))
  const destinations = await screen.findAllByTestId('automation-delivery-destination')
  expect(destinations[1]).toBeDisabled()
  fireEvent.click(destinations[0])
  expect(selected).toHaveBeenLastCalledWith({
    kind: 'channel',
    destinationRef: destination.id,
    destinationRevision: '7',
  })
  expect(call.mock.calls.map(args => args.slice(0, 2))).toEqual([
    ['P-CONNECTION', 'listConnections'],
    ['P-CONNECTION', 'readResourceGrant'],
  ])
  for (const args of call.mock.calls) {
    expect(args[2].operationId).toBeUndefined()
    expect(args[2].scope).toEqual(scope)
  }
  expect(call.mock.calls[0][2].payload).toMatchObject({ category: 'channels', limit: 10 })
  expect(call.mock.calls[1][2].payload).toMatchObject({ connectionId: connection.id })
  expect(management).not.toHaveBeenCalled()
  client.dispose()
})
it('reports C unavailable without presenting an observed empty list or sending anything', async () => {
  const client = new KnowledgeIntegrationClient(scope, {
    management: vi.fn(),
    call: async (_port, method, request) =>
      method === 'listConnections'
        ? reply(request, { items: [connection], nextCursor: null })
        : {
            ...reply(request, null),
            status: 'unavailable',
            error: {
              code: 'CONNECTIVITY_NATIVE_UNAVAILABLE',
              messageKey: 'safe',
              recovery: 'retry_read',
            },
          },
  })
  render(
    <AutomationDeliveryPicker client={client} value={{ kind: 'studio' }} onSelection={vi.fn()} />
  )
  fireEvent.change(screen.getByTestId('automation-delivery-mode'), { target: { value: 'channel' } })
  fireEvent.click(await screen.findByTestId('automation-delivery-connection'))
  expect(await screen.findByTestId('knowledge-operation-error')).toBeInTheDocument()
  expect(screen.queryByText('noDeliveryDestinations')).not.toBeInTheDocument()
  expect(screen.queryByTestId('automation-delivery-destination')).not.toBeInTheDocument()
  client.dispose()
})
it('rejects oversized pages, forged grant metadata and foreign connection receipts', async () => {
  let foreign = false
  const client = new KnowledgeIntegrationClient(scope, {
    management: vi.fn(),
    call: async (_port, method, request) =>
      reply(
        request,
        method === 'listConnections'
          ? { items: Array.from({ length: 11 }, () => connection), nextCursor: null }
          : foreign
            ? { connectionId: 'peer', destinations: [destination], destinationNextCursor: null }
            : {
                connectionId: connection.id,
                destinations: [{ id: 'fake', approved: true }],
                destinationNextCursor: null,
              }
      ),
  })
  await expect(client.listDeliveryConnections()).rejects.toThrow()
  await expect(client.listDeliveryDestinations(connection.id)).rejects.toThrow()
  foreign = true
  await expect(client.listDeliveryDestinations(connection.id)).rejects.toThrow()
  client.dispose()
})

it('includes the selected channel reference/revision in the exact preview and explicit save without sending from the form', async () => {
  const { BusinessSubscriptions } = await import('./BusinessSubscriptions')
  const management = vi.fn(async (_domain, method, request: IntegrationRequest) => {
    if (method === 'listConnectionEventSources')
      return reply(request, {
        page: {
          items: [
            {
              sourceRef: 'connection-event-1',
              connectionId: 'owned-channel',
              platform: 'wecom',
              receivedAtMs: 1000,
              state: 'available',
              reasonCode: null,
            },
          ],
          nextCursor: null,
        },
      })
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
  const call = vi.fn(async (_port, method, request: IntegrationRequest) =>
    method === 'listConnections'
      ? reply(request, { items: [connection], nextCursor: null })
      : method === 'readResourceGrant'
        ? reply(request, {
            connectionId: connection.id,
            destinations: [destination],
            destinationNextCursor: null,
          })
        : management(_port, method, request)
  )
  const client = new KnowledgeIntegrationClient(scope, { call, management })
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
  fireEvent.change(screen.getByTestId('automation-delivery-mode'), { target: { value: 'channel' } })
  expect(screen.getByTestId('subscription-preview')).toBeDisabled()
  fireEvent.click(await screen.findByTestId('automation-delivery-connection'))
  fireEvent.click(await screen.findByTestId('automation-delivery-destination'))
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
    delivery: {
      kind: 'channel',
      destinationRef: destination.id,
      destinationRevision: destination.revision,
    },
    eventSource: 'connection-event-1',
    schedule: null,
    workflowId: 'saved-code',
    workflowVersion: 1,
  })
  expect(call.mock.calls.some(entry => entry[0] === 'P-DELIVERY')).toBe(false)
  expect(request.payload).not.toHaveProperty('afterSequence')
  expect(request.payload).not.toHaveProperty('sourceStart')
  client.dispose()
})
