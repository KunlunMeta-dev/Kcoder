import { describe, expect, it, vi } from 'vitest'
import type {
  IntegrationReply,
  IntegrationRequest,
  IntegrationScope,
} from '../../../../shared/generated/contracts'
import fixtures from '../../../../../../tests/fixtures/integrations/knowledge/contract-fixtures.json'
import {
  KnowledgeIntegrationClient,
  KnowledgeOperationError,
  type KnowledgeIntegrationTransport,
} from './client'
const scope: IntegrationScope = {
  accountId: 'fixture-account',
  targetId: 'fixture-target',
  workspaceId: null,
  identityGeneration: '1',
  targetRevision: '1',
}
const memory = fixtures.ReviewedMemory.valid[0].value
function reply(
  request: IntegrationRequest,
  result: Record<string, unknown> | null,
  status: IntegrationReply['status'] = 'completed'
): IntegrationReply {
  return {
    contractVersion: 'parallel-v1',
    requestId: request.requestId,
    operationId: request.operationId ?? null,
    entityRevision: null,
    observedAt: '2026-10-24T00:00:00Z',
    status,
    result,
    error:
      status === 'unknown'
        ? { code: 'MEMORY_WRITE_UNCONFIRMED', messageKey: 'safe', recovery: 'reconcile_original' }
        : null,
  }
}
describe('knowledge client ownership and receipt semantics', () => {
  it('uses generated schemas and preserves native paging cursors', async () => {
    const call = vi.fn(async (_port: unknown, _method: unknown, request: IntegrationRequest) =>
      reply(request, { page: { items: [memory], nextCursor: 'native-cursor' } })
    )
    const transport: KnowledgeIntegrationTransport = { call, management: vi.fn() }
    const client = new KnowledgeIntegrationClient(scope, transport)
    expect((await client.listMemories('previous-cursor')).nextCursor).toBe('native-cursor')
    expect(call).toHaveBeenCalledWith(
      'P-MEMORY',
      'listMemories',
      expect.objectContaining({
        scope,
        payload: { after: 'previous-cursor', includeCandidates: true },
      }),
      expect.any(AbortSignal)
    )
    client.dispose()
  })
  it('discards a delayed response after its account or target owner is disposed', async () => {
    let settle: (value: unknown) => void = () => undefined
    let captured: IntegrationRequest | undefined
    const transport: KnowledgeIntegrationTransport = {
      call: vi.fn((_port, _method, request) => {
        captured = request
        return new Promise(resolve => {
          settle = resolve
        })
      }),
      management: vi.fn(),
    }
    const client = new KnowledgeIntegrationClient(scope, transport)
    const pending = client.listMemories()
    client.dispose()
    settle(reply(captured!, { page: { items: [memory], nextCursor: null } }))
    await expect(pending).rejects.toMatchObject({ code: 'KNOWLEDGE_OWNER_CHANGED' })
  })
  it('does not retry uncertain writes or expose transport error text', async () => {
    const call = vi.fn(async (_port: unknown, _method: unknown, request: IntegrationRequest) =>
      reply(request, null, 'unknown')
    )
    const client = new KnowledgeIntegrationClient(scope, { call, management: vi.fn() })
    await expect(
      client.proposeMemory(fixtures.MemoryProposal.valid[0].value)
    ).rejects.toMatchObject({ uncertain: true, operationId: expect.any(String) })
    expect(call).toHaveBeenCalledTimes(1)
    const failing = new KnowledgeIntegrationClient(scope, {
      call: vi.fn().mockRejectedValue(new Error('PRIVATE_TOKEN_PROVIDER_SECRET')),
      management: vi.fn(),
    })
    let error: unknown
    try {
      await failing.listMemories()
    } catch (reason) {
      error = reason
    }
    expect(error).toBeInstanceOf(KnowledgeOperationError)
    expect(String(error)).not.toContain('PRIVATE_TOKEN')
    client.dispose()
    failing.dispose()
  })
  it('rejects malformed result schemas and mismatched operation receipts', async () => {
    const client = new KnowledgeIntegrationClient(scope, {
      call: vi.fn(async (_port, _method, request) => ({
        ...reply(request, { page: { items: [{ invented: true }] } }),
        operationId: 'wrong-operation',
      })),
      management: vi.fn(),
    })
    await expect(client.listMemories()).rejects.toMatchObject({ code: 'KNOWLEDGE_INVALID_RECEIPT' })
    client.dispose()
  })
})
it('writes through the shared UUID helper when insecure HTTP lacks randomUUID', async () => {
  const original = globalThis.crypto
  vi.stubGlobal('crypto', { getRandomValues: original.getRandomValues.bind(original) })
  try {
    const call = vi.fn(async (_port: unknown, _method: unknown, request: IntegrationRequest) =>
      reply(request, { memory })
    )
    const client = new KnowledgeIntegrationClient(scope, { call, management: vi.fn() })
    await client.proposeMemory(fixtures.MemoryProposal.valid[0].value)
    expect(call).toHaveBeenCalledWith(
      'P-MEMORY',
      'proposeMemory',
      expect.objectContaining({ operationId: expect.stringMatching(/^[a-f0-9-]{36}$/) }),
      expect.any(AbortSignal)
    )
    client.dispose()
  } finally {
    vi.unstubAllGlobals()
  }
})

describe('safe transport error classification', () => {
  it.each([
    [{ code: 'INTEGRATION_TARGET_UPGRADE_REQUIRED' }, 'INTEGRATION_TARGET_UPGRADE_REQUIRED'],
    [{ reason: 'unauthorized' }, 'KNOWLEDGE_AUTHENTICATION_REQUIRED'],
    [{ reason: 'connection' }, 'KNOWLEDGE_CONNECTION_UNAVAILABLE'],
    [{ reason: 'timeout' }, 'KNOWLEDGE_CONNECTION_UNAVAILABLE'],
    [{ code: 'PRIVATE_SECRET', message: 'PRIVATE_SECRET' }, 'KNOWLEDGE_OPERATION_UNAVAILABLE'],
  ])('preserves only a fixed safe category for a read failure', async (failure, code) => {
    const call = vi.fn().mockRejectedValue(failure)
    const client = new KnowledgeIntegrationClient(scope, { call, management: vi.fn() })
    await expect(client.listMemories()).rejects.toMatchObject({ code, uncertain: false })
    expect(call).toHaveBeenCalledTimes(1)
    client.dispose()
  })
})
