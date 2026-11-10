import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requestLocalExecutor } from '@/host/localExecutor'
import { ConnectivityClient } from './client'
import { nativeApplicationAuthorization } from './nativeApplicationAuthorization'
import type { ConnectionView, ConnectivityReply, ConnectivityRequest } from './types'

vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))
const execute = vi.mocked(requestLocalExecutor)
const scope = { accountId: 'owned', targetId: 'native', workspaceId: null, identityGeneration: '1', targetRevision: '1' }
const connection: ConnectionView = { id: 'owned-app', revision: '2', kind: 'tencent_docs', label: 'Owned app', enabled: false,
  hasCredential: false, state: 'authorization_required', configuration: { mcpServerName: 'CaseSource', pluginId: 'CasePlugin' }, resourceGrants: [] }
function fixture() {
  let current = connection
  const reads: ConnectivityRequest[] = []
  const client = new ConnectivityClient(() => scope, async <T,>(_port: string, _method: string, request: ConnectivityRequest) => {
    reads.push(request)
    return { contractVersion: 'parallel-v1', requestId: request.requestId, operationId: null, status: 'completed', error: null,
      result: current, entityRevision: null, observedAt: '2026-10-26T00:00:00Z' } as ConnectivityReply<T>
  })
  return { client, reads, change: (next: ConnectionView) => { current = next } }
}
beforeEach(() => { execute.mockReset() })
describe('native application uses the existing original MCP authorization entry', () => {
  it('deduplicates the local start and uses the exact selected target and source', async () => {
    const { client, reads } = fixture()
    execute.mockResolvedValue({ flowId: 'original-native-flow', authorizationUrl: 'https://issuer.example.invalid/authorize?state=owned' })
    const owner = nativeApplicationAuthorization(client, connection, { deviceId: 'selected-second', workspacePath: '/owned/workspace' }, () => true)
    const first = owner.begin(), second = owner.begin()
    expect(first).toBe(second)
    expect(await first).toMatchObject({ authorizationId: 'original-native-flow', state: 'waiting' })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]).toEqual(['runtime.plugins.request', { deviceId: 'selected-second', workspacePath: '/owned/workspace',
      method: 'gateway/mcp/login', params: { server: { name: 'CaseSource', pluginId: 'CasePlugin' } } }])
    expect(reads.every(read => read.payload.connectionId === connection.id)).toBe(true)
  })
  it('cancels a late original flow after UI cancellation without publishing its URL', async () => {
    const { client } = fixture()
    let finish!: (result: unknown) => void
    execute.mockImplementation(async (_operation, raw) => (raw as { method: string }).method === 'gateway/mcp/login'
      ? await new Promise(resolve => { finish = resolve }) : {})
    const owner = nativeApplicationAuthorization(client, connection, { deviceId: 'original-target' }, () => true)
    const started = owner.begin()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await owner.cancel()
    finish({ flowId: 'late-original', authorizationUrl: 'https://issuer.example.invalid/authorize' })
    await expect(started).rejects.toThrow('APPLICATION_AUTHORIZATION_CANCELLED')
    expect(execute.mock.calls[1][1]).toEqual({ deviceId: 'original-target', method: 'mcp/cancel', params: { flowId: 'late-original' } })
  })
  it('a target change cleans only the captured requester, never the new target', async () => {
    const { client } = fixture()
    let current = true, finish!: (result: unknown) => void
    execute.mockImplementation(async (_operation, raw) => (raw as { method: string }).method === 'gateway/mcp/login'
      ? await new Promise(resolve => { finish = resolve }) : {})
    const target = { deviceId: 'original-target', workspacePath: '/original' }
    const owner = nativeApplicationAuthorization(client, connection, target, () => current)
    const started = owner.begin()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    current = false
    target.deviceId = 'new-target'
    finish({ flowId: 'original-flow', authorizationUrl: 'https://issuer.example.invalid/authorize' })
    await expect(started).rejects.toThrow('APPLICATION_AUTHORIZATION_CANCELLED')
    expect(execute.mock.calls[1][1]).toMatchObject({ deviceId: 'original-target', workspacePath: '/original', method: 'mcp/cancel' })
  })
  it('a changed connection cannot publish an older source authorization', async () => {
    const { client, change } = fixture()
    execute.mockImplementation(async (_operation, raw) => {
      if ((raw as { method: string }).method === 'gateway/mcp/login') {
        change({ ...connection, revision: '3', configuration: { mcpServerName: 'replacement' } })
        return { flowId: 'original-flow', authorizationUrl: 'https://issuer.example.invalid/authorize' }
      }
      return {}
    })
    const owner = nativeApplicationAuthorization(client, connection, { deviceId: 'original-target' }, () => true)
    await expect(owner.begin()).rejects.toThrow('APPLICATION_AUTHORIZATION_SOURCE_CHANGED')
    expect(execute.mock.calls[1][1]).toMatchObject({ method: 'mcp/cancel', params: { flowId: 'original-flow' } })
  })
})
