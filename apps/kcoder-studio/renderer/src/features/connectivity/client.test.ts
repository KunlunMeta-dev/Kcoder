import { describe, expect, it, vi } from 'vitest'
import { ConnectivityClient } from './client'
import type { ConnectivityReply, ConnectivityRequest, ConnectivityScope } from './types'

const scope: ConnectivityScope = { accountId: 'fixture-owner', targetId: 'fixture-target', workspaceId: null, identityGeneration: '1', targetRevision: '1' }
function success<T>(request: ConnectivityRequest, result: T): ConnectivityReply<T> {
  return { contractVersion: 'parallel-v1', requestId: request.requestId, operationId: request.operationId ?? null, status: 'completed', result, error: null, entityRevision: null, observedAt: '2026-10-24T00:00:00Z' }
}
describe('connectivity client durable operation boundary', () => {
  it('uses the shared UUID compatibility path on HTTP origins without crypto.randomUUID', async () => {
    const original = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: original.getRandomValues.bind(original) })
    try {
      const ids: string[] = []
      const client = new ConnectivityClient(() => scope, async <T,>(_port: string, _method: string, request: ConnectivityRequest) => { ids.push(request.requestId, request.operationId ?? ''); return success(request, {}) as ConnectivityReply<T> })
      await client.call('P-CONNECTION', 'prepareConnectionAction', { action: 'disable', connectionId: 'connection' })
      expect(ids).toHaveLength(2)
      expect(ids.every(value => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value))).toBe(true)
    } finally { vi.stubGlobal('crypto', original) }
  })
  it('keeps the same original operation after transport uncertainty and property reordering', async () => {
    const requests: ConnectivityRequest[] = []
    let first = true
    const client = new ConnectivityClient(() => scope, async <T,>(_port: string, _method: string, request: ConnectivityRequest) => {
      requests.push(request)
      if (first) { first = false; throw new Error('inert transport loss') }
      return success(request, { revision: '2' }) as ConnectivityReply<T>
    })
    await expect(client.call('P-CONNECTION', 'prepareConnectionAction', { connectionId: 'connection', action: 'disable' }, { expectedRevision: '1' })).rejects.toMatchObject({ code: 'CONNECTION_REQUEST_UNCONFIRMED', recovery: 'reconcile_original' })
    await client.call('P-CONNECTION', 'prepareConnectionAction', { action: 'disable', connectionId: 'connection' }, { expectedRevision: '1' })
    expect(requests[0].operationId).toBe(requests[1].operationId)
  })
  it('never adopts a delayed reply after target or identity generation changes', async () => {
    let current = scope
    let complete!: (value: ConnectivityReply<unknown>) => void
    let original!: ConnectivityRequest
    const transport = vi.fn().mockImplementation((_port, _method, request) => { original = request; return new Promise(resolve => { complete = resolve }) })
    const client = new ConnectivityClient(() => current, transport)
    const pending = client.call('P-CONNECTION', 'listConnections', {})
    current = { ...scope, identityGeneration: '2' }
    complete(success(original, { items: [] }))
    await expect(pending).rejects.toMatchObject({ code: 'TARGET_CHANGED' })
  })
  it('rejects malformed success and a response from a different mutation operation', async () => {
    const client = new ConnectivityClient(() => scope, async <T,>(_port: string, _method: string, request: ConnectivityRequest) => ({ ...success(request, {}), operationId: 'unrelated-operation' }) as ConnectivityReply<T>)
    await expect(client.call('P-CONNECTION', 'prepareConnectionAction', { action: 'disable', connectionId: 'connection' })).rejects.toMatchObject({ code: 'CONTRACT_UNSUPPORTED' })
    const bad = new ConnectivityClient(() => scope, async <T,>(_port: string, _method: string, request: ConnectivityRequest) => ({ ...success(request, {}), error: { code: 'FAILED', messageKey: 'failed', recoverability: 'retry', recovery: 'none' } }) as unknown as ConnectivityReply<T>)
    await expect(bad.call('P-CONNECTION', 'listConnections', {})).rejects.toBeInstanceOf(Error)
  })
})
it('a definite pre-dispatch rejection permits a new explicit operation after inspecting the resource', async () => {
  const requests: ConnectivityRequest[] = []
  const client = new ConnectivityClient(() => scope, async <T,>(_port: string, _method: string, request: ConnectivityRequest) => {
    requests.push(request)
    if (requests.length === 1) return { ...success(request, null), status: 'rejected', error: { code: 'BOT_ALREADY_OWNED', messageKey: 'connectivity.bot_owned', recovery: 'retry_read' } } as ConnectivityReply<T>
    return success(request, { state: 'connected' }) as ConnectivityReply<T>
  })
  await expect(client.call('P-CONNECTION', 'prepareConnectionAction', { action: 'start', connectionId: 'configured' })).rejects.toMatchObject({ code: 'BOT_ALREADY_OWNED' })
  await client.call('P-CONNECTION', 'prepareConnectionAction', { action: 'start', connectionId: 'configured' })
  expect(requests[0].operationId).not.toBe(requests[1].operationId)
})

it('reserves a bounded startup budget and keeps other channel mutations short', async () => {
  const requests: ConnectivityRequest[] = []
  const client = new ConnectivityClient(() => scope, async <T,>(_port: string, _method: string, request: ConnectivityRequest) => { requests.push(request); return success(request, {}) as ConnectivityReply<T> })
  await client.call('P-CONNECTION', 'prepareConnectionAction', { action: 'save', connectionId: 'new' })
  await client.call('P-CONNECTION', 'prepareConnectionAction', { action: 'save', connectionId: 'existing' }, { expectedRevision: '1' })
  await client.call('P-CONNECTION', 'prepareConnectionAction', { action: 'start', connectionId: 'existing' }, { expectedRevision: '2' })
  await client.call('P-CONNECTION', 'prepareConnectionAction', { action: 'takeoverBot', connectionId: 'existing' }, { expectedRevision: '2' })
  await client.call('P-CONNECTION', 'prepareConnectionAction', { action: 'stop', connectionId: 'existing' }, { expectedRevision: '3' })
  expect(requests.map(request => request.timeoutMs)).toEqual([60_000, 30_000, 60_000, 60_000, 30_000])
})
