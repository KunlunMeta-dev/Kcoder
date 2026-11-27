import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nativeConnectivityClient } from './nativeTransport'
import { requestLocalExecutor } from '@/host/localExecutor'
import type { ConnectivityScope } from './types'
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))
const scope: ConnectivityScope = { accountId: 'owner', targetId: 'actual-target', workspaceId: 'workspace', identityGeneration: 'native-1', targetRevision: 'revision-1' }
const request = vi.mocked(requestLocalExecutor)
beforeEach(() => { request.mockReset() })
describe('actual selected-target connectivity transport', () => {
  it('uses only the finite public route and exact original target/scope', async () => {
    request.mockImplementation(async (_operation, input) => {
      const envelope = (input as { params: Record<string, unknown> }).params
      return { contractVersion: 'parallel-v1', requestId: envelope.requestId, operationId: null, status: 'completed', result: { verified: 'original' }, error: null, entityRevision: null, observedAt: '2026-10-25T00:00:00Z' }
    })
    const controller = new AbortController()
    const client = nativeConnectivityClient(scope, { serverId: 'selected-second-target', workspacePath: '/owned/workspace' }, { signal: controller.signal, isCurrent: () => true })
    expect(await client.call('P-CONNECTION', 'listConnections', { limit: 10 })).toEqual({ verified: 'original' })
    expect(request).toHaveBeenCalledWith('runtime.integrations.request', expect.objectContaining({ serverId: 'selected-second-target', workspacePath: '/owned/workspace', method: 'integrations/connectivity/listConnections', params: expect.objectContaining({ scope }) }), expect.anything())
    await expect(client.call('P-DELIVERY', 'listConnections', {})).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('revokes an old target before dispatch and discards a response after identity changes', async () => {
    let current = true
    let finish!: (value: unknown) => void
    request.mockImplementation(async () => new Promise(resolve => { finish = resolve }))
    const controller = new AbortController()
    const client = nativeConnectivityClient(scope, { serverId: 'original-target' }, { signal: controller.signal, isCurrent: () => current })
    const pending = client.call('P-CONNECTION', 'listConnections', {})
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    current = false; finish({})
    await expect(pending).rejects.toThrow()
    await expect(client.call('P-CONNECTION', 'listConnections', {})).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(1)
  })
})
