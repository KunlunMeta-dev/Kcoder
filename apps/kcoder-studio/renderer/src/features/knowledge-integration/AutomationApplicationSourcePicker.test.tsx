import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { IntegrationRequest, IntegrationScope } from '../../../../shared/generated/contracts'
import { KnowledgeIntegrationClient } from './client'
import { AutomationApplicationSourcePicker } from './AutomationApplicationSourcePicker'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const scope: IntegrationScope = {
  accountId: 'owner',
  targetId: 'target',
  workspaceId: null,
  identityGeneration: '1',
  targetRevision: '1',
}
const source = {
  sourceRef: { id: 'native-source', revision: 'source-1' },
  accountRef: null,
  kind: 'mcp',
  displayName: 'Actual connected source',
  accountDisplayName: null,
  state: 'ready',
  reasonCode: null,
  capabilities: ['tools'],
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
function create(
  handler?: (method: string, request: IntegrationRequest) => unknown | Promise<unknown>
) {
  const call = vi.fn(async (_port, method: string, request: IntegrationRequest) =>
    handler && method !== 'listConnections'
      ? handler(method, request)
      : reply(request, { taskSources: [source], taskSourcesState: 'observed' })
  )
  const management = vi.fn(async (_domain, method: string, request: IntegrationRequest) =>
    handler
      ? handler(method, request)
      : reply(request, {
          owner: { accountId: scope.accountId, targetId: scope.targetId, workspaceId: null },
          sourceRef: 'application-events-fixed',
          selectionRevision: 'selection-1',
          source: request.payload.source,
          resourceRef: 'application-resource-fixed',
        })
  )
  return { client: new KnowledgeIntegrationClient(scope, { call, management }), call, management }
}
async function choose() {
  await screen.findByText('Actual connected source')
  fireEvent.change(screen.getByTestId('automation-application-source'), {
    target: { value: source.sourceRef.id },
  })
  fireEvent.change(screen.getByTestId('automation-application-resource-uri'), {
    target: { value: 'mailbox://owned/inbox' },
  })
}
it('requires an actual chosen source and fixed-resource read consent before a separate subscription preview', async () => {
  const instance = create(),
    selected = vi.fn()
  render(<AutomationApplicationSourcePicker client={instance.client} onSelection={selected} />)
  await choose()
  expect(screen.getByTestId('automation-application-authorize')).toBeDisabled()
  expect(instance.management).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('automation-application-read-consent'))
  fireEvent.click(screen.getByTestId('automation-application-authorize'))
  await waitFor(() => expect(instance.management).toHaveBeenCalledTimes(1))
  await waitFor(() =>
    expect(selected).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceRef: 'application-events-fixed', owner: instance.client })
    )
  )
  expect(instance.management.mock.calls[0][2].payload).toEqual({
    source: { sourceRef: source.sourceRef, accountRef: null },
    resourceUri: 'mailbox://owned/inbox',
    readConsentRef: expect.any(String),
  })
  expect(instance.management.mock.calls[0][1]).toBe('selectApplicationEventSource')
  expect(instance.management.mock.calls.some(call => call[1] === 'saveSubscription')).toBe(false)
})
it('only reads the original operation after an unknown grant acknowledgement and never replays it', async () => {
  let original = ''
  const instance = create((method, request) => {
    if (method === 'selectApplicationEventSource') {
      original = request.operationId!
      return reply(request, null, 'unknown')
    }
    return reply(request, {
      receipt: {
        operationId: original,
        scope,
        port: 'P-AUTOMATION',
        method: 'selectApplicationEventSource',
        revision: 2,
        phase: 'completed',
        createdAtMs: 1,
        updatedAtMs: 2,
        entityRef: { kind: 'input', id: 'application-events-fixed', revision: 'selection-1' },
        error: null,
      },
    })
  })
  const selected = vi.fn()
  render(<AutomationApplicationSourcePicker client={instance.client} onSelection={selected} />)
  await choose()
  fireEvent.click(screen.getByTestId('automation-application-read-consent'))
  fireEvent.click(screen.getByTestId('automation-application-authorize'))
  await screen.findByTestId('automation-application-reconcile')
  expect(screen.getByTestId('automation-application-authorize')).toBeDisabled()
  fireEvent.click(screen.getByTestId('automation-application-reconcile'))
  await waitFor(() =>
    expect(selected).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceRef: 'application-events-fixed' })
    )
  )
  expect(
    instance.management.mock.calls.filter(call => call[1] === 'selectApplicationEventSource')
  ).toHaveLength(1)
  expect(instance.call.mock.calls.at(-1)?.[1]).toBe('readOperation')
})
it('drops a late receipt after its owning picker unmounts', async () => {
  let finish!: (value: unknown) => void
  const selected = vi.fn()
  const instance = create(
    (_method, request) =>
      new Promise(resolve => {
        finish = value => resolve(reply(request, value))
      })
  )
  const view = render(
    <AutomationApplicationSourcePicker client={instance.client} onSelection={selected} />
  )
  await choose()
  fireEvent.click(screen.getByTestId('automation-application-read-consent'))
  fireEvent.click(screen.getByTestId('automation-application-authorize'))
  await waitFor(() => expect(instance.management).toHaveBeenCalledTimes(1))
  view.unmount()
  const before = selected.mock.calls.length
  finish({
    owner: { accountId: scope.accountId, targetId: scope.targetId, workspaceId: null },
    sourceRef: 'application-events-fixed',
    selectionRevision: 'selection-1',
    source: { sourceRef: source.sourceRef, accountRef: null },
    resourceRef: 'application-resource-fixed',
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(selected).toHaveBeenCalledTimes(before)
})
