import { afterEach, expect, test, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: fixture.request }))
import { nativeKnowledgeTransport } from './knowledgeTransport'
import type { IntegrationRequest } from '../../../../shared/generated/contracts'

const request: IntegrationRequest = {
  contractVersion: 'parallel-v1', requestId: 'request', timeoutMs: 1000,
  scope: { accountId: 'native-account', targetId: 'native-target', workspaceId: null,
    identityGeneration: 'native-generation', targetRevision: 'native-configuration' }, payload: {},
}
afterEach(() => fixture.request.mockReset())

test('finite public routes preserve the owning target and cancellation signal', async () => {
  fixture.request.mockResolvedValue({ status: 'completed' })
  const transport = nativeKnowledgeTransport({ serverId: 'selected-ssh', workspacePath: '/selected-workspace' })
  const cancel = new AbortController()
  await transport.management('knowledge', 'readPublicationSources', request, cancel.signal)
  await transport.call('P-AUTOMATION', 'saveSubscription', request, cancel.signal)
  await transport.call('P-MEMORY', 'listMemories', request, cancel.signal)
  expect(fixture.request.mock.calls.map(call => call[1].method)).toEqual([
    'integrations/knowledge/readPublicationSources', 'integrations/automation/saveSubscription', 'integrations/memory/list',
  ])
  for (const call of fixture.request.mock.calls) {
    expect(call[1]).toMatchObject({ serverId: 'selected-ssh', workspacePath: '/selected-workspace', params: request })
    expect(call[2]).toEqual({ signal: cancel.signal })
  }
})

test('the public client cannot invoke internal scheduling, claims or arbitrary Ports', async () => {
  const transport = nativeKnowledgeTransport({ serverId: 'selected' })
  for (const [port, method] of [
    ['P-AUTOMATION', 'triggerApprovedSubscription'], ['P-AUTOMATION', 'recordArtifactClaim'],
    ['P-POLICY', 'evaluateAction'], ['P-KNOWLEDGE', 'integrations/knowledge/listPublications'],
  ] as const) await expect(transport.call(port, method, request, new AbortController().signal)).rejects.toThrow('METHOD_UNAVAILABLE')
  expect(fixture.request).not.toHaveBeenCalled()
})

test('canonical memory snapshot reads keep their actual thread route and require no mutation identity', async () => {
  fixture.request.mockResolvedValue({ status: 'completed' })
  const transport = nativeKnowledgeTransport({ serverId: 'selected' })
  const read = { ...request, payload: { threadId: 'actual-thread', taskId: 'canonical-snapshot' } }
  await transport.management('memory', 'readMemoryTaskSnapshot', read, new AbortController().signal)
  expect(fixture.request).toHaveBeenCalledWith('runtime.integrations.request', expect.objectContaining({
    serverId: 'selected', method: 'integrations/memory/readTaskSnapshot', params: read,
  }), expect.anything())
  expect(Object.hasOwn(read, 'operationId')).toBe(false)
})

test('automation destination selection preserves the exact target through finite C reads', async () => {
  fixture.request.mockResolvedValue({ status: 'completed' })
  const transport = nativeKnowledgeTransport({ serverId: 'owned-ssh', workspacePath: '/owned/workspace' })
  const signal = new AbortController().signal
  for (const method of ['listConnections', 'readResourceGrant']) await transport.call('P-CONNECTION', method, request, signal)
  expect(fixture.request.mock.calls.map(call => call[1].method)).toEqual(['integrations/connectivity/listConnections', 'integrations/connectivity/readResourceGrant'])
  for (const call of fixture.request.mock.calls) expect(call[1]).toMatchObject({ serverId: 'owned-ssh', workspacePath: '/owned/workspace', params: request })
  fixture.request.mockReset()
  for (const [port, method] of [['P-CONNECTION', 'prepareConnectionAction'], ['P-CONNECTION', 'readEvents'], ['P-DELIVERY', 'submitDelivery']] as const)
    await expect(transport.call(port, method, request, signal)).rejects.toThrow('METHOD_UNAVAILABLE')
  expect(fixture.request).not.toHaveBeenCalled()
})
